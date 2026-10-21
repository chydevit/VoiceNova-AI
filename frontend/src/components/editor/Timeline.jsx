import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { formatTime } from '../../api.js';
import { token, useTheme } from '../../lib/theme.js';

const MIN_LENGTH = 0.3; // keep in sync with backend/sentences.py
const SNAP = 0.05; // dragged times snap to 50 ms
const RULER = 24;
const VIDEO = 44;
const VOICE = 56;
const BACKGROUND = 40;
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

// Video, Khmer voice and background tracks. Drag a clip to move it, drag its edges to change
// its timing, double-click an empty spot to add a sentence there. Only what is visible is drawn.
export default function Timeline({ project, sentences, videoRef, selectedId, onSelect, onSeek, onTiming, onAdd, filmstrip, waveform, voiceRemoved }) {
  const duration = project.video.duration;
  const theme = useTheme(); // the waveform is drawn with theme colours
  const scroller = useRef(null);
  const content = useRef(null);
  const playhead = useRef(null);
  const canvas = useRef(null);
  const [view, setView] = useState({ left: 0, width: 800 });
  const [pps, setPps] = useState(null); // pixels per second; null = default zoom
  const [drag, setDrag] = useState(null);
  const keepCenter = useRef(null);

  const scale = pps ?? Math.max(2, view.width / Math.min(duration, 40));
  const live = useRef({ scale, dragging: false });
  live.current = { scale, dragging: !!drag };

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
      const shown = inGap ? 1 : level;
      const h = Math.max(1, peak * (BACKGROUND - 6) * (0.2 + 0.8 * Math.min(1, shown)));
      g.fillStyle = inGap ? colors.gap : shown === 0 ? colors.off : colors.normal;
      g.fillRect(x, (BACKGROUND - h) / 2, 1.5, h);
    }
  }, [view, scale, waveform, settings.background, settings.background_volume, gaps, theme]);

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

  return (
    <div className="p-2.5">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
        <span className="font-semibold text-ink">Timeline</span>
        <span className="hidden text-xs text-faint lg:inline">Drag a clip to move it · drag its edges to change its time · double-click a gap to add a sentence</span>
        <span className="ml-auto inline-flex overflow-hidden rounded-lg border border-line-strong text-muted">
          <button type="button" className="px-2.5 py-1 hover:bg-raised" onClick={() => zoom(1 / 1.6)} aria-label="Zoom out">−</button>
          <button type="button" className="border-x border-line-strong px-2.5 py-1 text-xs hover:bg-raised" onClick={() => { keepCenter.current = duration / 2; setPps(Math.max(1, view.width / duration)); }}>Whole video</button>
          <button type="button" className="px-2.5 py-1 hover:bg-raised" onClick={() => zoom(1.6)} aria-label="Zoom in">+</button>
        </span>
      </div>
      <div className="flex overflow-hidden rounded-lg border border-line bg-sunken">
        <div className="w-20 shrink-0 border-r border-line bg-raised text-[11px] font-medium text-muted">
          <div style={{ height: RULER }} />
          <div className="flex items-center px-2" style={{ height: VIDEO }}>Video</div>
          <div className="flex items-center px-2 text-accent-ink" style={{ height: VOICE }}>Khmer voice</div>
          <div className="flex flex-col justify-center px-2 leading-tight" style={{ height: BACKGROUND }} title={voiceRemoved ? 'Music & sounds, with the original voice removed' : 'The original audio'}>
            Background<span className="text-faint">{level}{voiceRemoved && ' · no voice'}</span>
          </div>
        </div>
        <div ref={scroller} className="relative flex-1 overflow-x-auto overflow-y-hidden" onScroll={(e) => setView({ left: e.currentTarget.scrollLeft, width: e.currentTarget.clientWidth })}>
          <div ref={content} className="relative" style={{ width: duration * scale + 16 }} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={() => setDrag(null)}>
            <div className="relative cursor-pointer border-b border-line bg-panel" style={{ height: RULER }} onClick={(e) => onSeek(timeAt(e.clientX))}>
              {ticks.map((t) => (
                <span key={t} className="absolute top-0 h-full border-l border-line-strong pl-1 text-[10px] leading-6 text-muted" style={{ left: t * scale }}>{formatTime(t).replace(/\.\d$/, '')}</span>
              ))}
            </div>
            <div className="relative bg-black" style={{ height: VIDEO }}>{tiles}</div>
            <div className="relative border-y border-line bg-raised" style={{ height: VOICE }}
              onDoubleClick={(e) => { if (e.target === e.currentTarget) onAdd(round3(snap(timeAt(e.clientX)))); }}>
              {gaps.filter((g) => g.end >= t0 && g.start <= t1).map((g) => (
                <div key={g.start} className="pointer-events-none absolute inset-y-1.5 rounded-md border border-emerald-500/50 bg-emerald-500/10 px-1.5 text-[10px] leading-5 text-emerald-700 dark:text-emerald-300"
                  style={{ left: g.start * scale, width: (g.end - g.start) * scale }}>original audio</div>
              ))}
              {blocks}
            </div>
            <div className="relative bg-panel" style={{ height: BACKGROUND }}>
              <canvas ref={canvas} className="pointer-events-none absolute top-0" style={{ left: view.left, width: view.width, height: BACKGROUND }} />
            </div>
            <div ref={playhead} className="pointer-events-none absolute top-0 bottom-0 left-0 w-0.5 bg-red-500" />
          </div>
        </div>
      </div>
    </div>
  );
}
