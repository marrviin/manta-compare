/**
 * Beyond-Compare-style file tabs shared by the folder/git compare pages.
 *
 * Tab #0 is always the (implicit, unclosable) directory tree; each opened file
 * gets one additional tab keyed by its relative path. The active tab is
 * mirrored in the URL as the `file` search param (`/folder-compare?file=…`),
 * so the browser back button walks through tabs while route leaves (pathname
 * changes) still hit useUnsavedGuard — search-only switches pass its
 * `pathname !== pathname` predicate untouched, which is correct because every
 * pane stays mounted and nothing is lost when switching.
 *
 * Also owns the tab keyboard shortcuts (registered on window in the capture
 * phase so they fire even while Monaco has focus):
 *   Ctrl/Cmd+Tab, Ctrl/Cmd+Shift+Tab — cycle next/prev (macOS: use plain
 *   Ctrl+Tab; Cmd+Tab is swallowed by the OS app switcher)
 *   Ctrl/Cmd+1..9 — jump to tab index (1 = the tree tab)
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Modal } from 'antd';
import { useTranslation } from 'react-i18next';
import { useSettings } from './settings';

/** Key of the implicit, always-first, unclosable directory-tree tab. */
export const TREE_TAB_KEY = '__tree__';

export interface FileTabsApi {
  /** Open file tabs (relative paths), in open order. The tree tab is implicit index 0. */
  tabs: string[];
  /** Active file path; null means the tree tab. Derived from the `file` search param. */
  activePath: string | null;
  /** Open (or activate) a tab for a path. Pushes a history entry. */
  openFile: (path: string) => void;
  /** Activate a tab, or null for the tree tab. */
  activate: (path: string | null) => void;
  /** Close one tab (x button / context menu). Confirms when dirty. */
  closeTab: (path: string) => void;
  /** Close every file tab except `keep` — TREE_TAB_KEY keeps none. Confirms when others are dirty. */
  closeOthers: (keep: string) => void;
  /** Close every file tab (context menu). Confirms when any is dirty. */
  closeAll: () => void;
  /**
   * Retarget a tab after its file was renamed on disk (folder-compare context
   * menu): swap the tab's path, keeping it active. Confirms when the tab is
   * dirty (the pane remounts, so unsaved edits would be lost).
   */
  renameTab: (from: string, to: string) => void;
  /**
   * Called before a new diff: confirm-discard when any tab is dirty, then clear
   * all tabs and activate the tree tab. Resolves false when the user cancelled
   * (the caller aborts the directory/ref change so edits are never silently lost).
   */
  resetForNewDiff: () => Promise<boolean>;
}

/** Confirm dialog copy/keys are shared with useUnsavedGuard (diff ns). */
function confirmDiscardModal(t: (k: string) => string, onOk: () => void) {
  Modal.confirm({
    title: t('unsavedTitle'),
    content: t('unsavedContent'),
    okText: t('unsavedLeave'),
    okType: 'danger',
    cancelText: t('unsavedStay'),
    onOk,
  });
}

