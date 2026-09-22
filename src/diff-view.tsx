/**
 * Shared side-by-side diff panel. The scrolling body is a Monaco DiffEditor
 * (see monaco-panel.tsx); this module owns the surrounding chrome that all three
 * comparison modes share: column headers (label + pick/save/reload + jump-to-diff
 * buttons), the warning banner, empty states, and the footer status bars.
 *
 * Per-side read-only control lives here (git ref snapshots pass readonly). The
 * pages hold the authoritative left/right text and pass it down; edits and diff
 * stats bubble back up through onChange/onStats.
 */
import { forwardRef, useImperativeHandle, useRef, useState, type Ref } from 'react';
import cx from 'classnames';
import { Alert, Button, Divider, Empty, Tag, Tooltip } from 'antd';
import { useTranslation } from 'react-i18next';
import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  FolderOpenOutlined,
  SaveOutlined,
  SearchOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import { MonacoPanel, type MergePanelHandle } from './monaco-panel';
import { SearchPopup } from './search-popup';
import { useSettings } from './settings';

export interface FileContent {
  content: string;
  is_binary: boolean;
  size: number;
  encoding: string;
  truncated: boolean;
  modified: number | null;
}

export interface LoadedFile {
  path: string;
  meta: FileContent;
  /** Display label override (e.g. a git ref path); falls back to basename(path). */
  label?: string;
}

export type Side = 'left' | 'right';

/** Global actions DiffPanel exposes for the parent to call (e.g. hoisting buttons into the page header). */
export interface DiffPanelHandle {
  goPrev: () => void;
  goNext: () => void;
  toggleSearch: () => void;
}

export function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/** File extension (upper-cased, no dot). Empty when there is no extension; the caller labels that case. */
export function fileExt(p: string): string {
  const name = basename(p);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toUpperCase() : '';
}

/** Human-readable byte size, e.g. 1536 -> "1.5 KB". */
export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = size / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

/** Format a Unix ms timestamp as a local date-time string. */
export function formatTime(ms: number | null): string {
  if (ms == null) return '—';
  return new Date(ms).toLocaleString();
}

/**
 * Reusable side-by-side diff panel: column headers, the MergeView diff body, and
 * the footer status bars.
 *
 * Editing is opt-in per side. `onSave` enables the save button; `onChange`
 * receives edits from the writable side(s). `leftReadonly`/`rightReadonly`
 * suppress writes into that side (git ref snapshots pass readonly). `onPick`
 * makes the column header act as a file picker (text compare); folder/git omit
 * it and show plain labels.
 */
export interface DiffPanelProps {
  left: LoadedFile | null;
  right: LoadedFile | null;
  leftContent: string;
  rightContent: string;
  notice?: string;
  canDiff: boolean;
  hoverSide?: Side | null;
  onPick?: (side: Side) => void;
  onChange?: (side: Side, text: string) => void;
  onStats?: (stats: { added: number; removed: number }) => void;
  onSave?: (side: Side) => void;
  onReload?: () => void;
  leftDirty?: boolean;
  rightDirty?: boolean;
  leftReadonly?: boolean;
  rightReadonly?: boolean;
  emptyMode?: 'pick' | 'hint';
  /** Whether to render the jump/search buttons inside the right column header; when false, the parent (page header) hosts them. */
  showGlobalActions?: boolean;
  /** Whether to render the reload button inside the column header; when false, the parent (page header) hosts it. */
  showReload?: boolean;
  /** Whether to render the per-side diff stats (-removed / +added) in the footer status bars instead of the page header. */
  showStatsInFooter?: boolean;
}

