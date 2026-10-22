// The timeline panel's geometry (src/components/editor/timeline/layout.js).
// Run: npm test  (node --test, no extra packages)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BAR, COLLAPSED_ROW, DEFAULT_VIEW, MAX_ROW, MIN_ROW, RULER, defaultPanelHeight, edgeSpeed, layoutRows, normalizeView, panelBounds,
  reveal, rowOf, rowsHeight, visibleRowIds, wheelIntent,
} from '../src/components/editor/timeline/layout.js';

const BASE = { video: 52, voice: 54, text: 40, background: 48, audio: 40 };
const five = ['video', 'voice', 'text', 'background', 'audio'].map((id) => ({ id, kind: id, clips: id === 'audio' ? [] : [{ id: `${id}1` }] }));
const empty = (t) => !t.clips.length;

test('rows follow the tracks, each at its usual height', () => {
  const rows = layoutRows(five, { base: BASE, view: normalizeView() });
  assert.deepEqual(rows.map((r) => [r.id, r.top, r.height]), [['video', 0, 52], ['voice', 52, 54], ['text', 106, 40], ['background', 146, 48], ['audio', 194, 40]]);
  assert.equal(rowsHeight(rows), 234);
  assert.equal(rowOf(rows, 'text').top, 106);
  assert.equal(rowOf(rows, 'nope'), null);
});

test('a track can be taller, shorter (within limits) or collapsed', () => {
  const view = normalizeView({ tracks: { voice: { height: 120 }, text: { collapsed: true }, background: { height: 5 }, audio: { height: 9999 } } });
  const rows = layoutRows(five, { base: BASE, view });
  assert.deepEqual(rows.map((r) => r.height), [52, 120, COLLAPSED_ROW, MIN_ROW, MAX_ROW]);
  assert.equal(rowOf(rows, 'text').collapsed, true);
  assert.equal(rowOf(rows, 'background').top, 52 + 120 + COLLAPSED_ROW);
});

test('empty tracks can be hidden', () => {
  const rows = layoutRows(five, { base: BASE, view: normalizeView({ hide_empty: true }), empty });
  assert.deepEqual(rows.map((r) => r.id), ['video', 'voice', 'text', 'background']);
});

test('any number of tracks, in their order; unknown ones get a usual height', () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ id: `t${i}`, clips: [] }));
  const rows = layoutRows(many, { base: {}, view: normalizeView() });
  assert.equal(rows.length, 12);
  assert.equal(rows[11].top, 11 * 40);
  const shown = visibleRowIds(rows, 200, 120, 0); // scrolled 200 px down, 120 px of view
  assert.deepEqual([...shown], ['t4', 't5', 't6', 't7', 't8']);
});

test('a saved view is checked and tidied', () => {
  assert.deepEqual(normalizeView(null), DEFAULT_VIEW);
  const v = normalizeView({ mode: 'huge', sheet: 'x', height: 333.6, follow: 0, tracks: { a: { height: 2 }, b: { collapsed: false }, c: { collapsed: true } } });
  assert.equal(v.mode, 'open');
  assert.equal(v.sheet, 'open');
  assert.equal(v.height, 334);
  assert.equal(v.follow, true); // only an explicit false turns it off
  assert.deepEqual(v.tracks, { a: { collapsed: false, height: MIN_ROW }, c: { collapsed: true, height: null } });
});

test('the panel is at least tools + ruler + one track, at most 80% of the window', () => {
  const b = panelBounds({ windowHeight: 1000, chrome: 90, firstRow: 52 });
  assert.deepEqual(b, { min: 90 + RULER + 52, max: 800 });
  assert.deepEqual(panelBounds({ windowHeight: 150, chrome: 90, firstRow: 52 }), { min: 168, max: 168 }); // tiny window: min wins
  assert.equal(defaultPanelHeight({ windowHeight: 1000, chrome: 90, rowsTotal: 234 }), 90 + RULER + 234); // fits
  assert.equal(defaultPanelHeight({ windowHeight: 600, chrome: 90, rowsTotal: 900 }), 270); // capped at 45%
  assert.ok(BAR < b.min);
});

test('wheel and trackpad gestures', () => {
  const w = (o) => ({ deltaX: 0, deltaY: 0, deltaMode: 0, ctrlKey: false, metaKey: false, shiftKey: false, ...o });
  assert.equal(wheelIntent(w({ deltaY: 100, ctrlKey: true }), { canScrollY: true }).kind, 'zoom');
  assert.ok(wheelIntent(w({ deltaY: 100, metaKey: true }), { canScrollY: true }).amount < 1); // down = out
  assert.ok(wheelIntent(w({ deltaY: -100, ctrlKey: true }), { canScrollY: true }).amount > 1); // pinch out = in
  assert.deepEqual(wheelIntent(w({ deltaY: 30, shiftKey: true }), { canScrollY: true }), { kind: 'x', amount: 30 });
  assert.deepEqual(wheelIntent(w({ deltaY: 3, deltaMode: 1, shiftKey: true }), { canScrollY: true }), { kind: 'x', amount: 48 }); // lines
  assert.equal(wheelIntent(w({ deltaX: 40, deltaY: 5 }), { canScrollY: true }).kind, 'native'); // sideways swipe
  assert.equal(wheelIntent(w({ deltaY: 40 }), { canScrollY: true }).kind, 'native'); // tracks scroll
  assert.deepEqual(wheelIntent(w({ deltaY: 40 }), { canScrollY: false }), { kind: 'x', amount: 40 }); // nothing to scroll: time
});

test('dragging near an edge scrolls, faster closer to it', () => {
  assert.equal(edgeSpeed(200, 0, 400), 0);
  assert.ok(edgeSpeed(10, 0, 400) < 0);
  assert.ok(edgeSpeed(395, 0, 400) > 0);
  assert.ok(Math.abs(edgeSpeed(2, 0, 400)) > Math.abs(edgeSpeed(30, 0, 400)));
  assert.equal(edgeSpeed(-50, 0, 400), -22); // past the edge: full speed
  assert.equal(edgeSpeed(5, 0, 60), 0); // too small to tell the edges apart
});

test('revealing a clip moves the view as little as possible', () => {
  assert.equal(reveal(100, 400, 200, 300), 100); // already shown
  assert.equal(reveal(100, 400, 50, 80), 26); // just left of the view
  assert.equal(reveal(100, 400, 520, 560), 184); // just right
  assert.equal(reveal(100, 400, 900, 2000), 876); // too long: show its start
  assert.equal(reveal(100, 400, 10, 20), 0); // never before the start
});
