import { useEffect, useRef, useState } from 'react';
import { formatTime } from '../../api.js';
import { drawSubtitle, loadSubtitleFont } from '../../lib/subtitleImages.js';
import { IconButton } from '../ui.jsx';
import { gainAt } from '../../lib/background.js';

const inGap = (gaps, t) => gaps.some((g) => t >= g.start && t <= g.end); // deleted sentence: original audio at full volume
// Levels at time t, as they will sound in the export: the original audio (the video's own sound)
// and the voice-free music track (when the original voice has been removed).
function levels(p, t) {
  const left = gainAt(p.settings.background_cuts || [], t); // background volume parts
  const { original, music } = uncut(p, t);
  return { original: original * left, music: music * left };
}

function uncut(p, t) {
  const { background, background_volume: volume } = p.settings;
  const gap = inGap(p.original_gaps, t);
  if (background === 'separate' && p.background_url) return { original: gap ? 1 : 0, music: gap ? 0 : Math.min(1, volume) };
  if (gap) return { original: 1, music: 0 };
  if (background === 'replace') return { original: 0, music: 0 };
  if (background === 'separate') return { original: Math.min(1, volume) * 0.3, music: 0 }; // stand-in until the track is ready
  return { original: Math.min(1, volume), music: 0 };
}

// The subtitle on screen at time t, with the same timing rules as the export (backend subtitles.spans).
function subtitleAt(sentences, duration, t) {
  const shown = sentences.filter((s) => (s.subtitle_text ?? s.khmer_text).trim());
  for (let i = 0; i < shown.length; i += 1) {
    const s = shown[i];
    const end = Math.min(Math.max(s.end, s.start + 0.5), shown[i + 1]?.start ?? duration, duration);
    if (t >= s.start && t < end) return { id: s.id, text: s.subtitle_text ?? s.khmer_text, original: s.original_text };
    if (s.start > t) break;
  }
  return null;
}

