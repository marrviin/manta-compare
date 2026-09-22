//! macOS open-file intake. Paths the system hands the app through Apple's odoc
//! events — Finder "Open With", `open -a`, or our own Finder Quick Action —
//! arrive as `RunEvent::Opened { urls }`. Two quirks shape the design:
//!
//! 1. The system may deliver one event per file, so the N paths of a single
//!    "open" arrive as a short burst; we collect for a small window before
//!    dispatching so the frontend sees the whole batch at once.
//! 2. The events can arrive before the webview has mounted (fresh launch).
//!    Dispatch is therefore "park then signal": paths are parked in
//!    [`OpenState::pending`] first, then an `open://paths` event nudges the
//!    frontend — which always pulls the actual paths via
//!    [`take_pending_open_paths`] (on startup and on every signal). That makes
//!    the handoff race-free with a single code path.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, State};
use url::Url;

/// How long to keep collecting `Opened` events before dispatching a batch.
const COLLECT_WINDOW: Duration = Duration::from_millis(300);

/// Managed state for the open-file intake.
#[derive(Default)]
pub struct OpenState {
    /// Paths accumulated inside the current [`COLLECT_WINDOW`].
    buffer: Mutex<Vec<PathBuf>>,
    /// Bumped on every arrival; the collector whose generation is stale backs
    /// off so the newest event's collector does the dispatch.
    generation: AtomicU64,
    /// Paths waiting for the frontend to pull (see module doc).
    pending: Mutex<Vec<PathBuf>>,
}

/// Entry point from `RunEvent::Opened`: convert `file://` URLs to local paths,
/// buffer them and schedule the dispatch.
pub fn handle_opened(app: &AppHandle, state: State<'_, OpenState>, urls: Vec<Url>) {
    let fresh: Vec<PathBuf> = urls
        .into_iter()
        .filter(|url| url.scheme() == "file")
        .filter_map(|url| url.to_file_path().ok())
        .collect();
    if fresh.is_empty() {
        return;
    }
    let generation = {
        let mut buffer = state.buffer.lock().unwrap();
        buffer.extend(fresh);
        state.generation.fetch_add(1, Ordering::SeqCst) + 1
    };
    let app = app.clone();
    // The event loop must not block while collecting, and the process may exit
    // concurrently — a detached thread is fine (worst case the batch is lost).
    thread::spawn(move || dispatch_after_window(&app, generation));
}

/// Wait out the collect window, then — if no newer arrival took over — take the
/// buffered batch, park it and signal the frontend.
fn dispatch_after_window(app: &AppHandle, generation: u64) {
    thread::sleep(COLLECT_WINDOW);
    let state: State<OpenState> = app.state();
    if state.generation.load(Ordering::SeqCst) != generation {
        return; // a newer arrival owns this batch
    }
    let batch = std::mem::take(&mut *state.buffer.lock().unwrap());
    if batch.is_empty() {
        return;
    }
    state.pending.lock().unwrap().extend(batch);
    if let Some(window) = app.get_webview_window("main") {
        // The Quick Action can reach us while the window is hidden/minimized.
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        // Payload is only a signal; the frontend pulls the parked paths.
        let _ = window.emit("open://paths", ());
    }
}

/// At startup: pick file paths out of argv and park them like odoc paths.
/// Convenience/development path: the `tauri dev` binary is not an app bundle,
/// so `open -a`/odoc events can't reach it — launching
/// `target/debug/manta-compare a.txt b.txt` exercises the same routing.
/// Only existing paths count, so stray flags never match.
pub fn queue_argv_paths(state: State<'_, OpenState>) {
    let paths: Vec<PathBuf> = std::env::args()
        .skip(1)
        .map(PathBuf::from)
        .filter(|path| path.exists())
        .collect();
    if !paths.is_empty() {
        state.pending.lock().unwrap().extend(paths);
    }
}

/// Frontend pull: drain everything parked so far (frontend-only contract: the
/// returned paths are strings as rendered by the OS).
#[tauri::command]
pub fn take_pending_open_paths(state: State<'_, OpenState>) -> Vec<String> {
    state
        .pending
        .lock()
        .unwrap()
        .drain(..)
        .map(|path| path.to_string_lossy().to_string())
        .collect()
}
