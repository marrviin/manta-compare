/**
 * Persistent app shell (mirrors joybuddy's BuddyLayout): the recent sider is
 * always mounted on the left, the active route renders as a content card via
 * <Outlet/>. Shared cross-route state (error toasts, sider collapse, recent
 * history) lives here and is handed down through the router outlet context.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { Outlet, useLocation, useNavigate, useOutletContext } from 'react-router-dom';
import { App as AntdApp, ConfigProvider, Dropdown, Menu, Segmented } from 'antd';
import type { MenuProps } from 'antd';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import cx from 'classnames';
import {
  BgColorsOutlined,
  DiffOutlined,
  DeleteOutlined,
  EllipsisOutlined,
  FolderOpenOutlined,
  MoonOutlined,
  QuestionCircleOutlined,
  RetweetOutlined,
  SettingOutlined,
  SunOutlined,
} from '@ant-design/icons';
import {
  HistoryEntry,
  basename,
  entryKey,
  loadHistory,
  pushHistory,
  removeHistory,
} from './history';
import { SidebarToggleSvg } from './icons';
import { menuSkinTheme } from './menu-skin';
import { useSettings, type Theme } from './settings';
import { materialIconUrl, materialIconUrlByName } from './material-icons';
import { SettingsModal } from './pages/settings/settings-modal';
import { openUrl } from '@tauri-apps/plugin-opener';
import { getVersion } from '@tauri-apps/api/app';
import { isMac } from './platform';

/** Sidebar fixed icons are all rendered as material-icon-theme colored svgs. */
function MaterialNavIcon({ name }: { name: string }) {
  return (
    <img
      className="w-4 h-4 object-contain select-none"
      src={materialIconUrlByName(name)}
      alt=""
      aria-hidden
      draggable={false}
    />
  );
}

/** Shared shell context handed to every route through the outlet. */
export interface ShellContext {
  /** Show an error toast (antd message); '' is a no-op kept for call-site compat. */
  setError: (msg: string) => void;
  siderCollapsed: boolean;
  onExpandSider: () => void;
  /** Live recent-comparison list (single source of truth shared with the sidebar). */
  recent: HistoryEntry[];
  /** Record a freshly-compared pair into recent history. */
  pushRecent: (
    left: string,
    right: string,
    kind?: 'file' | 'folder' | 'git',
    git?: { repo: string; leftName: string; rightName: string },
  ) => void;
  /** Remove a single recent-comparison entry by its {@link entryKey}. */
  removeRecent: (key: string) => void;
}

/** Hook so route pages can read the shared shell context in a typed way. */
export function useShell() {
  return useOutletContext<ShellContext>();
}

/**
 * Re-renders once a minute so the relative "last opened" labels on recent items
 * (刚刚 → 1分钟前 → …) age in place without any per-item timers.
 */
