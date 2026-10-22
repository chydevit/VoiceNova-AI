import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { drawSubtitle, drawTextClip, drawTitle, loadSubtitleFont, measureTextClip } from '../../lib/subtitleImages.js';
import { canvasSize, clipAt, lineAt, pictureRect, subtitleLines, timecode, trackOf } from '../../lib/timeline.js';
import { SAFE_AREA, drawWatermarks, isPortrait, loadImage, logoUrl, placeRendered, renderWatermark, snapBox } from '../../lib/watermark.js';
import { IconButton } from '../ui.jsx';

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

const SAMPLE = { id: 'sample', text: 'ឧទាហរណ៍អក្សររត់ · sample subtitle', original: 'Original line' }; // shown while styling, when no sentence is on screen

// The box around the subtitle on the preview while styling it: drag it to move the subtitle.
// Snaps to the middle. `onMove({x, margin})` gets the new position (% of the picture).
function SubtitleHandle({ bounds, box, canvas, style, onMove }) {
  const drag = useRef(null);
  if (!bounds) return null;
  const k = box.width / canvas.width;
  const start = (e) => {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x0: e.clientX, y0: e.clientY, x: style.x ?? 50, margin: style.margin, top: style.position === 'top' };
  };
  const move = (e) => {
    const d = drag.current;
    if (!d) return;
    const dx = ((e.clientX - d.x0) / box.width) * 100;
    const dy = ((e.clientY - d.y0) / box.height) * 100;
    let x = clamp(d.x + dx, 0, 100);
    if (Math.abs(x - 50) < 1.5) x = 50;
    const margin = clamp(d.top ? d.margin + dy : d.margin - dy, 0, 95);
    onMove({ x: Math.round(x * 2) / 2, margin: Math.round(margin * 2) / 2 });
  };
  return (
    <div role="button" tabIndex={-1} title="Drag to move the subtitle"
      onPointerDown={start} onPointerMove={move} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}
      className="absolute cursor-move rounded outline-2 outline-dashed outline-accent hover:bg-white/10"
      style={{ left: box.left + bounds.left * k, top: box.top + bounds.top * k, width: bounds.width * k, height: bounds.height * k }}>
      <span className="pointer-events-none absolute -top-6 left-1/2 -translate-x-1/2 whitespace-nowrap rounded bg-accent px-1.5 py-0.5 text-[10px] font-semibold text-white shadow">✥ drag</span>
    </div>
  );
}

// The box around the selected text clip on the preview (paused): drag it to place the text, double-click
// it to edit the words. Snaps to the middle. Positions are % of the picture (the text's middle).
function TextHandle({ clip, box, canvas, onMove, onDone, onEdit }) {
  const drag = useRef(null);
  const bounds = measureTextClip(clip, canvas.width, canvas.height);
  if (!bounds) return null;
  const k = box.width / canvas.width;
  const start = (e) => {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x0: e.clientX, y0: e.clientY, x: clip.x ?? 50, y: clip.y ?? 50, moved: false, last: null };
  };
  const move = (e) => {
    const d = drag.current;
    if (!d || (!d.moved && Math.abs(e.clientX - d.x0) + Math.abs(e.clientY - d.y0) < 3)) return;
    let x = clamp(d.x + ((e.clientX - d.x0) / box.width) * 100, 0, 100);
    let y = clamp(d.y + ((e.clientY - d.y0) / box.height) * 100, 0, 100);
    if (Math.abs(x - 50) < 1.5) x = 50;
    if (Math.abs(y - 50) < 1.5) y = 50;
    d.moved = true;
    d.last = { x: Math.round(x * 2) / 2, y: Math.round(y * 2) / 2 };
    onMove(d.last);
  };
  const up = () => {
    const d = drag.current;
    drag.current = null;
    if (d?.moved && d.last) onDone(d.last);
  };
  return (
    <div role="button" tabIndex={-1} title="Drag to place the text · double-click to edit it"
      onPointerDown={start} onPointerMove={move} onPointerUp={up} onPointerCancel={() => { drag.current = null; }} onDoubleClick={onEdit}
      className="absolute cursor-move rounded outline-2 outline-dashed outline-violet-400 hover:bg-white/10"
      style={{ left: box.left + bounds.left * k, top: box.top + bounds.top * k, width: bounds.width * k, height: bounds.height * k }}>
      <span className="pointer-events-none absolute -top-6 left-1/2 -translate-x-1/2 whitespace-nowrap rounded bg-violet-500 px-1.5 py-0.5 text-[10px] font-semibold text-white shadow">✥ drag · double-click to edit</span>
    </div>
  );
}

