// The timeline panel's geometry (pure: no React, no DOM, so it's tested in tests/timeline-layout.test.js):
// where each track's row is, which rows are on screen, how tall the panel may be, what a wheel or
// trackpad gesture does, and how fast to scroll while a drag is held near an edge.

export const RULER = 26; // the time ruler's height
export const HEADER_W = 160; // the track names' column
export const COLLAPSED_ROW = 16; // a collapsed track: a thin row with its clips as bars
export const MIN_ROW = 28;
export const MAX_ROW = 240;
export const BAR = 40; // the collapsed panel: one slim bar
export const MAX_SHARE = 0.8; // the panel may take this much of the window's height
export const DEFAULT_SHARE = 0.45; // and starts at most this tall

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// How the panel looks, as kept with the project (backend panelview.py) — keep the two in sync.
//   mode: open | collapsed | closed | max · height: px (null: the default) · follow: the view follows
//   the playhead while playing · hide_empty: hide tracks with nothing on them · sheet (phones):
//   closed | open | expanded · tracks: {id: {collapsed, height}}
export const DEFAULT_VIEW = { mode: 'open', height: null, follow: true, hide_empty: false, sheet: 'open', tracks: {} };

export function normalizeView(v) {
  const out = { ...DEFAULT_VIEW, ...(v || {}) };
  if (!['open', 'collapsed', 'closed', 'max'].includes(out.mode)) out.mode = 'open';
  if (!['closed', 'open', 'expanded'].includes(out.sheet)) out.sheet = 'open';
  out.height = Number.isFinite(out.height) ? Math.round(out.height) : null;
  out.follow = out.follow !== false;
  out.hide_empty = !!out.hide_empty;
  const tracks = {};
  for (const [id, t] of Object.entries(out.tracks || {})) {
    const height = Number.isFinite(t?.height) ? clamp(Math.round(t.height), MIN_ROW, MAX_ROW) : null;
    if (t?.collapsed || height !== null) tracks[id] = { collapsed: !!t?.collapsed, height };
  }
  out.tracks = tracks;
  return out;
}

// One row per track, in the tracks' order (hidden empty ones left out):
// [{id, top, height, collapsed}], `top` measured from just under the ruler.
// base: {track id: its usual height}; empty(track): whether it has nothing on it.
export function layoutRows(tracks, { base, view, empty = () => false }) {
  const rows = [];
  let top = 0;
  for (const t of tracks) {
    if (view.hide_empty && empty(t)) continue;
    const own = view.tracks[t.id] || {};
    const height = own.collapsed ? COLLAPSED_ROW : clamp(own.height ?? base[t.id] ?? 40, MIN_ROW, MAX_ROW);
    rows.push({ id: t.id, top, height, collapsed: !!own.collapsed });
    top += height;
  }
  return rows;
}

export const rowsHeight = (rows) => rows.reduce((h, r) => h + r.height, 0);
export const rowOf = (rows, id) => rows.find((r) => r.id === id) || null;

// The rows in (or near) the visible part, scrolled `top` pixels down a view `height` tall (both
// measured under the ruler). Rows further away aren't drawn.
export function visibleRowIds(rows, top, height, margin = 120) {
  return new Set(rows.filter((r) => r.top + r.height >= top - margin && r.top <= top + height + margin).map((r) => r.id));
}

// How tall the panel may be: at least its tools, the ruler and one track; at most MAX_SHARE of the
// window. `chrome`: the panel's own height without the tracks (title row, tools, borders).
export function panelBounds({ windowHeight, chrome, firstRow }) {
  const min = Math.round(chrome + RULER + (firstRow || MIN_ROW));
  return { min, max: Math.max(min, Math.round(windowHeight * MAX_SHARE)) };
}

// Its height when nobody has chosen one: everything fits, up to DEFAULT_SHARE of the window.
export function defaultPanelHeight({ windowHeight, chrome, rowsTotal }) {
  const bounds = panelBounds({ windowHeight, chrome, firstRow: 0 });
  const natural = Math.round(chrome + RULER + rowsTotal);
  return clamp(natural, bounds.min, Math.max(bounds.min, Math.round(windowHeight * DEFAULT_SHARE)));
}

// What a wheel or trackpad gesture over the tracks does:
//   Ctrl/⌘ (and a trackpad pinch, which arrives as Ctrl + wheel) → zoom, around the pointer
//   Shift → move through time; a sideways swipe → the browser scrolls sideways itself
//   up/down → the browser scrolls the tracks; when they all fit, it moves through time instead
// Returns {kind: 'zoom' | 'x' | 'native', amount} (amount: pixels for 'x', a zoom factor for 'zoom').
export function wheelIntent(e, { canScrollY }) {
  const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY; // lines → pixels
  const dx = e.deltaMode === 1 ? e.deltaX * 16 : e.deltaX;
  if (e.ctrlKey || e.metaKey) return { kind: 'zoom', amount: Math.exp(-dy * 0.0025) };
  if (e.shiftKey) return { kind: 'x', amount: Math.abs(dx) > Math.abs(dy) ? dx : dy };
  if (Math.abs(dx) >= Math.abs(dy)) return { kind: 'native', amount: 0 };
  if (!canScrollY) return { kind: 'x', amount: dy };
  return { kind: 'native', amount: 0 };
}

// While a clip or edge is dragged near the edge of the tracks, scroll that way: pixels per frame,
// faster the closer to the edge (negative: up / left). `pos` and the edges in the same coordinates.
export function edgeSpeed(pos, start, end, zone = 36, fastest = 22) {
  if (end - start < zone * 2) return 0;
  if (pos < start + zone) return -Math.ceil(fastest * Math.min(1, (start + zone - pos) / zone));
  if (pos > end - zone) return Math.ceil(fastest * Math.min(1, (pos - (end - zone)) / zone));
  return 0;
}

// The scroll offset that brings [a, b] into a view showing [offset, offset + size], moving as
// little as possible (with `margin` to spare); a span bigger than the view shows its start.
export function reveal(offset, size, a, b, margin = 24) {
  if (b - a > size - 2 * margin) return Math.max(0, a - margin);
  if (a < offset + margin) return Math.max(0, a - margin);
  if (b > offset + size - margin) return b - size + margin;
  return offset;
}
