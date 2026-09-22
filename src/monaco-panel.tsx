/**
 * Side-by-side diff body wrapping the Monaco DiffEditor. Replaces the CodeMirror MergeView
 * (merge-panel.tsx), gaining IDE-grade look and feel, language highlighting, and huge-file
 * performance (spike measurements: ~250ms to render 200k lines, ~5s for precise diff without
 * freezing the UI).
 *
 * The diff editor is created imperatively (monaco.editor.createDiffEditor, with React only
 * providing the mount point), not using @monaco-editor/react's <DiffEditor> -- the latter's value
 * sync effect is asymmetric between sides: the modified side uses guarded executeEdits (preserving
 * cursor/undo stack), but the original side unconditionally calls setValue, causing the left side's
 * cursor to reset to the start after every keystroke and its undo stack to be cleared. Here both
 * sides use the same "replace the whole content only when the value differs" symmetric sync,
 * matching the old CM behavior.
 *
 * The public interface aligns with the old MergePanel (same props + MergePanelHandle), so the
 * upper-layer DiffPanel / SearchPopup barely change. Diff stats are derived from getLineChanges()
 * on onDidUpdateDiff and emitted upward. The minimap shows only on the right modified side (the
 * left one would squeeze the left column content and misalign the center split line with the
 * header/footer); keeping one on the right edge stays aligned while preserving the minimap feature.
 *
 * Search: SearchPopup provides the UI; here we drive it ourselves with model.findMatches +
 * decoration highlighting + selection positioning (not popping Monaco's built-in find widget),
 * matching the old CM implementation.
 */
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import cx from 'classnames';
import { useTranslation } from 'react-i18next';
import * as monaco from './monaco-core';
import { renderToStaticMarkup } from 'react-dom/server';
import { ArrowLeftOutlined, ArrowRightOutlined } from '@ant-design/icons';
import { basename } from './diff-view';
import { useSettings } from './settings';
import './monaco-env';

export type Side = 'left' | 'right';

// The glyph margin widget is imperative DOM and can't be fit into a React component, so pre-render
// the antd icons as static SVG strings (computed once); the click-to-copy arrows inject them directly via innerHTML.
const ARROW_RIGHT_SVG = renderToStaticMarkup(<ArrowRightOutlined />);
const ARROW_LEFT_SVG = renderToStaticMarkup(<ArrowLeftOutlined />);

// Monaco's default word separators (used for "whole word match"). Monaco doesn't export this constant, so we use its built-in default value.
const WORD_SEPARATORS = '`~!@#$%^&*()-=+[{]}\\|;:\'",.<>/?';

// Only reveal the "computing diff" progress bar if the diff takes longer than this (ms). Fast diffs
// (the common case, now that large inputs use the legacy algorithm) finish well under this and never
// flash the bar; only genuinely heavy computations show it, so the bar reads as meaningful, not noise.
const DIFF_PROGRESS_DELAY_MS = 180;

/** Search/replace query options (driven by the outer antd popup). Kept consistent with the old MergePanel. */
export interface SearchOptions {
  search: string;
  replace?: string;
  caseSensitive?: boolean;
  regexp?: boolean;
  wholeWord?: boolean;
}

/** Imperative handle: called by the column-header toolbar buttons + antd search popup. Consistent with the old MergePanel. */
export interface MergePanelHandle {
  goNext: () => void;
  goPrev: () => void;
  undo: (side?: Side) => void;
  redo: (side?: Side) => void;
  setQuery: (opts: SearchOptions) => void;
  findNext: () => void;
  findPrev: () => void;
  replaceNext: () => void;
  replaceAll: () => void;
}

/**
 * Choose the diff algorithm based on input size.
 *
 * Monaco's default 'advanced' algorithm (defaultLinesDiffComputer) produces nicer
 * hunks (move detection, finer intra-block alignment) but degrades to a worst-case
 * O(n·m) path on large, mutually-similar, *asymmetric* blocks — a real 442-vs-462
 * line HTML pair was measured pegging the 5s maxComputationTime cap (quitEarly=true)
 * every time, while 'legacy' returned an equivalent diff in ~5ms for the same input.
 *
 * So: keep 'advanced' for everyday small diffs (its quality is the reason it's the
 * default), but fall back to 'legacy' once the input is big enough that 'advanced'
 * risks the timeout. Two independent size signals push up the char-level alignment
 * cost, so either one trips the fallback:
 *   - total line count across both sides (many lines → more/larger hunks), and
 *   - the longest single line (very long lines make per-line char diff expensive).
 * Thresholds are deliberately well above typical everyday diffs (which measured
 * ~20-30ms on 'advanced') yet below the observed pathological file.
 */
