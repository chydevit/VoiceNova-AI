import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { formatTime } from '../../api.js';
import { token, useTheme } from '../../lib/theme.js';
import { DEFAULT_FADE, gainAt, partLabel } from '../../lib/background.js';

const MIN_LENGTH = 0.3; // keep in sync with backend/sentences.py
const SNAP = 0.05; // dragged times snap to 50 ms
const RULER = 24;
const VIDEO = 44;
const VOICE = 56;
const BACKGROUND = 52;
const MIN_CUT = 0.1; // shortest cut, in seconds

// The two lanes you can cut: remove part of the video, or silence part of the background.
const LANES = {
  video: { key: 'video_cuts', verb: 'Remove', icon: '✂', done: 'removed', tip: 'Remove this part from the video (Delete)', restore: 'Put this part back into the video' },
  background: { key: 'background_cuts', verb: 'Silence', icon: '🔇', done: 'silent', tip: 'Silence the background here (Delete)', restore: 'Restore the background here' },
};
const TICK_STEPS = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];

const BLOCK = {
  ok: 'border-accent/60 bg-accent-soft',
  too_long: 'border-amber-500 bg-amber-500/15',
  edited: 'border-dashed border-line-strong bg-panel',
  regenerating: 'border-accent/60 bg-accent-soft animate-pulse',
  failed: 'border-red-500/70 bg-red-500/15',
  empty: 'border-dashed border-line-strong bg-raised',
};

const snap = (t) => Math.round(t / SNAP) * SNAP;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round3 = (t) => Math.round(t * 1000) / 1000;

const HATCH = { backgroundImage: 'repeating-linear-gradient(135deg, var(--line-strong) 0 1px, transparent 1px 6px)' };
// A background part's look: silent (hatched), quieter (amber) or louder (green).
const PART_STYLE = (p) => ((p.gain ?? 0) === 0 ? 'border-line-strong bg-sunken/70' : p.gain < 1 ? 'border-amber-500/70 bg-amber-500/15' : 'border-emerald-500/70 bg-emerald-500/15');
const REMOVED_HATCH = { backgroundImage: 'repeating-linear-gradient(135deg, rgb(239 68 68 / 0.55) 0 2px, transparent 2px 8px)' };

// A number box that saves on Enter or when you leave it.
function TimeBox({ value, onCommit, label, min = 0, max }) {
  const [text, setText] = useState(value.toFixed(2));
  useEffect(() => { setText(value.toFixed(2)); }, [value]);
  const commit = () => {
    const v = Number(text);
    if (Number.isFinite(v) && Math.abs(v - value) > 0.0005) onCommit(clamp(v, min, max ?? v));
    else setText(value.toFixed(2));
  };
  return (
    <input type="number" step="0.1" aria-label={label} title={`${label} (seconds)`} value={text} onChange={(e) => setText(e.target.value)}
      onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      className="w-[4.4rem] rounded-md border border-line-strong bg-panel px-1.5 py-0.5 font-mono text-xs tabular-nums text-ink focus:border-accent focus:outline-none" />
  );
}