// The box around the selected watermark on the preview (paused): drag it anywhere; it snaps to the
// edges (at its margin) and the middle, with guide lines, and to the nine positions there.
function WatermarkHandle({ clip, box, canvas, media, onMove, onDone }) {
  const drag = useRef(null);
  const [guides, setGuides] = useState([]);
  const r = renderWatermark(clip, canvas.width, canvas.height, media);
  if (!r || clip.kind === 'tiled') return null;
  const k = box.width / canvas.width;
  const at = placeRendered(clip, r, canvas.width, canvas.height);
  const start = (e) => {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const logo = { x: at.x + r.canvas.width / 2 - r.size.width / 2, y: at.y + r.canvas.height / 2 - r.size.height / 2 };
    drag.current = { x0: e.clientX, y0: e.clientY, logo, moved: false, last: null };
  };
  const move = (e) => {
    const d = drag.current;
    if (!d || (!d.moved && Math.abs(e.clientX - d.x0) + Math.abs(e.clientY - d.y0) < 3)) return;
    d.moved = true;
    const moved = { x: d.logo.x + (e.clientX - d.x0) / k, y: d.logo.y + (e.clientY - d.y0) / k, width: r.size.width, height: r.size.height };
    const snapped = snapBox(moved, clip, canvas.width, canvas.height, 10 / k);
    setGuides(snapped.guides);
    const cx = clamp(((snapped.x + r.size.width / 2) / canvas.width) * 100, 0, 100);
    const cy = clamp(((snapped.y + r.size.height / 2) / canvas.height) * 100, 0, 100);
    d.last = snapped.anchor ? { anchor: snapped.anchor } : { anchor: 'free', x: Math.round(cx * 10) / 10, y: Math.round(cy * 10) / 10 };
    onMove(d.last);
  };
  const up = () => {
    const d = drag.current;
    drag.current = null;
    setGuides([]);
    if (d?.moved && d.last) onDone(d.last);
  };
  return (
    <>
      <div role="button" tabIndex={-1} title="Drag to place the watermark (it snaps to the edges and the middle)"
        onPointerDown={start} onPointerMove={move} onPointerUp={up} onPointerCancel={() => { drag.current = null; setGuides([]); }}
        className="absolute z-[6] cursor-move rounded outline-2 outline-dashed outline-accent hover:bg-white/10"
        style={{ left: box.left + at.x * k, top: box.top + at.y * k, width: r.canvas.width * k, height: r.canvas.height * k }}>
        <span className="pointer-events-none absolute -top-6 left-1/2 -translate-x-1/2 whitespace-nowrap rounded bg-accent px-1.5 py-0.5 text-[10px] font-semibold text-white shadow">✥ drag the watermark</span>
      </div>
      {guides.map((g, i) => (
        <span key={i} className="pointer-events-none absolute z-[6] bg-accent/80"
          style={g.x !== undefined ? { left: box.left + g.x * k, top: box.top, width: 1, height: box.height } : { top: box.top + g.y * k, left: box.left, height: 1, width: box.width }} />
      ))}
    </>
  );
}

// Where TikTok, Reels and Shorts put their buttons and captions on a 9:16 video.
function SafeArea({ box }) {
  const s = SAFE_AREA;
  return (
    <div className="pointer-events-none absolute z-[5]" style={{ left: box.left, top: box.top, width: box.width, height: box.height }}>
      <div className="absolute border-2 border-dashed border-amber-300/80" style={{ left: `${s.left}%`, top: `${s.top}%`, right: `${s.right}%`, bottom: `${s.bottom}%` }} />
      <span className="absolute whitespace-nowrap rounded bg-amber-400/90 px-1 text-[9px] font-semibold leading-3 text-black" style={{ left: `${s.left}%`, top: `calc(${s.top}% + 2px)` }} title="TikTok, Reels and Shorts cover the rest with their buttons and captions">safe area</span>
    </div>
  );
}

