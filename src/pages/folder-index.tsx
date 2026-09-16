/**
 * Folder comparison tree pane (the fixed tab #0 inside FolderComparePage):
 *   - Each of the left/right panes has a column header: shows the selected directory name + icon buttons to open/change the directory;
 *   - Each of the left/right panes renders the same diff records (DiffSideTable), marking diffs with color/placeholders;
 *   - The bottom shows each side's file count on the left/right;
 *   - Right-clicking a diff node pops a menu: copy to the other side, delete to trash; the diff is recomputed after the action.
 * Clicking a file node opens it as a file tab (see useFileTabs on the owning page).
 */
import { useEffect, useMemo, useState } from 'react';
import cx from 'classnames';
import { open } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { Button, Empty, Tooltip } from 'antd';
import { useTranslation } from 'react-i18next';
import { FolderOpenOutlined } from '@ant-design/icons';
import { Side } from '../diff-view';
import { DiffMenuAction, DiffSideTable, buildRecords, folderColumns } from '../diff-table';
import { useScrollSync } from '../scroll-sync';
import { useFolder } from './folder-compare';

/** Determine which half of the window the x coordinate falls in (for native drag-and-drop). */
function sideForX(x: number): Side {
  return x < window.innerWidth / 2 ? 'left' : 'right';
}