// The bar above the tracks for the selected part: exact times, and (background) volume and fade.
function PartBar({ lane, part, lo, hi, onChange, onRestore, onClose }) {
  const [gain, setGain] = useState(part.gain ?? 0);
  useEffect(() => { setGain(part.gain ?? 0); }, [part.gain]);
  const isVideo = lane === 'video';
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-accent/40 bg-accent-soft px-2.5 py-1.5 text-xs">
      <span className="font-semibold text-accent-ink">{isVideo ? '✂ Removed from the video' : `Background ${partLabel({ gain })}`}</span>
      <span className="flex items-center gap-1 text-muted">
        <TimeBox label="Start" value={part.start} min={lo} max={part.end - MIN_CUT} onCommit={(start) => onChange({ start })} />
        →
        <TimeBox label="End" value={part.end} min={part.start + MIN_CUT} max={hi} onCommit={(end) => onChange({ end })} />
        <span className="tabular-nums">{(part.end - part.start).toFixed(1)}s</span>
      </span>
      {!isVideo && (
        <>
          <label className="flex items-center gap-1.5 text-muted">
            Volume
            <input type="range" min="0" max="2" step="0.05" value={gain} className="w-28" aria-label="Background volume in this part"
              onChange={(e) => setGain(Number(e.target.value))}
              onPointerUp={() => gain !== part.gain && onChange({ gain })} onKeyUp={() => gain !== part.gain && onChange({ gain })} />
            <span className="w-9 tabular-nums text-ink">{Math.round(gain * 100)}%</span>
          </label>
          <label className="flex items-center gap-1.5 text-muted" title="How long the volume takes to change at each edge">
            Fade
            <select value={String(part.fade ?? DEFAULT_FADE)} onChange={(e) => onChange({ fade: Number(e.target.value) })}
              className="rounded-md border border-line-strong bg-panel px-1 py-0.5 text-xs text-ink">
              {[[0.05, 'quick'], [0.3, '0.3 s'], [1, '1 s'], [2, '2 s']].map(([v, l]) => <option key={v} value={String(v)}>{l}</option>)}
            </select>
          </label>
        </>
      )}
      <span className="ml-auto flex items-center gap-1">
        <button type="button" onClick={onRestore} className="rounded-md bg-panel px-2 py-0.5 font-semibold text-ink shadow-sm ring-1 ring-line-strong hover:bg-raised">
          ↺ {isVideo ? 'Put back' : 'Remove'}
        </button>
        <button type="button" onClick={onClose} aria-label="Close" title="Close (Esc)" className="rounded-md px-1.5 py-0.5 text-muted hover:text-ink">✕</button>
      </span>
    </div>
  );
}

