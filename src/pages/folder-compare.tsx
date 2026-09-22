/**
 * Folder comparison page (single route, tab-based, Beyond-Compare style).
 *
 * Owns the folder-level state (the two picked directories, the diff tree) plus
 * the file tab system: tab #0 is the directory tree (always mounted, hidden
 * while a file tab is active), and every file opened from the tree gets its
 * own always-mounted pane, so scroll position / cursor / undo / dirty state
 * survive tab switches. The active tab is mirrored in the `?file=` search
 * param, which keeps useUnsavedGuard's pathname-based route-leave blocker
 * semantics intact (search-only switches pass through).
 *
 * Panes:
 *   FolderTreePane   — directory pickers + diff tree (src/pages/folder-index.tsx)
 *   FolderFilePane   — per-file side-by-side diff (src/pages/folder-file.tsx)
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
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
import { Side, basename } from '../diff-view';
import { ShellContext, useShell } from '../layout';
import { useSettings } from '../settings';
import { AppHeader } from '../app-header';
import { TabBar, type TabBarTab } from '../tab-bar';
import { TREE_TAB_KEY, useFileTabs } from '../use-file-tabs';
import { useUnsavedGuard } from '../use-unsaved-guard';
import { usePaneActions, type PaneActions } from '../use-pane-actions';
import { materialIconUrl, materialIconUrlByName } from '../material-icons';
import { FolderTreePane } from './folder-index';
import { FolderFilePane } from './folder-file';

/** Context handed to the folder panes: shell context + folder state + tab api. */
export interface FolderContext extends ShellContext {
  leftDir: string | null;
  rightDir: string | null;
  entries: DiffEntry[];
  /** Active file tab path; null = the tree tab. Drives the tree's row highlight. */
  activePath: string | null;
  /** Open (or activate) the tab for a tree file. */
  openFile: (path: string) => void;
  /** Report a pane's dirty state so tab close/leave guards can confirm. */
  reportDirty: (path: string, dirty: boolean) => void;
  /** Report a pane's header actions (jump/search/reload) so the page header can host them for the active tab. */
  reportPanel: (path: string, actions: PaneActions | null) => void;
  /** Set one side's directory and (once both are set) recompute the diff. */
  setDir: (side: Side, path: string) => Promise<void>;
  /** Set both sides at once (dropping two folders together) and recompute. */
  setDirs: (dirs: { left?: string; right?: string }) => Promise<void>;
  /** Shared tree-expanded keys, hoisted so they survive tab switches. */
  expandedKeys: string[];
  setExpandedKeys: (keys: string[]) => void;
  /** Recompute the diff for the two currently-picked directories. */
  refresh: () => Promise<void>;
  /** Retarget a tab after its file was renamed on disk (context-menu rename). */
  renameTab: (from: string, to: string) => void;
}

const FolderCtx = createContext<FolderContext | null>(null);

/** Typed accessor for the folder context (used by both panes). */
export function useFolder() {
  const ctx = useContext(FolderCtx);
  if (!ctx) throw new Error('useFolder must be used within FolderComparePage');
  return ctx;
}