const DIFF_TOTAL_LINES_THRESHOLD = 600;
const DIFF_MAX_LINE_LEN_THRESHOLD = 1000;
function pickDiffAlgorithm(
  left: monaco.editor.ITextModel,
  right: monaco.editor.ITextModel,
): 'legacy' | 'advanced' {
  const totalLines = left.getLineCount() + right.getLineCount();
  if (totalLines > DIFF_TOTAL_LINES_THRESHOLD) return 'legacy';
  const maxLineLen = (m: monaco.editor.ITextModel) => {
    let mx = 0;
    const n = m.getLineCount();
    for (let i = 1; i <= n; i++) {
      const len = m.getLineLength(i);
      if (len > mx) mx = len;
    }
    return mx;
  };
  if (maxLineLen(left) > DIFF_MAX_LINE_LEN_THRESHOLD) return 'legacy';
  if (maxLineLen(right) > DIFF_MAX_LINE_LEN_THRESHOLD) return 'legacy';
  return 'advanced';
}

/**
 * Monarch tokenization runs on the main thread; for a pathologically long single
 * line (minified HTML/JS/JSON — e.g. a 20KB+ line with no newlines) WebKit's
 * regex engine can stall it for minutes, freezing the whole diff view: content
 * never renders and the "computing diff" bar spins forever (worker results can't
 * be delivered while the main thread is blocked). Such files skip highlighting
 * entirely — they diff as plaintext, which the diff computation doesn't care
 * about (it's language-agnostic).
 */
const MAX_TOKENIZED_LINE_LEN = 5000;

function hasVeryLongLine(content: string): boolean {
  let start = 0;
  for (;;) {
    const nl = content.indexOf('\n', start);
    const end = nl === -1 ? content.length : nl;
    if (end - start > MAX_TOKENIZED_LINE_LEN) return true;
    if (nl === -1) return false;
    start = nl + 1;
  }
}

/** Monaco language for a side: extension-based, but plaintext when the content
 * carries pathologically long lines (see {@link MAX_TOKENIZED_LINE_LEN}). */
function languageForContent(path: string | undefined, content: string): string {
  return hasVeryLongLine(content) ? 'plaintext' : languageFor(path);
}

/** Map file extension to a Monaco language id; returns 'plaintext' if unrecognized. */
function languageFor(path: string | undefined): string {
  if (!path) return 'plaintext';
  const name = basename(path);
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  switch (ext) {
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return 'javascript';
    case 'ts':
    case 'tsx':
      return 'typescript';
    case 'json':
      return 'json';
    case 'html':
    case 'htm':
    case 'vue':
      return 'html';
    case 'css':
      return 'css';
    case 'scss':
      return 'scss';
    case 'less':
      return 'less';
    case 'md':
    case 'markdown':
      return 'markdown';
    case 'py':
      return 'python';
    case 'rs':
      return 'rust';
    case 'go':
      return 'go';
    case 'java':
      return 'java';
    case 'xml':
      return 'xml';
    case 'yaml':
    case 'yml':
      return 'yaml';
    case 'sh':
    case 'bash':
      return 'shell';
    case 'sql':
      return 'sql';
    default:
      return 'plaintext';
  }
}

/**
 * Define the Monaco themes aligned with the project's visuals (registered only once). The diff
 * inserted/removed backgrounds and character highlights use Monaco's built-in tokens; here we align
 * the editor background, line numbers, selection, etc. to the static values of the project's CSS variables.
 * Note: Monaco themes only accept concrete color values, not CSS variables, so we use the fixed
 * values from the project's light/dark palettes (see styles.css).
 */
let themesDefined = false;
const THEME_NAME = 'manta-compare-light';
const THEME_NAME_DARK = 'manta-compare-dark';
function ensureTheme() {
  if (themesDefined) return;
  monaco.editor.defineTheme(THEME_NAME, {
    base: 'vs',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#fafafa',
      'editorGutter.background': '#f2f2f2',
      'editorLineNumber.foreground': '#8c8c8c',
      'editor.selectionBackground': '#3768fa26',
      'editor.findMatchBackground': '#f0843366',
      'editor.findMatchHighlightBackground': '#3768fa26',
      // diff inserted/removed: align with the project's red/green (insert green / delete red).
      'diffEditor.insertedTextBackground': '#00b26f26',
      'diffEditor.removedTextBackground': '#f33b5026',
      'diffEditor.insertedLineBackground': '#00b26f1a',
      'diffEditor.removedLineBackground': '#f33b501a',
    },
  });
  monaco.editor.defineTheme(THEME_NAME_DARK, {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#1d1d1f',
      'editorGutter.background': '#161617',
      'editorLineNumber.foreground': '#8a8a8a',
      'editor.selectionBackground': '#3768fa40',
      'editor.findMatchBackground': '#f0843366',
      'editor.findMatchHighlightBackground': '#3768fa40',
      'diffEditor.insertedTextBackground': '#00b26f33',
      'diffEditor.removedTextBackground': '#f33b5033',
      'diffEditor.insertedLineBackground': '#00b26f26',
      'diffEditor.removedLineBackground': '#f33b5026',
    },
  });
  themesDefined = true;
}

/** The Monaco theme name for the current app theme. */
function themeNameFor(isDark: boolean): string {
  return isDark ? THEME_NAME_DARK : THEME_NAME;
}

