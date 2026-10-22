// The browser's edit-list maths must match the backend's (backend/tests/test_render.py).
// Run: npm test  (node --test, no extra packages)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  canvasSize, clipAt, keptRanges, keysAt, levelOf, outputTime, runGain, skippedRanges, snapTo, soundRuns, speech, subtitleLines, timecode,
  trackOf, voiceGain, volume, withVoice,
} from '../src/lib/timeline.js';

const piece = (start, end, vol = 100, extra = {}) => ({ id: `b${start}`, type: 'audio', media: 'source', link: 'v1', start, end, source_in: start, source_out: end, volume: vol, muted: false, fade_in: 0, fade_out: 0, keep_voice: false, skipped: false, ...extra });
const duck = { on: false, level: 10, fade: 0.3 };
const tracksOf = ({ video, background = [], voice = [], text = [], audio = [], level = 100 }) => withVoice({
  tracks: [
    { id: 'video', clips: video, locked: false, hidden: false, muted: false },
    { id: 'voice', clips: [], locked: false, hidden: false, muted: false, volume: 100 },
    { id: 'text', clips: text, locked: false, hidden: false, muted: false },
    { id: 'background', clips: background, locked: false, hidden: false, muted: false, volume: level, duck },
    { id: 'audio', clips: audio, locked: false, hidden: false, muted: false, volume: 100, duck },
  ],
}, voice);
const whole = [{ id: 'v1', type: 'video', media: 'source', start: 0, end: 100, source_in: 0, source_out: 100, speed: 1, skipped: false }];

// The old export's level (schema 2): normal, times 1 + Σ (gain − 1) · ramp inside each part.
function oldLevel(normal, parts, t) {
  let factor = 1;
  for (const p of parts) factor += (p.gain - 1) * Math.min(1, Math.max(0, Math.min(t - p.start, p.end - t) / Math.max(p.fade, 0.01)));
  return normal * Math.max(0, factor);
}

test('background levels match the old export', () => {
  // the migrated form of parts {10–20 silent, fade 1} and {50–60 at 50 %, fade 0.05}
  const background = [piece(0, 10), piece(10, 20, 0, { fade_in: 1, fade_out: 1 }), piece(20, 50), piece(50, 60, 50, { fade_in: 0.05, fade_out: 0.05 }), piece(60, 100)];
  const runs = soundRuns(tracksOf({ video: whole, background, level: 15 }), { background: 'duck' }, false);
  assert.equal(runs.length, 1);
  const parts = [{ start: 10, end: 20, gain: 0, fade: 1 }, { start: 50, end: 60, gain: 0.5, fade: 0.05 }];
  for (let t = 0.05; t < 99.95; t += 0.013) {
    assert.ok(Math.abs(levelOf(runs, 'original', 'source', t) - oldLevel(0.15, parts, t)) < 1e-6, `t=${t}`);
  }
});

test('separate mode: the stem, and the original voice where it is kept', () => {
  const background = [piece(0, 10), piece(10, 20, 100, { keep_voice: true }), piece(20, 100)];
  const runs = soundRuns(tracksOf({ video: whole, background, level: 80 }), { background: 'separate' }, true);
  assert.ok(Math.abs(levelOf(runs, 'stem', 'source', 5) - 0.8) < 1e-9);
  assert.equal(levelOf(runs, 'stem', 'source', 15), 0);
  assert.equal(levelOf(runs, 'original', 'source', 15), 1);
  assert.equal(levelOf(runs, 'original', 'source', 5), 0);
});

test('a ramp across a join is one straight line', () => {
  const pieces = [
    { start: 0, end: 10, level: 1, keys: null, source_in: 0, fade_in: 0.01, fade_out: 0, lead_in: 0, lead_out: 1 },
    { start: 10, end: 20, level: 0, keys: null, source_in: 10, fade_in: 1, fade_out: 0.01, lead_in: 0, lead_out: 0 },
  ];
  const run = { start: 0, end: 20, speed: 1, pieces, duck: null };
  assert.equal(runGain(run, 10), 1);
  assert.equal(runGain(run, 10.5), 0.5);
  assert.equal(runGain(run, 11), 0);
});