export function FolderComparePage() {
  const shell = useShell();
  const { setError } = shell;
  const { settings } = useSettings();
  const { t } = useTranslation(['folder', 'common']);
  const navigate = useNavigate();
  // Ignore parameters for diff_dirs (directories + whitespace/case). Kept in a ref so callbacks read the latest values,
  // avoiding stuffing settings into the useCallback deps, which would rebuild setDir/refresh frequently.
  const diffArgsRef = useRef({
    ignore_dirs: settings.ignoreDirs,
    ignore_whitespace: settings.ignoreWhitespace,
    ignore_case: settings.ignoreCase,
  });
  useEffect(() => {
    diffArgsRef.current = {
      ignore_dirs: settings.ignoreDirs,
      ignore_whitespace: settings.ignoreWhitespace,
      ignore_case: settings.ignoreCase,
    };
  }, [settings.ignoreDirs, settings.ignoreWhitespace, settings.ignoreCase]);
  const [leftDir, setLeftDir] = useState<string | null>(null);
  const [rightDir, setRightDir] = useState<string | null>(null);
  const [entries, setEntries] = useState<DiffEntry[]>([]);
  // Shared tree-expanded keys: hoisted here so they survive tab switches; cleared on each new diff.
  const [expandedKeys, setExpandedKeys] = useState<string[]>([]);
  // Per-tab dirty state, reported by each FolderFilePane; feeds the tab close/leave guards.
  const [dirtyMap, setDirtyMap] = useState<Record<string, boolean>>({});
  const reportDirty = useCallback((path: string, dirty: boolean) => {
    setDirtyMap((prev) => (prev[path] === dirty ? prev : { ...prev, [path]: dirty }));
  }, []);

  // Per-tab header actions, reported by each FolderFilePane; the header buttons
  // below act on the active tab's pane (matching text-compare's header layout).
  const { reportPanel, getPanel } = usePaneActions();

  const tabsApi = useFileTabs({
    basePath: '/folder-compare',
    isDirty: (p) => !!dirtyMap[p],
  });
  const {
    tabs,
    activePath,
    openFile,
    activate,
    closeTab,
    closeOthers,
    closeAll,
    renameTab,
    resetForNewDiff,
  } = tabsApi;

  // Route-leave guard, hoisted to the page: fires when leaving /folder-compare
  // with any dirty tab (search-only tab switches never hit the pathname check).
  useUnsavedGuard(tabs.some((p) => !!dirtyMap[p]));

  // Compute the diff: allow only one side to exist (pass an empty string for the missing side; the backend marks the other side entirely as added/removed),
  // so importing one side first immediately shows its directory contents without waiting for the other side.
  const runDiff = useCallback(
    async (l: string | null, r: string | null) => {
      // A new diff wipes the file tabs (paths belong to the old directory pair);
      // confirm first when any tab has unsaved edits — cancel aborts everything.
      if (!(await resetForNewDiff())) return;
      if (!l && !r) {
        setEntries([]);
        return;
      }
      setError('');
      try {
        const result = await invoke<DiffEntry[]>('diff_dirs', {
          left: l ?? '',
          right: r ?? '',
          ...diffArgsRef.current,
        });
        setEntries(result);
        setExpandedKeys([]);
      } catch (e) {
        setError(String(e));
      }
    },
    [setError, resetForNewDiff],
  );

  const setDir = useCallback(
    async (side: Side, path: string) => {
      const l = side === 'left' ? path : leftDir;
      const r = side === 'right' ? path : rightDir;
      // Set the picked dir only after the discard confirm passed (cancel keeps the old pair).
      if (!(await resetForNewDiff())) return;
      if (side === 'left') setLeftDir(path);
      else setRightDir(path);
      await runDiff(l, r);
    },
    [leftDir, rightDir, runDiff, resetForNewDiff],
  );

  // Set both sides at once (dragging in two directories together) and compute the diff immediately.
  const setDirs = useCallback(
    async (dirs: { left?: string; right?: string }) => {
      const l = dirs.left ?? leftDir;
      const r = dirs.right ?? rightDir;
      if (!(await resetForNewDiff())) return;
      if (dirs.left !== undefined) setLeftDir(dirs.left);
      if (dirs.right !== undefined) setRightDir(dirs.right);
      await runDiff(l, r);
    },
    [leftDir, rightDir, runDiff, resetForNewDiff],
  );

  // Consume router state on each navigation: apply the directories passed from
  // the home page's drag or a re-selected "recent comparison". Keyed on
  // location.key so re-selecting the same folder pair from the sidebar reloads
  // it (a fresh navigation always yields a new key, even for identical state),
  // instead of staying on an empty folder-compare page when already on this route.
  // Tab switches also produce a new location.key but carry no state — the
  // early-return below makes them inert.
  const location = useLocation();
  useEffect(() => {
    const { left, right } = (location.state as { left?: string; right?: string } | null) ?? {};
    if (!left && !right) return;
    void (async () => {
      if (!(await resetForNewDiff())) return;
      setLeftDir(left ?? null);
      setRightDir(right ?? null);
      await runDiff(left ?? null, right ?? null);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.key]);

  // Recompute the diff after a copy/write, but keep the open tabs (don't wipe them).
  const refresh = useCallback(async () => {
    if (!leftDir && !rightDir) return;
    setError('');
    try {
      const result = await invoke<DiffEntry[]>('diff_dirs', {
        left: leftDir ?? '',
        right: rightDir ?? '',
        ...diffArgsRef.current,
      });
      setEntries(result);
    } catch (e) {
      setError(String(e));
    }
  }, [leftDir, rightDir, setError]);

  // When the ignore settings change, recompute the diff for the already-open directory pair (so settings take effect immediately).
  useEffect(() => {
    if (leftDir || rightDir) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.ignoreDirs, settings.ignoreWhitespace, settings.ignoreCase]);

  // Record history (kind=folder) once both directories are selected, for the left sidebar's "recent comparisons" to restore.
  const { pushRecent } = shell;
  useEffect(() => {
    if (leftDir && rightDir) pushRecent(leftDir, rightDir, 'folder');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leftDir, rightDir]);

  // Tab strip: the closable tree tab + one tab per opened file. Every tab has a
  // close button; the tree tab is the session's last tab, so closing it (with any
  // unsaved edits confirmed by useUnsavedGuard) leaves for home.
  const tabBarTabs = useMemo<TabBarTab[]>(
    () => [
      {
        key: TREE_TAB_KEY,
        label: t('treeTab'),
        iconUrl: materialIconUrlByName('folder-base-open'),
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

  const ctx = useMemo<FolderContext>(
    () => ({
      ...shell,
      leftDir,
      rightDir,
      entries,
      activePath,
      openFile,
      reportDirty,
      reportPanel,
      setDir,
      setDirs,
      expandedKeys,
      setExpandedKeys,
      refresh,
      renameTab,
    }),
    [
      shell,
      leftDir,
      rightDir,
      entries,
      activePath,
      openFile,
      reportDirty,
      reportPanel,
      setDir,
      setDirs,
      expandedKeys,
      refresh,
      renameTab,
    ],
  );

  return (
    <FolderCtx.Provider value={ctx}>
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
                  file pair; on the tree tab it recomputes the directory diff (always visible,
                  disabled with nothing picked — mirrors text-compare). */}
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
                    disabled={!leftDir && !rightDir}
                    onClick={() => void refresh()}
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
            <FolderTreePane active={activePath === null} />
          </div>
          {tabs.map((path) => (
            <div
              key={path}
              className={cx('flex flex-col flex-1 min-h-0', path !== activePath && 'hidden')}
            >
              <FolderFilePane path={path} active={path === activePath} />
            </div>
          ))}
        </div>
      </div>
    </FolderCtx.Provider>
  );
}
