import { useEffect, useRef, useState } from 'react';
import { timecode, trackOf } from '../../../lib/timeline.js';
import { Filmstrip } from './lanes.jsx';

const STRIP_H = 44;
const VOICE_H = 18;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Phones and tablets: one strip — the picture with the Khmer voice under it — that scrolls under a
// fixed playhead in the middle (scroll to move through the video), and big buttons for the main tools.
// size: 'open' or 'expanded' (the phone's bottom sheet swiped up: taller strips).
export default function MobileTimeline({ project, tracks, sentences, playback, filmstrip, selectedId, onSelect, tools, size = 'open' }) {
  const STRIP = size === 'expanded' ? 76 : STRIP_H;
  const VOICE = size === 'expanded' ? 28 : VOICE_H;
  const box = useRef(null);
  const [width, setWidth] = useState(360);
  const [scale, setScale] = useState(24); // pixels per second
  const [t, setT] = useState(playback.t);
  const userScroll = useRef(false);
  const fps = project.video.fps || 30;
  const end = Math.max(playback.duration, 1);
  const video = trackOf(tracks, 'video').clips;

  useEffect(() => {
    const el = box.current;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // While playing (or after a seek elsewhere) the strip follows the playhead.
  useEffect(() => {
    let frame;
    const loop = () => {
      const el = box.current;
      if (el && !userScroll.current) {
        const x = playback.t * scale;
        if (Math.abs(el.scrollLeft - x) > 1) el.scrollLeft = x;
      }
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [playback, scale]);
  useEffect(() => playback.subscribe(({ t: now }) => setT(now)), [playback]);

  const onScroll = (e) => {
    if (!userScroll.current) return;
    const at = clamp(e.currentTarget.scrollLeft / scale, 0, end);
    playback.seek(at);
  };
  const grab = () => { userScroll.current = true; if (playback.playing) playback.pause(); };
  const release = () => { setTimeout(() => { userScroll.current = false; }, 150); };

  const pad = width / 2;
  const t0 = t - pad / scale - 2;
  const t1 = t + pad / scale + 2;

  return (
    <div className="select-none">
      <div className="relative">
        <div ref={box} onScroll={onScroll} onTouchStart={grab} onTouchEnd={release} onPointerDown={grab} onPointerUp={release} onWheel={grab}
          className="scroll-quiet overflow-x-auto overflow-y-hidden rounded-lg bg-sunken">
          <div className="relative" style={{ width: end * scale + 2 * pad, height: STRIP + VOICE + 10 }}>
            {video.filter((c) => c.end >= t0 && c.start <= t1).map((c) => (
              <div key={c.id} className={`absolute top-1 overflow-hidden rounded-md border border-black/40 bg-neutral-800 ${c.id === selectedId ? 'ring-2 ring-accent' : ''}`}
                style={{ left: pad + c.start * scale, width: Math.max(2, (c.end - c.start) * scale), height: STRIP }}
                onClick={() => onSelect(c.id)} role="button" tabIndex={-1}>
                {c.type === 'video' && c.media === 'source' && filmstrip && <Filmstrip clip={c} filmstrip={filmstrip} scale={scale} t0={t0} t1={t1} height={STRIP} />}
                {c.skipped && <div className="absolute inset-0 flex items-center justify-center bg-black/60 text-[10px] font-semibold text-white">⤼ skipped</div>}
              </div>
            ))}
            {sentences.filter((s) => s.end >= t0 && s.start <= t1).map((s) => (
              <div key={s.id} role="button" tabIndex={-1} onClick={() => onSelect(s.id)}
                className={`khmer absolute truncate rounded border px-1 text-[10px] leading-[16px] ${s.id === selectedId ? 'border-accent bg-accent text-white' : s.status === 'too_long' ? 'border-amber-500 bg-amber-500/20' : 'border-accent/50 bg-accent-soft text-ink'} ${s.skipped ? 'opacity-50' : ''}`}
                style={{ left: pad + s.start * scale, width: Math.max(3, (s.end - s.start) * scale), top: STRIP + 6, height: VOICE }}>
                {s.khmer_text}
              </div>
            ))}
          </div>
        </div>
        <div className="pointer-events-none absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-red-500" />
        <span className="pointer-events-none absolute left-1/2 top-0 -translate-x-1/2 rounded-b bg-red-500 px-1 font-mono text-[10px] text-white">{timecode(t, fps)}</span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {tools}
        <span className="ml-auto inline-flex overflow-hidden rounded-lg border border-line-strong text-muted">
          <button type="button" className="px-3 py-1.5" onClick={() => setScale((s) => clamp(s / 1.6, 2, 200))} aria-label="Zoom out">−</button>
          <button type="button" className="border-l border-line-strong px-3 py-1.5" onClick={() => setScale((s) => clamp(s * 1.6, 2, 200))} aria-label="Zoom in">+</button>
        </span>
      </div>
    </div>
  );
}
