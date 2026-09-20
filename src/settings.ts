/**
 * Application preferences: language, theme, ignored directories, diff options (ignore whitespace/case),
 * unsaved-changes guard, file watching.
 * Persisted via the Tauri Store plugin (JSON on disk, settings.json) rather than localStorage,
 * so preferences can be shared across windows and migrate with the app data directory.
 *
 * Exports:
 *   - SettingsProvider: mounted at the app root; asynchronously loads the store on the first frame, then injects context;
 *   - useSettings(): reads the current settings + `update(patch)` for incremental write-back;
 *   - DEFAULT_SETTINGS / Settings type.
 */
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { LazyStore } from '@tauri-apps/plugin-store';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { applyLang, FALLBACK_LANG, resolveLang, type Lang, type LangSetting } from './i18n';

export type ThemeSetting = 'system' | 'light' | 'dark';
/** The resolved effective theme ('system' resolved against the OS preference). */
export type Theme = 'light' | 'dark';

export interface Settings {
  /** UI language: 'system' to follow the OS, or an explicit 'zh-CN' / 'en'. */
  language: LangSetting;
  /** UI theme: 'system' to follow the OS light/dark preference, or an explicit 'light' / 'dark'. */
  theme: ThemeSetting;
  /** Ignore directories by name during folder comparison (exact match at any depth). */
  ignoreDirs: string[];
  /** Ignore whitespace differences (leading/trailing whitespace + collapse consecutive whitespace). */
  ignoreWhitespace: boolean;
  /** Ignore case differences. */
  ignoreCase: boolean;
  /** When there are unsaved changes, show a confirmation prompt before leaving/switching. */
  confirmOnUnsaved: boolean;
  /** Watch open files for external changes and prompt to reload. */
  watchFiles: boolean;
  /** macOS only: keep the Finder Quick Action ("Compare with Manta Compare" in the context menu) installed. */
  finderQuickAction: boolean;
}

/** Built-in default ignored directories (matching the old backend's hardcoded list); treated as "built-in" and not removable. */
export const BUILTIN_IGNORE_DIRS = ['.git', 'node_modules', 'target', 'dist', '.DS_Store'];

export const DEFAULT_SETTINGS: Settings = {
  language: 'system',
  theme: 'system',
  ignoreDirs: [...BUILTIN_IGNORE_DIRS],
  ignoreWhitespace: false,
  ignoreCase: false,
  confirmOnUnsaved: true,
  watchFiles: true,
  finderQuickAction: true,
};

const STORE_FILE = 'settings.json';
const STORE_KEY = 'preferences';

/** Lazily-loaded store: the disk file is only opened on first read/write. */
const store = new LazyStore(STORE_FILE);

/** Read persisted settings, filling missing fields with defaults; falls back to all defaults on failure. */
async function loadSettings(): Promise<Settings> {
  try {
    const saved = await store.get<Partial<Settings>>(STORE_KEY);
    return { ...DEFAULT_SETTINGS, ...(saved ?? {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Write back the whole settings object (best-effort, fails silently -- settings shouldn't block the main flow). */
async function saveSettings(next: Settings): Promise<void> {
  try {
    await store.set(STORE_KEY, next);
    await store.save();
  } catch {
    // ignore: if persistence fails the in-memory state still applies; on next launch it falls back to defaults.
  }
}

interface SettingsContextValue {
  settings: Settings;
  /** Incremental update: only pass the fields you want to change. */
  update: (patch: Partial<Settings>) => void;
  /** Whether the store has finished its first load (renders with defaults until then). */
  loaded: boolean;
  /** The currently effective UI language (with 'system' already resolved to a concrete language), used to derive the antd locale. */
  lang: Lang;
  /** The currently effective theme, with 'system' already resolved against the OS preference. */
  theme: Theme;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  // The currently effective language: the result of resolving 'system', or the user's explicit choice.
  const [lang, setLang] = useState<Lang>(FALLBACK_LANG);
  // The currently effective theme ('system' resolved against the OS preference).
  // Seed from the same localStorage mirror index.html's pre-paint script reads, so the first
  // React render agrees with the pre-painted theme; otherwise (e.g. OS light + user picked
  // dark) the mount effect would strip the pre-painted .pc-dark and flash light until the
  // async store load completes.
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const mirrored = localStorage.getItem('pc-theme');
      if (mirrored === 'dark' || mirrored === 'light') return mirrored;
    } catch {
      // ignore: mirror is best-effort; fall back to the OS preference.
    }
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });
  // Avoid the first-frame load (writing store values back into memory) triggering one redundant saveSettings.
  const hydrating = useRef(true);

  useEffect(() => {
    let alive = true;
    void loadSettings().then((s) => {
      if (!alive) return;
      setSettings(s);
      setLoaded(true);
      hydrating.current = false;
    });
    return () => {
      alive = false;
    };
  }, []);

  // On language change (including once the first-frame load completes) -> resolve the actual language and sync it to i18next + local lang.
  useEffect(() => {
    let alive = true;
    void resolveLang(settings.language).then((resolved) => {
      if (!alive) return;
      setLang(resolved);
      void applyLang(resolved);
    });
    return () => {
      alive = false;
    };
  }, [settings.language]);

  // On theme change (including once the first-frame load completes) -> resolve the effective theme.
  // Re-resolves live when following the system: matchMedia fires on the OS light/dark switch.
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const resolve = () => {
      if (settings.theme === 'system') setTheme(media.matches ? 'dark' : 'light');
      else setTheme(settings.theme);
    };
    resolve();
    if (settings.theme !== 'system') return;
    media.addEventListener('change', resolve);
    return () => media.removeEventListener('change', resolve);
  }, [settings.theme]);

  // Keep the native window's background in sync with the effective theme: the webview paints
  // over it in normal use, but on macOS the window's own background is visible for the first
  // frames (before the webview's first paint) and behind any transparent regions. Uses the
  // same container colors as app.tsx's ConfigProvider seeds (colorBgContainer).
  useEffect(() => {
    getCurrentWindow()
      .setBackgroundColor(theme === 'dark' ? '#1d1d1f' : '#fafafa')
      .catch(() => {
        // ignore: a missing permission / unsupported platform must not break settings.
      });
  }, [theme]);

  // Mirror the raw theme setting to localStorage: index.html reads it synchronously
  // before React mounts to pre-paint the correct theme and avoid a light flash.
  useEffect(() => {
    try {
      localStorage.setItem('pc-theme', settings.theme);
    } catch {
      // ignore: localStorage may be unavailable; the flash-only fallback just degrades.
    }
  }, [settings.theme]);

  const update = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      if (!hydrating.current) void saveSettings(next);
      return next;
    });
  }, []);

  return createElement(
    SettingsContext.Provider,
    { value: { settings, update, loaded, lang, theme } },
    children,
  );
}

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error('useSettings must be used within a SettingsProvider');
  return ctx;
}
