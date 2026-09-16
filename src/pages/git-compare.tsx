/**
 * Git comparison page (single route, tab-based, Beyond-Compare style —
 * mirrors folder-compare). Owns the repo-level state (the opened repo, the
 * two picked refs, the synthesized diff entries) plus the file tab system:
 * tab #0 is the ref/tree view (always mounted), every opened file gets its
 * own always-mounted pane, and the active tab is mirrored in the `?file=`
 * search param so useUnsavedGuard's pathname-based route-leave blocker keeps
 * working (search-only tab switches pass through).
 *
 * Panes:
 *   GitTreePane  — repo picker + ref pickers + diff tree (src/pages/git-index.tsx)
 *   GitFilePane  — per-file side-by-side diff; worktree side writable (src/pages/git-file.tsx)
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import cx from 'classnames';
import { Button, Divider, Space, Tooltip } from 'antd';
import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  ReloadOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import { DiffEntry } from '../diff-tree';
import { basename } from '../diff-view';
import { ShellContext, useShell } from '../layout';
import { AppHeader } from '../app-header';
import { TabBar, type TabBarTab } from '../tab-bar';
import { TREE_TAB_KEY, useFileTabs } from '../use-file-tabs';
import { useUnsavedGuard } from '../use-unsaved-guard';
import { usePaneActions, type PaneActions } from '../use-pane-actions';
import { materialIconUrl, materialIconUrlByName } from '../material-icons';
import { GitTreePane } from './git-index';
import { GitFilePane } from './git-file';

/** Sentinel ref value meaning "the working tree" (empty rev to the backend). */
export const WORKTREE = '__worktree__';

export interface GitCommit {
  hash: string;
  short: string;
  subject: string;
  author: string;
  date: string;
}

export interface GitRepoInfo {
  is_repo: boolean;
  root: string;
  current_branch: string;
  branches: string[];
  commits: GitCommit[];
}

/** Map a picker value to the rev string the backend expects ("" = worktree). */
export function toRev(v: string): string {
  return v === WORKTREE ? '' : v;
}

/**
 * Human-readable label for a ref value, used in history display. The worktree
 * label is passed in so this stays a pure helper (i18n's t is only available in
 * components); callers pass t('git:worktree').
 */
export function refLabel(v: string, repo: GitRepoInfo | null, worktreeLabel: string): string {
  if (v === WORKTREE) return worktreeLabel;
  const c = repo?.commits.find((x) => x.hash === v);
  if (c) return `${c.short} ${c.subject}`;
  return v;
}

/** Context handed to the git panes: shell context + git compare state + tab api. */
export interface GitContext extends ShellContext {
  repo: GitRepoInfo | null;
  from: string | null;
  to: string;
  entries: DiffEntry[];
  /** Active file tab path; null = the tree tab. Drives the tree's row highlight. */
  activePath: string | null;
  /** Open (or activate) the tab for a tree file. */
  openFile: (path: string) => void;
  /** Report a pane's dirty state so tab close/leave guards can confirm. */
  reportDirty: (path: string, dirty: boolean) => void;
  /** Report a pane's header actions (jump/search/reload) so the page header can host them for the active tab. */
  reportPanel: (path: string, actions: PaneActions | null) => void;
  /** Shared tree-expanded keys, hoisted so they survive tab switches. */
  expandedKeys: string[];
  setExpandedKeys: (keys: string[]) => void;
  /** Open (or reopen) a repo by directory, optionally restoring two refs. */
  loadRepo: (path: string, wantFrom?: string, wantTo?: string) => Promise<void>;
  /** Change one side's ref and recompute the diff. */
  setFrom: (v: string) => void;
  setTo: (v: string) => void;
  /** Recompute the diff for the current repo + refs. */
  refresh: () => void;
}

const GitCtx = createContext<GitContext | null>(null);

/** Typed accessor for the git context (used by both panes). */
export function useGit() {
  const ctx = useContext(GitCtx);
  if (!ctx) throw new Error('useGit must be used within GitComparePage');
  return ctx;
}

