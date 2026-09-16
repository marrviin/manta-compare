/**
 * Git comparison tree pane (the fixed tab #0 inside GitComparePage; mirrors
 * the two-column layout of folder compare):
 *   - Each side has a column header: a ref dropdown (worktree / branch / commit) + refresh;
 *   - Both sides render the same diff records synthesized by git_diff_refs (DiffSideTable),
 *     sharing the expanded set + synced scrolling, with strictly aligned rows;
 *   - Clicking a file node present on a side opens it as a file tab (see useFileTabs
 *     on the owning page);
 *   - Supports auto-detecting a repo directory dropped onto the window.
 */
import { useEffect, useMemo, useState } from 'react';
import cx from 'classnames';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { Empty, Select, Tooltip } from 'antd';
import { useTranslation } from 'react-i18next';
import { FolderOpenOutlined } from '@ant-design/icons';
import { Side } from '../diff-view';
import { DiffMenuAction, DiffSideTable, buildRecords, folderColumns } from '../diff-table';
import { useScrollSync } from '../scroll-sync';
import { useGit, WORKTREE, toRev } from './git-compare';

export function GitTreePane({ active }: { active: boolean }) {
  const { t, i18n } = useTranslation(['git', 'common']);
  // Column-header labels under the diff namespace (size/mtime/name); folderColumns needs it + the current locale.
  const { t: td } = useTranslation('diff');
  const {
    setError,
    repo,
    from,
    to,
    entries,
    activePath,
    openFile,
    expandedKeys,
    setExpandedKeys,
    loadRepo,
    setFrom,
    setTo,
    refresh,
  } = useGit();
  const [hoverSide, setHoverSide] = useState<Side | null>(null);
  const scrollRegister = useScrollSync();

  // Both sides share one expanded set (hoisted into the page so the expansion
  // survives tab switches). The page clears it whenever a new diff is computed.

  async function pickRepo() {
    try {
      const selected = await open({
        multiple: false,
        directory: true,
        title: t('pickRepo'),
      });
      if (typeof selected !== 'string') return;
      await loadRepo(selected);
    } catch (e) {
      setError(String(e));
    }
  }

  // Native Tauri drag-drop: dropping a directory tries to open it as a Git repo.
  // Gated on `active` — the pane stays mounted while a file tab is on top, and
  // an ungated listener would react to drops made while another pane is visible.
  useEffect(() => {
    if (!active) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    getCurrentWebview()
      .onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === 'over') {
          const x = p.position.x;
          setHoverSide(x < window.innerWidth / 2 ? 'left' : 'right');
        } else if (p.type === 'drop') {
          setHoverSide(null);
          const paths = p.paths.filter(Boolean);
          if (paths.length === 0) return;
          const path = paths[0];
          void (async () => {
            try {
              const kind = await invoke<string>('path_kind', { path });
              if (kind !== 'dir') {
                setError(t('dropRepoDir'));
                return;
              }
              await loadRepo(path);
            } catch (e) {
              setError(String(e));
            }
          })();
        } else {
          setHoverSide(null);
        }
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [active, loadRepo, setError, t]);

  // Check out this file from a side's ref into the working tree (git checkout <rev> -- <path>), then recompute the diff.
  // Only available on the ref-snapshot side (the worktree side is already a disk file, so no checkout is needed).
  async function checkoutFile(path: string, side: Side) {
    if (!repo) return;
    const rev = side === 'left' ? from : to;
    if (!rev || rev === WORKTREE) return;
    setError('');
    try {
      await invoke('git_checkout_file', { repo: repo.root, rev: toRev(rev), path });
      refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  // Move this working-tree file to the trash, then recompute the diff. Only available on the worktree side.
  async function deleteFile(path: string, side: Side) {
    if (!repo) return;
    const rev = side === 'left' ? from : to;
    if (rev !== WORKTREE) return;
    setError('');
    try {
      await invoke('trash_path', { path: `${repo.root}/${path}` });
      refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  // Context menu: check out to working tree (ref-snapshot side) + move to trash (worktree side).
  const menuActions = useMemo<DiffMenuAction[]>(
    () => [
      {
        key: 'checkout',
        label: t('checkoutToWorktree'),
        enabled: (_node, side) => (side === 'left' ? from : to) !== WORKTREE,
        onClick: (node, side) => void checkoutFile(node.path, side),
      },
      {
        key: 'delete',
        label: t('deleteToTrash'),
        danger: true,
        enabled: (_node, side) => (side === 'left' ? from : to) === WORKTREE,
        onClick: (node, side) => void deleteFile(node.path, side),
      },
    ],
    // checkoutFile / deleteFile depend on repo/from/to, so rebuild when those change; t for language switch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [repo, from, to, t],
  );

  const refOptions = repo
    ? [
        {
          label: t('worktree'),
          title: t('worktree'),
          options: [{ label: t('worktreeUncommitted'), value: WORKTREE }],
        },
        {
          label: t('branch'),
          title: t('branch'),
          options: repo.branches.map((b) => ({ label: b, value: b })),
        },
        {
          label: t('commit'),
          title: t('commit'),
          options: repo.commits.map((c) => ({
            label: `${c.short} ${c.subject}`,
            value: c.hash,
          })),
        },
      ]
    : [];

  // Record tree shared by both sides (synthesized once from entries).
  const records = useMemo(() => buildRecords(entries), [entries]);
  // Additional columns (size / modified): rebuilt on language change for headers + localized time.
  const columns = useMemo(() => folderColumns(td, i18n.language), [td, i18n.language]);

  // File count per side (excluding directories and placeholders that exist only on the other side).
  const counts = useMemo(() => {
    let l = 0;
    let r = 0;
    for (const e of entries) {
      if (e.is_dir) continue;
      if (e.status !== 'added') l++;
      if (e.status !== 'removed') r++;
    }
    return { left: l, right: r };
  }, [entries]);

  // Ref column-header dropdown.
  const refPicker = (side: Side, value: string | null, onChange: (v: string) => void) => (
    <div
      className={cx(
        'flex-1 basis-0 min-w-0 flex items-center gap-2 pl-3 pr-2 py-0.5 border-r border-line last:border-r-0 overflow-hidden',
        hoverSide === side && 'bg-accent-bg',
      )}
    >
      <Tooltip title={repo?.root}>
        <span className="flex items-center gap-1.5 text-[13px] font-medium whitespace-nowrap text-muted shrink-0">
          <FolderOpenOutlined />
          {repo?.root.split(/[\\/]/).pop()}
        </span>
      </Tooltip>
      <Select
        showSearch
        value={value ?? undefined}
        options={refOptions}
        onChange={onChange}
        placeholder={side === 'left' ? t('fromRef') : t('toRef')}
        className="flex-1 min-w-0 ref-picker-select"
        popupMatchSelectWidth={420}
        optionFilterProp="label"
      />
    </div>
  );

  // The table area for one side.
  const sidePane = (side: Side) => (
    <div className="flex-1 basis-0 flex flex-col min-w-0 border-r border-line last:border-r-0">
      <div className="flex-1 min-h-0 overflow-auto bg-surface">
        {entries.length === 0 ? (
          <div className="h-full flex items-center justify-center">
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={
                <div className="text-[13px] text-muted">
                  <div>{t('noDiff')}</div>
                  <div className="mt-1 text-[12px]">{t('tryOtherRefs')}</div>
                </div>
              }
            />
          </div>
        ) : (
          <DiffSideTable
            side={side}
            records={records}
            columns={columns}
            selectedPath={activePath}
            onSelect={openFile}
            menuActions={menuActions}
            scrollRegister={scrollRegister}
            expandedKeys={expandedKeys}
            onExpand={setExpandedKeys}
          />
        )}
      </div>
    </div>
  );

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
      {!repo ? (
        <div
          className="box-border flex-1 flex items-center justify-center p-6 cursor-pointer"
          onClick={pickRepo}
          role="button"
        >
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              <div className="text-[13px] text-muted">
                <div>{t('clickOrDropRepo')}</div>
              </div>
            }
          />
        </div>
      ) : (
        <>
          <div className="flex bg-panel border-b border-line [-webkit-app-region:no-drag]">
            {refPicker('left', from, setFrom)}
            {refPicker('right', to, setTo)}
          </div>
          <div className="flex-1 flex min-h-0">
            {sidePane('left')}
            {sidePane('right')}
          </div>
          <footer className="flex border-t border-line bg-panel text-xs text-muted">
            {(['left', 'right'] as Side[]).map((side) => (
              <div
                key={side}
                className="flex-1 basis-0 flex items-center justify-end px-3 py-1 border-r border-line last:border-r-0"
              >
                <span>
                  {t('common:fileCount', { count: side === 'left' ? counts.left : counts.right })}
                </span>
              </div>
            ))}
          </footer>
        </>
      )}
    </div>
  );
}
