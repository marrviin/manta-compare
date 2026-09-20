/**
 * The "two-pane diff table" for folder / Git comparison. Replaces the former FolderSideTree (antd Tree):
 * switches to antd `Table`'s tree data (`childrenColumnName` + `expandable`) + virtual scrolling,
 * to support multi-column display and future "user-defined columns".
 *
 * Design notes (following Beyond Compare-style two-pane linkage):
 *   - Each side renders its own `<DiffSideTable>`, sharing one set of `records` (synthesized from entries),
 *     one controlled `expandedKeys`, and a sync-scroll controller -> rows are strictly aligned line by line;
 *   - The "name" column is built in (expand arrow + icon + name + status color); right-clicking a row opens a context menu
 *     (copy to the other side / delete to trash); other columns are passed in via the `columns` config;
 *   - A node that doesn't exist on this side leaves the whole row empty + a placeholder background (added only on the right, removed only on the left);
 *   - Single click selects a row (files and dirs alike; Ctrl/Cmd+click toggles, Shift+click range-selects for batch actions);
 *     double click opens a file (as a tab, via `onSelect`) or toggles a directory's expansion;
 *   - Zebra striping injects a class based on the global parity of the "visible row order after expansion"; both sides share the visible order -> alignment.
 */
import { MouseEvent as ReactMouseEvent, ReactNode, useCallback, useMemo, useState } from 'react';
import cx from 'classnames';
import { Dropdown, Table } from 'antd';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { ColumnsType } from 'antd/es/table';
import type { MenuProps } from 'antd';
import { DiffEntry, EntryStatus, useContainerSize } from './diff-tree';
import { materialIconUrl, materialFolderUrl } from './material-icons';
import { Side } from './diff-view';
import { ScrollRegister } from './scroll-sync';

/** A synthesized row record: directories have `children`, leaves don't. Both sides share the same set. */
export interface DiffRecord {
  key: string;
  /** Forward-slash relative path. */
  path: string;
  name: string;
  isDir: boolean;
  status?: EntryStatus;
  leftSize?: number | null;
  rightSize?: number | null;
  leftMtime?: number | null;
  rightMtime?: number | null;
  children?: DiffRecord[];
}

/**
 * Declarative config for one column. The "name" column is built in and not in this list;
 * this configures the additional columns after the name column (size / modified / future permissions, hash, custom columns...).
 */
export interface DiffColumn {
  key: string;
  title: ReactNode;
  /** Fixed pixel width (additional columns are all fixed-width; the name column flexes to fill remaining space). */
  width: number;
  align?: 'left' | 'right';
  /** Extra class applied to the cell content span (for special layouts like left ellipsis). */
  cellClassName?: string;
  /** Given a node and the current side, return this cell's content. */
  render: (node: DiffRecord, side: Side) => ReactNode;
}

/**
 * Declarative config for one right-click menu item. Provided by each page (folder / Git) per its own semantics,
 * so {@link DiffSideTable} no longer hardcodes fixed "copy / delete" wording and logic.
 */
export interface DiffMenuAction {
  key: string;
  /**
   * Menu label; can vary by the current side (e.g. "copy to right" / "copy to left").
   * The second argument is the number of nodes the action will actually run on
   * (the multi-selection, or 1 for a single row) so callers can render "N items" labels.
   */
  label: string | ((side: Side, count: number) => string);
  /** Dangerous item (red), such as delete. */
  danger?: boolean;
  /**
   * Whether this item is available for the given node / side. Omitting it means "available if it exists on this side".
   * Returning false hides the item; if a row has no available items, no menu pops for that row.
   * For a multi-selection the action only runs on the selected nodes this returns true for.
   */
  enabled?: (node: DiffRecord, side: Side) => boolean;
  /** Called once per menu click with every eligible selected node (the table filters by exists-on-side + enabled). */
  onClick: (nodes: DiffRecord[], side: Side) => void;
}

/** Size with thousands separators; directories / missing show a placeholder dash. */
function fmtSize(size: number | null | undefined): string {
  if (size == null) return '--';
  return size.toLocaleString('en-US');
}

/** epoch seconds -> localized date-time string (follows the active UI language). */
function fmtMtime(secs: number | null | undefined, locale: string): string {
  if (secs == null) return '';
  return new Date(secs * 1000).toLocaleString(locale);
}