// Typing straight into the subtitle on the preview (after a double-click on it).
function InlineSubtitle({ line, bounds, box, canvas, onSave, onCancel }) {
  const [text, setText] = useState(line.text);
  const done = useRef(false);
  const k = box.width / canvas.width;
  const finish = (save) => {
    if (done.current) return;
    done.current = true;
    if (save && text.trim() && text.trim() !== line.text) onSave(text.trim()); else onCancel();
  };
  return (
    <textarea autoFocus lang="km" value={text} rows={2} aria-label="Edit the subtitle"
      onChange={(e) => setText(e.target.value)} onBlur={() => finish(true)}
      onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finish(true); } if (e.key === 'Escape') { e.preventDefault(); finish(false); } }}
      className="khmer absolute z-20 resize-none rounded-md border-2 border-accent bg-black/80 p-1 text-center text-white shadow-lg focus:outline-none"
      style={{ left: box.left + Math.max(0, bounds.left - 20) * k, top: box.top + bounds.top * k - 8, width: Math.max(200, Math.min(canvas.width, bounds.width + 40) * k), minHeight: bounds.height * k + 16, fontSize: Math.max(13, bounds.height * k * 0.38) }} />
  );
}

const Svg = ({ d, fill = false, className = 'h-4 w-4' }) => (
  <svg viewBox="0 0 24 24" className={className} fill={fill ? 'currentColor' : 'none'} stroke={fill ? 'none' : 'currentColor'} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);