test('volumes are whole percents, 0–200', () => {
  assert.equal(volume(37.4), 37);
  assert.equal(volume(-5), 0);
  assert.equal(volume(250), 200);
  assert.equal(keysAt([{ at: 0, v: 0 }, { at: 10, v: 100 }], 2.5), 25);
  assert.equal(keysAt([{ at: 0, v: 0 }, { at: 10, v: 100 }], 12), 100); // level after the last point
  const runs = soundRuns(tracksOf({ video: whole, background: [piece(0, 100, 50)], level: 1 }), { background: 'duck' }, false);
  assert.ok(Math.abs(levelOf(runs, 'original', 'source', 50) - 0.005) < 1e-12); // 1 % of the track, times the piece's 50 %
});

// The same numbers as the export: backend/tests/test_volume.py writes them (parity_cases).
test('levels match the export exactly', () => {
  const { cases } = JSON.parse(readFileSync(new URL('../../backend/tests/fixtures/volume_parity.json', import.meta.url), 'utf-8'));
  assert.equal(cases.length, 2);
  for (const c of cases) {
    const tracks = withVoice(c.timeline, c.sentences);
    assert.deepEqual(speech(tracks).map(([a, b]) => [Math.round(a * 1e6) / 1e6, Math.round(b * 1e6) / 1e6]),
      c.speech.map(([a, b]) => [Math.round(a * 1e6) / 1e6, Math.round(b * 1e6) / 1e6]));
    const runs = soundRuns(tracks, c.settings, c.stem_ready);
    for (const [t, media, stream, want] of c.levels) {
      const got = levelOf(runs, stream, media, t);
      assert.ok(Math.abs(got - want) < 1e-9, `${media} ${stream} at ${t}: ${got} ≠ ${want}`);
    }
    const voiceVolume = trackOf(tracks, 'voice').volume;
    for (const [sid, local, plays, cut, want] of c.voice) {
      const s = c.sentences.find((x) => x.id === sid);
      const got = voiceGain(s, local, plays, cut) * (voiceVolume / 100);
      assert.ok(Math.abs(got - want) < 1e-9, `${sid} at ${local}: ${got} ≠ ${want}`);
    }
  }
});

test('skipped parts', () => {
  const video = [
    { ...whole[0], end: 10, source_out: 10 },
    { ...whole[0], id: 'v2', start: 10, end: 20, source_in: 10, source_out: 20, skipped: true },
    { ...whole[0], id: 'v3', start: 20, source_in: 20 },
  ];
  const skipped = skippedRanges(tracksOf({ video }));
  assert.deepEqual(skipped, [{ start: 10, end: 20 }]);
  assert.deepEqual(keptRanges(skipped, 100), [[0, 10], [20, 100]]);
  assert.equal(outputTime(25, skipped), 15);
  assert.equal(clipAt(video, 15).id, 'v2');
  assert.equal(clipAt(video, 100), null);
});

test('subtitles keep half a second and never run into the next', () => {
  const voice = [
    { id: 's1', start: 1, end: 1.2, khmer_text: 'ក', subtitle_text: null, skipped: false },
    { id: 's2', start: 1.4, end: 3, khmer_text: 'ខ', subtitle_text: 'គ', skipped: false },
    { id: 's3', start: 5, end: 6, khmer_text: 'ឃ', subtitle_text: null, skipped: true },
  ];
  const lines = subtitleLines(tracksOf({ video: whole, voice }));
  assert.deepEqual(lines.map((l) => [l.id, l.text, l.start, l.end]), [['s1', 'ក', 1, 1.4], ['s2', 'គ', 1.4, 3]]);
});

test('canvas sizes match the export', () => {
  const p = (w, h, e) => ({ video: { width: w, height: h }, settings: { export: e } });
  assert.deepEqual(canvasSize(p(1920, 1080, { aspect: '9:16', resolution: '720p' })), { width: 720, height: 1280 });
  assert.deepEqual(canvasSize(p(1920, 1080, { aspect: '1:1', resolution: 'original' })), { width: 1080, height: 1080 });
  assert.deepEqual(canvasSize(p(1920, 1080, { aspect: 'original', resolution: '720p' })), { width: 1280, height: 720 });
  assert.deepEqual(canvasSize(p(576, 1022, {})), { width: 576, height: 1022 });
});

test('timecode and snapping', () => {
  assert.equal(timecode(62.5, 30), '1:02.15');
  assert.equal(timecode(0, 25), '0:00.00');
  assert.equal(snapTo(10.03, [10, 20], 100), 10); // 3 px away
  assert.equal(snapTo(10.2, [10, 20], 100), 10.2); // 20 px away: no snap
});
