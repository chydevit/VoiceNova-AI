// Watermarks: where they sit (any size and shape of picture), the safe area, snapping, the subtitle
// check, and the same animation and hidden parts as the export (backend/tests/test_watermarks.py).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  SAFE_AREA, animationAt, awayFrom, hiddenRanges, logoSize, overlapsBand, placeBox, snapBox, subtitleBand, watermarkDefaults,
} from '../src/lib/watermark.js';

const w = (patch = {}) => ({ ...watermarkDefaults('image'), ...patch });
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} ≠ ${b}`);

test('size and place are percents of the picture', () => {
  const logo = { width: 400, height: 200 };
  for (const [W, H] of [[1920, 1080], [1280, 720], [1080, 1080]]) {
    const size = logoSize(w({ width: 10 }), W, H, logo);
    near(size.width, W * 0.1, 'width');
    near(size.height, W * 0.05, 'keeps the logo’s shape');
    const box = placeBox(w({ anchor: 'bottom-right', margin: 4, safe_area: false }), W, H, size);
    const m = Math.min(W, H) * 0.04;
    near(box.x + box.width, W - m, 'right edge at the margin');
    near(box.y + box.height, H - m, 'bottom edge at the margin');
  }
  const free = placeBox(w({ anchor: 'free', x: 25, y: 75 }), 1000, 500, { width: 100, height: 50 });
  assert.deepEqual([free.x + 50, free.y + 25], [250, 375]); // its middle at x %, y %
  const stretched = logoSize(w({ width: 10, height: 20 }), 1000, 500, logo);
  assert.deepEqual([stretched.width, stretched.height], [100, 100]); // shape unlocked
  const centred = placeBox(w({ anchor: 'center' }), 1000, 500, { width: 100, height: 50 });
  assert.deepEqual([centred.x, centred.y], [450, 225]);
});

test('9:16 keeps it inside the safe area', () => {
  const [W, H] = [1080, 1920];
  const size = { width: 200, height: 100 };
  const m = W * 0.04;
  const safe = placeBox(w({ anchor: 'bottom-right' }), W, H, size);
  near(safe.x + safe.width, W - (W * SAFE_AREA.right) / 100 - m, 'clear of the buttons on the right');
  near(safe.y + safe.height, H - (H * SAFE_AREA.bottom) / 100 - m, 'clear of the caption at the bottom');
  const top = placeBox(w({ anchor: 'top-left' }), W, H, size);
  near(top.y, (H * SAFE_AREA.top) / 100 + m, 'below the top bar');
  const off = placeBox(w({ anchor: 'bottom-right', safe_area: false }), W, H, size);
  near(off.y + off.height, H - m, 'safe area off: the picture’s edge');
  const wide = placeBox(w({ anchor: 'bottom-right' }), 1920, 1080, size); // not 9:16: the whole picture
  near(wide.y + wide.height, 1080 - 1080 * 0.04, '16:9 ignores it');
});

test('snapping to edges and the middle', () => {
  const W = 1000;
  const H = 500;
  const m = 20; // 4 % of 500
  const s = snapBox({ x: m + 5, y: H - m - 50 - 3, width: 100, height: 50 }, w({ safe_area: false }), W, H, 8);
  assert.deepEqual([s.x, s.y, s.anchor], [m, H - m - 50, 'bottom-left']);
  const mid = snapBox({ x: 452, y: 100, width: 100, height: 50 }, w(), W, H, 8);
  assert.equal(mid.x, 450);
  assert.equal(mid.anchor, null); // only one side snapped: placed freely
  assert.equal(mid.guides.length, 1);
});

test('the subtitle check and moving away from it', () => {
  const W = 1920;
  const H = 1080;
  const band = subtitleBand({ size: 5.5, margin: 7, position: 'bottom' }, W, H);
  assert.ok(band.bottom < H && band.top < band.bottom);
  const size = { width: 400, height: 200 };
  assert.equal(overlapsBand(w({ anchor: 'bottom-center', safe_area: false }), W, H, size, band), true);
  assert.equal(overlapsBand(w({ anchor: 'top-center' }), W, H, size, band), false);
  assert.equal(awayFrom('bottom-center', 'bottom'), 'top-center');
  assert.equal(awayFrom('bottom-left', 'bottom'), 'top-left');
  assert.equal(awayFrom('top-right', 'top'), 'bottom-right');
});

// The same numbers as the export: backend/tests/test_watermarks.py writes them (parity_cases).
test('animation and hidden parts match the export', () => {
  const fixture = JSON.parse(readFileSync(new URL('../../backend/tests/fixtures/watermark_parity.json', import.meta.url), 'utf-8'));
  let n = 0;
  for (const { w: mark, samples } of fixture.animations) {
    for (const [since, until, alpha, anchor] of samples) {
      const got = animationAt(mark, since, until);
      near(got.alpha, alpha, `${mark.animation.type} at ${since}`);
      assert.equal(got.anchor, anchor, `${mark.animation.type} at ${since}`);
      n += 1;
    }
  }
  assert.ok(n > 5000);
  const { timeline, media, ranges } = fixture.hidden;
  for (const [hide, want] of Object.entries(ranges)) {
    assert.deepEqual(hiddenRanges(timeline.tracks, media, hide ? hide.split(',') : []), want, hide);
  }
});
