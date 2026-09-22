/**
 * Text (two-file) comparison route. Picks files (or receives dropped/replayed
 * paths through router state) and renders the shared DiffPanel. All text-compare
 * state (files, working copies, hover) lives here now that it is its own route.
 *
 * The header uses the same Chrome-style tab strip as folder/git compare, with a
 * single closable tab standing for the current comparison (its label tracks the
 * picked file pair, plus the unsaved-changes dot); closing it returns home.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { Button, Divider, Space, Tooltip } from 'antd';
import { useTranslation } from 'react-i18next';
import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  ReloadOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import { DiffPanel, DiffPanelHandle, FileContent, LoadedFile, Side, basename } from '../diff-view';
import { AppHeader } from '../app-header';
import { TabBar, type TabBarTab } from '../tab-bar';
import { useShell } from '../layout';
import { useFileWatch } from '../use-file-watch';
import { useUnsavedGuard } from '../use-unsaved-guard';
import { materialIconUrl, materialIconUrlByName } from '../material-icons';

/** Key of the page's single, unclosable comparison tab. */
const TEXT_TAB_KEY = '__text__';

/** Which pane an x-coordinate falls into (window midline split). */
function sideForX(x: number): Side {
  return x < window.innerWidth / 2 ? 'left' : 'right';
}

/** Router state accepted by this route (dropped or replayed file pair). */
interface TextCompareState {
  left?: string;
  right?: string;
}

