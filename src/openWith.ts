/**
 * External open-file intake (macOS): when files/folders are handed to the app
 * by the system — Finder Quick Action, "Open With", `open -a` — the Rust side
 * parks the paths and signals `open://paths`; the frontend pulls them with
 * `take_pending_open_paths` and routes them exactly like a home-screen drop:
 * directories -> folder compare, files -> text compare, via router state.
 */
import { invoke } from '@tauri-apps/api/core';

/** Minimal slice of react-router's navigate that routeOpenPaths needs. */
type NavigateLike = (to: string, options?: { state?: unknown }) => void;

/**
 * Route a batch of externally-opened paths to the matching comparison page.
 * Mirrors HomePage's auto-routing: first two dirs as left/right, otherwise
 * first two files; a lone path opens the corresponding page with just `left`
 * (the page then shows the picker for the other side). Falls back to
 * text-compare in first-two order if type detection fails.
 */
export async function routeOpenPaths(navigate: NavigateLike, paths: string[]) {
  const cleaned = paths.filter(Boolean);
  if (cleaned.length === 0) return;
  try {
    const kinds = await Promise.all(cleaned.map((path) => invoke<string>('path_kind', { path })));
    const dirs = cleaned.filter((_, i) => kinds[i] === 'dir');
    const files = cleaned.filter((_, i) => kinds[i] === 'file');
    if (dirs.length >= 2) {
      navigate('/folder-compare', { state: { left: dirs[0], right: dirs[1] } });
    } else if (files.length >= 2) {
      navigate('/text-compare', { state: { left: files[0], right: files[1] } });
    } else if (dirs.length === 1) {
      navigate('/folder-compare', { state: { left: dirs[0] } });
    } else if (files.length === 1) {
      navigate('/text-compare', { state: { left: files[0] } });
    }
  } catch {
    if (cleaned.length >= 2) {
      navigate('/text-compare', { state: { left: cleaned[0], right: cleaned[1] } });
    } else {
      navigate('/text-compare', { state: { left: cleaned[0] } });
    }
  }
}