export function FolderTreePane({ active }: { active: boolean }) {
  const { t, i18n } = useTranslation(['folder', 'common']);
  // Column-header labels under the diff namespace (size/mtime/name); folderColumns needs it + the current locale.
  const { t: td } = useTranslation('diff');
  const {
    setError,
    leftDir,
    rightDir,
    entries,
    activePath,
    openFile,
    setDir,
    setDirs,
    expandedKeys,
    setExpandedKeys,
    refresh,
  } = useFolder();
  const [hoverSide, setHoverSide] = useState<Side | null>(null);
  const scrollRegister = useScrollSync();

  // Both sides share one expanded set (Beyond Compare-style linkage): expanding/collapsing a directory on either side
  // applies to both panes, keeping the row counts identical -> sync scrolling can align strictly.
  // Hoisted into the page so the expansion survives tab switches; cleared whenever a new diff is computed.

  async function pickDir(side: Side) {
    setError('');
    try {
      const selected = await open({
        multiple: false,
        directory: true,
        title: side === 'left' ? t('pickLeftDir') : t('pickRightDir'),
      });
      if (typeof selected !== 'string') return;
      await setDir(side, selected);
    } catch (e) {
      setError(String(e));
    }
  }

  // Native Tauri drag-and-drop: dragging a folder onto one half sets that side's directory.
  // Gated on `active` — the pane stays mounted while a file tab is on top, and an ungated
  // listener would react to drops made while another pane is visible.
  useEffect(() => {
    if (!active) return;
    let unlisten: (() => void) | undefined;
    getCurrentWebview()
      .onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === 'over') {
          setHoverSide(sideForX(p.position.x));
        } else if (p.type === 'drop') {
          setHoverSide(null);
          const paths = p.paths.filter(Boolean);
          if (paths.length === 0) return;
          const dropSide = sideForX(p.position.x);
          // Only accept folders; when multiple directories are dropped, assign left/right starting from the drop side.
          void (async () => {
            try {
              const kinds = await Promise.all(
                paths.map((path) => invoke<string>('path_kind', { path })),
              );
              const dirs = paths.filter((_, i) => kinds[i] === 'dir');
              if (dirs.length === 0) {
                setError(t('dropDirOnly'));
                return;
              }
              if (dirs.length >= 2) {
                // Dropping two or more directories at once: the drop side takes the first, the other side takes the second.
                await setDirs(
                  dropSide === 'left'
                    ? { left: dirs[0], right: dirs[1] }
                    : { right: dirs[0], left: dirs[1] },
                );
              } else {
                await setDir(dropSide, dirs[0]);
              }
            } catch (e) {
              setError(String(e));
            }
          })();
        } else {
          setHoverSide(null);
        }
      })
      .then((fn) => {
        unlisten = fn;
      });
    return () => unlisten?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, leftDir, rightDir]);

  // Copy a file/folder to the other side: from the `from` side -> the mirror path on the other side; recompute the diff when done.
  async function copyEntry(path: string, _isDir: boolean, from: Side) {
    if (!leftDir || !rightDir) return;
    const srcRoot = from === 'left' ? leftDir : rightDir;
    const dstRoot = from === 'left' ? rightDir : leftDir;
    setError('');
    try {
      await invoke('copy_path', {
        src: `${srcRoot}/${path}`,
        dst: `${dstRoot}/${path}`,
      });
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  // Delete a file/folder to the trash (the `from` side's path); recompute the diff when done.
  async function deleteEntry(path: string, _isDir: boolean, from: Side) {
    const root = from === 'left' ? leftDir : rightDir;
    if (!root) return;
    setError('');
    try {
      await invoke('trash_path', { path: `${root}/${path}` });
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  // Right-click menu: copy to the other side + delete to trash (available for any node that exists on this side).
  const menuActions = useMemo<DiffMenuAction[]>(
    () => [
      {
        key: 'copy',
        label: (s) => (s === 'left' ? t('copyToRight') : t('copyToLeft')),
        onClick: (node, s) => void copyEntry(node.path, node.isDir, s),
      },
      {
        key: 'delete',
        label: t('deleteToTrash'),
        danger: true,
        onClick: (node, s) => void deleteEntry(node.path, node.isDir, s),
      },
    ],
    // copyEntry / deleteEntry depend on leftDir/rightDir and are rebuilt when they change; menu text refreshes when t changes (language switch).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [leftDir, rightDir, t],
  );

  // The record tree shared by both sides (synthesized from entries once).
  const records = useMemo(() => buildRecords(entries), [entries]);
  // Additional columns (size / modified): rebuilt on language change for headers + localized time.
  const columns = useMemo(() => folderColumns(td, i18n.language), [td, i18n.language]);

  // Each side's file count (excluding directories and "exists only on the other side" placeholders).
  const counts = useMemo(() => {
    let left = 0;
    let right = 0;
    for (const e of entries) {
      if (e.is_dir) continue;
      if (e.status !== 'added') left++; // Exists on the left: equal/modified/removed
      if (e.status !== 'removed') right++; // Exists on the right: equal/modified/added
    }
    return { left, right };
  }, [entries]);

  // Column header: full directory path + open/change directory buttons (matching the file-comparison header interaction).
  const colHead = (side: Side, dir: string | null) => (
    <div
      className={cx(
        'flex-1 basis-0 flex items-center gap-1 pl-3 pr-2 py-0.5 text-xs border-r border-line last:border-r-0',
        hoverSide === side && 'bg-accent-bg',
        dir ? 'text-fg' : 'text-muted',
      )}
    >
      <Tooltip title={dir ?? undefined}>
        <span
          dir="rtl"
          className="flex-1 min-w-0 whitespace-nowrap overflow-hidden text-ellipsis text-left"
        >
          <bdi>{dir ?? (side === 'left' ? t('pickOrDropLeft') : t('pickOrDropRight'))}</bdi>
        </span>
      </Tooltip>
      <Tooltip title={dir ? t('changeDir') : t('openDir')}>
        <Button
          type="text"
          size="small"
          className="flex-none"
          icon={<FolderOpenOutlined />}
          onClick={() => pickDir(side)}
        />
      </Tooltip>
    </div>
  );

  // A side's table area: when no directory is selected, show a clickable/droppable placeholder.
  const sidePane = (side: Side, dir: string | null) => (
    <div className="flex-1 basis-0 flex flex-col min-w-0 border-r border-line last:border-r-0">
      <div className="flex-1 min-h-0 overflow-auto bg-surface">
        {!dir ? (
          <div
            className={cx(
              // box-border: preflight is excluded, so h-full + p-6 in content-box would
              // overflow the scroll container by the padding and show a phantom scrollbar.
              'box-border h-full flex items-center justify-center p-6 cursor-pointer transition-[background]',
              // Drag-over only: plain mouse hover must not recolor the empty pane.
              hoverSide === side && 'bg-accent-bg',
            )}
            onClick={() => pickDir(side)}
            role="button"
          >
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={<span className="text-[13px] text-muted">{t('clickOrDropDir')}</span>}
            />
          </div>
        ) : entries.length === 0 ? (
          <div className="h-full flex items-center justify-center">
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={
                <span className="text-[13px] text-muted">
                  {leftDir && rightDir ? t('sameContent') : t('waitOtherSide')}
                </span>
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
      {/* Left/right column headers: directory name + open-directory button. */}
      <div className="flex bg-panel border-b border-line [-webkit-app-region:no-drag]">
        {colHead('left', leftDir)}
        {colHead('right', rightDir)}
      </div>

      {/* Left/right directory tables (the header is rendered by the Table itself). */}
      <div className="flex-1 flex min-h-0">
        {sidePane('left', leftDir)}
        {sidePane('right', rightDir)}
      </div>

      {/* Bottom: each side's file count. */}
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
    </div>
  );
}