/**
 * Symmetric "external value -> editor" sync: replace the whole content only when the model's current
 * value differs from the target. Uses pushEditOperations to preserve the undo stack (better than
 * setValue clearing everything) and keeps the cursor where possible.
 * Equal values (echo from the editor's own edits) are skipped, so user input never triggers a replace and the cursor doesn't jump.
 */
function syncModel(model: monaco.editor.ITextModel | undefined, next: string) {
  if (!model) return;
  if (model.getValue() === next) return;
  model.pushEditOperations(null, [{ range: model.getFullModelRange(), text: next }], () => null);
}

/**
 * Copy a diff block from the source side to the target side (directional copy like Beyond Compare).
 * Computed from the ILineChange line ranges: pure insertion (original has no lines), pure deletion
 * (modified has no lines), and replacement are all unified as "replace the target side's corresponding
 * line range with the source block's full-line text".
 *
 * - toRight: left (original) -> right (modified), source = original block, target = modified line range
 * - toLeft : right (modified) -> left (original), source = modified block, target = original line range
 *
 * Uses executeEdits to preserve the target side's undo stack; delete/insert boundaries land precisely by joining a newline at the line end/start.
 */
function copyChange(
  editor: monaco.editor.IStandaloneDiffEditor,
  change: monaco.editor.ILineChange,
  direction: 'toRight' | 'toLeft',
) {
  const orig = editor.getOriginalEditor();
  const mod = editor.getModifiedEditor();
  const origModel = orig.getModel();
  const modModel = mod.getModel();
  if (!origModel || !modModel) return;

  const {
    originalStartLineNumber: oStart,
    originalEndLineNumber: oEnd,
    modifiedStartLineNumber: mStart,
    modifiedEndLineNumber: mEnd,
  } = change;
  // endLineNumber < startLineNumber means this side has no lines in this block (pure insertion / pure deletion).
  const origHasLines = oEnd >= oStart;
  const modHasLines = mEnd >= mStart;

  // Get the full-line text of a line span (inclusive of both ends) on one side.
  const linesText = (model: monaco.editor.ITextModel, start: number, end: number) => {
    const arr: string[] = [];
    for (let ln = start; ln <= end; ln++) arr.push(model.getLineContent(ln));
    return arr.join('\n');
  };

  if (direction === 'toRight') {
    // target = modified. source = original block text (empty on pure deletion).
    const srcText = origHasLines ? linesText(origModel, oStart, oEnd) : '';
    let range: monaco.Range;
    let text: string;
    if (modHasLines) {
      // Target side has lines: replace the whole block.
      range = new monaco.Range(mStart, 1, mEnd, modModel.getLineMaxColumn(mEnd));
      text = srcText;
    } else {
      // Target side has no lines (pure insertion on the left, so delete the corresponding right lines):
      // anchor at the end of the line before modStart. In Monaco, modifiedStartLineNumber is the "line
      // number before the change", so insert after that line.
      const anchor = mStart; // the change is located after the anchor line
      const col = modModel.getLineMaxColumn(anchor);
      range = new monaco.Range(anchor, col, anchor, col);
      text = srcText ? '\n' + srcText : '';
    }
    mod.executeEdits('copy-change', [{ range, text }]);
    mod.focus();
  } else {
    // toLeft: target = original. source = modified block text (empty on pure insertion).
    const srcText = modHasLines ? linesText(modModel, mStart, mEnd) : '';
    let range: monaco.Range;
    let text: string;
    if (origHasLines) {
      range = new monaco.Range(oStart, 1, oEnd, origModel.getLineMaxColumn(oEnd));
      text = srcText;
    } else {
      const anchor = oStart;
      const col = origModel.getLineMaxColumn(anchor);
      range = new monaco.Range(anchor, col, anchor, col);
      text = srcText ? '\n' + srcText : '';
    }
    orig.executeEdits('copy-change', [{ range, text }]);
    orig.focus();
  }
}