export function GitComparePage() {
  const shell = useShell();
  const { setError, pushRecent } = shell;
  const location = useLocation();
  const navigate = useNavigate();
  const { t } = useTranslation(['git', 'common']);

  const [repo, setRepo] = useState<GitRepoInfo | null>(null);
  const [from, setFromState] = useState<string | null>(null);
  const [to, setToState] = useState<string>(WORKTREE);
  const [entries, setEntries] = useState<DiffEntry[]>([]);
  // Shared tree-expanded keys: hoisted here so they survive tab switches; cleared on each new diff.
  const [expandedKeys, setExpandedKeys] = useState<string[]>([]);
  // Per-tab dirty state, reported by each GitFilePane; feeds the tab close/leave guards.
  const [dirtyMap, setDirtyMap] = useState<Record<string, boolean>>({});
  const reportDirty = useCallback((path: string, dirty: boolean) => {
    setDirtyMap((prev) => (prev[path] === dirty ? prev : { ...prev, [path]: dirty }));
  }, []);

  // Per-tab header actions, reported by each GitFilePane; the header buttons
  // below act on the active tab's pane (matching text-compare's header layout).
  const { reportPanel, getPanel } = usePaneActions();

  const tabsApi = useFileTabs({
    basePath: '/git-compare',
    isDirty: (p) => !!dirtyMap[p],
  });
  const { tabs, activePath, openFile, activate, closeTab, closeOthers, closeAll, resetForNewDiff } =
    tabsApi;

  // Route-leave guard, hoisted to the page: fires when leaving /git-compare
  // with any dirty tab (search-only tab switches never hit the pathname check).
  useUnsavedGuard(tabs.some((p) => !!dirtyMap[p]));

  // Compute the diff between the two refs and record one history entry (kind=git).
  const runDiff = useCallback(
    async (root: string, f: string, tgt: string, info: GitRepoInfo | null) => {
      // A new diff wipes the file tabs (paths belong to the old ref pair);
      // confirm first when any tab has unsaved edits — cancel aborts everything.
      if (!(await resetForNewDiff())) return;
      setError('');
      try {
        const result = await invoke<DiffEntry[]>('git_diff_refs', {
          repo: root,
          from: toRev(f),
          to: toRev(tgt),
        });
        setEntries(result);
        setExpandedKeys([]);
        const ctx = info ?? repo;
        const wt = t('worktree');
        pushRecent(f, tgt, 'git', {
          repo: root,
          leftName: refLabel(f, ctx, wt),
          rightName: refLabel(tgt, ctx, wt),
        });
      } catch (e) {
        setError(String(e));
      }
    },
    [setError, pushRecent, repo, t, resetForNewDiff],
  );

  const loadRepo = useCallback(
    async (path: string, wantFrom?: string, wantTo?: string) => {
      setError('');
      try {
        const info = await invoke<GitRepoInfo>('git_repo_info', { path });
        if (!info.is_repo) {
          setError(t('notGitRepo'));
          setRepo(null);
          return;
        }
        const known = (v?: string) =>
          !!v &&
          (v === WORKTREE || info.branches.includes(v) || info.commits.some((c) => c.hash === v));
        const defaultFrom = info.current_branch || info.branches[0] || null;
        const initialFrom = known(wantFrom) ? wantFrom! : defaultFrom;
        const initialTo = known(wantTo) ? wantTo! : WORKTREE;
        // Confirm BEFORE mutating any state so a cancel keeps the current repo/refs/tabs.
        if (!(await resetForNewDiff())) return;
        setRepo(info);
        setFromState(initialFrom);
        setToState(initialTo);
        setEntries([]);
        setExpandedKeys([]);
        if (initialFrom) await runDiff(info.root, initialFrom, initialTo, info);
      } catch (e) {
        setError(String(e));
      }
    },
    [setError, runDiff, t, resetForNewDiff],
  );

  const setFrom = useCallback(
    (v: string) => {
      void (async () => {
        if (!(await resetForNewDiff())) return;
        setFromState(v);
        if (repo) await runDiff(repo.root, v, to, repo);
      })();
    },
    [repo, to, runDiff, resetForNewDiff],
  );

  const setTo = useCallback(
    (v: string) => {
      void (async () => {
        if (!(await resetForNewDiff())) return;
        setToState(v);
        if (repo && from) await runDiff(repo.root, from, v, repo);
      })();
    },
    [repo, from, runDiff, resetForNewDiff],
  );

  const refresh = useCallback(() => {
    if (repo && from) void runDiff(repo.root, from, to, repo);
  }, [repo, from, to, runDiff]);

  // Consume router state on each navigation: auto-load the repo/refs passed from
  // a re-selected "recent comparison". Keyed on location.key so re-selecting the
  // same repo from the sidebar reloads it. Tab switches also produce a new
  // location.key but carry no state — the initState?.repo check makes them inert.
  useEffect(() => {
    const initState = location.state as { repo?: string; from?: string; to?: string } | null;
    if (initState?.repo)
      void loadRepo(initState.repo, initState.from ?? undefined, initState.to ?? undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.key]);

  // Tab strip: the closable tree tab + one tab per opened file. Every tab has a
  // close button; the tree tab is the session's last tab, so closing it (with any
  // unsaved edits confirmed by useUnsavedGuard) leaves for home.
  const tabBarTabs = useMemo<TabBarTab[]>(
    () => [
      {
        key: TREE_TAB_KEY,
        label: t('treeTab'),
        iconUrl: materialIconUrlByName('git'),
        closable: true,
      },
      ...tabs.map((path) => ({
        key: path,
        label: basename(path),
        iconUrl: materialIconUrl(basename(path)),
        title: path,
        closable: true,
        dirty: !!dirtyMap[path],
      })),
    ],
    [tabs, dirtyMap, t],
  );

  const onTabSelect = useCallback(
    (key: string) => activate(key === TREE_TAB_KEY ? null : key),
    [activate],
  );

  const onTabClose = useCallback(
    (key: string) => {
      if (key === TREE_TAB_KEY) navigate('/');
      else closeTab(key);
    },
    [closeTab, navigate],
  );

  // The active pane's hoisted actions (null on the tree tab): gating flags come
  // from the pane's report, so header buttons appear/disappear in sync.
  const activeActions = getPanel(activePath);

  const ctx = useMemo<GitContext>(
    () => ({
      ...shell,
      repo,
      from,
      to,
      entries,
      activePath,
      openFile,
      reportDirty,
      reportPanel,
      expandedKeys,
      setExpandedKeys,
      loadRepo,
      setFrom,
      setTo,
      refresh,
    }),
    [
      shell,
      repo,
      from,
      to,
      entries,
      activePath,
      openFile,
      reportDirty,
      reportPanel,
      expandedKeys,
      loadRepo,
      setFrom,
      setTo,
      refresh,
    ],
  );

  return (
    <GitCtx.Provider value={ctx}>
      <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
        <AppHeader
          siderCollapsed={shell.siderCollapsed}
          onExpandSider={shell.onExpandSider}
          tabs={
            <TabBar
              tabs={tabBarTabs}
              activeKey={activePath ?? TREE_TAB_KEY}
              onSelect={onTabSelect}
              onClose={onTabClose}
              onCloseOthers={closeOthers}
              onCloseAll={closeAll}
            />
          }
          right={
            <Space size="small">
              {activeActions?.canDiff && (
                <>
                  <Tooltip title={t('common:prevDiff')}>
                    <Button
                      type="text"
                      size="small"
                      icon={<ArrowUpOutlined />}
                      onClick={() => activeActions.goPrev()}
                    />
                  </Tooltip>
                  <Tooltip title={t('common:nextDiff')}>
                    <Button
                      type="text"
                      size="small"
                      icon={<ArrowDownOutlined />}
                      onClick={() => activeActions.goNext()}
                    />
                  </Tooltip>
                  <Tooltip title={t('common:findReplace')}>
                    <Button
                      type="text"
                      size="small"
                      icon={<SearchOutlined />}
                      onClick={() => activeActions.toggleSearch()}
                    />
                  </Tooltip>
                  <Divider vertical className="mx-0.5" />
                </>
              )}
              {/* Refresh lives in the header for both tab kinds: on a file tab it reloads that
                  file pair; on the tree tab it recomputes the ref diff (always visible,
                  disabled until a repo + from-ref are picked — mirrors text-compare). */}
              {activeActions ? (
                activeActions.hasFile && (
                  <Tooltip title={t('common:refresh')}>
                    <Button
                      type="text"
                      size="small"
                      icon={<ReloadOutlined />}
                      onClick={() => activeActions.reload()}
                    />
                  </Tooltip>
                )
              ) : (
                <Tooltip title={t('common:refresh')}>
                  <Button
                    type="text"
                    size="small"
                    icon={<ReloadOutlined />}
                    disabled={!repo || !from}
                    onClick={refresh}
                  />
                </Tooltip>
              )}
            </Space>
          }
        />

        {/* All panes stay mounted; inactive ones are merely hidden so their
            editor state (scroll/cursor/undo/dirty) survives tab switches. */}
        <div className="flex-1 flex flex-col min-h-0">
          <div className={cx('flex flex-col flex-1 min-h-0', activePath !== null && 'hidden')}>
            <GitTreePane active={activePath === null} />
          </div>
          {tabs.map((path) => (
            <div
              key={path}
              className={cx('flex flex-col flex-1 min-h-0', path !== activePath && 'hidden')}
            >
              <GitFilePane path={path} />
            </div>
          ))}
        </div>
      </div>
    </GitCtx.Provider>
  );
}
