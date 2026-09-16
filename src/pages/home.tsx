/**
 * Home route: the session picker. Dropping files opens the comparison type
 * matching the feature card under the pointer (text/folder/git); dropping
 * elsewhere on the page auto-routes by path kind (directories -> folder,
 * files -> text). Paths are passed through router state.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import cx from 'classnames';
import { useNavigate } from 'react-router-dom';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { invoke } from '@tauri-apps/api/core';
import { Card, Modal, Input, Empty, Tooltip } from 'antd';
import { useTranslation } from 'react-i18next';
import { RetweetOutlined, SearchOutlined } from '@ant-design/icons';
import { AppHeader } from '../app-header';
import { useShell } from '../layout';
import { materialIconUrlByName, materialIconUrl } from '../material-icons';
import { basename, HistoryEntry, entryKey, useStaleHistory } from '../history';
import icon from '../assets/icon.png';

/** Colored material-icon-theme icon (about 28px) used by the home cards. */
function CardIcon({ name }: { name: string }) {
  return (
    <img
      className="inline-block w-7 h-7 object-contain select-none"
      src={materialIconUrlByName(name)}
      alt=""
      aria-hidden
      draggable={false}
    />
  );
}

/**
 * Home hero: a local replacement for @ant-design/x's <Welcome variant="borderless">
 * (removed along with the dependency). Clones its exact metrics: 16px gap between
 * the 58px icon and the text column, 24px/32px semibold title, 14px/22px
 * description, 8px between them.
 */
function WelcomeHero({
  icon,
  title,
  description,
}: {
  icon: string;
  title: string;
  description: string;
}) {
  return (
    <div className="flex items-start gap-4 text-[color:var(--ant-color-text,rgba(0,0,0,0.88))]">
      <img
        src={icon}
        alt=""
        aria-hidden
        draggable={false}
        className="h-[58px] w-[58px] object-contain select-none"
      />
      <div className="flex min-w-0 flex-col gap-2">
        <div className="text-[24px] leading-8 font-semibold">{title}</div>
        <div className="text-sm leading-[22px]">{description}</div>
      </div>
    </div>
  );
}

/** Session cards; titles/descriptions are resolved via i18n at render time (titleKey/descKey). */
const SESSIONS = [
  { key: 'text', titleKey: 'textTitle', descKey: 'textDesc', icon: 'document', enabled: true },
  {
    key: 'folder',
    titleKey: 'folderTitle',
    descKey: 'folderDesc',
    icon: 'folder-base-open',
    enabled: true,
  },
  { key: 'git', titleKey: 'gitTitle', descKey: 'gitDesc', icon: 'git', enabled: true },
];

/** Map a session card key to its route path. */
function pathFor(key: string): string {
  return key === 'folder' ? '/folder-compare' : key === 'git' ? '/git-compare' : '/text-compare';
}

/** A single history row: icon + "left name ⇄ right name" (git prefixes the repo name); the click callback opens the comparison.
 *  When stale=true (the path no longer exists) the whole row is greyed out with a tooltip, but stays clickable (the target page reports the error). */
function RecentRow({
  entry,
  onOpen,
  stale = false,
}: {
  entry: HistoryEntry;
  onOpen: () => void;
  stale?: boolean;
}) {
  const { t } = useTranslation('home');
  return (
    <Tooltip title={stale ? t('stalePath') : undefined}>
      <button
        type="button"
        onClick={onOpen}
        className={cx(
          'flex items-center gap-2 w-full px-2.5 py-2 rounded-md bg-transparent border-0 cursor-pointer text-left transition-colors hover:bg-hover',
          stale && 'opacity-45',
        )}
      >
        <img
          className="w-4 h-4 object-contain select-none flex-none"
          src={
            entry.kind === 'git'
              ? materialIconUrlByName('git')
              : entry.kind === 'folder'
                ? materialIconUrlByName('folder-base-open')
                : materialIconUrl(entry.leftName, 'document')
          }
          alt=""
          aria-hidden
          draggable={false}
        />
        <span className="flex-1 min-w-0 flex items-center gap-1 text-sm truncate">
          {/* Git comparisons dedupe per repo and show only the repo's directory name. */}
          {entry.kind === 'git' ? (
            <span className="truncate">{basename(entry.repo ?? '')}</span>
          ) : (
            <>
              <span className="truncate">{entry.leftName}</span>
              <RetweetOutlined className="text-muted text-[12px] flex-none" />
              <span className="truncate">{entry.rightName}</span>
            </>
          )}
        </span>
      </button>
    </Tooltip>
  );
}