/**
 * Default additional columns for folder comparison: size + modified. Built as a
 * function (not a const) so the column titles resolve against the active language;
 * `locale` drives the localized mtime format. Call sites pass t + i18n.language.
 */
export function folderColumns(t: TFunction<'diff'>, locale: string): DiffColumn[] {
  return [
    {
      key: 'size',
      title: t('size'),
      width: 96,
      align: 'right',
      render: (node, side) =>
        node.isDir ? '' : fmtSize(side === 'left' ? node.leftSize : node.rightSize),
    },
    {
      key: 'mtime',
      title: t('mtime'),
      width: 208,
      align: 'right',
      cellClassName: '[direction:rtl] [unicode-bidi:plaintext]',
      render: (node, side) => fmtMtime(side === 'left' ? node.leftMtime : node.rightMtime, locale),
    },
  ];
}

/** Text color for each status (taken from styles.css tokens). */
const STATUS_CLS: Record<EntryStatus, string> = {
  added: 'text-add-fg',
  removed: 'text-remove-fg',
  modified: 'text-accent',
  renamed: 'text-warning',
  equal: '',
};

interface RawNode {
  name: string;
  path: string;
  isDir: boolean;
  status?: EntryStatus;
  leftSize?: number | null;
  rightSize?: number | null;
  leftMtime?: number | null;
  rightMtime?: number | null;
  children: Map<string, RawNode>;
}

function newNode(name: string, path: string, isDir: boolean): RawNode {
  return { name, path, isDir, children: new Map() };
}

/** Build a nested tree from the flat entry list (same synthesis rules as the old implementation). */
function buildRaw(entries: DiffEntry[]): RawNode {
  const root = newNode('', '', true);
  for (const entry of entries) {
    const segs = entry.path.split('/').filter(Boolean);
    let cur = root;
    let acc = '';
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      acc = acc ? `${acc}/${seg}` : seg;
      const last = i === segs.length - 1;
      const isDir = last ? !!entry.is_dir : true;
      let child = cur.children.get(seg);
      if (!child) {
        child = newNode(seg, acc, isDir);
        cur.children.set(seg, child);
      }
      if (last) {
        child.status = entry.status;
        child.leftSize = entry.left_size;
        child.rightSize = entry.right_size;
        child.leftMtime = entry.left_mtime;
        child.rightMtime = entry.right_mtime;
      }
      cur = child;
    }
  }
  return root;
}