interface Props {
  leftContent: string;
  rightContent: string;
  leftPath?: string;
  rightPath?: string;
  leftReadonly?: boolean;
  rightReadonly?: boolean;
  /** Ignore whitespace differences -> Monaco's ignoreTrimWhitespace. */
  ignoreWhitespace?: boolean;
  onChange?: (side: Side, text: string) => void;
  onStats?: (stats: { added: number; removed: number }) => void;
  /** Left editor's width as a ratio of the container (0~1), so the outer header/footer can align with Monaco's split bar. */
  onSplit?: (leftRatio: number) => void;
  handleRef?: Ref<MergePanelHandle>;
}
export function MonacoPanel({
  leftContent,
  rightContent,
  leftPath,
  rightPath,
  leftReadonly = false,
  rightReadonly = false,
  ignoreWhitespace = false,
  onChange,
  onStats,
  onSplit,
  handleRef,
}: Props) {
  const { t } = useTranslation('diff');
  // Effective app theme: selects the matching Monaco theme at creation and live-switches running editors.
  const { theme } = useSettings();
  const isDark = theme === 'dark';
  // Keep t in a ref: the copy arrows are imperative DOM (created inside the onDidUpdateDiff closure);
  // the ref ensures the current language's text is read. Written in the effect below (not during render).
  const tRef = useRef(t);
  const hostRef = useRef<HTMLDivElement>(null);
  // "Diff is computing" indicator: a thin indeterminate bar shown only when the computation is slow
  // enough to be worth signalling (see DIFF_PROGRESS_DELAY_MS). Monaco's diff worker reports no
  // percentage, so this is intentionally indeterminate (a sliding sweep), not a real progress value.
  const [computing, setComputing] = useState(false);
  // Pending "show the bar" timer: armed when a diff starts, cleared when it finishes (or a new one starts).
  const progressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const modelsRef = useRef<{
    original: monaco.editor.ITextModel;
    modified: monaco.editor.ITextModel;
  } | null>(null);
  // The side most recently focused: undo/redo/search without a side argument act on that side (IDE
  // intuition -- the operation applies to the editor where the cursor is). Defaults to the right (modified), compatible with historical behavior.
  const lastFocusedRef = useRef<Side>('right');
  // Readonly state in a ref: lets the onDidUpdateDiff callback (a closure captured at mount) read the
  // latest readonly side to decide which side shows a direction arrow (a readonly side gets no arrow pointing at it = no arrow for a direction that can't be written).
  const readonlyRef = useRef({ left: leftReadonly, right: rightReadonly });
  readonlyRef.current = { left: leftReadonly, right: rightReadonly };
  // The copy-arrow widgets currently mounted on both sides' glyph margins; clear the old ones before rebuilding.
  const copyWidgetsRef = useRef<{
    original: monaco.editor.IGlyphMarginWidget[];
    modified: monaco.editor.IGlyphMarginWidget[];
  }>({ original: [], modified: [] });
  // The "bracket range line" decoration set for each diff block (outlines the line range the operation affects, like Beyond Compare).
  const rangeDecoRef = useRef<{
    original: monaco.editor.IEditorDecorationsCollection | null;
    modified: monaco.editor.IEditorDecorationsCollection | null;
  }>({ original: null, modified: null });
  // Search-match decoration set (highlights all matches): one per side, both sides highlighted at once.
  const searchDecoRef = useRef<{
    left: monaco.editor.IEditorDecorationsCollection | null;
    right: monaco.editor.IEditorDecorationsCollection | null;
  }>({ left: null, right: null });
  // The merged match sequence: matches from both sides arranged into one list by left->right and line/column order, for continuous next/prev navigation.
  const searchState = useRef<{
    hits: { side: Side; match: monaco.editor.FindMatch }[];
    index: number;
    opts: SearchOptions | null;
  }>({ hits: [], index: -1, opts: null });

  // Callbacks in refs to avoid callback changes triggering remounts / listener rebuilds.
  const onChangeRef = useRef(onChange);
  const onStatsRef = useRef(onStats);
  useEffect(() => {
    onChangeRef.current = onChange;
    onStatsRef.current = onStats;
    tRef.current = t;
  });
  const onSplitRef = useRef(onSplit);
  useEffect(() => {
    onSplitRef.current = onSplit;
  });

  // Arm the progress bar: after DIFF_PROGRESS_DELAY_MS, if the diff still hasn't finished, show the bar.
  // A diff that completes sooner clears the timer in finishProgress and the bar never appears.
  const startProgress = () => {
    if (progressTimerRef.current) clearTimeout(progressTimerRef.current);
    progressTimerRef.current = setTimeout(() => {
      progressTimerRef.current = null;
      setComputing(true);
    }, DIFF_PROGRESS_DELAY_MS);
  };
  // Diff finished (onDidUpdateDiff fired): cancel a pending reveal and hide the bar if it was showing.
  const finishProgress = () => {
    if (progressTimerRef.current) {
      clearTimeout(progressTimerRef.current);
      progressTimerRef.current = null;
    }
    setComputing(false);
  };

  /** Derive "added lines / removed lines" from getLineChanges and emit upward. */
  const emitStats = (editor: monaco.editor.IStandaloneDiffEditor) => {
    const changes = editor.getLineChanges();
    if (!changes) return;
    let added = 0;
    let removed = 0;
    for (const c of changes) {
      // endLineNumber < startLineNumber (and start=0) means this side has no lines (pure insertion / pure deletion).
      if (c.modifiedStartLineNumber > 0 && c.modifiedEndLineNumber >= c.modifiedStartLineNumber)
        added += c.modifiedEndLineNumber - c.modifiedStartLineNumber + 1;
      if (c.originalStartLineNumber > 0 && c.originalEndLineNumber >= c.originalStartLineNumber)
        removed += c.originalEndLineNumber - c.originalStartLineNumber + 1;
    }
    onStatsRef.current?.({ added, removed });
  };

  /**
   * Rebuild the "directional copy arrow" widgets on both sides' glyph margins (like Beyond Compare).
   * - Left column (original): each diff block gets a "right arrow" (left->right), shown only when the right side is writable.
   * - Right column (modified): each diff block gets a "left arrow" (right->left), shown only when the left side is writable.
   * The arrow is anchored at the block's start line in the glyph margin and is always visible; clicking calls copyChange to do a block-level copy.
   * Each diff update clears the old widgets first, then rebuilds (block ranges change).
   */
  const renderCopyArrows = (editor: monaco.editor.IStandaloneDiffEditor) => {
    const orig = editor.getOriginalEditor();
    const mod = editor.getModifiedEditor();
    const store = copyWidgetsRef.current;
    // Clear the old ones.
    store.original.forEach((w) => orig.removeGlyphMarginWidget(w));
    store.modified.forEach((w) => mod.removeGlyphMarginWidget(w));
    store.original = [];
    store.modified = [];

    const changes = editor.getLineChanges();
    if (!changes) return;
    const { left: leftRO, right: rightRO } = readonlyRef.current;

    // Collect each side's "bracket range line" decorations: each diff block uses linesDecorationsClassName
    // to add a left vertical bar on every line in the block, with an extra corner on the first / last line (CSS ⊏ shape), outlining the affected line range.
    const origDecos: monaco.editor.IModelDeltaDecoration[] = [];
    const modDecos: monaco.editor.IModelDeltaDecoration[] = [];
    const pushRange = (
      target: monaco.editor.IModelDeltaDecoration[],
      start: number,
      end: number,
    ) => {
      const single = start === end;
      for (let ln = start; ln <= end; ln++) {
        const cls = cx('copy-range', {
          'copy-range-single': single,
          'copy-range-first': !single && ln === start,
          'copy-range-last': !single && ln === end,
        });
        target.push({
          range: new monaco.Range(ln, 1, ln, 1),
          options: { isWholeLine: true, linesDecorationsClassName: cls },
        });
      }
    };

    changes.forEach((change, i) => {
      const origHasLines = change.originalEndLineNumber >= change.originalStartLineNumber;
      const modHasLines = change.modifiedEndLineNumber >= change.modifiedStartLineNumber;

      // Range line: drawn only when this side actually has changed lines (not drawn when a pure-insertion block has no lines on the left, or a pure-deletion block has no lines on the right).
      if (origHasLines)
        pushRange(origDecos, change.originalStartLineNumber, change.originalEndLineNumber);
      if (modHasLines)
        pushRange(modDecos, change.modifiedStartLineNumber, change.modifiedEndLineNumber);

      // Left-column right arrow: write the left block to the right -- shown only when the right side is writable. Anchored at the original block's start line
      // (for a pure-deletion block, originalStart is the change location).
      if (!rightRO) {
        const line = origHasLines ? change.originalStartLineNumber : change.originalStartLineNumber;
        const node = document.createElement('div');
        node.className = 'copy-arrow copy-arrow-right';
        node.title = tRef.current('copyToRight');
        node.innerHTML = ARROW_RIGHT_SVG;
        node.onclick = (e) => {
          e.stopPropagation();
          copyChange(editor, change, 'toRight');
        };
        const widget: monaco.editor.IGlyphMarginWidget = {
          getId: () => `copy-arrow-r-${i}`,
          getDomNode: () => node,
          getPosition: () => ({
            lane: monaco.editor.GlyphMarginLane.Center,
            zIndex: 10,
            range: new monaco.Range(Math.max(1, line), 1, Math.max(1, line), 1),
          }),
        };
        orig.addGlyphMarginWidget(widget);
        store.original.push(widget);
      }

      // Right-column left arrow: write the right block to the left -- shown only when the left side is writable. Anchored at the modified block's start line.
      if (!leftRO) {
        const line = modHasLines ? change.modifiedStartLineNumber : change.modifiedStartLineNumber;
        const node = document.createElement('div');
        node.className = 'copy-arrow copy-arrow-left';
        node.title = tRef.current('copyToLeft');
        node.innerHTML = ARROW_LEFT_SVG;
        node.onclick = (e) => {
          e.stopPropagation();
          copyChange(editor, change, 'toLeft');
        };
        const widget: monaco.editor.IGlyphMarginWidget = {
          getId: () => `copy-arrow-l-${i}`,
          getDomNode: () => node,
          getPosition: () => ({
            lane: monaco.editor.GlyphMarginLane.Center,
            zIndex: 10,
            range: new monaco.Range(Math.max(1, line), 1, Math.max(1, line), 1),
          }),
        };
        mod.addGlyphMarginWidget(widget);
        store.modified.push(widget);
      }
    });

    // Commit the range-line decorations in one shot (the collection is reused; set automatically replaces the old ones).
    const deco = rangeDecoRef.current;
    if (!deco.original) deco.original = orig.createDecorationsCollection();
    if (!deco.modified) deco.modified = mod.createDecorationsCollection();
    deco.original.set(origDecos);
    deco.modified.set(modDecos);
  };

  // Imperatively create the diff editor -- mounted only once. Document/readonly/language changes are
  // synced by the incremental effects below, without rebuilding the view (rebuilding would lose the cursor, undo stack, and scroll position).
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    ensureTheme();

    const original = monaco.editor.createModel(
      leftContent,
      languageForContent(leftPath, leftContent),
    );
    const modified = monaco.editor.createModel(
      rightContent,
      languageForContent(rightPath, rightContent),
    );
    modelsRef.current = { original, modified };

    const editor = monaco.editor.createDiffEditor(host, {
      theme: themeNameFor(isDark),
      originalEditable: !leftReadonly,
      readOnly: rightReadonly,
      // Disable Monaco's built-in editor context menu: this compare tool doesn't need it (cut/copy/paste
      // still work via keyboard), and its menu text isn't localized by our i18n. Right-click stays a no-op in the body.
      contextmenu: false,
      renderSideBySide: true,
      // When width narrows, don't degrade into a single-column inline view (Monaco defaults to true): the compare page keeps fixed left/right columns.
      useInlineViewWhenSpaceIsLimited: false,
      //Lock both columns to half each, and forbid dragging to change the ratio -- otherwise the center
      // split line won't align with the outer header/footer's 50/50 flex split (defaults to 0.5 but drifts after dragging).
      splitViewDefaultRatio: 0.5,
      enableSplitViewResizing: false,
      // Turn off all of Monaco's built-in center-gutter copy/revert UI, using our own two-way copy arrows
      // below instead (left-column right arrow does left->right, right-column left arrow does right->left), like Beyond Compare.
      // Monaco 0.56 has two built-in UIs that show in the center gutter, both must be off or they overlap our custom arrows:
      //   1. renderMarginRevertIcon -- the old one-way revert arrow (revertButtonsFeature)
      //   2. renderGutterMenu       -- the new center-gutter hunk toolbar (gutterFeature), defaults to true
      renderMarginRevertIcon: false,
      renderGutterMenu: false,
      glyphMargin: true,
      // Adaptive: 'advanced' for everyday diffs, 'legacy' for large/long-line inputs where
      // 'advanced' pegs the computation-time cap (see pickDiffAlgorithm). Kept in sync on
      // content changes by the effect below.
      diffAlgorithm: pickDiffAlgorithm(original, modified),
      // In compare scenarios, expand everything by default; don't collapse unchanged regions.
      hideUnchangedRegions: { enabled: false },
      // Turn off the per-line rendering character cap (defaults to 10000): long lines are no longer truncated to "Show more (N)" and are shown in full.
      stopRenderingLineAfter: -1,
      // Wrap very long lines instead of scrolling horizontally. The diff editor's wrapping is determined by
      // diffWordWrap (it overrides the sub-editors' wordWrapOverride1), which must be explicitly set to 'on'; setting wordWrap alone has no effect.
      wordWrap: 'on',
      diffWordWrap: 'on',
      ignoreTrimWhitespace: ignoreWhitespace,
      automaticLayout: true,
      // Enable minimap at the top level: both sub-editors render a minimap. In side-by-side mode the left
      // one gets squeezed between the left column content and the center split bar, forming a gap, so styles.css
      // hides the left minimap via CSS, keeping only one on the far-right modified side (the common diff style in IDEs); its width is deducted when reporting the ratio.
      minimap: { enabled: true },
      fontSize: 12.5,
      lineHeight: 20,
      scrollBeyondLastLine: false,
      renderOverviewRuler: true,
      // Large files: soft cap of 5s; on timeout, degrade to an imprecise diff but don't freeze the UI (verified by spike).
      maxComputationTime: 5000,
      maxFileSize: 0,
    });
    editor.setModel({ original, modified });
    editorRef.current = editor;
    // setModel kicks off the first diff (the on-entry computation, the one most likely to be slow);
    // arm the progress bar so it reveals if that first diff runs long. onDidUpdateDiff disarms it.
    startProgress();

    const mod = editor.getModifiedEditor();
    const orig = editor.getOriginalEditor();
    // Emit content changes upward (symmetric on both sides). model.getValue gives the authoritative text.
    const d1 = modified.onDidChangeContent(() =>
      onChangeRef.current?.('right', modified.getValue()),
    );
    const d2 = original.onDidChangeContent(() =>
      onChangeRef.current?.('left', original.getValue()),
    );
    // Focus tracking: undo/redo/search without a side act on the side where the cursor is.
    const d3 = mod.onDidFocusEditorText(() => (lastFocusedRef.current = 'right'));
    const d4 = orig.onDidFocusEditorText(() => (lastFocusedRef.current = 'left'));
    // diff computation done -> hide the progress bar, emit stats upward, and rebuild the copy arrows
    // (triggered on the first frame and on subsequent edits).
    const d5 = editor.onDidUpdateDiff(() => {
      finishProgress();
      emitStats(editor);
      renderCopyArrows(editor);
    });
    // Left editor layout change -> report the center split bar (sash) position as a ratio of the container,
    // so the outer header/footer align precisely with Monaco's split bar. The sash sits at the original
    // editor's right edge = modified's left edge, i.e. original's full layoutInfo.width. Note: although the
    // left minimap is hidden via CSS, the original editor itself still occupies that full width (modified
    // still starts from this x), so we must not deduct minimapWidth here, or leftRatio would be too small and the right column's content would start to the left of the center split line.
    const reportSplit = () => {
      const host = hostRef.current;
      const w = orig.getLayoutInfo().width;
      const total = host?.clientWidth ?? 0;
      if (total > 0 && w > 0) onSplitRef.current?.(w / total);
    };
    const d6 = orig.onDidLayoutChange(reportSplit);
    reportSplit();

    return () => {
      d1.dispose();
      d2.dispose();
      d3.dispose();
      d4.dispose();
      d5.dispose();
      d6.dispose();
      editor.dispose();
      original.dispose();
      modified.dispose();
      editorRef.current = null;
      modelsRef.current = null;
      if (progressTimerRef.current) clearTimeout(progressTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live theme switch: Monaco's standalone theme service is a global singleton -- setTheme
  // re-highlights every editor in place (including the hidden prewarm one), keeping cursor/undo/scroll.
  useEffect(() => {
    monaco.editor.setTheme(themeNameFor(isDark));
  }, [isDark]);

  useImperativeHandle(handleRef, () => {
    const editorFor = (side: Side) =>
      side === 'left'
        ? editorRef.current!.getOriginalEditor()
        : editorRef.current!.getModifiedEditor();
    const isReadonly = (side: Side) => (side === 'left' ? leftReadonly : rightReadonly);

    // Target editor: use the given side if specified; otherwise use the "most recently focused side" (where
    // the cursor is) -- but if that side is readonly, fall back to the other writable side, and if both are
    // readonly, default to the most recently focused side (search/navigation still make sense on a readonly side). Fixes a legacy issue: without a side it always took the right side, breaking the left.
    const pick = (side?: Side): monaco.editor.IStandaloneCodeEditor | null => {
      const ed = editorRef.current;
      if (!ed) return null;
      if (side) return editorFor(side);
      const focused = lastFocusedRef.current;
      if (!isReadonly(focused)) return editorFor(focused);
      const other: Side = focused === 'left' ? 'right' : 'left';
      if (!isReadonly(other)) return editorFor(other);
      return editorFor(focused);
    };

    const clearSearch = () => {
      searchDecoRef.current.left?.clear();
      searchDecoRef.current.right?.clear();
      searchState.current = { hits: [], index: -1, opts: null };
    };

    const findAll = (
      ed: monaco.editor.IStandaloneCodeEditor,
      opts: SearchOptions,
    ): monaco.editor.FindMatch[] => {
      const model = ed.getModel();
      if (!model) return [];
      // findMatches(search, limitToViewport=false, isRegex, matchCase, wordSeparators|null, captureMatches)
      return model.findMatches(
        opts.search,
        false,
        opts.regexp ?? false,
        opts.caseSensitive ?? false,
        opts.wholeWord ? WORD_SEPARATORS : null,
        false,
      );
    };

    // Re-highlight all matches on a given side (decoration collections are cached per side to avoid cross-side bleed).
    const paintSide = (side: Side, matches: monaco.editor.FindMatch[]) => {
      const ed = editorFor(side);
      const store = searchDecoRef.current;
      if (!store[side]) store[side] = ed.createDecorationsCollection();
      store[side]!.set(
        matches.map((m) => ({
          range: m.range,
          options: { className: 'monaco-search-match', stickiness: 1 },
        })),
      );
    };

    // Search and highlight both sides together; return the merged hits (left first, right after, each keeping document order).
    const searchBothSides = (opts: SearchOptions) => {
      const leftMatches = findAll(editorFor('left'), opts);
      const rightMatches = findAll(editorFor('right'), opts);
      paintSide('left', leftMatches);
      paintSide('right', rightMatches);
      return [
        ...leftMatches.map((match) => ({ side: 'left' as Side, match })),
        ...rightMatches.map((match) => ({ side: 'right' as Side, match })),
      ];
    };

    const revealCurrent = () => {
      const st = searchState.current;
      if (st.index < 0 || !st.hits[st.index]) return;
      const { side, match } = st.hits[st.index];
      const ed = editorFor(side);
      ed.setSelection(match.range);
      ed.revealRangeInCenterIfOutsideViewport(match.range);
    };

    return {
      goNext: () => editorRef.current?.goToDiff('next'),
      goPrev: () => editorRef.current?.goToDiff('previous'),
      undo: (side?: Side) => {
        const ed = pick(side);
        if (ed) {
          ed.trigger('keyboard', 'undo', null);
          ed.focus();
        }
      },
      redo: (side?: Side) => {
        const ed = pick(side);
        if (ed) {
          ed.trigger('keyboard', 'redo', null);
          ed.focus();
        }
      },
      // Search and highlight both sides at once; navigation moves continuously over the single sequence merged from both sides' matches.
      setQuery: (opts: SearchOptions) => {
        if (!editorRef.current) return;
        if (!opts.search) {
          clearSearch();
          return;
        }
        const hits = searchBothSides(opts);
        searchState.current = { hits, index: hits.length ? 0 : -1, opts };
        revealCurrent();
      },
      findNext: () => {
        const st = searchState.current;
        if (!st.hits.length) return;
        st.index = (st.index + 1) % st.hits.length;
        revealCurrent();
        editorFor(st.hits[st.index].side).focus();
      },
      findPrev: () => {
        const st = searchState.current;
        if (!st.hits.length) return;
        st.index = (st.index - 1 + st.hits.length) % st.hits.length;
        revealCurrent();
        editorFor(st.hits[st.index].side).focus();
      },
      replaceNext: () => {
        const st = searchState.current;
        if (!st.opts || st.index < 0 || !st.hits[st.index]) return;
        const { side, match } = st.hits[st.index];
        // A readonly side can't be replaced: jump to the next match (which may land on the other side).
        if (isReadonly(side)) {
          st.index = (st.index + 1) % st.hits.length;
          revealCurrent();
          return;
        }
        editorFor(side).executeEdits('search-replace', [
          { range: match.range, text: st.opts.replace ?? '' },
        ]);
        // After the edit, match positions are stale; recompute both sides and refresh highlights; keep the index in place (modulo to prevent overflow).
        st.hits = searchBothSides(st.opts);
        st.index = st.hits.length ? st.index % st.hits.length : -1;
        revealCurrent();
      },
      replaceAll: () => {
        const st = searchState.current;
        if (!st.opts || !st.hits.length) return;
        // Batch replace per side: skip readonly sides, run only on writable sides.
        (['left', 'right'] as Side[]).forEach((side) => {
          if (isReadonly(side)) return;
          const matches = st.hits.filter((h) => h.side === side).map((h) => h.match);
          if (!matches.length) return;
          editorFor(side).executeEdits(
            'search-replace-all',
            matches.map((m) => ({ range: m.range, text: st.opts!.replace ?? '' })),
          );
        });
        clearSearch();
      },
    };
  }, [leftReadonly, rightReadonly]);

  // External value change -> symmetrically sync to each side's model (skip if the value is equal, so echo from the editor's own edits doesn't reset the cursor).
  // A real change kicks off a fresh diff, so arm the progress bar; onDidUpdateDiff disarms it when done.
  useEffect(() => {
    const model = modelsRef.current?.original;
    if (model && model.getValue() !== leftContent) startProgress();
    syncModel(model, leftContent);
  }, [leftContent]);

  useEffect(() => {
    const model = modelsRef.current?.modified;
    if (model && model.getValue() !== rightContent) startProgress();
    syncModel(model, rightContent);
  }, [rightContent]);

  // Re-pick the diff algorithm after content changes: switching files (or a large edit) can
  // move the input across the size threshold, so keep 'advanced'/'legacy' in sync. updateOptions
  // reconfigures the diff model reactively and recomputes without rebuilding the editor.
  useEffect(() => {
    const editor = editorRef.current;
    const models = modelsRef.current;
    if (!editor || !models) return;
    editor.updateOptions({ diffAlgorithm: pickDiffAlgorithm(models.original, models.modified) });
  }, [leftContent, rightContent]);

  // Hot-swap the language (content-dependent too: a very-long-line file demotes to plaintext).
  useEffect(() => {
    const model = modelsRef.current?.original;
    if (model) monaco.editor.setModelLanguage(model, languageForContent(leftPath, leftContent));
  }, [leftPath, leftContent]);

  useEffect(() => {
    const model = modelsRef.current?.modified;
    if (model) monaco.editor.setModelLanguage(model, languageForContent(rightPath, rightContent));
  }, [rightPath, rightContent]);

  // Hot-swap the readonly state (left = negation of originalEditable, right = readOnly).
  useEffect(() => {
    editorRef.current?.updateOptions({ originalEditable: !leftReadonly });
  }, [leftReadonly]);

  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly: rightReadonly });
  }, [rightReadonly]);

  // Rebuild the direction arrows after a readonly-state change (which side is writable decides which side shows an arrow).
  // Also rebuild on language change so the arrows' title tooltips pick up the new copy.
  useEffect(() => {
    const ed = editorRef.current;
    if (ed) renderCopyArrows(ed);
  }, [leftReadonly, rightReadonly, t]);

  // Hot-swap ignore-whitespace (also triggers a recompute, so arm the progress bar).
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    startProgress();
    editor.updateOptions({ ignoreTrimWhitespace: ignoreWhitespace });
  }, [ignoreWhitespace]);

  return (
    <div className="monaco-merge-host relative flex-1 min-h-0 overflow-hidden">
      <div ref={hostRef} className="absolute inset-0" />
      {/* Indeterminate "computing diff" bar: pinned to the bottom edge, spanning both columns. Only
          shown for slow diffs (armed with a delay), and the worker reports no percentage, so it's a
          sliding sweep rather than a real progress value. */}
      {computing && (
        <div className="monaco-diff-progress" role="progressbar" aria-label={t('computingDiff')} />
      )}
    </div>
  );
}
