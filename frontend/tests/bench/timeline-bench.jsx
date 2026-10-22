// A made-up project for timeline-bench.html: a video of `minutes`, a sentence every ~2 seconds, and
// `tracks` tracks (the five usual ones, then more music tracks and tracks of other kinds).
import { useCallback, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/index.css';
import Timeline from '../../src/components/editor/timeline/Timeline.jsx';
import TimelineDock from '../../src/components/editor/timeline/TimelineDock.jsx';
import { normalizeView } from '../../src/components/editor/timeline/layout.js';

const params = new URLSearchParams(window.location.search);
const MINUTES = Number(params.get('minutes') || 60);
const TRACK_COUNT = Number(params.get('tracks') || 12);
const LENGTH = MINUTES * 60;
const r3 = (t) => Math.round(t * 1000) / 1000;

function makeProject() {
  const video = [];
  const background = [];
  for (let t = 0, i = 1; t < LENGTH; t += 60, i += 1) {
    const end = Math.min(LENGTH, t + 60);
    video.push({ id: `v${i}`, type: 'video', media: 'source', start: t, end, source_in: t, source_out: end, speed: 1, skipped: false });
    background.push({ id: `b${i}`, type: 'audio', media: 'source', link: `v${i}`, start: t, end, source_in: t, source_out: end, volume: 100, muted: false, fade_in: 0, fade_out: 0, keep_voice: false, skipped: false });
  }
  const sentences = [];
  for (let t = 0.5, i = 1; t < LENGTH - 2; i += 1) {
    const length = 1 + ((i * 7) % 13) / 10;
    sentences.push({ id: `s${i}`, type: 'voice', start: r3(t), end: r3(t + length), khmer_text: `ប្រយោគទី ${i}`, subtitle_text: null, original_text: '', status: 'ok', audio_duration: length * 0.9, audio_url: null, voice_warning: null, skipped: false, volume: 100, muted: false, subtitle_timing: null });
    t += length + 0.3 + ((i * 3) % 5) / 10;
  }
  const clipsEvery = (prefix, every, length, extra = {}) => {
    const out = [];
    for (let t = 3, i = 1; t < LENGTH - length; t += every, i += 1) out.push({ id: `${prefix}${i}`, start: t, end: t + length, skipped: false, ...extra });
    return out;
  };
  const track = (id, kind, clips, more = {}) => ({ id, kind, locked: false, muted: false, hidden: false, clips, ...more });
  const tracks = [
    track('video', 'video', video),
    track('voice', 'voice', [], { volume: 100 }),
    track('text', 'text', clipsEvery('t', 45, 4, { type: 'text', text: 'ផ្សាយពាណិជ្ជកម្ម' })),
    track('background', 'background', background, { volume: 100, duck: { on: false, level: 30, fade: 0.3 } }),
    track('audio', 'audio', clipsEvery('a', 120, 30, { type: 'audio', media: 'm1', source_in: 0, source_out: 30, volume: 80, muted: false, fade_in: 0, fade_out: 0 }), { volume: 100, duck: { on: false, level: 30, fade: 0.3 } }),
  ];
  for (let k = 6; k <= TRACK_COUNT; k += 1) { // more tracks: other kinds get the plain lane
    const kind = k % 2 ? 'overlay' : `fx${k}`;
    tracks.push(track(`${kind}${k}`, kind, clipsEvery(`x${k}_`, 20 + k, 6, { type: kind, name: `${kind} clip` }), { name: `${kind === 'overlay' ? 'Overlay' : 'Effects'} ${k}` }));
  }
  return {
    tracks, sentences,
    project: { id: 'bench', video: { fps: 30, duration: LENGTH, width: 1920, height: 1080 }, settings: { background: 'duck', background_volume: 0.15 }, background_url: null,
      media: { source: { kind: 'video', duration: LENGTH, name: 'bench.mp4' }, m1: { kind: 'audio', duration: 30, name: 'music.m4a' } } },
  };
}

// Stand-ins for the editor's playback and tools: enough for the timeline to draw and scroll.
function makePlayback() {
  const subs = new Set();
  const p = {
    t: 0, duration: LENGTH, playing: false,
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    seek(t) { p.t = Math.max(0, Math.min(LENGTH, t)); subs.forEach((fn) => fn({ t: p.t, playing: p.playing })); },
    pause() { p.playing = false; }, toggle() {}, step() {}, playRange() {},
  };
  return p;
}
const noop = () => {};
const tools = new Proxy({ picked: [], range: null, full: null, gap: null, asking: null, locked: () => false }, { get: (o, k) => (k in o ? o[k] : noop) });

function Bench() {
  const { project, tracks, sentences } = useMemo(makeProject, []);
  const playback = useMemo(makePlayback, []);
  const [view, setView] = useState(() => normalizeView({}));
  const update = useCallback((patch) => setView((v) => normalizeView(typeof patch === 'function' ? patch(v) : { ...v, ...patch })), []);
  const setTrack = useCallback((id, patch) => update((v) => ({ ...v, tracks: { ...v.tracks, [id]: { ...(v.tracks[id] || {}), ...patch } } })), [update]);
  const [selection, setSelection] = useState([]);
  window.bench = { tracks: tracks.length, sentences: sentences.length, minutes: MINUTES, playback, select: setSelection };
  return (
    <div className="flex h-screen flex-col gap-3 bg-canvas p-3 text-ink">
      <p className="text-sm text-muted">Timeline bench: {tracks.length} tracks · {MINUTES} minutes · {sentences.length} sentences</p>
      <div className="min-h-0 flex-1" />
      <TimelineDock view={view} update={update} playback={playback} fps={30}>
        {({ controls, onMeasure }) => (
          <Timeline project={project} tracks={tracks} sentences={sentences} media={project.media} playback={playback} selection={selection}
            onSelect={setSelection} onTiming={noop} onAdd={noop} onTrack={noop} tools={tools} menuFor={() => ({ items: [] })} locked={false}
            onSubtitleEdit={noop} onClipDouble={noop} onDropMedia={noop} onDropFiles={noop} waves={{}} sound={tools} onMixer={noop}
            filmstrip={null} waveform={null} voiceRemoved={false}
            layout={view} onLayout={update} onTrackLayout={setTrack} controls={controls} onMeasure={onMeasure} />
        )}
      </TimelineDock>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<Bench />);