// Video, Khmer voice and background tracks. Drag a clip to move it, drag its edges to change
// its timing, double-click an empty spot to add a sentence there. Drag on the Video track to
// select a part and remove it from the video; drag on the Background to select a part and
// silence it. A cut's edges can be dragged and ↺ restores it. Only what is visible is drawn.
export default function Timeline({ project, sentences, videoRef, selectedId, onSelect, onSeek, onTiming, onAdd, onCuts, onVideoCuts, onOpenAudio, filmstrip, waveform, voiceRemoved }) {
  const duration = project.video.duration;
  const theme = useTheme(); // the waveform is drawn with theme colours
  const scroller = useRef(null);
  const content = useRef(null);
  const playhead = useRef(null);
  const canvas = useRef(null);
  const [view, setView] = useState({ left: 0, width: 800 });
  const [pps, setPps] = useState(null); // pixels per second; null = default zoom
  const [drag, setDrag] = useState(null);
  const [range, setRange] = useState(null); // {lane, start, end}: a selected part, not cut yet
  const [cutDrag, setCutDrag] = useState(null); // selecting a range, or moving a cut's edge
  const cutLive = useRef(null); // the same, for pointerup arriving before the last move is rendered
  const updateCut = (next) => { cutLive.current = next; setCutDrag(next); };
  const [picked, setPicked] = useState(null); // {lane, i}: the selected cut
  const keepCenter = useRef(null);

  const scale = pps ?? Math.max(2, view.width / Math.min(duration, 40));
  const live = useRef({ scale, dragging: false });
  live.current = { scale, dragging: !!drag || !!cutDrag };

  useLayoutEffect(() => {
    const el = scroller.current;
    const measure = () => setView({ left: el.scrollLeft, width: el.clientWidth });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // After zooming, keep the same moment in the middle.
  useLayoutEffect(() => {
    if (keepCenter.current === null) return;
    const el = scroller.current;
    el.scrollLeft = keepCenter.current * scale - el.clientWidth / 2;
    keepCenter.current = null;
    setView({ left: el.scrollLeft, width: el.clientWidth });
  }, [scale]);

  // The playhead follows the video; while playing, the timeline scrolls along.
  useEffect(() => {
    let frame;
    const loop = () => {
      const v = videoRef.current;
      const el = scroller.current;
      if (v && el && playhead.current) {
        const x = v.currentTime * live.current.scale;
        playhead.current.style.transform = `translateX(${x}px)`;
        if (!v.paused && !live.current.dragging && (x < el.scrollLeft || x > el.scrollLeft + el.clientWidth * 0.85)) {
          el.scrollLeft = x - el.clientWidth * 0.15;
        }
      }
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [videoRef]);

  // Bring the selected sentence into view.
  useEffect(() => {
    const s = sentences.find((x) => x.id === selectedId);
    const el = scroller.current;
    if (!s || !el) return;
    const a = s.start * scale;
    const b = s.end * scale;
    if (a < el.scrollLeft || b > el.scrollLeft + el.clientWidth) el.scrollLeft = a - el.clientWidth * 0.3;
  }, [selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  const t0 = view.left / scale - 2;
  const t1 = (view.left + view.width) / scale + 2;

  // Background waveform, drawn for the visible part only.
  const { settings, original_gaps: gaps } = project;
  const saved = (lane) => settings[LANES[lane].key] || [];
  const shownCuts = (lane) => (cutDrag?.mode === 'edge' && cutDrag.lane === lane ? cutDrag.cuts : saved(lane)); // live while an edge is dragged
  const save = (lane, list, note) => (lane === 'video' ? onVideoCuts : onCuts)(list, note);
  const cuts = shownCuts('background');
  const removedParts = shownCuts('video');
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(view.width * dpr);
    c.height = BACKGROUND * dpr;
    const g = c.getContext('2d');
    g.scale(dpr, dpr);
    g.clearRect(0, 0, view.width, BACKGROUND);
    if (!waveform?.peaks?.length) return;
    const { peaks, per_second: rate } = waveform;
    const colors = { normal: token('--muted'), off: token('--line-strong'), gap: 'rgb(16 185 129 / 0.85)' };
    const level = settings.background === 'replace' ? 0 : settings.background_volume;
    for (let x = 0; x < view.width; x += 2) {
      const a = Math.floor(((view.left + x) / scale) * rate);
      const b = Math.max(a + 1, Math.floor(((view.left + x + 2) / scale) * rate));
      if (a >= peaks.length) break;
      let peak = 0;
      for (let k = a; k < b && k < peaks.length; k += 1) peak = Math.max(peak, peaks[k]);
      const t = (view.left + x) / scale;
      const inGap = gaps.some((gap) => t >= gap.start && t <= gap.end);
      const gain = gainAt(cuts, t);
      const shown = (inGap ? 1 : level) * gain;
      const h = gain < 0.01 ? 1 : Math.max(1, peak * (BACKGROUND - 8) * (0.2 + 0.8 * Math.min(1, shown)));
      g.fillStyle = gain < 0.01 ? colors.off : inGap ? colors.gap : shown === 0 ? colors.off : colors.normal;
      g.fillRect(x, (BACKGROUND - h) / 2, 1.5, h);
    }
  }, [view, scale, waveform, settings.background, settings.background_volume, gaps, cuts, theme]);

  // ---------- cutting (both lanes) ----------
  const cutRange = (gain = 0) => {
    if (!range) return;
    const { lane, start, end } = range;
    const when = `${formatTime(start)}–${formatTime(end)}`;
    const part = { start: round3(start), end: round3(end) };
    if (lane === 'video') save(lane, [...saved(lane), part], `Removed ${when} from the video.`);
    else save(lane, [...saved(lane), { ...part, gain, fade: DEFAULT_FADE }], gain === 0 ? `Silenced the background ${when}.` : `Background at ${Math.round(gain * 100)}% ${when}.`);
    setRange(null);
  };
  const updatePart = (lane, i, patch) => save(lane, saved(lane).map((c, k) => (k === i ? { ...c, ...patch } : c)));
  const restoreCut = (lane, i) => {
    save(lane, saved(lane).filter((_, k) => k !== i), lane === 'video' ? 'That part is back in the video.' : 'Background restored there.');
    setPicked(null);
  };

  // Delete / Backspace / X cuts the selected range or restores the selected cut. Esc clears.
  const keys = useRef(null);
  keys.current = { range, picked, cutRange, restoreCut };
  useEffect(() => {
    const onKey = (e) => {
      if (e.target.closest?.('input, textarea, select, dialog') || e.ctrlKey || e.metaKey) return;
      const k = keys.current;
      const key = e.key.toLowerCase();
      if (key === 'escape') { setRange(null); setPicked(null); return; }
      if (!['delete', 'backspace', 'x'].includes(key)) return;
      if (k.range) { e.preventDefault(); k.cutRange(); } else if (k.picked) { e.preventDefault(); k.restoreCut(k.picked.lane, k.picked.i); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Pressing starts a selection; dragging selects a part (also across or inside existing parts).
  // A click without dragging moves the playhead — or, on an existing part, opens it for editing.
  function startLane(e, lane, part = null) {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    updateCut({ lane, mode: 'select', x0: e.clientX, from: timeAt(e.clientX), moved: false, range: null, part });
  }

  function startEdge(e, lane, i, side) {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    e.currentTarget.closest('[data-lane]').setPointerCapture(e.pointerId);
    const list = saved(lane);
    setPicked({ lane, i });
    setRange(null);
    updateCut({
      lane, mode: 'edge', i, side, x0: e.clientX, moved: false, cuts: list,
      lo: side === 'start' ? (list[i - 1]?.end ?? 0) : list[i].start + MIN_CUT,
      hi: side === 'start' ? list[i].end - MIN_CUT : (list[i + 1]?.start ?? duration),
    });
  }

  function moveLane(e) {
    const d = cutLive.current;
    if (!d) return;
    if (!d.moved && Math.abs(e.clientX - d.x0) < 4) return;
    const t = snap(timeAt(e.clientX));
    if (d.mode === 'select') {
      const from = snap(d.from);
      const next = { lane: d.lane, start: Math.min(from, t), end: Math.max(from, t) };
      setRange(next);
      updateCut({ ...d, moved: true, range: next });
    } else {
      const list = saved(d.lane);
      const cut = { ...list[d.i], [d.side]: clamp(t, d.lo, d.hi) };
      updateCut({ ...d, moved: true, cuts: list.map((c, k) => (k === d.i ? cut : c)) });
    }
  }

  function endLane() {
    const d = cutLive.current;
    if (!d) return;
    if (d.mode === 'select') {
      if (!d.moved) {
        setRange(null);
        if (d.part !== null) setPicked({ lane: d.lane, i: d.part }); else { setPicked(null); onSeek(d.from); }
      } else {
        setPicked(null);
        setRange(d.range.end - d.range.start < MIN_CUT ? null : d.range);
      }
    } else if (d.moved) {
      save(d.lane, d.cuts.map((c) => ({ ...c, start: round3(c.start), end: round3(c.end) })));
    }
    updateCut(null);
  }

  // The cuts of one lane, and the selected range with its action button.
  function laneCuts(lane) {
    const { verb, icon, done, restore } = LANES[lane];
    const list = shownCuts(lane);
    return (
      <>
        {list.map((c, i) => (c.end < t0 || c.start > t1 ? null : (
          <div key={i} role="button" tabIndex={-1} title={`${formatTime(c.start)}–${formatTime(c.end)} · ${lane === 'video' ? 'removed from the video' : `background ${partLabel(c)}`} · click to edit`}
            onPointerDown={(e) => startLane(e, lane, i)}
            className={`absolute inset-y-0 z-10 cursor-pointer border-x border-dashed ${lane === 'video' ? 'border-red-500/70 bg-black/70' : PART_STYLE(c)} ${picked?.lane === lane && picked.i === i ? 'ring-2 ring-inset ring-accent' : ''}`}
            style={{ left: c.start * scale, width: Math.max(2, (c.end - c.start) * scale), ...(lane === 'video' ? REMOVED_HATCH : (c.gain ?? 0) === 0 ? HATCH : {}) }}>
            {(c.end - c.start) * scale > 54 && (
              <span className={`pointer-events-none absolute left-1.5 top-1 rounded px-1 text-[10px] font-medium leading-4 ${lane === 'video' ? 'bg-red-600 text-white' : 'bg-panel text-muted'}`}>{lane === 'video' ? `${icon} ${done}` : partLabel(c)}</span>
            )}
            {(c.end - c.start) * scale > 30 && (
              <button type="button" title={restore} aria-label={restore}
                onPointerDown={(e) => e.stopPropagation()} onClick={() => restoreCut(lane, i)}
                className="absolute bottom-1 right-1 rounded bg-panel px-1 text-[11px] leading-4 text-muted shadow-sm hover:text-accent-ink">↺</button>
            )}
            <div className="absolute inset-y-0 -left-1 w-2 cursor-ew-resize hover:bg-accent/30" onPointerDown={(e) => startEdge(e, lane, i, 'start')} />
            <div className="absolute inset-y-0 -right-1 w-2 cursor-ew-resize hover:bg-accent/30" onPointerDown={(e) => startEdge(e, lane, i, 'end')} />
          </div>
        )))}
        {range?.lane === lane && (
          <div className="pointer-events-none absolute inset-y-0 z-20 border-x-2 border-accent bg-accent/20" style={{ left: range.start * scale, width: Math.max(2, (range.end - range.start) * scale) }}>
            {!cutDrag && (
              <span className={`pointer-events-auto absolute top-1/2 flex -translate-y-1/2 items-center gap-1 whitespace-nowrap ${(range.end - range.start) * scale > 130 ? 'left-1/2 -translate-x-1/2' : 'left-full ml-1.5'}`}>
                <button type="button" onPointerDown={(e) => e.stopPropagation()} onClick={() => cutRange(0)}
                  className={`rounded-md px-2 py-0.5 text-[11px] font-semibold text-white shadow ${lane === 'video' ? 'bg-red-600 hover:bg-red-700' : 'bg-accent hover:bg-accent-hover'}`} title={LANES[lane].tip}>
                  {icon} {verb} {(range.end - range.start).toFixed(1)}s
                </button>
                {lane === 'background' && (
                  <>
                    <button type="button" onPointerDown={(e) => e.stopPropagation()} onClick={() => cutRange(0.5)} title="Half as loud here"
                      className="rounded-md bg-panel px-2 py-0.5 text-[11px] font-semibold text-ink shadow ring-1 ring-line-strong hover:bg-raised">🔉 Quieter</button>
                    <button type="button" onPointerDown={(e) => e.stopPropagation()} onClick={() => cutRange(1.5)} title="One and a half times as loud here"
                      className="rounded-md bg-panel px-2 py-0.5 text-[11px] font-semibold text-ink shadow ring-1 ring-line-strong hover:bg-raised">🔊 Louder</button>
                  </>
                )}
                <button type="button" onPointerDown={(e) => e.stopPropagation()} onClick={() => setRange(null)}
                  className="rounded-md bg-panel px-1.5 py-0.5 text-[11px] text-muted shadow ring-1 ring-line-strong hover:text-ink" aria-label="Clear the selection" title="Clear (Esc)">✕</button>
              </span>
            )}
          </div>
        )}
      </>
    );
  }

  function zoom(factor) {
    const el = scroller.current;
    keepCenter.current = (el.scrollLeft + el.clientWidth / 2) / scale;
    setPps(factor === null ? null : clamp(scale * factor, 1, 400));
  }

  function timeAt(clientX) {
    const rect = content.current.getBoundingClientRect();
    return clamp((clientX - rect.left) / scale, 0, duration);
  }

  // ---------- dragging ----------
  function startDrag(e, s, mode) {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const i = sentences.findIndex((x) => x.id === s.id);
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({
      sid: s.id, mode, x0: e.clientX, start0: s.start, end0: s.end, start: s.start, end: s.end, moved: false,
      prevEnd: i > 0 ? sentences[i - 1].end : 0,
      nextStart: i + 1 < sentences.length ? sentences[i + 1].start : duration,
    });
  }

  function moveDrag(e) {
    if (!drag) return;
    if (!drag.moved && Math.abs(e.clientX - drag.x0) < 4) return;
    const dt = (e.clientX - drag.x0) / scale;
    let { start, end } = drag;
    if (drag.mode === 'move') {
      const length = drag.end0 - drag.start0;
      start = clamp(snap(drag.start0 + dt), drag.prevEnd, drag.nextStart - length);
      end = start + length;
    } else if (drag.mode === 'start') {
      start = clamp(snap(drag.start0 + dt), drag.prevEnd, drag.end0 - MIN_LENGTH);
    } else {
      end = clamp(snap(drag.end0 + dt), drag.start0 + MIN_LENGTH, drag.nextStart);
    }
    setDrag({ ...drag, start, end, moved: true });
  }

  function endDrag() {
    if (!drag) return;
    if (drag.moved) {
      if (round3(drag.start) !== drag.start0 || round3(drag.end) !== drag.end0) onTiming(drag.sid, round3(drag.start), round3(drag.end));
    } else {
      onSelect(drag.sid);
      onSeek(drag.start0);
    }
    setDrag(null);
  }

  // ---------- drawing ----------
  const step = TICK_STEPS.find((s) => s * scale >= 70) || 600;
  const ticks = [];
  for (let t = Math.max(0, Math.floor(t0 / step) * step); t <= Math.min(duration, t1); t += step) ticks.push(t);

  const tiles = [];
  if (filmstrip) {
    const k = VIDEO / filmstrip.tile_height;
    for (let i = 0; i < filmstrip.tiles; i += 1) {
      const a = i * filmstrip.every;
      if (a > t1 || a + filmstrip.every < t0) continue;
      tiles.push(
        <div key={i} className="absolute top-0 h-full border-r border-black/20" style={{
          left: a * scale, width: filmstrip.every * scale,
          backgroundImage: `url(${filmstrip.url})`, backgroundRepeat: 'no-repeat',
          backgroundSize: `${filmstrip.tiles * filmstrip.tile_width * k}px ${VIDEO}px`,
          backgroundPosition: `${-i * filmstrip.tile_width * k}px 0`,
        }} />,
      );
    }
  }

  const blocks = sentences.filter((s) => s.end >= t0 && s.start <= t1).map((s) => {
    const shown = drag?.sid === s.id ? { ...s, start: drag.start, end: drag.end } : s;
    const slot = shown.end - shown.start;
    const hasClip = s.status === 'ok' || s.status === 'too_long';
    const clip = hasClip ? s.audio_duration : 0;
    const overflow = Math.max(0, clip - slot);
    const selected = s.id === selectedId;
    return (
      <div
        key={s.id}
        role="button"
        tabIndex={-1}
        onPointerDown={(e) => startDrag(e, s, 'move')}
        className={`absolute top-1.5 select-none rounded-md border ${BLOCK[s.status] || BLOCK.edited} ${selected ? 'z-10 ring-2 ring-accent' : ''} ${drag?.sid === s.id ? 'cursor-grabbing opacity-90' : 'cursor-grab'}`}
        style={{ left: shown.start * scale, width: Math.max(4, slot * scale), height: VOICE - 12 }}
        title={`${formatTime(shown.start)}–${formatTime(shown.end)} · ${s.khmer_text || '(no text)'}`}
      >
        {hasClip && <div className="pointer-events-none absolute inset-y-0 left-0 rounded-l-md bg-accent/30" style={{ width: Math.min(clip, slot) * scale }} />}
        {overflow > 0.05 && (
          <div className="pointer-events-none absolute inset-y-2 rounded-r bg-red-500/45" style={{ left: '100%', width: overflow * scale }} title="Longer than its time — the end will be cut" />
        )}
        {slot * scale > 26 && (
          <span className="khmer pointer-events-none relative block truncate px-1.5 pt-0.5 text-[11px] leading-[1.7] text-ink">
            {s.status === 'too_long' && '⚠ '}{s.khmer_text || '…'}
          </span>
        )}
        <div className="absolute inset-y-0 left-0 w-2 cursor-ew-resize rounded-l-md hover:bg-accent/30" onPointerDown={(e) => startDrag(e, s, 'start')} />
        <div className="absolute inset-y-0 right-0 w-2 cursor-ew-resize rounded-r-md hover:bg-accent/30" onPointerDown={(e) => startDrag(e, s, 'end')} />
      </div>
    );
  });

  const level = settings.background === 'replace' ? 'off' : `${Math.round(settings.background_volume * 100)}%`;
  const backgroundOff = settings.background === 'replace' || settings.background_volume === 0;
  const pickedList = picked ? saved(picked.lane) : [];
  const pickedPart = picked ? pickedList[picked.i] : null;
  const pickedLo = picked ? (pickedList[picked.i - 1]?.end ?? 0) : 0;
  const pickedHi = picked ? (pickedList[picked.i + 1]?.start ?? duration) : duration;

  return (
    <div className="p-2.5">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
        <span className="font-semibold text-ink">Timeline</span>
        {pickedPart && (
          <div className="order-last w-full">
            <PartBar key={`${picked.lane}-${picked.i}`} lane={picked.lane} part={pickedPart} lo={pickedLo} hi={pickedHi}
              onChange={(patch) => updatePart(picked.lane, picked.i, patch)} onRestore={() => restoreCut(picked.lane, picked.i)} onClose={() => setPicked(null)} />
          </div>
        )}
        <span className="hidden text-xs text-faint lg:inline">Drag a clip to move it or its edges to retime it · double-click a gap to add a sentence · drag on Video to remove a part · drag on Background to change its volume</span>
        <span className="ml-auto inline-flex overflow-hidden rounded-lg border border-line-strong text-muted">
          <button type="button" className="px-2.5 py-1 hover:bg-raised" onClick={() => zoom(1 / 1.6)} aria-label="Zoom out">−</button>
          <button type="button" className="border-x border-line-strong px-2.5 py-1 text-xs hover:bg-raised" onClick={() => { keepCenter.current = duration / 2; setPps(Math.max(1, view.width / duration)); }}>Whole video</button>
          <button type="button" className="px-2.5 py-1 hover:bg-raised" onClick={() => zoom(1.6)} aria-label="Zoom in">+</button>
        </span>
      </div>
      <div className="flex overflow-hidden rounded-lg border border-line bg-sunken">
        <div className="w-20 shrink-0 border-r border-line bg-raised text-[11px] font-medium text-muted">
          <div style={{ height: RULER }} />
          <div className="flex flex-col justify-center px-2 leading-tight" style={{ height: VIDEO }} title="Drag here to select a part to remove from the video">
            Video
            {saved('video').length > 0 && (
              <button type="button" className="w-fit whitespace-nowrap text-[10px] text-red-600 hover:text-accent-ink dark:text-red-400" title="Put every removed part back"
                onClick={() => { save('video', [], 'Every removed part is back in the video.'); setPicked(null); }}>
                ↺ {saved('video').length} removed
              </button>
            )}
          </div>
          <div className="flex items-center px-2 text-accent-ink" style={{ height: VOICE }}>Khmer voice</div>
          <div className="flex flex-col justify-center px-2 leading-tight" style={{ height: BACKGROUND }} title={`${voiceRemoved ? 'Music & sounds, with the original voice removed' : 'The original audio'} · drag here to select a part to silence`}>
            Background<span className="text-faint">{level}{voiceRemoved && ' · no voice'}</span>
            {saved('background').length > 0 && (
              <button type="button" className="w-fit whitespace-nowrap text-[10px] text-faint hover:text-accent-ink" title="Put the background back to normal everywhere"
                onClick={() => { save('background', [], 'Background restored everywhere.'); setPicked(null); }}>
                ↺ {saved('background').length} changed
              </button>
            )}
          </div>
        </div>
        <div ref={scroller} className="relative flex-1 overflow-x-auto overflow-y-hidden" onScroll={(e) => setView({ left: e.currentTarget.scrollLeft, width: e.currentTarget.clientWidth })}>
          <div ref={content} className="relative" style={{ width: duration * scale + 16 }} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={() => setDrag(null)}>
            <div className="relative cursor-pointer border-b border-line bg-panel" style={{ height: RULER }} onClick={(e) => onSeek(timeAt(e.clientX))}>
              {ticks.map((t) => (
                <span key={t} className="absolute top-0 h-full border-l border-line-strong pl-1 text-[10px] leading-6 text-muted" style={{ left: t * scale }}>{formatTime(t).replace(/\.\d$/, '')}</span>
              ))}
            </div>
            <div data-lane className="relative cursor-text bg-black" style={{ height: VIDEO }}
              onPointerDown={(e) => startLane(e, 'video')} onPointerMove={moveLane} onPointerUp={endLane} onPointerCancel={() => updateCut(null)}>
              {tiles}
              {laneCuts('video')}
            </div>
            <div className="relative border-y border-line bg-raised" style={{ height: VOICE }}
              onDoubleClick={(e) => { if (e.target === e.currentTarget) onAdd(round3(snap(timeAt(e.clientX)))); }}>
              {gaps.filter((g) => g.end >= t0 && g.start <= t1).map((g) => (
                <div key={g.start} className="pointer-events-none absolute inset-y-1.5 rounded-md border border-emerald-500/50 bg-emerald-500/10 px-1.5 text-[10px] leading-5 text-emerald-700 dark:text-emerald-300"
                  style={{ left: g.start * scale, width: (g.end - g.start) * scale }}>original audio</div>
              ))}
              {blocks}
            </div>
            <div data-lane className="relative cursor-text bg-panel" style={{ height: BACKGROUND }}
              onPointerDown={(e) => startLane(e, 'background')} onPointerMove={moveLane} onPointerUp={endLane} onPointerCancel={() => updateCut(null)}>
              <canvas ref={canvas} className="pointer-events-none absolute top-0" style={{ left: view.left, width: view.width, height: BACKGROUND }} />
              {laneCuts('background')}
              {backgroundOff && !range && (
                <div className="pointer-events-none sticky left-0 z-[6] flex h-full w-fit items-center gap-2 px-3 text-[11px] text-muted">
                  The background is {settings.background === 'replace' ? 'off' : 'at 0%'}, so changes here won't be heard.
                  {onOpenAudio && (
                    <button type="button" onPointerDown={(e) => e.stopPropagation()} onClick={onOpenAudio}
                      className="pointer-events-auto rounded-md bg-panel px-2 py-0.5 font-semibold text-accent-ink shadow-sm ring-1 ring-line-strong hover:bg-raised">🎚 Turn it on</button>
                  )}
                </div>
              )}
            </div>
            {/* parts removed from the video are removed from every track: shade the voice and background too */}
            {removedParts.filter((c) => c.end >= t0 && c.start <= t1).map((c, i) => (
              <div key={i} className="pointer-events-none absolute bottom-0 z-[5] bg-black/45" style={{ top: RULER + VIDEO, left: c.start * scale, width: (c.end - c.start) * scale, ...REMOVED_HATCH }} />
            ))}
            <div ref={playhead} className="pointer-events-none absolute top-0 bottom-0 left-0 w-0.5 bg-red-500" />
          </div>
        </div>
      </div>
    </div>
  );
}