// The preview: the edit list played by control.playback (lib/playback.js) on a canvas the shape
// of the export, with the subtitles and title drawn exactly as they'll be burned in.
export default function Player({ project, sentences, tracks, control, time, playing, subtitleStyle, showSubtitles, setShowSubtitles, numbers, onStep, cover, editingCover, onCoverChange, title, onSubtitleMove,
  selectedText, textDraft, onTextMove, onTextCommit, onEditText, onSubtitleEdit, selectedWatermark, onWatermarkMove, onWatermarkCommit, showSafeArea }) {
  const style = subtitleStyle || project.settings.subtitle_style;
  const shownTitle = title || project.settings.title;
  const styling = !!onSubtitleMove; // the Subtitles tab is open: show a sample line and let it be dragged
  const { playback } = control;
  const canvas = useMemo(() => canvasSize(project), [project]);
  const fit = project.settings.export?.fit || 'fit';
  const fps = project.video.fps || 30;
  const lines = useMemo(() => subtitleLines(tracks), [tracks]);
  // the text clips that are drawn (the one being edited as it is being edited)
  const texts = useMemo(() => {
    const text = trackOf(tracks, 'text');
    if (text.hidden) return [];
    return text.clips.filter((c) => !c.skipped).map((c) => (textDraft?.id === c.id ? { ...c, ...textDraft.fields } : c));
  }, [tracks, textDraft]);
  const latest = useRef({});
  latest.current = { lines, style, showSubtitles, styling, texts, tracks, media: project.media };
  const wmCanvas = useRef(null);
  const wmDrawn = useRef(null);
  const [editingLine, setEditingLine] = useState(null);
  const shownLine = useRef(null);
  const textCanvas = useRef(null);
  const textsDrawn = useRef(null);
  const [subBounds, setSubBounds] = useState(null);
  const [box, setBox] = useState(null); // the canvas, in CSS pixels inside the stage
  const [fontReady, setFontReady] = useState(false);
  const stage = useRef(null);
  const els = { a: useRef(null), b: useRef(null), image: useRef(null), stem: useRef(null) };
  const subs = useRef(null);
  const titleCanvas = useRef(null);
  const drawn = useRef('');
  const duration = playback.duration;

  useEffect(() => {
    let live = true;
    loadSubtitleFont(style).then(() => { if (live) setFontReady(style.font || true); });
    return () => { live = false; };
  }, [style.font]); // eslint-disable-line react-hooks/exhaustive-deps
  const textFonts = [...new Set(texts.map((c) => c.style?.font).filter(Boolean))].join('|');
  useEffect(() => {
    let live = true;
    Promise.all(textFonts.split('|').filter(Boolean).map((f) => loadSubtitleFont({ font: f }))).then(() => { if (live) setFontReady(`${textFonts}#`); });
    return () => { live = false; };
  }, [textFonts]);

  useLayoutEffect(() => {
    playback.attach({ a: els.a.current, b: els.b.current, image: els.image.current, stem: els.stem.current });
    return () => playback.detach();
  }, [playback]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the canvas as large as the stage allows, in the export's shape.
  useLayoutEffect(() => {
    const el = stage.current;
    const measure = () => {
      const k = Math.min(el.clientWidth / canvas.width, el.clientHeight / canvas.height);
      const w = canvas.width * k;
      const h = canvas.height * k;
      setBox({ left: (el.clientWidth - w) / 2, top: (el.clientHeight - h) / 2, width: w, height: h });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [canvas.width, canvas.height]);

  // Draw the subtitle for time t (only when it changes).
  const caption = (t) => {
    const c = subs.current;
    if (!c) return;
    const { lines: ls, style: st, showSubtitles: on, styling: sample } = latest.current;
    const line = on ? lineAt(ls, t) || (sample ? SAMPLE : null) : null;
    const key = line ? `${line.id}|${line.text}|${line.original}|${JSON.stringify(st)}` : '';
    if (key === drawn.current) return;
    drawn.current = key;
    shownLine.current = line?.id === 'sample' ? null : line;
    setSubBounds(drawSubtitle(c.getContext('2d'), line, c.width, c.height, st));
  };

  // Draw the text clips on screen at time t, every frame (they animate in and out).
  const drawTexts = (t) => {
    const c = textCanvas.current;
    if (!c) return;
    const on = latest.current.texts.filter((x) => t >= x.start && t < x.end);
    if (!on.length && textsDrawn.current === '') return; // nothing then, nothing now
    textsDrawn.current = on.length ? 'some' : '';
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);
    for (const x of on) drawTextClip(ctx, x, c.width, c.height, t);
  };
  useEffect(() => playback.onFrame(drawTexts), [playback]); // eslint-disable-line react-hooks/exhaustive-deps

  // The watermarks on screen at time t, every frame (they may animate); drawn again once a logo loads.
  const drawMarks = (t) => {
    const c = wmCanvas.current;
    if (!c) return;
    const { tracks: tr, media } = latest.current;
    const any = trackOf(tr, 'watermark')?.clips.length > 0;
    if (!any && wmDrawn.current === '') return;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);
    wmDrawn.current = any ? 'some' : '';
    if (any && !drawWatermarks(ctx, tr, media, t, c.width, c.height)) {
      const waiting = trackOf(tr, 'watermark').clips.map((w) => logoUrl(w, media)).filter(Boolean);
      Promise.allSettled([...waiting.map(loadImage), document.fonts?.ready]).then(() => setTimeout(() => drawMarks(playback.t), 30));
    }
  };
  useEffect(() => playback.onFrame(drawMarks), [playback]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { wmDrawn.current = null; drawMarks(playback.t); }, [tracks, project.media, fontReady, box]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { textsDrawn.current = null; drawTexts(playback.t); }, [texts, fontReady, box]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => playback.subscribe(({ t }) => caption(t)), [playback]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { drawn.current = '#'; caption(playback.t); }, [lines, style, showSubtitles, fontReady, box, styling]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const c = titleCanvas.current;
    if (c) drawTitle(c.getContext('2d'), shownTitle, c.width, c.height);
  }, [shownTitle, fontReady, box, canvas]);

  // ⏮ / ⏭: the previous / next sentence from the playhead.
  const step = (dir) => {
    const t = playback.t;
    const target = dir > 0 ? sentences.find((x) => x.start > t + 0.05) : [...sentences].reverse().find((x) => x.start < t - 0.3);
    if (target) onStep(target);
  };

  const video = trackOf(tracks, 'video');
  const clip = clipAt(video.clips, time);
  const sourceOnScreen = clip?.type === 'video' && clip.media === 'source';
  const picture = box && pictureRect(box, project.video.width, project.video.height, fit); // the upload, inside the canvas
  const current = sentences.find((x) => time >= x.start && time < x.end);
  const { settings } = project;
  const separate = settings.background === 'separate';
  const bgTrack = trackOf(tracks, 'background');
  const level = bgTrack.muted ? 'muted' : `${bgTrack.volume ?? 100}%${bgTrack.duck?.on ? ` · ${bgTrack.duck.level}% under the voice` : ''}`;
  const background = settings.background === 'replace' ? 'original audio off'
    : separate ? (project.background_url ? `music ${level} · original voice removed` : 'original quiet until its voice is removed')
      : `original ${level}`;
  const objectFit = fit === 'fill' ? 'object-cover' : 'object-contain';
  const layer = box ? { left: box.left, top: box.top, width: box.width, height: box.height } : { display: 'none' };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* small screens: the canvas's own shape (portrait stays tall); desktop: fills the panel */}
      <div ref={stage} style={{ '--ar': `${canvas.width} / ${canvas.height}` }}
        className="relative max-h-[65vh] w-full overflow-hidden bg-neutral-900 [aspect-ratio:var(--ar)] lg:max-h-none lg:min-h-0 lg:flex-1 lg:[aspect-ratio:auto]">
        <div className="absolute bg-black" style={layer} onClick={() => playback.toggle()}>
          <video ref={els.a} playsInline preload="auto" className={`absolute inset-0 h-full w-full ${objectFit}`} />
          <video ref={els.b} playsInline preload="auto" className={`absolute inset-0 h-full w-full ${objectFit}`} />
          <img ref={els.image} alt="" className={`absolute inset-0 h-full w-full ${objectFit}`} style={{ visibility: 'hidden' }} />
        </div>
        {picture && sourceOnScreen && !video.hidden && (
          <CoverBox cover={cover || project.settings.cover} editing={editingCover} onChange={onCoverChange}
            box={{ left: box.left + picture.left, top: box.top + picture.top, width: picture.width, height: picture.height }} />
        )}
        <canvas ref={titleCanvas} width={canvas.width} height={canvas.height} aria-hidden="true" className="pointer-events-none absolute" style={layer} />
        <canvas ref={textCanvas} width={canvas.width} height={canvas.height} aria-hidden="true" className="pointer-events-none absolute" style={layer} />
        <canvas ref={subs} width={canvas.width} height={canvas.height} aria-hidden="true" className="pointer-events-none absolute" style={layer} />
        <canvas ref={wmCanvas} width={canvas.width} height={canvas.height} aria-hidden="true" className="pointer-events-none absolute" style={layer} />
        {box && showSafeArea && isPortrait(canvas.width, canvas.height) && <SafeArea box={box} />}
        {box && !playing && selectedWatermark && time >= selectedWatermark.start && time < selectedWatermark.end && !selectedWatermark.skipped && (
          <WatermarkHandle clip={selectedWatermark} box={box} canvas={canvas} media={project.media}
            onMove={(patch) => onWatermarkMove(selectedWatermark, patch)} onDone={(patch) => onWatermarkCommit(selectedWatermark, patch)} />
        )}
        {box && !playing && !styling && subBounds && shownLine.current && !editingLine && onSubtitleEdit && (
          <div role="button" tabIndex={-1} title="Double-click to edit this subtitle" onDoubleClick={() => setEditingLine(shownLine.current)}
            className="absolute cursor-text rounded hover:outline-1 hover:outline-dashed hover:outline-white/50"
            style={{ left: box.left + subBounds.left * (box.width / canvas.width), top: box.top + subBounds.top * (box.width / canvas.width), width: subBounds.width * (box.width / canvas.width), height: subBounds.height * (box.width / canvas.width) }} />
        )}
        {box && editingLine && subBounds && (
          <InlineSubtitle line={editingLine} bounds={subBounds} box={box} canvas={canvas}
            onSave={(text) => { onSubtitleEdit(editingLine.id, text); setEditingLine(null); }} onCancel={() => setEditingLine(null)} />
        )}
        {box && !playing && selectedText && time >= selectedText.start && time < selectedText.end && !selectedText.skipped && (
          <TextHandle clip={texts.find((x) => x.id === selectedText.id) || selectedText} box={box} canvas={canvas}
            onMove={(pos) => onTextMove(selectedText.id, pos)} onDone={(pos) => onTextCommit(selectedText.id, pos)} onEdit={() => onEditText(selectedText.id)} />
        )}
        {box && styling && showSubtitles && !playing && (
          <SubtitleHandle bounds={subBounds} box={box} canvas={canvas} style={style} onMove={onSubtitleMove} />
        )}
        {clip?.skipped && !playing && (
          <span className="pointer-events-none absolute left-3 top-3 rounded-md bg-red-600 px-2 py-1 text-xs font-semibold text-white shadow">⤼ Skipped — left out of the export</span>
        )}
        {!clip && !playing && duration > 0 && time < duration && (
          <span className="pointer-events-none absolute left-3 top-3 rounded-md bg-neutral-700 px-2 py-1 text-xs font-semibold text-white shadow">Empty — black in the export</span>
        )}
        {!playing && (
          <button type="button" onClick={() => playback.play()} aria-label="Play"
            className="absolute left-1/2 top-1/2 flex h-14 w-14 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur transition hover:bg-black/70">
            <svg viewBox="0 0 24 24" className="ml-1 h-6 w-6" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15l13-7.5z" /></svg>
          </button>
        )}
      </div>
      <audio ref={els.stem} preload="auto" className="hidden" />

      <div className="flex items-center gap-1 border-t border-line px-2 py-1.5 sm:gap-1.5 sm:px-3">
        <IconButton label="Previous sentence" onClick={() => step(-1)}><Svg fill d="M6 5h2v14H6zM20 5v14L9 12z" /></IconButton>
        <IconButton label="Back one frame (←)" onClick={() => playback.step(-1)}><Svg d="M15 6l-6 6 6 6M8 6v12" /></IconButton>
        <button type="button" onClick={() => playback.toggle()} aria-label={playing ? 'Pause' : 'Play'} title={playing ? 'Pause (Space)' : 'Play (Space)'}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent text-white shadow-sm hover:bg-accent-hover">
          {playing
            ? <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" aria-hidden="true"><path d="M7 5h4v14H7zM13 5h4v14h-4z" /></svg>
            : <svg viewBox="0 0 24 24" className="ml-0.5 h-4 w-4" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15l13-7.5z" /></svg>}
        </button>
        <IconButton label="Forward one frame (→)" onClick={() => playback.step(1)}><Svg d="M9 6l6 6-6 6M16 6v12" /></IconButton>
        <IconButton label="Next sentence" onClick={() => step(1)}><Svg fill d="M16 5h2v14h-2zM4 5v14l11-7z" /></IconButton>
        <span className="ml-1 shrink-0 font-mono text-xs tabular-nums text-ink" title="Playhead: minutes:seconds.frame">
          {timecode(time, fps)}<span className="text-faint"> / {timecode(duration, fps)}</span>
        </span>
        <input type="range" min="0" max={duration || 1} step={1 / fps} value={time} aria-label="Position on the timeline"
          onChange={(e) => playback.seek(Number(e.target.value))} className="min-w-0 flex-1 md:invisible" />
        <IconButton label={showSubtitles ? 'Hide subtitles in the preview' : 'Show subtitles in the preview'} active={showSubtitles} onClick={() => setShowSubtitles(!showSubtitles)}>
          <span className="text-[11px] font-bold">CC</span>
        </IconButton>
        <IconButton label="Full screen" onClick={() => (document.fullscreenElement ? document.exitFullscreen() : stage.current?.requestFullscreen?.())}>
          <Svg d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
        </IconButton>
      </div>
      <div className="flex items-center gap-2 border-t border-line px-3 py-1.5 text-xs">
        {current ? (
          <>
            <span className="shrink-0 font-semibold text-accent-ink">#{numbers.get(current.id)}</span>
            <span className="khmer min-w-0 flex-1 truncate text-ink">{current.khmer_text || '—'}</span>
          </>
        ) : <span className="flex-1 text-faint">No sentence here</span>}
        <span className="hidden shrink-0 text-faint md:inline" title="The preview plays the edit list live, with the background as it will be exported">Live preview · {background}</span>
      </div>
    </div>
  );
}
