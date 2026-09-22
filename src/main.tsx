import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './app';
import { prewarmDiffWorker } from './monaco-prewarm';
import './i18n';
import './styles.css';

// Block the native Cmd+A / Ctrl+A "Select All" editing command outside editable
// contexts. The CSS `user-select: none` on the root only stops mouse-drag selection —
// WKWebView's Select All command ignores it (known WebKit behavior) and would still
// highlight every piece of text in the app. Intercepting the keydown is the reliable
// fix; editable surfaces (inputs, textareas, contenteditable, Monaco's hidden input)
// keep their native select-all so copy/edit flows are unaffected.
document.addEventListener(
  'keydown',
  (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'a') return;
    const target = e.target as HTMLElement | null;
    if (
      target?.closest(
        'input, textarea, [contenteditable="true"], [contenteditable=""], .monaco-editor',
      )
    )
      return;
    e.preventDefault();
  },
  true,
);

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// Spin up Monaco's diff Web Worker ahead of time (during idle, after first paint)
// so the first real comparison doesn't pay the worker cold-start — the gap that
// makes the colored diff appear well after the file text. See monaco-prewarm.ts.
const warm = () => prewarmDiffWorker();
if ('requestIdleCallback' in window) {
  requestIdleCallback(warm, { timeout: 2000 });
} else {
  setTimeout(warm, 500);
}