export function HomePage() {
  const navigate = useNavigate();
  const { t } = useTranslation('home');
  const { siderCollapsed, onExpandSider, recent: allRecentRaw } = useShell();
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const navRef = useRef(navigate);
  navRef.current = navigate;

  // Recent comparisons come from the shell's live state (single source of truth shared
  // with the sidebar), so deleting an entry there updates the home page immediately.
  // Home shows the 5 most recently opened (sorted by ts descending).
  const recent = allRecentRaw
    .slice()
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 5);
  // Clicking a recent comparison: navigate to the matching route by kind, passing the left/right paths/refs through to the target page.
  function openRecent(entry: (typeof recent)[number]) {
    navigate(
      entry.kind === 'git'
        ? '/git-compare'
        : entry.kind === 'folder'
          ? '/folder-compare'
          : '/text-compare',
      {
        state:
          entry.kind === 'git'
            ? { repo: entry.repo, from: entry.left, to: entry.right }
            : { left: entry.left, right: entry.right },
      },
    );
  }

  // Full history (descending); the "More" modal shows everything and supports search filtering.
  const [moreOpen, setMoreOpen] = useState(false);
  const [keyword, setKeyword] = useState('');
  const allRecent = useMemo(() => allRecentRaw.slice().sort((a, b) => b.ts - a.ts), [allRecentRaw]);
  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    if (!kw) return allRecent;
    return allRecent.filter((e) =>
      [e.leftName, e.rightName, e.left, e.right, e.repo ?? ''].join(' ').toLowerCase().includes(kw),
    );
  }, [allRecent, keyword]);

  // Open a comparison and close the "More" modal.
  function openFromMore(entry: HistoryEntry) {
    setMoreOpen(false);
    openRecent(entry);
  }

  // Check which history entries have stale paths (grey out + tooltip). Validate the full list when the modal is open, otherwise only the 5 on the home page.
  const stale = useStaleHistory(moreOpen ? allRecent : recent);

  // Native Tauri drag-drop on the home screen. While hovering we hit-test the pointer
  // position against the session cards (via data-session) and highlight just that card;
  // elsewhere nothing is highlighted. On drop, a hovered card forces that comparison
  // type; elsewhere we auto-route by path kind.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    // Session card under the pointer (null = none). Wry (macOS) reports the drag
    // position in top-left-origin AppKit points, i.e. already CSS pixels — no
    // devicePixelRatio conversion (verified against wry's drag_drop.rs).
    const sessionAt = (px: number, py: number): string | null => {
      const el = document.elementFromPoint(px, py);
      return el?.closest<HTMLElement>('[data-session]')?.dataset.session ?? null;
    };
    getCurrentWebview()
      .onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === 'over') {
          setHoverKey(sessionAt(p.position.x, p.position.y));
        } else if (p.type === 'drop') {
          const session = sessionAt(p.position.x, p.position.y);
          setHoverKey(null);
          const paths = p.paths.filter(Boolean);
          if (paths.length === 0) return;
          void (session ? routeBySession(session, paths) : routeByKind(paths));
        } else {
          setHoverKey(null);
        }
      })
      .then((fn) => {
        // If the component unmounted before the listener finished registering, unregister immediately to avoid a listener leak.
        if (disposed) fn();
        else unlisten = fn;
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
    // routeBySession/routeByKind only read navRef, never component state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Look up whether the dropped paths are directories or files, then route:
  //   - any directory present  -> folder-compare (first two dirs as left/right)
  //   - otherwise (files only) -> text-compare
  async function routeByKind(paths: string[]) {
    try {
      const kinds = await Promise.all(paths.map((path) => invoke<string>('path_kind', { path })));
      const dirs = paths.filter((_, i) => kinds[i] === 'dir');
      const files = paths.filter((_, i) => kinds[i] === 'file');
      if (dirs.length > 0) {
        navRef.current('/folder-compare', {
          state: dirs.length >= 2 ? { left: dirs[0], right: dirs[1] } : { left: dirs[0] },
        });
        return;
      }
      navRef.current('/text-compare', {
        state: files.length >= 2 ? { left: files[0], right: files[1] } : { left: files[0] },
      });
    } catch {
      // Fall back to text-compare if type detection fails.
      navRef.current('/text-compare', {
        state: paths.length >= 2 ? { left: paths[0], right: paths[1] } : { left: paths[0] },
      });
    }
  }

  // Drop landed on a specific session card: route to that card's comparison type.
  //   - text   -> the dropped files (first two) as left/right
  //   - folder -> the dropped directories (first two) as left/right
  //   - git    -> the dropped directory as the repo
  // If the paths don't fit the card (e.g. a folder dropped on the text card) or type
  // detection fails, fall back to auto routing by kind so the drop still does something sensible.
  async function routeBySession(session: string, paths: string[]) {
    try {
      const kinds = await Promise.all(paths.map((path) => invoke<string>('path_kind', { path })));
      const dirs = paths.filter((_, i) => kinds[i] === 'dir');
      const files = paths.filter((_, i) => kinds[i] === 'file');
      if (session === 'git' && dirs.length > 0) {
        navRef.current('/git-compare', { state: { repo: dirs[0] } });
        return;
      }
      if (session === 'folder' && dirs.length > 0) {
        navRef.current('/folder-compare', {
          state: dirs.length >= 2 ? { left: dirs[0], right: dirs[1] } : { left: dirs[0] },
        });
        return;
      }
      if (session === 'text' && files.length > 0) {
        navRef.current('/text-compare', {
          state: files.length >= 2 ? { left: files[0], right: files[1] } : { left: files[0] },
        });
        return;
      }
    } catch {
      // Type detection failed: fall through to auto routing.
    }
    void routeByKind(paths);
  }

  // Session card currently targeted by the drag (null = none); hoverKey only ever
  // holds a card key or null — the bare page area is no longer a highlighted target.
  const dropSession = hoverKey;

  return (
    <div className="relative flex flex-col flex-1 min-h-0 overflow-hidden">
      <AppHeader siderCollapsed={siderCollapsed} onExpandSider={onExpandSider} bordered={false} />
      <div className="flex-1 min-w-0 flex flex-col items-center justify-center gap-7 p-4 sm:p-8">
        <div className="mb-4">
          <WelcomeHero icon={icon} title="Manta Compare" description={t('description')} />
        </div>

        <div className="w-full max-w-[760px] grid gap-4 justify-center grid-cols-[repeat(auto-fit,minmax(140px,1fr))]">
          {SESSIONS.map((s) => (
            <Card
              key={s.key}
              hoverable={false}
              data-session={s.key}
              className={cx(
                'cursor-pointer text-center transition-transform',
                !s.enabled && 'opacity-50 cursor-not-allowed',
                // Drag-over highlight: ring the card being targeted.
                dropSession === s.key && 'ring-2 ring-accent rounded-lg',
              )}
              onClick={s.enabled ? () => navigate(pathFor(s.key)) : undefined}
              size="small"
            >
              <div className={cx('text-[28px]', s.enabled ? 'text-accent' : 'text-muted')}>
                <CardIcon name={s.icon} />
              </div>
              <div className="mt-2 text-sm font-semibold">{t(s.titleKey)}</div>
              <div className="text-xs text-muted">{t(s.descKey)}</div>
            </Card>
          ))}
        </div>

        {recent.length > 0 && (
          <div className="w-full max-w-[760px] mt-8">
            <div className="mb-2 px-1 text-xs font-semibold text-muted">{t('recentCompare')}</div>
            <div className="flex flex-col gap-1">
              {recent.map((e) => (
                <RecentRow
                  key={entryKey(e)}
                  entry={e}
                  onOpen={() => openRecent(e)}
                  stale={stale.has(entryKey(e))}
                />
              ))}
            </div>
            <button
              type="button"
              onClick={() => {
                setKeyword('');
                setMoreOpen(true);
              }}
              className="mt-1 w-full text-left text-sm text-accent bg-transparent border-0 cursor-pointer px-2.5 py-2 rounded-md transition-colors hover:bg-hover"
            >
              {t('more')}
            </button>
          </div>
        )}
      </div>

      <Modal
        title={t('allCompare')}
        open={moreOpen}
        onCancel={() => setMoreOpen(false)}
        footer={null}
        destroyOnHidden
      >
        <Input
          allowClear
          autoFocus
          prefix={<SearchOutlined className="text-muted" />}
          placeholder={t('searchPlaceholder')}
          value={keyword}
          onChange={(ev) => setKeyword(ev.target.value)}
        />
        <div className="mt-3 max-h-[50vh] overflow-auto flex flex-col gap-1">
          {filtered.length === 0 ? (
            <div className="flex items-center justify-center py-8">
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('noMatch')} />
            </div>
          ) : (
            filtered.map((e) => (
              <RecentRow
                key={entryKey(e)}
                entry={e}
                onOpen={() => openFromMore(e)}
                stale={stale.has(entryKey(e))}
              />
            ))
          )}
        </div>
      </Modal>
    </div>
  );
}