// The part of the <video> box the picture fills (object-fit: contain).
function pictureBox(el, width, height) {
  const scale = Math.min(el.clientWidth / width, el.clientHeight / height);
  const w = width * scale;
  const h = height * scale;
  return { left: (el.clientWidth - w) / 2, top: (el.clientHeight - h) / 2, width: w, height: h };
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const r1 = (v) => Math.round(v * 10) / 10;

// The area covering the original's burned-in subtitles (blur or dark box), as the export will
// have it. While `editing`, drag it to move it and drag its edges to resize it.
function CoverBox({ cover, box, editing, onChange }) {
  const drag = useRef(null);
  if (!cover || (!cover.enabled && !editing)) return null;
  const start = (e, mode) => {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { mode, x0: e.clientX, y0: e.clientY, from: { ...cover } };
  };
  const move = (e) => {
    const d = drag.current;
    if (!d) return;
    const dx = ((e.clientX - d.x0) / box.width) * 100;
    const dy = ((e.clientY - d.y0) / box.height) * 100;
    let { x, y, w, h } = d.from;
    if (d.mode === 'move') { x = clamp(x + dx, 0, 100 - w); y = clamp(y + dy, 0, 100 - h); }
    if (d.mode === 'left') { const nx = clamp(x + dx, 0, x + w - 2); w += x - nx; x = nx; }
    if (d.mode === 'right') w = clamp(w + dx, 2, 100 - x);
    if (d.mode === 'top') { const ny = clamp(y + dy, 0, y + h - 2); h += y - ny; y = ny; }
    if (d.mode === 'bottom') h = clamp(h + dy, 2, 100 - y);
    onChange({ ...cover, x: r1(x), y: r1(y), w: r1(w), h: r1(h) });
  };
  const handle = 'absolute rounded-full bg-white shadow ring-1 ring-accent';
  return (
    <div
      onPointerDown={editing ? (e) => start(e, 'move') : undefined} onPointerMove={move} onPointerUp={() => { drag.current = null; }}
      className={`absolute ${editing ? 'cursor-move outline-2 outline-dashed outline-accent' : 'pointer-events-none'}`}
      style={{
        left: box.left + (box.width * cover.x) / 100, top: box.top + (box.height * cover.y) / 100,
        width: (box.width * cover.w) / 100, height: (box.height * cover.h) / 100,
        ...(cover.mode === 'box' ? { background: '#000' } : { backdropFilter: 'blur(14px)', WebkitBackdropFilter: 'blur(14px)', background: 'rgb(0 0 0 / 0.08)' }),
        opacity: cover.enabled ? 1 : 0.45,
      }}
    >
      {editing && (
        <>
          <span onPointerDown={(e) => start(e, 'left')} className={`${handle} -left-1 top-1/2 h-4 w-1.5 -translate-y-1/2 cursor-ew-resize`} />
          <span onPointerDown={(e) => start(e, 'right')} className={`${handle} -right-1 top-1/2 h-4 w-1.5 -translate-y-1/2 cursor-ew-resize`} />
          <span onPointerDown={(e) => start(e, 'top')} className={`${handle} -top-1 left-1/2 h-1.5 w-4 -translate-x-1/2 cursor-ns-resize`} />
          <span onPointerDown={(e) => start(e, 'bottom')} className={`${handle} -bottom-1 left-1/2 h-1.5 w-4 -translate-x-1/2 cursor-ns-resize`} />
        </>
      )}
    </div>
  );
}

// The video with the Khmer voice playing over it. `control` (from EditorPage) holds the
// <video> ref, the VoicePreview and an optional time to pause at (for ▶ on one sentence).
export default function Player({ project, sentences, control, onTime, time, subtitleStyle, showSubtitles, setShowSubtitles, numbers, onStep, cover, editingCover, onCoverChange }) {
  const style = subtitleStyle || project.settings.subtitle_style;
  const latest = useRef({ sentences, project, style, showSubtitles });
  latest.current = { sentences, project, style, showSubtitles };
  const music = useRef(null);
  const subs = useRef(null);
  const drawn = useRef('');
  const [box, setBox] = useState(null);
  const [fontReady, setFontReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const stage = useRef(null);
  const { width, height, duration } = project.video;

  useEffect(() => { loadSubtitleFont().then(() => setFontReady(true)); }, []);

  // Keep the subtitle canvas exactly over the picture.
  useEffect(() => {
    const v = control.video.current;
    if (!v) return undefined;
    const measure = () => setBox(pictureBox(v, width, height));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(v);
    return () => ro.disconnect();
  }, [control, width, height]);
  const { video, preview, stopAt } = control;

  useEffect(() => {
    const v = video.current;
    if (!v) return undefined;
    let frame = 0;
    // Draw the subtitle for time t (only when it changes).
    const caption = (t) => {
      const c = subs.current;
      if (!c) return;
      const { sentences: items, style: st, showSubtitles: on } = latest.current;
      const item = on ? subtitleAt(items, duration, t) : null;
      const key = item ? `${item.id}|${item.text}|${item.original}|${JSON.stringify(st)}` : '';
      if (key === drawn.current) return;
      drawn.current = key;
      drawSubtitle(c.getContext('2d'), item, c.width, c.height, st);
    };
    control.redrawSubtitle = () => { drawn.current = '#'; caption(v.currentTime); };
    const follow = () => { // keep the music track on the video's clock
      const m = music.current;
      if (!m || !m.src) return;
      if (Math.abs(m.currentTime - v.currentTime) > 0.15) m.currentTime = v.currentTime;
      if (m.paused && !v.paused) m.play().catch(() => {});
    };
    const loop = () => {
      const t = v.currentTime;
      const { sentences: items, project: p } = latest.current;
      if (stopAt.current !== null && t >= stopAt.current) {
        stopAt.current = null;
        v.pause();
        return;
      }
      // Parts removed from the video are skipped, as in the export.
      const removedPart = (p.settings.video_cuts || []).find((c) => t >= c.start && t < c.end - 0.02);
      if (removedPart) {
        v.currentTime = removedPart.end;
        frame = requestAnimationFrame(loop);
        return;
      }
      const level = levels(p, t);
      v.volume = level.original;
      if (music.current) music.current.volume = level.music;
      follow();
      caption(t);
      preview.tick(t, items);
      frame = requestAnimationFrame(loop);
    };
    const start = () => { setPlaying(true); cancelAnimationFrame(frame); frame = requestAnimationFrame(loop); };
    const stop = () => { setPlaying(!v.paused); cancelAnimationFrame(frame); preview.stop(); music.current?.pause(); };
    const seeking = () => {
      preview.stop();
      if (music.current?.src) music.current.currentTime = v.currentTime;
      if (!v.paused) start();
    };
    const time = () => { onTime(v.currentTime); caption(v.currentTime); };
    v.addEventListener('playing', start);
    v.addEventListener('pause', stop);
    v.addEventListener('waiting', stop);
    v.addEventListener('ended', stop);
    v.addEventListener('seeking', seeking);
    v.addEventListener('timeupdate', time);
    return () => {
      stop();
      v.removeEventListener('playing', start);
      v.removeEventListener('pause', stop);
      v.removeEventListener('waiting', stop);
      v.removeEventListener('ended', stop);
      v.removeEventListener('seeking', seeking);
      v.removeEventListener('timeupdate', time);
    };
  }, [video, preview, stopAt, onTime, control, duration]);

  // Redraw when the style, the text or the toggle changes (also while paused).
  useEffect(() => { control.redrawSubtitle?.(); }, [control, style, sentences, showSubtitles, fontReady, box]);

  const { settings } = project;
  const separate = settings.background === 'separate';
  const toggle = () => {
    const v = video.current;
    if (!v) return;
    stopAt.current = null;
    if (v.paused) v.play().catch(() => {}); else v.pause();
  };
  // ⏮ / ⏭: the previous / next sentence from the playhead.
  const step = (dir) => {
    const t = video.current?.currentTime ?? 0;
    const target = dir > 0 ? sentences.find((x) => x.start > t + 0.05) : [...sentences].reverse().find((x) => x.start < t - 0.3);
    if (target) onStep(target);
  };
  const current = sentences.find((x) => time >= x.start && time < x.end);
  const inRemoved = (settings.video_cuts || []).some((c) => time >= c.start && time < c.end - 0.02);
  const background = settings.background === 'replace' ? 'original audio off'
    : separate ? (project.background_url ? `music ${Math.round(settings.background_volume * 100)}% · original voice removed` : 'original quiet until its voice is removed')
      : `original ${Math.round(settings.background_volume * 100)}%`;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* small screens: the video's own shape (portrait stays tall); desktop: fills the panel */}
      <div ref={stage} style={{ '--ar': `${width} / ${height}` }}
        className="relative max-h-[65vh] w-full bg-black [aspect-ratio:var(--ar)] lg:max-h-none lg:min-h-0 lg:flex-1 lg:[aspect-ratio:auto]">
        <video ref={video} src={project.source_url} playsInline preload="auto" onClick={toggle} className="absolute inset-0 h-full w-full cursor-pointer" />
        {box && <CoverBox cover={cover || project.settings.cover} box={box} editing={editingCover} onChange={onCoverChange} />}
        {box && (
          <canvas ref={subs} width={width} height={height} aria-hidden="true" className="pointer-events-none absolute"
            style={{ left: box.left, top: box.top, width: box.width, height: box.height }} />
        )}
        {inRemoved && !playing && (
          <span className="pointer-events-none absolute left-3 top-3 rounded-md bg-red-600 px-2 py-1 text-xs font-semibold text-white shadow">✂ Removed from the video</span>
        )}
        {!playing && (
          <button type="button" onClick={toggle} aria-label="Play"
            className="absolute left-1/2 top-1/2 flex h-14 w-14 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur transition hover:bg-black/70">
            <svg viewBox="0 0 24 24" className="ml-1 h-6 w-6" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15l13-7.5z" /></svg>
          </button>
        )}
      </div>
      {separate && project.background_url && <audio ref={music} src={project.background_url} preload="auto" className="hidden" />}

      <div className="flex items-center gap-1.5 border-t border-line px-2 py-1.5 sm:gap-2 sm:px-3">
        <IconButton label="Previous sentence" onClick={() => step(-1)}>
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" aria-hidden="true"><path d="M6 5h2v14H6zM20 5v14L9 12z" /></svg>
        </IconButton>
        <button type="button" onClick={toggle} aria-label={playing ? 'Pause' : 'Play'} title={playing ? 'Pause (Space)' : 'Play (Space)'}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent text-white shadow-sm hover:bg-accent-hover">
          {playing
            ? <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" aria-hidden="true"><path d="M7 5h4v14H7zM13 5h4v14h-4z" /></svg>
            : <svg viewBox="0 0 24 24" className="ml-0.5 h-4 w-4" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15l13-7.5z" /></svg>}
        </button>
        <IconButton label="Next sentence" onClick={() => step(1)}>
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" aria-hidden="true"><path d="M16 5h2v14h-2zM4 5v14l11-7z" /></svg>
        </IconButton>
        <span className="shrink-0 font-mono text-xs tabular-nums text-muted">{formatTime(time)}</span>
        <input type="range" min="0" max={duration} step="0.1" value={time} aria-label="Position in the video"
          onChange={(e) => { stopAt.current = null; if (video.current) video.current.currentTime = Number(e.target.value); }} className="min-w-0 flex-1" />
        <span className="hidden shrink-0 font-mono text-xs tabular-nums text-faint sm:inline">{formatTime(duration)}</span>
        <IconButton label={showSubtitles ? 'Hide subtitles in the preview' : 'Show subtitles in the preview'} active={showSubtitles} onClick={() => setShowSubtitles(!showSubtitles)}>
          <span className="text-[11px] font-bold">CC</span>
        </IconButton>
        <IconButton label="Full screen" onClick={() => (document.fullscreenElement ? document.exitFullscreen() : stage.current?.requestFullscreen?.())}>
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></svg>
        </IconButton>
      </div>
      <div className="flex items-center gap-2 border-t border-line px-3 py-1.5 text-xs">
        {current ? (
          <>
            <span className="shrink-0 font-semibold text-accent-ink">#{numbers.get(current.id)}</span>
            <span className="khmer min-w-0 flex-1 truncate text-ink">{current.khmer_text || '—'}</span>
          </>
        ) : <span className="flex-1 text-faint">No sentence here</span>}
        <span className="hidden shrink-0 text-faint md:inline" title="The preview plays the Khmer clips live, with the background as it will be exported">Live preview · {background}</span>
      </div>
    </div>
  );
}