function DiffPanelInner(
  {
    left,
    right,
    leftContent,
    rightContent,
    notice,
    canDiff,
    hoverSide = null,
    onPick,
    onChange,
    onStats,
    onSave,
    onReload,
    leftDirty = false,
    rightDirty = false,
    leftReadonly = false,
    rightReadonly = false,
    emptyMode = 'hint',
    showGlobalActions = true,
    showReload = true,
    showStatsInFooter = false,
  }: DiffPanelProps,
  ref: Ref<DiffPanelHandle>,
) {
  const mergeRef = useRef<MergePanelHandle>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [footerStats, setFooterStats] = useState({ added: 0, removed: 0 });
  const handleStats = (next: { added: number; removed: number }) => {
    setFooterStats(next);
    onStats?.(next);
  };
  const { settings } = useSettings();
  const { t } = useTranslation(['diff', 'common']);
  // Left column width ratio: reported by Monaco from the actual sash position (including
  // minimap/scrollbar/overview-ruler width), used to strictly align the header/footer left
  // column with the editor's center split line. Defaults to 0.5, corrected after layout.
  const [leftRatio, setLeftRatio] = useState(0.5);
  useImperativeHandle(
    ref,
    () => ({
      goPrev: () => mergeRef.current?.goPrev(),
      goNext: () => mergeRef.current?.goNext(),
      toggleSearch: () => setSearchOpen((s) => !s),
    }),
    [],
  );

  const label = (side: Side, file: LoadedFile | null): string => {
    if (file) return file.label ?? file.path;
    return side === 'left' ? t('pickLeftFile') : t('pickRightFile');
  };

  // Per-side column header: file name (clickable) + open + save. No undo/redo buttons; those
  // rely on Monaco's native shortcuts. Cross-side global actions like jump/search are
  // consolidated in the right column header (see globalActions).
  const colHead = (side: Side, file: LoadedFile | null, trailing?: React.ReactNode) => {
    const dirty = side === 'left' ? leftDirty : rightDirty;
    const readonly = side === 'left' ? leftReadonly : rightReadonly;
    return (
      <div
        className={cx(
          'min-w-0 flex items-center gap-1 pl-3 pr-2 py-0.5 text-xs border-r border-line last:border-r-0',
          hoverSide === side && 'bg-accent-bg',
          file ? 'text-fg' : 'text-muted',
        )}
        style={{ flex: `${side === 'left' ? leftRatio : 1 - leftRatio} 0 0` }}
      >
        <Tooltip title={file?.path}>
          <span
            dir="rtl"
            className={cx(
              'flex-1 min-w-0 whitespace-nowrap overflow-hidden text-ellipsis text-left',
              onPick && 'cursor-pointer',
            )}
            onClick={onPick ? () => onPick(side) : undefined}
          >
            {/* dir=rtl makes the ellipsis appear on the left, wrapping the content in LRM (‎)
                to preserve the path's own left-to-right reading order, avoiding the left ellipsis
                breaking when <bdi>/<span dir=ltr> isolate the direction. */}
            {'‎' + label(side, file) + '‎'}
          </span>
        </Tooltip>
        {onPick && (
          <Tooltip title={t('openFile')}>
            <Button
              type="text"
              size="small"
              className="flex-none"
              icon={<FolderOpenOutlined />}
              onClick={(e) => {
                e.stopPropagation();
                onPick(side);
              }}
            />
          </Tooltip>
        )}
        {file && onSave && !readonly && (
          <Tooltip title={dirty ? t('saveChanges') : t('noChanges')}>
            <Button
              type="text"
              size="small"
              className="flex-none"
              icon={<SaveOutlined />}
              disabled={!dirty}
              onClick={(e) => {
                e.stopPropagation();
                onSave(side);
              }}
            />
          </Tooltip>
        )}
        {onReload && showReload && (
          <Tooltip title={t('common:refresh')}>
            <Button
              type="text"
              size="small"
              className="flex-none"
              icon={<ReloadOutlined />}
              onClick={(e) => {
                e.stopPropagation();
                onReload();
              }}
            />
          </Tooltip>
        )}
        {trailing}
      </div>
    );
  };

  // No undo/redo buttons: the Monaco editor natively supports Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z,
  // which take effect when the corresponding side is focused (each side has its own undo stack).

  // Global actions (jump to diff / search): cross-side semantics, consolidated as one copy in the
  // right column header. Jump moves between the two sides and search uses a single popup (duplicating
  // a popup per side would be odd), so these aren't split per side.
  // editable: whether a writable side exists (when both sides are read-only, the search popup hides the replace area).
  const editable = !(leftReadonly && rightReadonly);
  const globalActions =
    canDiff && showGlobalActions ? (
      <>
        <Divider vertical className="mx-0.5" />
        <Tooltip title={t('common:prevDiff')}>
          <Button
            type="text"
            size="small"
            className="flex-none"
            icon={<ArrowUpOutlined />}
            onClick={() => mergeRef.current?.goPrev()}
          />
        </Tooltip>
        <Tooltip title={t('common:nextDiff')}>
          <Button
            type="text"
            size="small"
            className="flex-none"
            icon={<ArrowDownOutlined />}
            onClick={() => mergeRef.current?.goNext()}
          />
        </Tooltip>
        <Tooltip title={t('common:findReplace')}>
          <Button
            type="text"
            size="small"
            className="flex-none"
            icon={<SearchOutlined />}
            onClick={() => setSearchOpen((s) => !s)}
          />
        </Tooltip>
      </>
    ) : null;

  const statusBar = (side: Side, file: LoadedFile | null) => (
    <div
      className="flex items-center justify-between gap-4 px-3 py-1 border-r border-line last:border-r-0 whitespace-nowrap overflow-hidden"
      style={{ flex: `${side === 'left' ? leftRatio : 1 - leftRatio} 0 0` }}
    >
      {showStatsInFooter && canDiff ? (
        <Tag color={side === 'left' ? 'error' : 'success'} className="me-0">
          {side === 'left' ? `-${footerStats.removed}` : `+${footerStats.added}`}
        </Tag>
      ) : (
        <span />
      )}
      <div className="flex items-center gap-4 overflow-hidden [&>span]:overflow-hidden [&>span]:text-ellipsis">
        {file ? (
          <>
            <span title={t('lastModified')}>{formatTime(file.meta.modified)}</span>
            <span title={t('bytes')}>{formatBytes(file.meta.size)}</span>
            <span title={t('fileType')}>{fileExt(file.path) || t('noExtension')}</span>
            <span title={t('encoding')}>{file.meta.encoding || '—'}</span>
          </>
        ) : (
          <span className="text-muted">{t('noFileSelected')}</span>
        )}
      </div>
    </div>
  );

  return (
    <div className="relative flex-1 flex flex-col overflow-hidden">
      {notice && <Alert type="warning" message={notice} banner showIcon />}
      <div className="flex bg-panel border-b border-line">
        {colHead('left', left)}
        {colHead('right', right, globalActions)}
      </div>
      {canDiff ? (
        <div className="flex-1 flex min-h-0">
          <MonacoPanel
            leftContent={leftContent}
            rightContent={rightContent}
            leftPath={left?.path}
            rightPath={right?.path}
            leftReadonly={leftReadonly}
            rightReadonly={rightReadonly}
            ignoreWhitespace={settings.ignoreWhitespace}
            onChange={onChange}
            onStats={handleStats}
            onSplit={setLeftRatio}
            handleRef={mergeRef}
          />
        </div>
      ) : emptyMode === 'pick' ? (
        <div className="flex-1 flex min-h-0">
          {(['left', 'right'] as Side[]).map((side) => {
            const file = side === 'left' ? left : right;
            return (
              <div
                key={side}
                className={cx(
                  // box-border: preflight is excluded; without it p-6 adds to the flexed
                  // size and the row overflows horizontally by the padding.
                  'box-border flex-1 basis-0 flex items-center justify-center p-6 border-r border-line last:border-r-0 cursor-pointer transition-[background]',
                  // Drag-over only: plain mouse hover must not recolor the empty pane.
                  hoverSide === side && 'bg-accent-bg',
                )}
                onClick={onPick ? () => onPick(side) : undefined}
                role="button"
              >
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description={
                    <span className="text-[13px] text-muted">
                      {file ? basename(file.path) : t('dropOrClickFile')}
                    </span>
                  }
                />
              </div>
            );
          })}
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center p-6">
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              <span className="text-[13px] text-muted">
                {left || right ? t('cannotDiffOrNoDiff') : t('selectFromList')}
              </span>
            }
          />
        </div>
      )}
      <footer className="flex border-t border-line bg-panel text-xs text-muted">
        {statusBar('left', left)}
        {statusBar('right', right)}
      </footer>

      <SearchPopup
        open={searchOpen && canDiff}
        onClose={() => setSearchOpen(false)}
        target={mergeRef}
        replaceDisabled={!editable}
      />
    </div>
  );
}

export const DiffPanel = forwardRef<DiffPanelHandle, DiffPanelProps>(DiffPanelInner);