export function TextComparePage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { t } = useTranslation(['diff', 'common', 'layout']);
  const { setError, pushRecent, siderCollapsed, onExpandSider } = useShell();

  const [left, setLeft] = useState<LoadedFile | null>(null);
  const [right, setRight] = useState<LoadedFile | null>(null);
  // Working copies of each side's text — seeded from the file, edited by copy actions.
  const [leftContent, setLeftContent] = useState('');
  const [rightContent, setRightContent] = useState('');
  const [hoverSide, setHoverSide] = useState<Side | null>(null);

  async function loadFile(side: Side, path: string): Promise<boolean> {
    setError('');
    try {
      const meta = await invoke<FileContent>('read_text_file', { path });
      const loaded: LoadedFile = { path, meta };
      if (side === 'left') {
        setLeft(loaded);
        setLeftContent(meta.content);
      } else {
        setRight(loaded);
        setRightContent(meta.content);
      }
      return true;
    } catch (e) {
      setError(String(e));
      return false;
    }
  }

  // Consume router state on each navigation: load dropped/replayed paths. Keyed
  // on location.key so re-selecting the same pair from the sidebar reloads it
  // (a fresh navigation always yields a new key, even for identical state).
  useEffect(() => {
    const state = location.state as TextCompareState | null;
    if (!state) return;
    if (state.left && state.right) {
      void Promise.all([loadFile('left', state.left), loadFile('right', state.right)]);
    } else if (state.left) {
      void loadFile('left', state.left);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.key]);

  async function pickFile(side: Side) {
    setError('');
    try {
      const selected = await open({
        multiple: false,
        directory: false,
        title: side === 'left' ? t('pickLeftFile') : t('pickRightFile'),
      });
      if (typeof selected !== 'string') return;
      await loadFile(side, selected);
    } catch (e) {
      setError(String(e));
    }
  }

  // Native Tauri drag-drop: HTML5 ondrop cannot expose real file paths, so we
  // listen to the webview's drag-drop events. One file loads the hovered side;
  // two or more are split across the panes (drop side takes the first, like the
  // folder/git pages) — a dropped pair therefore completes a comparison and gets
  // recorded into the recent list by the history effect below.
  useEffect(() => {
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
          const side = sideForX(p.position.x);
          const other = side === 'left' ? 'right' : 'left';
          // Directories can't go into a text comparison; only files are accepted.
          void (async () => {
            try {
              const kinds = await Promise.all(
                paths.map((path) => invoke<string>('path_kind', { path })),
              );
              const files = paths.filter((_, i) => kinds[i] === 'file');
              if (files.length === 0) {
                setError(t('dropFolderUseFolder'));
                return;
              }
              if (files.length >= 2) {
                await Promise.all([loadFile(side, files[0]), loadFile(other, files[1])]);
              } else {
                await loadFile(side, files[0]);
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
  }, []);

  const baseNotice = useMemo(() => {
    for (const f of [left, right]) {
      if (!f) continue;
      if (f.meta.is_binary) return t('binaryFile', { name: basename(f.path) });
      if (f.meta.truncated) return t('oversized', { name: basename(f.path) });
    }
    return '';
  }, [left, right, t]);

  // As long as one side is selected and readable, enter the diff view; the unselected/missing
  // side is treated as empty content, so the selected side shows entirely as added or removed,
  // while the unselected side's column header can still pick or drop a file.
  const leftOk = !!left && !left.meta.is_binary && !left.meta.truncated;
  const rightOk = !!right && !right.meta.is_binary && !right.meta.truncated;
  // With no file picked on either side, still enter the diff view: both sides start as empty,
  // editable Monaco panes so the user can type or paste content to compare directly. The empty
  // pick state only appears when a loaded file blocks diffing (binary / oversized).
  const canDiff =
    (leftOk || rightOk || (!left && !right)) && !(left && !leftOk) && !(right && !rightOk);

  // Record history when both sides are selected and readable — covers the case of picking each file separately.
  useEffect(() => {
    if (left && right && leftOk && rightOk) {
      pushRecent(left.path, right.path);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [left?.path, right?.path, leftOk, rightOk]);

  const diffPanelRef = useRef<DiffPanelHandle>(null);

  const leftDirty = !!left && leftContent !== left.meta.content;
  const rightDirty = !!right && rightContent !== right.meta.content;

  // Intercept route navigation when there are unsaved edits (controlled by a settings toggle).
  useUnsavedGuard(leftDirty || rightDirty);

  // External change watch: silently reload the side when not dirty, or set a conflict flag when dirty (shown by the notice below).
  const leftWatch = useFileWatch({
    path: leftOk ? (left?.path ?? null) : null,
    dirty: leftDirty,
    onReload: () => left && void loadFile('left', left.path),
  });
  const rightWatch = useFileWatch({
    path: rightOk ? (right?.path ?? null) : null,
    dirty: rightDirty,
    onReload: () => right && void loadFile('right', right.path),
  });

  // The external-change conflict message takes priority over the ordinary notice (binary / oversized).
  const notice = leftWatch.externallyChanged
    ? t('leftChangedExternally')
    : rightWatch.externallyChanged
      ? t('rightChangedExternally')
      : baseNotice;

  // Edits bubbled up from within MergeView: update the corresponding side's working copy.
  function onChange(side: Side, text: string) {
    if (side === 'left') setLeftContent(text);
    else setRightContent(text);
  }

  // Write a side's working copy back to its original file path.
  async function saveFile(side: Side) {
    const file = side === 'left' ? left : right;
    if (!file) return;
    const content = side === 'left' ? leftContent : rightContent;
    setError('');
    try {
      const modified = await invoke<number | null>('write_text_file', {
        path: file.path,
        content,
      });
      const nextMeta: FileContent = {
        ...file.meta,
        content,
        size: new TextEncoder().encode(content).length,
        modified,
      };
      const updated: LoadedFile = { ...file, meta: nextMeta };
      if (side === 'left') setLeft(updated);
      else setRight(updated);
    } catch (e) {
      setError(String(e));
    }
  }

  // Reload both files and clear the external-change notice — reused by the top header refresh button and DiffPanel.
  function reloadAll() {
    if (left) void loadFile('left', left.path);
    if (right) void loadFile('right', right.path);
    leftWatch.dismiss();
    rightWatch.dismiss();
  }

  // The single comparison tab: label tracks the picked pair ("a ⇄ b"), falling
  // back to one side's name and finally the mode label while empty. It is also
  // the page's last tab: closing it leaves for home (unsaved edits are confirmed
  // by useUnsavedGuard on the route change).
  const tabBarTabs = useMemo<TabBarTab[]>(() => {
    const label =
      left && right
        ? `${basename(left.path)} ⇄ ${basename(right.path)}`
        : left
          ? basename(left.path)
          : right
            ? basename(right.path)
            : t('layout:textCompare');
    return [
      {
        key: TEXT_TAB_KEY,
        label,
        iconUrl: left
          ? materialIconUrl(basename(left.path))
          : right
            ? materialIconUrl(basename(right.path))
            : materialIconUrlByName('document'),
        title: left && right ? `${left.path} ⇄ ${right.path}` : (left?.path ?? right?.path),
        closable: true,
        dirty: leftDirty || rightDirty,
      },
    ];
  }, [left, right, leftDirty, rightDirty, t]);

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
      <AppHeader
        siderCollapsed={siderCollapsed}
        onExpandSider={onExpandSider}
        tabs={
          <TabBar
            tabs={tabBarTabs}
            activeKey={TEXT_TAB_KEY}
            onSelect={() => {}}
            onClose={() => navigate('/')}
          />
        }
        right={
          <Space size="small">
            {canDiff && (
              <>
                <Tooltip title={t('common:prevDiff')}>
                  <Button
                    type="text"
                    size="small"
                    icon={<ArrowUpOutlined />}
                    onClick={() => diffPanelRef.current?.goPrev()}
                  />
                </Tooltip>
                <Tooltip title={t('common:nextDiff')}>
                  <Button
                    type="text"
                    size="small"
                    icon={<ArrowDownOutlined />}
                    onClick={() => diffPanelRef.current?.goNext()}
                  />
                </Tooltip>
                <Tooltip title={t('common:findReplace')}>
                  <Button
                    type="text"
                    size="small"
                    icon={<SearchOutlined />}
                    onClick={() => diffPanelRef.current?.toggleSearch()}
                  />
                </Tooltip>
                <Divider vertical className="mx-0.5" />
              </>
            )}
            {/* Refresh stays visible even with no file loaded, just disabled — keeps the
                header button row from shifting when the first file gets picked. */}
            <Tooltip title={t('common:refresh')}>
              <Button
                type="text"
                size="small"
                icon={<ReloadOutlined />}
                disabled={!left && !right}
                onClick={reloadAll}
              />
            </Tooltip>
          </Space>
        }
      />

      <DiffPanel
        ref={diffPanelRef}
        showGlobalActions={false}
        left={left}
        right={right}
        leftContent={leftContent}
        rightContent={rightContent}
        notice={notice}
        canDiff={canDiff}
        hoverSide={hoverSide}
        onPick={pickFile}
        onChange={onChange}
        onSave={saveFile}
        showStatsInFooter
        onReload={reloadAll}
        showReload={false}
        leftDirty={leftDirty}
        rightDirty={rightDirty}
        emptyMode="pick"
      />
    </div>
  );
}