/** Directories first, then within the same kind sort by name. */
function sortNodes<T extends { isDir: boolean; name: string }>(nodes: T[]): T[] {
  return nodes.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/** RawNode -> antd Table record (children recursively; leaves have no children). */
function toRecord(node: RawNode): DiffRecord {
  const kids = sortNodes([...node.children.values()]);
  return {
    key: node.path,
    path: node.path,
    name: node.name,
    isDir: node.isDir,
    status: node.status,
    leftSize: node.leftSize,
    rightSize: node.rightSize,
    leftMtime: node.leftMtime,
    rightMtime: node.rightMtime,
    children: node.isDir ? kids.map(toRecord) : undefined,
  };
}

/** Synthesize the top-level record array from entries (shared by both sides). */
export function buildRecords(entries: DiffEntry[]): DiffRecord[] {
  const root = buildRaw(entries);
  return sortNodes([...root.children.values()]).map(toRecord);
}

/** Collect all directory paths, for the parent's "expand all by default". */
export function collectDirKeys(entries: DiffEntry[]): string[] {
  const keys: string[] = [];
  const walk = (node: RawNode) => {
    for (const c of node.children.values()) {
      if (c.isDir) {
        keys.push(c.path);
        walk(c);
      }
    }
  };
  walk(buildRaw(entries));
  return keys;
}

/** Whether the node exists on the given side. */
function existsOnSide(status: EntryStatus | undefined, side: Side): boolean {
  if (!status) return true; // Synthesized intermediate directory: present on both sides
  if (status === 'added') return side === 'right';
  if (status === 'removed') return side === 'left';
  return true; // modified / renamed / equal
}

/** Whether this node (including descendants) contains any diff; used to mark intermediate directories with the modified color. */
function recordHasDiff(node: DiffRecord): boolean {
  if (node.status && node.status !== 'equal') return true;
  return !!node.children?.some(recordHasDiff);
}

/**
 * Compute parity (0/1) for each path by "visible row order after expansion", for zebra striping. Under virtual
 * scrolling `:nth-child` drifts as you scroll, so parity is injected explicitly by global visible order. Both sides
 * share the same records + expandedKeys -> identical visible order -> left/right zebra alignment.
 */
function visibleParity(records: DiffRecord[], expandedKeys: string[]): Map<string, number> {
  const expanded = new Set(expandedKeys);
  const parity = new Map<string, number>();
  let seq = 0;
  const walk = (nodes: DiffRecord[]) => {
    for (const n of nodes) {
      parity.set(n.path, seq++ % 2);
      if (n.isDir && n.children && expanded.has(n.path)) walk(n.children);
    }
  };
  walk(records);
  return parity;
}

/**
 * Collect the visible rows (including directories) in "expanded row order", shared by
 * zebra parity and Shift-range multi-selection. Both sides share records + expandedKeys
 * -> identical order.
 */
function visibleRows(records: DiffRecord[], expandedKeys: string[]): DiffRecord[] {
  const expanded = new Set(expandedKeys);
  const out: DiffRecord[] = [];
  const walk = (nodes: DiffRecord[]) => {
    for (const n of nodes) {
      out.push(n);
      if (n.isDir && n.children && expanded.has(n.path)) walk(n.children);
    }
  };
  walk(records);
  return out;
}

function iconImg(url: string) {
  return (
    <img
      className="w-4 h-4 object-contain select-none"
      src={url}
      alt=""
      aria-hidden
      draggable={false}
    />
  );
}

export function DiffSideTable({
  side,
  records,
  columns,
  selectedPath,
  onSelect,
  menuActions,
  scrollRegister,
  expandedKeys,
  onExpand,
}: {
  side: Side;
  /** Records synthesized by {@link buildRecords} (both sides pass the same set). */
  records: DiffRecord[];
  /** Config for the additional columns after the name column. */
  columns: DiffColumn[];
  selectedPath: string | null;
  /** Double click on a file node (only when it exists on this side): opens it (e.g. as a file tab). */
  onSelect: (path: string) => void;
  /** Right-click menu items (each page provides them per its own semantics). Omitting / an empty array means no menu. */
  menuActions?: DiffMenuAction[];
  /** Registration function for two-pane sync scrolling (registers this pane's virtual-list scroll container). */
  scrollRegister?: ScrollRegister;
  /** Controlled expanded directory keys (shared by both sides). */
  expandedKeys: string[];
  /** Bubble up the new set on expand/collapse (both sides stay in sync). */
  onExpand: (keys: string[]) => void;
}) {
  const { t } = useTranslation('diff');
  const [sizeRef, { width, height }] = useContainerSize();

  const parity = useMemo(() => visibleParity(records, expandedKeys), [records, expandedKeys]);

  // Name column flexes: container width - total additional-column width (keep a minimum to avoid 0).
  const trailingWidth = useMemo(() => columns.reduce((sum, c) => sum + c.width, 0), [columns]);
  const nameWidth = Math.max(200, (width || 480) - trailingWidth);

  const tableColumns = useMemo<ColumnsType<DiffRecord>>(() => {
    const nameCol = {
      key: '__name__',
      title: t('name'),
      dataIndex: 'name',
      width: nameWidth,
      ellipsis: true,
      render: (_: unknown, node: DiffRecord) => {
        const present = existsOnSide(node.status, side);
        if (!present) {
          // Doesn't exist on this side: leave the name column empty (the whole-row placeholder background comes from rowClassName).
          return <span className="block w-full h-full" />;
        }
        // Directory diff color is derived from whether it contains diffs; files use their own status.
        const status: EntryStatus | undefined = node.isDir
          ? recordHasDiff(node)
            ? 'modified'
            : 'equal'
          : node.status;
        const cls = status ? STATUS_CLS[status] : '';
        const url = node.isDir ? materialFolderUrl(node.name) : materialIconUrl(node.name);
        return (
          <span className={cx('flex items-center gap-1.5 min-w-0 whitespace-nowrap', cls)}>
            {iconImg(url)}
            <span className="truncate">{node.name}</span>
          </span>
        );
      },
    };

    const extra = columns.map((col) => ({
      key: col.key,
      title: col.title,
      width: col.width,
      align: col.align,
      render: (_: unknown, node: DiffRecord) => {
        // Doesn't exist on this side: leave this column empty (whole-row placeholder).
        if (!existsOnSide(node.status, side)) return null;
        return (
          <span
            className={cx(
              'block tabular-nums text-muted whitespace-nowrap overflow-hidden',
              col.cellClassName,
            )}
          >
            {col.render(node, side)}
          </span>
        );
      },
    }));

    return [nameCol, ...extra];
  }, [columns, side, nameWidth, t]);

  // Right-click menu: record the right-clicked node and viewport coordinates; use controlled open + an anchor positioned at the cursor.
  const [ctx, setCtx] = useState<{ record: DiffRecord; x: number; y: number } | null>(null);

  // Multi-selection (for batch right-click actions), internal to the table: Ctrl/Cmd toggles rows,
  // Shift selects a visible-order range from the anchor row, plain click collapses to one row.
  // Cleared whenever records change (new diff / refresh invalidates the old paths) — reset during
  // render (the React-recommended "adjust state when props change" pattern, no effect needed).
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [prevRecords, setPrevRecords] = useState(records);
  if (prevRecords !== records) {
    setPrevRecords(records);
    setSelected(new Set());
    setAnchor(null);
  }

  // Selected rows in visible order (rows absent on this side can never be selected).
  const selectedRecords = useMemo(
    () => visibleRows(records, expandedKeys).filter((n) => selected.has(n.path)),
    [records, expandedKeys, selected],
  );

  // The node set the open menu acts on: the whole selection when the right-clicked row is
  // part of it, otherwise just that row (right-clicking outside the selection shrinks it).
  const ctxNodes = useMemo<DiffRecord[]>(() => {
    const record = ctx?.record;
    if (!record) return [];
    if (selected.has(record.path) && selectedRecords.some((n) => n.path === record.path)) {
      return selectedRecords;
    }
    return [record];
  }, [ctx, selected, selectedRecords]);

  // For a given node, filter out the available menu items (exists on this side + passes action.enabled).
  const actionsFor = useCallback(
    (record: DiffRecord): DiffMenuAction[] => {
      if (!menuActions || !existsOnSide(record.status, side)) return [];
      return menuActions.filter((a) => (a.enabled ? a.enabled(record, side) : true));
    },
    [menuActions, side],
  );

  // Per action: the selected nodes it will actually run on (exists-on-side rows passing enabled).
  const eligibleFor = useCallback(
    (a: DiffMenuAction): DiffRecord[] =>
      ctxNodes.filter(
        (n) => existsOnSide(n.status, side) && (a.enabled ? a.enabled(n, side) : true),
      ),
    [ctxNodes, side],
  );

  const menuItems = useMemo<MenuProps['items']>(() => {
    if (!ctx || !menuActions) return [];
    return menuActions
      .map((a) => ({ action: a, nodes: eligibleFor(a) }))
      .filter(({ nodes }) => nodes.length > 0)
      .map(({ action, nodes }) => ({
        key: action.key,
        label: typeof action.label === 'function' ? action.label(side, nodes.length) : action.label,
        danger: action.danger,
      }));
  }, [ctx, menuActions, eligibleFor, side]);

  const onMenuClick = useCallback<NonNullable<MenuProps['onClick']>>(
    ({ key }) => {
      const action = menuActions?.find((a) => a.key === key);
      const nodes = action ? eligibleFor(action) : [];
      setCtx(null);
      if (action && nodes.length > 0) action.onClick(nodes, side);
    },
    [menuActions, eligibleFor, side],
  );

  // Plain click on a row (file or dir): collapse the selection to that row and remember the
  // Shift-range anchor. Opening (files) / expanding (dirs) happens on double click instead.
  const onRowClick = useCallback(
    (record: DiffRecord, e: ReactMouseEvent) => {
      if (!existsOnSide(record.status, side)) return;
      if (e.shiftKey && anchor) {
        // Range select between the anchor and the clicked row, in visible row order.
        const order = visibleRows(records, expandedKeys);
        const a = order.findIndex((n) => n.path === anchor);
        const b = order.findIndex((n) => n.path === record.path);
        if (a !== -1 && b !== -1) {
          const [lo, hi] = a < b ? [a, b] : [b, a];
          setSelected(
            new Set(
              order
                .slice(lo, hi + 1)
                .filter((n) => existsOnSide(n.status, side))
                .map((n) => n.path),
            ),
          );
          window.getSelection()?.removeAllRanges();
          return;
        }
      }
      if (e.metaKey || e.ctrlKey) {
        // Toggle the row in the selection (files and dirs alike).
        setSelected((prev) => {
          const next = new Set(prev);
          if (next.has(record.path)) next.delete(record.path);
          else next.add(record.path);
          return next;
        });
        setAnchor(record.path);
        window.getSelection()?.removeAllRanges();
        return;
      }
      setAnchor(record.path);
      setSelected(new Set([record.path]));
    },
    [side, anchor, records, expandedKeys],
  );

  // Double click: a file opens (via onSelect), a directory toggles its expansion (replacing the
  // former expandRowByClick single-click toggling). Dblclick also selects text — clear it.
  const onRowDoubleClick = useCallback(
    (record: DiffRecord) => {
      if (!existsOnSide(record.status, side)) return;
      window.getSelection()?.removeAllRanges();
      if (record.isDir) {
        const expanded = expandedKeys.includes(record.path);
        onExpand(
          expanded ? expandedKeys.filter((k) => k !== record.path) : [...expandedKeys, record.path],
        );
      } else {
        setSelected(new Set([record.path]));
        onSelect(record.path);
      }
    },
    [side, expandedKeys, onExpand, onSelect],
  );

  const onRowContextMenu = useCallback(
    (record: DiffRecord, e: ReactMouseEvent) => {
      // If the row has no available items, don't pop (placeholder row / all disabled).
      if (actionsFor(record).length === 0) {
        setCtx(null);
        return;
      }
      e.preventDefault();
      // Clear the text selection created by the right-click, so the file name isn't highlighted as selected.
      window.getSelection()?.removeAllRanges();
      // Right-clicking outside the selection collapses it to that row; inside, the whole selection is kept.
      setSelected((prev) => (prev.has(record.path) ? prev : new Set([record.path])));
      setAnchor(record.path);
      setCtx({ record, x: e.clientX, y: e.clientY });
    },
    [actionsFor],
  );

  // Merged ref: the container needs both size measurement (virtual scroll + name column width) and registration into sync scrolling.
  const setRef = useCallback(
    (el: HTMLDivElement | null) => {
      sizeRef.current = el;
      return scrollRegister?.(el);
    },
    [sizeRef, scrollRegister],
  );

  const menuEnabled = (menuActions?.length ?? 0) > 0;

  return (
    <div ref={setRef} className="diff-side-table h-full">
      {/* Controlled context menu: anchor positioned at the right-click point (fixed viewport coords), then Dropdown pops next to it. */}
      <Dropdown
        open={!!ctx && (menuItems?.length ?? 0) > 0}
        onOpenChange={(open) => {
          if (!open) setCtx(null);
        }}
        menu={{ items: menuItems, onClick: onMenuClick }}
      >
        <div
          style={{
            position: 'fixed',
            left: ctx?.x ?? 0,
            top: ctx?.y ?? 0,
            width: 1,
            height: 1,
            pointerEvents: 'none',
          }}
        />
      </Dropdown>
      <Table<DiffRecord>
        size="small"
        virtual
        pagination={false}
        showSorterTooltip={false}
        dataSource={records}
        columns={tableColumns}
        rowKey="path"
        // A numeric y enables virtual scrolling; x matches the container width to avoid extra horizontal scrolling.
        scroll={{ y: height || 400, x: width || undefined }}
        expandable={{
          expandedRowKeys: expandedKeys,
          onExpandedRowsChange: (keys) => onExpand([...keys] as string[]),
          // Row clicks only select; expansion is via the arrow or a double click on the row.
          expandRowByClick: false,
        }}
        rowClassName={(record) => {
          const zebra = parity.get(record.path) === 1 ? 'zebra-odd' : 'zebra-even';
          const absent = existsOnSide(record.status, side) ? '' : 'diff-row-absent';
          const highlighted =
            record.path === selectedPath || selected.has(record.path) ? 'diff-row-selected' : '';
          // select-none: single click selects the row, double click opens it — neither should
          // drag-select the cell text (name / size / mtime).
          return cx('select-none', zebra, absent, highlighted);
        }}
        onRow={(record) => ({
          onClick: (e: ReactMouseEvent) => onRowClick(record, e),
          onDoubleClick: () => onRowDoubleClick(record),
          onContextMenu: menuEnabled
            ? (e: ReactMouseEvent) => onRowContextMenu(record, e)
            : undefined,
        })}
        className="text-[13px]"
      />
    </div>
  );
}