function useMinuteTick(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

/** Relative time for a recent entry's ts: 刚刚 / N分钟前 / N小时前 / N天前. */
function relativeTime(ts: number, now: number, t: TFunction<'layout'>): string {
  const minutes = Math.floor((now - ts) / 60_000);
  if (minutes < 1) return t('justNow');
  if (minutes < 60) return t('minutesAgo', { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('hoursAgo', { n: hours });
  return t('daysAgo', { n: Math.floor(hours / 24) });
}

/**
 * Name for a "recent comparison" list item: single-line ellipsis by default; on
 * hover, if the text overflows, it scrolls left in a loop to show the full content.
 * After mount / content change, it measures the overflow amount and writes it into
 * a CSS variable to drive the animation; no scrolling is triggered when there is no
 * overflow. Scroll speed is derived from the overflow distance to keep a constant pace.
 */
function MarqueeLabel({ text, className }: { text: ReactNode; className?: string }) {
  const wrapRef = useRef<HTMLSpanElement>(null);
  const innerRef = useRef<HTMLSpanElement>(null);
  const [shift, setShift] = useState(0);

  // Measure the overflow distance: inner is block+nowrap, so its scrollWidth is the
  // full text width; the difference from the visible window width is the distance to
  // scroll left. On mount the font/layout may not be stable, making the measurement
  // too small, so we re-measure once on mouse enter to get an accurate value.
  const measure = () => {
    const wrap = wrapRef.current;
    const inner = innerRef.current;
    if (!wrap || !inner) return;
    const overflow = inner.scrollWidth - wrap.clientWidth;
    setShift(overflow > 0 ? overflow : 0);
  };

  useLayoutEffect(() => {
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    if (wrapRef.current) ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, [text]);

  useLayoutEffect(() => {
    // The text width changes after fonts finish loading asynchronously, but the
    // container size hasn't changed, so ResizeObserver won't fire; we proactively
    // re-measure once the fonts are ready.
    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
    if (!fonts?.ready) return;
    let alive = true;
    fonts.ready.then(() => {
      if (alive) measure();
    });
    return () => {
      alive = false;
    };
  }, [text]);

  // Constant 160px/s speed keeps long and short names scrolling at the same pace (a stop frame at each end adds a pause).
  const duration = shift > 0 ? Math.max(1.5, shift / 160 + 0.4) : 0;
  return (
    <span
      ref={wrapRef}
      className={cx('recent-marquee', className)}
      onMouseEnter={measure}
      style={
        {
          '--marquee-shift': `-${shift}px`,
          '--marquee-duration': `${duration}s`,
        } as CSSProperties
      }
    >
      <span ref={innerRef} className="recent-marquee__inner">
        {text}
      </span>
    </span>
  );
}

/**
 * Left sidebar listing recently compared file pairs. Collapses to width 0 with a
 * sliding animation; the collapse toggle floats at the top-right and stays visible
 * even when collapsed (mirrors joybuddy's ConversationSider).
 */
function RecentPanel({
  recent,
  collapsed,
  onToggle,
  onOpenSettings,
  onRemove,
}: {
  recent: HistoryEntry[];
  collapsed: boolean;
  onToggle: () => void;
  /** Opens the settings modal at the given panel (defaults to general). */
  onOpenSettings: (pane?: string) => void;
  onRemove: (key: string) => void;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useTranslation('layout');
  const { update, theme } = useSettings();
  const now = useMinuteTick();
  // App version for the label next to the bottom Settings entry; empty before it
  // resolves (Tauri runtime only) so nothing renders in the browser preview.
  const [appVersion, setAppVersion] = useState('');
  useEffect(() => {
    getVersion()
      .then(setAppVersion)
      .catch(() => setAppVersion(''));
  }, []);
  // Dropdown menu behind the bottom "Settings" entry: a quick theme switch (Segmented pinned to
  // the row's right edge) + the settings modal entry. The Segmented's wrapper stops click
  // propagation so toggling it neither selects the menu item nor closes the dropdown.
  const settingsMenuItems: MenuProps['items'] = [
    { key: 'settings', icon: <SettingOutlined />, label: t('generalSettings') },
    {
      key: 'ignore',
      icon: <DiffOutlined />,
      label: t('compareRules'),
    },
    {
      key: 'theme',
      icon: <BgColorsOutlined />,
      label: (
        <div
          className="flex items-center justify-between gap-3"
          onClick={(e) => e.stopPropagation()}
        >
          <span>{t('theme')}</span>
          <Segmented<Theme>
            size="small"
            value={theme}
            onChange={(v) => update({ theme: v })}
            options={[
              { value: 'light', title: t('themeLight'), icon: <SunOutlined /> },
              { value: 'dark', title: t('themeDark'), icon: <MoonOutlined /> },
            ]}
            classNames={{
              root: '[&_.ant-segmented-group]:gap-0.5',
            }}
          />
        </div>
      ),
    },
    {
      key: 'help',
      icon: <QuestionCircleOutlined />,
      label: t('helpFeedback'),
    },
  ];
  // Top navigation items (aligned with joybuddy's navItems). Just add to the array,
  // and Menu handles unified styling/interaction automatically.
  const navItems: MenuProps['items'] = [
    {
      key: 'text',
      label: t('textCompare'),
      icon: <MaterialNavIcon name="document" />,
    },
    {
      key: 'folder',
      label: t('folderCompare'),
      icon: <MaterialNavIcon name="folder-base-open" />,
    },
    {
      key: 'git',
      label: t('gitCompare'),
      icon: <MaterialNavIcon name="git" />,
    },
  ];
  // Navigate to the comparison page for a recent entry, seeding it via location state.
  // Shared by row click and the three-dot dropdown's "Open" entry.
  const openEntry = (entry: HistoryEntry) => {
    navigate(
      entry.kind === 'git'
        ? '/git-compare'
        : entry.kind === 'folder'
          ? '/folder-compare'
          : '/text-compare',
      {
        state:
          entry.kind === 'git'
            ? {
                repo: entry.repo,
                from: entry.left,
                to: entry.right,
              }
            : { left: entry.left, right: entry.right },
      },
    );
  };
  // Recent-comparison list items: key uses entryKey (kind|paths, git: repo) for unique identification;
  // icon distinguishes file/folder by type. The delete entry is a Dropdown pinned to the row's
  // right edge inside the label: hovering an item fades in a three-dot button, click to open the menu.
  const recentItems: MenuProps['items'] = recent.map((e) => {
    const key = entryKey(e);
    return {
      key,
      label: (
        <span className="flex items-center w-full min-w-0">
          <MarqueeLabel
            className="flex-[1_1_auto] w-auto"
            text={
              // Git comparisons dedupe per repo and show only the repo's directory
              // name; file/folder comparisons show the left/right pair.
              e.kind === 'git' ? (
                <span className="whitespace-nowrap">{basename(e.repo ?? '')}</span>
              ) : (
                <span className="inline whitespace-nowrap">
                  <span className="whitespace-nowrap">{e.leftName}</span>
                  <RetweetOutlined className="inline-flex align-middle mx-1 text-muted text-[12px]" />
                  <span className="whitespace-nowrap">{e.rightName}</span>
                </span>
              )
            }
          />
          {/* Last-opened time, hidden on hover so the three-dot menu takes over the right edge. */}
          <span className="recent-time">{relativeTime(e.ts, now, t)}</span>
          {/* Three-dot delete trigger. Absolutely pinned to the row's right edge (the li is
              position:relative); the built-in trigger stops propagation, so the click never
              navigates the item. The dropdown popup renders in a portal, so its own clicks
              can't bubble into the row either. */}
          <Dropdown
            trigger={['click']}
            placement="bottomRight"
            menu={{
              items: [
                {
                  key: 'open',
                  icon: <FolderOpenOutlined />,
                  label: t('openRecent'),
                },
                {
                  key: 'remove',
                  danger: true,
                  icon: <DeleteOutlined />,
                  label: t('removeRecent'),
                },
              ],
              onClick: ({ key: menuKey, domEvent }) => {
                domEvent.stopPropagation();
                if (menuKey === 'open') openEntry(e);
                if (menuKey === 'remove') onRemove(key);
              },
            }}
          >
            <EllipsisOutlined className="recent-more" onClick={(e) => e.stopPropagation()} />
          </Dropdown>
        </span>
      ),
      icon:
        e.kind === 'git' ? (
          <MaterialNavIcon name="git" />
        ) : e.kind === 'folder' ? (
          <MaterialNavIcon name="folder-base-open" />
        ) : (
          <img
            className="w-4 h-4 object-contain select-none"
            src={materialIconUrl(e.leftName, 'document')}
            alt=""
            aria-hidden
            draggable={false}
          />
        ),
    };
  });
  const pathFor = (key: string): string =>
    key === 'folder' ? '/folder-compare' : key === 'git' ? '/git-compare' : '/text-compare';
  // Top-nav highlight: derive the nav key from the current route so the highlight stays in sync
  // after route changes; selectedKeys stays empty off-route so every click goes through onClick.
  const navActiveKey =
    location.pathname === '/folder-compare'
      ? 'folder'
      : location.pathname === '/git-compare'
        ? 'git'
        : location.pathname === '/text-compare'
          ? 'text'
          : undefined;
  return (
    <div
      className={cx(
        'relative flex-none h-full overflow-hidden transition-[width] duration-200 ease-in-out',
        collapsed ? 'w-0' : 'w-60',
      )}
    >
      <div className="h-full w-60 overflow-hidden">
        <aside className="h-full w-60 flex flex-col px-0 pb-4 overflow-y-auto">
          {/* macOS vibrancy: no bg here — the window base (AppLayout root) paints the
              theme-tinted wash over the system blur; the aside itself stays clear. */}
          {/* Top spacer under the native traffic lights; draggable window strip. */}
          <div className="h-12 flex-none" data-tauri-drag-region />
          {/* Action area: comparison methods. Menu's onClick fires even when the clicked
              item is already selected, so re-clicking a nav entry still navigates — same
              semantics as the old Conversations onActiveChange. */}
          <div className="shrink-0">
            <ConfigProvider theme={menuSkinTheme}>
              <Menu
                mode="inline"
                items={navItems}
                className="pc-menu-skin px-2 pt-2 pb-3"
                selectedKeys={navActiveKey ? [navActiveKey] : []}
                onClick={({ key }) => navigate(pathFor(key))}
              />
            </ConfigProvider>
          </div>
          {/* Divider between the action area and the recent list. */}
          <div className="mx-2 my-1 h-px shrink-0 bg-split" />
          <div className="shrink-0 px-4 pt-1 pb-1 text-[12px] text-muted">{t('recentCompare')}</div>
          {/* Empty list renders nothing: the Menu simply shows no items (no Empty placeholder). */}
          <ConfigProvider theme={menuSkinTheme}>
            <Menu
              mode="inline"
              items={recentItems}
              className="pc-menu-skin flex-1 min-h-0 overflow-auto px-2 pb-2 pt-0"
              selectedKeys={[]}
              onClick={({ key }) => {
                // Key lookup must go through entryKey — it's both the item key and the dedupe identity.
                const entry = recent.find((e) => entryKey(e) === key);
                if (entry) openEntry(entry);
              }}
            />
          </ConfigProvider>
          {/* Fixed entry at the bottom (mt-auto pushes it to the bottom, always visible).
              Opens a dropdown with a quick theme switch (Segmented on the row's right) and the settings modal entry. */}
          <div className="mt-auto shrink-0 px-2 py-2">
            <Dropdown
              trigger={['click']}
              placement="topRight"
              align={{ offset: [0, -8] }}
              menu={{
                style: { minWidth: 240 },
                items: settingsMenuItems,
                onClick: ({ key }) => {
                  if (key === 'settings') onOpenSettings('general');
                  if (key === 'ignore') onOpenSettings('ignore');
                  if (key === 'help')
                    void openUrl('https://github.com/marrviin/manta-compare/issues/new');
                },
              }}
            >
              <button
                type="button"
                className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-sm text-fg bg-transparent border-0 cursor-pointer transition-colors hover:bg-hover [-webkit-app-region:no-drag]"
              >
                <SettingOutlined />
                <span className="flex-1 text-left">{t('settings')}</span>
                {/* App version, inside the click area at the row's right edge. */}
                {appVersion && (
                  <span className="shrink-0 text-[11px] text-muted select-none">v{appVersion}</span>
                )}
              </button>
            </Dropdown>
          </div>
        </aside>
      </div>
      {!collapsed && (
        <button
          type="button"
          aria-label={t('collapseSider')}
          className="text-[14px] absolute top-[15px] left-51 z-20 flex items-center justify-center w-7 h-7 rounded-md text-fg bg-transparent border-0 cursor-pointer transition-colors hover:bg-hover [-webkit-app-region:no-drag]"
          onClick={onToggle}
        >
          <SidebarToggleSvg />
        </button>
      )}
    </div>
  );
}

/**
 * Root layout: single persistent shell hosting the recent sider plus the active
 * route as a content card. Shared state is provided to child routes via context.
 */
export function AppLayout() {
  // Error toasts come from antd's App context so they inherit the configured theme.
  const { message } = AntdApp.useApp();
  const [recent, setRecent] = useState<HistoryEntry[]>(() => loadHistory());
  const [siderCollapsed, setSiderCollapsed] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsPane, setSettingsPane] = useState('general');

  // Errors surface as a transient toast instead of a banner; the '' calls
  // scattered through the pages ("clear previous error") become a no-op.
  const setError = useCallback(
    (msg: string) => {
      if (msg) message.error(msg);
    },
    [message],
  );

  const ctx = useMemo<ShellContext>(
    () => ({
      setError,
      siderCollapsed,
      onExpandSider: () => setSiderCollapsed(false),
      recent,
      pushRecent: (left, right, kind = 'file', git) =>
        setRecent(pushHistory(left, right, kind, git)),
      removeRecent: (key) => setRecent(removeHistory(key)),
    }),
    [setError, siderCollapsed, recent],
  );

  return (
    // macOS vibrancy: the shell root paints the theme-tinted translucent wash over the
    // system blur material; non-mac keeps the opaque bg-panel shell.
    <div className={cx('flex h-screen overflow-hidden', isMac ? 'pc-vibrancy-wash' : 'bg-panel')}>
      <RecentPanel
        recent={recent}
        collapsed={siderCollapsed}
        onToggle={() => setSiderCollapsed((c) => !c)}
        onOpenSettings={(pane) => {
          setSettingsPane(pane ?? 'general');
          setSettingsOpen(true);
        }}
        onRemove={(key) => setRecent(removeHistory(key))}
      />
      <div
        className="group/card relative flex flex-col flex-1 min-w-0 bg-surface border border-white/10 dark:border-white/10 overflow-hidden m-2 rounded-[12px] outline outline-(--color-line)"
        data-collapsed={siderCollapsed}
      >
        <Outlet context={ctx} />
      </div>
      {/* key=settingsPane: the modal's internal pane state initializes from initialPane on mount only,
          so remounting per target panel guarantees it always opens on the requested pane. */}
      <SettingsModal
        key={settingsPane}
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        initialPane={settingsPane}
      />
    </div>
  );
}