export function useFileTabs({
  basePath,
  isDirty,
}: {
  basePath: string;
  isDirty: (path: string) => boolean;
}): FileTabsApi {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { settings } = useSettings();
  const { t } = useTranslation('diff');
  const [tabs, setTabs] = useState<string[]>([]);

  const fileParam = searchParams.get('file');
  const activePath = fileParam && tabs.includes(fileParam) ? fileParam : null;

  // isDirty comes from the page as an inline closure; keep it in a ref so the
  // callbacks below stay referentially stable and always read the latest map.
  const isDirtyRef = useRef(isDirty);
  useEffect(() => {
    isDirtyRef.current = isDirty;
  });

  const activate = useCallback(
    (path: string | null) => {
      navigate({
        pathname: basePath,
        search: path ? `?file=${encodeURIComponent(path)}` : '',
      });
    },
    [navigate, basePath],
  );

  // Stale `?file=` (deep link / reload after page state was lost): strip the
  // param and land on the tree tab — same net UX as the old detail-page bounce.
  useEffect(() => {
    if (fileParam && !tabs.includes(fileParam)) {
      navigate({ pathname: basePath, search: '' }, { replace: true });
    }
  }, [fileParam, tabs, navigate, basePath]);

  const openFile = useCallback(
    (path: string) => {
      setTabs((prev) => (prev.includes(path) ? prev : [...prev, path]));
      activate(path);
    },
    [activate],
  );

  // Closing the active tab activates the right neighbor, else the left one,
  // else the tree tab; closing a background tab never navigates.
  const closeTab = useCallback(
    (path: string) => {
      const doClose = () => {
        const idx = tabs.indexOf(path);
        if (idx === -1) return;
        const next = tabs.filter((p) => p !== path);
        setTabs(next);
        if (path === activePath) activate(next[idx] ?? next[idx - 1] ?? null);
      };
      if (isDirtyRef.current(path) && settings.confirmOnUnsaved) {
        confirmDiscardModal(t, doClose);
      } else {
        doClose();
      }
    },
    [tabs, activePath, settings.confirmOnUnsaved, t, activate],
  );

  const closeOthers = useCallback(
    (keep: string) => {
      const next = keep === TREE_TAB_KEY ? [] : tabs.includes(keep) ? [keep] : tabs;
      const doClose = () => {
        setTabs(next);
        if (activePath && !next.includes(activePath)) {
          activate(keep === TREE_TAB_KEY ? null : keep);
        }
      };
      const othersDirty = tabs.some((p) => p !== keep && isDirtyRef.current(p));
      if (othersDirty && settings.confirmOnUnsaved) {
        confirmDiscardModal(t, doClose);
      } else {
        doClose();
      }
    },
    [tabs, activePath, settings.confirmOnUnsaved, t, activate],
  );

  const closeAll = useCallback(() => {
    const doClose = () => {
      setTabs([]);
      if (activePath) activate(null);
    };
    const anyDirty = tabs.some((p) => isDirtyRef.current(p));
    if (anyDirty && settings.confirmOnUnsaved) {
      confirmDiscardModal(t, doClose);
    } else {
      doClose();
    }
  }, [tabs, activePath, settings.confirmOnUnsaved, t, activate]);

  const renameTab = useCallback(
    (from: string, to: string) => {
      const doRename = () => {
        const idx = tabs.indexOf(from);
        if (idx === -1) return;
        setTabs(tabs.map((p) => (p === from ? to : p)));
        if (activePath === from) activate(to);
      };
      if (isDirtyRef.current(from) && settings.confirmOnUnsaved) {
        confirmDiscardModal(t, doRename);
      } else {
        doRename();
      }
    },
    [tabs, activePath, settings.confirmOnUnsaved, t, activate],
  );

  const resetForNewDiff = useCallback(async () => {
    const anyDirty = tabs.some((p) => isDirtyRef.current(p));
    if (anyDirty && settings.confirmOnUnsaved) {
      // onCancel fires on the cancel button, Esc and the modal's close affordances.
      const ok = await new Promise<boolean>((resolve) => {
        Modal.confirm({
          title: t('unsavedTitle'),
          content: t('unsavedContent'),
          okText: t('unsavedLeave'),
          okType: 'danger',
          cancelText: t('unsavedStay'),
          onOk: () => resolve(true),
          onCancel: () => resolve(false),
        });
      });
      if (!ok) return false;
    }
    setTabs([]);
    if (activePath) activate(null);
    return true;
  }, [tabs, activePath, settings.confirmOnUnsaved, t, activate]);

  // Tab keyboard shortcuts. Window-level capture listener: runs before
  // Monaco's editor-scoped handlers, and our combos (Ctrl+Tab, Ctrl/Cmd+digits)
  // are unbound in Monaco's standalone editor, so there are no conflicts.
  useEffect(() => {
    const order: (string | null)[] = [null, ...tabs];
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (e.key === 'Tab' && mod) {
        e.preventDefault();
        const i = order.indexOf(activePath);
        const next = order[(i + (e.shiftKey ? -1 : 1) + order.length) % order.length];
        activate(next);
      } else if (mod && e.key >= '1' && e.key <= '9') {
        const idx = Number(e.key) - 1;
        if (idx >= order.length) return;
        e.preventDefault();
        activate(order[idx]);
      }
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [tabs, activePath, activate]);

  return {
    tabs,
    activePath,
    openFile,
    activate,
    closeTab,
    closeOthers,
    closeAll,
    renameTab,
    resetForNewDiff,
  };
}
