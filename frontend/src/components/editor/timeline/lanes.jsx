import { useEffect, useRef, useState } from 'react';
import { formatTime } from '../../../api.js';
import { onPeaks, peaksOf } from '../../../lib/peaks.js';
import { token } from '../../../lib/theme.js';
import { clipAt, clipLevel, mediaLevel, sourceTime, voiceGain } from '../../../lib/timeline.js';
import { gapId } from './tools.js';
import { HEADER_W } from './layout.js';

// The five lanes of the timeline. Each draws only the clips between t0 and t1 (what's on screen);
// x = t * scale. Every lane gets the same `lane` props:
//   scale, t0, t1, sel (Set of selected ids), trim (an edge being dragged: {id, start, end}),
//   locked, onPick(e, clip) (click; Shift/⌘ adds to the selection), onMenu(e, clip) (right-click),
//   onEdge(e, clip, side) (drag a clip's edge), and `height` (the row's, or HEIGHT[kind]).
//
// Waveforms are drawn at the level the sound plays at (its volumes, volume line, fades and ducking:
// lib/timeline.js), over a faint full-size copy, so a change of volume shows as it's heard.

export const HEIGHT = { video: 52, voice: 54, text: 40, watermark: 34, background: 48, audio: 40 };

export const HATCH = { backgroundImage: 'repeating-linear-gradient(135deg, rgb(239 68 68 / 0.6) 0 2px, transparent 2px 8px)' };
const SOFT_HATCH = { backgroundImage: 'repeating-linear-gradient(135deg, var(--line-strong) 0 1px, transparent 1px 6px)' };

const VOICE_STYLE = {
  ok: 'border-accent/60 bg-accent-soft',
  too_long: 'border-amber-500 bg-amber-500/15',
  edited: 'border-dashed border-line-strong bg-panel',
  regenerating: 'border-accent/60 bg-accent-soft animate-pulse',
  failed: 'border-red-500/70 bg-red-500/15',
  empty: 'border-dashed border-line-strong bg-raised',
};

const visible = (c, t0, t1) => c.end >= t0 && c.start <= t1;
const ring = (on) => (on ? 'z-10 ring-2 ring-accent ring-offset-1 ring-offset-sunken' : '');
const shown = (c, trim) => (trim?.id === c.id ? { ...c, start: trim.start, end: trim.end } : c); // while its edge is dragged

// Very zoomed out (a one-second clip narrower than PACK_PX), each run of tiny clips is drawn as one bar:
// one element instead of hundreds, so zooming out of a long video stays smooth. Clips that are selected
// or being dragged (`keep`) still get their own block; a click on a bar moves the playhead there.
const PACK_PX = 4;
function packRuns(items, t0, t1, scale, keep) {
  const runs = [];
  let run = null;
  for (const c of items) {
    if (!visible(c, t0, t1) || keep(c)) continue;
    if (run && (c.start - run.end) * scale < 2) { run.end = Math.max(run.end, c.end); run.n += 1; } else { run = { start: c.start, end: c.end, n: 1, key: c.id }; runs.push(run); }
  }
  return runs;
}
function Packed({ runs, scale, className, style }) {
  return runs.map((r) => (
    <div key={`pack-${r.key}`} className={`pointer-events-none absolute rounded-sm ${className}`}
      style={{ left: r.start * scale, width: Math.max(1, (r.end - r.start) * scale), ...style }} />
  ));
}

// A thin handle on a clip's edge: drag it to make the clip shorter or longer.
function Edge({ side, onDown }) {
  return <div className={`absolute inset-y-0 ${side === 'start' ? 'left-0 rounded-l-md' : 'right-0 rounded-r-md'} z-[2] w-2 cursor-ew-resize hover:bg-accent/40`} onPointerDown={onDown} />;
}

// The parts every clip block shares: position, selection ring, click, right-click and edges.
function Block({ c, lane, className = '', style, title, children, edges = true }) {
  const s = shown(c, lane.trim);
  return (
    <div role="button" tabIndex={-1} data-clip={c.id} title={title}
      onPointerDown={(e) => lane.onPick(e, c)} onContextMenu={(e) => lane.onMenu(e, c)} onDoubleClick={() => lane.onDouble?.(c)}
      className={`absolute select-none ${ring(lane.sel.has(c.id))} ${className}`}
      style={{ left: s.start * lane.scale, width: Math.max(2, (s.end - s.start) * lane.scale), ...style }}>
      {children}
      {edges && !lane.locked && (s.end - s.start) * lane.scale > 10 && (
        <>
          <Edge side="start" onDown={(e) => lane.onEdge(e, c, 'start')} />
          <Edge side="end" onDown={(e) => lane.onEdge(e, c, 'end')} />
        </>
      )}
    </div>
  );
}

// ---------- video ----------

export function VideoLane({ clips, media, filmstrip, lane }) {
  const { scale, t0, t1, sel } = lane;
  const out = [];
  // the gaps between clips (black in the export): click one, then Delete closes it
  let last = 0;
  for (const c of clips) {
    if (c.start - last > 0.01 && c.start >= t0 && last <= t1) {
      const id = gapId(last, c.start);
      out.push(
        <div key={id} role="button" tabIndex={-1} title={`Empty: black in the export · ${formatTime(last)}–${formatTime(c.start)} · click it, then Delete closes it`}
          onPointerDown={(e) => lane.onPick(e, { id, start: last, end: c.start, gap: true })} onContextMenu={(e) => lane.onMenu(e, { id, start: last, end: c.start, gap: true })}
          className={`absolute inset-y-1 cursor-pointer rounded-md border border-dashed ${sel.has(id) ? 'border-accent bg-accent/15' : 'border-white/15 hover:border-white/40'}`}
          style={{ left: last * scale, width: (c.start - last) * scale }}>
          {sel.has(id) && (c.start - last) * scale > 90 && <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-[10px] font-semibold text-white/80">empty · Delete closes it</span>}
        </div>,
      );
    }
    last = Math.max(last, c.end);
  }
  for (const c of clips) {
    if (!visible(shown(c, lane.trim), t0, t1)) continue;
    const s = shown(c, lane.trim);
    const width = (s.end - s.start) * scale;
    const name = media[c.media]?.name;
    out.push(
      <Block key={c.id} c={c} lane={lane} className="inset-y-1 cursor-pointer overflow-hidden rounded-md border border-black/40 bg-neutral-800"
        title={`${c.type === 'image' ? 'Picture' : 'Video'} · ${formatTime(s.start)}–${formatTime(s.end)}${c.media !== 'source' && name ? ` · ${name}` : ''}${c.skipped ? ' · skipped: left out of the export' : ''}`}>
        {c.type === 'video' && c.media === 'source' && filmstrip && <Filmstrip clip={s} filmstrip={filmstrip} scale={scale} t0={t0} t1={t1} height={(lane.height ?? HEIGHT.video) - 8} />}
        {c.type === 'image' && media[c.media]?.url && (
          <div className="pointer-events-none absolute inset-0 opacity-90" style={{ backgroundImage: `url(${media[c.media].url})`, backgroundSize: 'auto 100%', backgroundRepeat: 'repeat-x' }} />
        )}
        {c.type === 'video' && c.media !== 'source' && media[c.media]?.poster_url && (
          <div className="pointer-events-none absolute inset-0 opacity-90" style={{ backgroundImage: `url(${media[c.media].poster_url})`, backgroundSize: 'auto 100%', backgroundRepeat: 'repeat-x' }} />
        )}
        {c.media !== 'source' && width > 60 && (
          <span className="pointer-events-none absolute left-1 top-1 max-w-[calc(100%-8px)] truncate rounded bg-black/60 px-1 text-[10px] leading-4 text-white">{c.type === 'image' ? '🖼' : '🎞'} {name}</span>
        )}
        {c.skipped && (
          <div className="pointer-events-none absolute inset-0 bg-black/55" style={HATCH}>
            {width > 70 && <span className="absolute bottom-1 left-1 rounded bg-red-600 px-1 text-[10px] font-semibold leading-4 text-white">⤼ skipped</span>}
          </div>
        )}
      </Block>,
    );
  }
  return out;
}

// The upload's frames along a clip, from the filmstrip (one small frame every `every` seconds).
export function Filmstrip({ clip, filmstrip, scale, t0, t1, height = HEIGHT.video - 8 }) {
  const { every, tiles, tile_width: tw, tile_height: th, url } = filmstrip;
  const k = height / th;
  const speed = clip.speed || 1;
  const out = [];
  const from = Math.max(clip.source_in, sourceTime(clip, Math.max(t0, clip.start)) - every);
  const to = Math.min(clip.source_out, sourceTime(clip, Math.min(t1, clip.end)) + every);
  for (let i = Math.max(0, Math.floor(from / every)); i < tiles && i * every < to; i += 1) {
    out.push(
      <div key={i} className="pointer-events-none absolute top-0 h-full border-r border-black/25" style={{
        left: ((i * every - clip.source_in) / speed) * scale, width: (every / speed) * scale,
        backgroundImage: `url(${url})`, backgroundRepeat: 'no-repeat',
        backgroundSize: `${tiles * tw * k}px ${height}px`, backgroundPosition: `${-i * tw * k}px 0`,
      }} />,
    );
  }
  return out;
}

// ---------- Khmer voice ----------

export function VoiceLane({ sentences, lane, drag, onDragStart }) {
  const { scale, t0, t1, sel, locked } = lane;
  const keep = (s) => sel.has(s.id) || drag?.id === s.id;
  const pack = scale < PACK_PX;
  const runs = pack ? packRuns(sentences, t0, t1, scale, keep) : [];
  const blocks = sentences.filter((s) => visible(s, t0, t1) && (!pack || keep(s))).map((s) => {
    const shownS = drag?.id === s.id ? { ...s, start: drag.start, end: drag.end } : s;
    const slot = shownS.end - shownS.start;
    const hasClip = s.status === 'ok' || s.status === 'too_long';
    const suspect = hasClip && !!s.voice_warning; // the voice may have come out wrong
    const clip = hasClip ? s.audio_duration : 0;
    const overflow = Math.max(0, clip - slot);
    return (
      <div key={s.id} role="button" tabIndex={-1} data-clip={s.id} onPointerDown={(e) => onDragStart(e, s, 'move')} onContextMenu={(e) => lane.onMenu(e, s)}
        className={`absolute top-1.5 select-none rounded-md border ${suspect ? VOICE_STYLE.too_long : VOICE_STYLE[s.status] || VOICE_STYLE.edited} ${ring(sel.has(s.id))} ${locked ? 'cursor-pointer' : drag?.id === s.id ? 'cursor-grabbing opacity-90' : 'cursor-grab'}`}
        style={{ left: shownS.start * scale, width: Math.max(4, slot * scale), height: (lane.height ?? HEIGHT.voice) - 12 }}
        title={`${formatTime(shownS.start)}–${formatTime(shownS.end)} · ${s.khmer_text || '(no text)'}${s.skipped ? '\n⤼ skipped: silent in the export' : ''}${s.status === 'too_long' ? '\n⚠ longer than its time: the end will be cut' : ''}${suspect ? `\n⚠ ${s.voice_warning}` : ''}`}>
        {hasClip && <div className="pointer-events-none absolute inset-y-0 left-0 rounded-l-md bg-accent/30" style={{ width: Math.min(clip, slot) * scale }} />}
        {overflow > 0.05 && (
          <div className="pointer-events-none absolute inset-y-2 rounded-r bg-red-500/45" style={{ left: '100%', width: overflow * scale }} title="Longer than its time — the end will be cut" />
        )}
        {s.skipped && <div className="pointer-events-none absolute inset-0 rounded-md bg-panel/60" style={SOFT_HATCH} />}
        {slot * scale > 26 && (
          <span className="khmer pointer-events-none relative block truncate px-1.5 pt-0.5 text-[11px] leading-[1.7] text-ink">
            {s.skipped && '⤼ '}{s.muted && '🔇 '}{(s.status === 'too_long' || suspect) && '⚠ '}{s.khmer_text || '…'}
          </span>
        )}
        {!locked && <Edge side="start" onDown={(e) => onDragStart(e, s, 'start')} />}
        {!locked && <Edge side="end" onDown={(e) => onDragStart(e, s, 'end')} />}
      </div>
    );
  });
  if (!pack) return blocks;
  return [<Packed key="packed" runs={runs} scale={scale} className="top-1.5 border border-accent/40 bg-accent-soft" style={{ height: (lane.height ?? HEIGHT.voice) - 12 }} />, ...blocks];
}

// ---------- text: the subtitles (from the voice clips) and text clips ----------

export const SUB_ROW = 18; // the subtitles' row; text clips get rows of TEXT_ROW under it
export const TEXT_ROW = 18;

// Text clips that overlap in time go on separate rows: {clip id: row}, and how many rows there are.
export function textRows(clips) {
  const ends = [];
  const rows = {};
  for (const c of [...clips].sort((a, b) => a.start - b.start)) {
    let r = ends.findIndex((e) => e <= c.start + 0.001);
    if (r < 0) { r = ends.length; ends.push(0); }
    ends[r] = c.end;
    rows[c.id] = r;
  }
  return { rows, count: Math.max(1, ends.length) };
}

export function TextLane({ lines, clips, rows, lane, subDrag, onLine, onLineEdge, onLineEdit }) {
  const { scale, t0, t1, sel, locked } = lane;
  const pack = scale < PACK_PX;
  const keepLine = (l) => sel.has(l.id) || subDrag?.id === l.id;
  const lineRuns = pack ? packRuns(lines, t0, t1, scale, keepLine) : [];
  return (
    <>
      {pack && <Packed runs={lineRuns} scale={scale} className="border border-sky-500/40 bg-sky-500/15" style={{ top: 2, height: SUB_ROW - 2 }} />}
      {lines.filter((l) => visible(l, t0, t1) && (!pack || keepLine(l))).map((l) => {
        const shownL = subDrag?.id === l.id ? { ...l, start: subDrag.start, end: subDrag.end } : l;
        return (
          <div key={`sub-${l.id}`} role="button" tabIndex={-1} onPointerDown={(e) => onLine(e, l)} onDoubleClick={() => onLineEdit(l)}
            onContextMenu={(e) => lane.onMenu(e, { ...l, subtitle: true })}
            title={`Subtitle of sentence · ${formatTime(shownL.start)}–${formatTime(shownL.end)} · ${l.text}\nDrag it (or its edges) to change when it shows · double-click to edit it`}
            className={`absolute cursor-pointer select-none overflow-hidden rounded border ${l.timed ? 'border-sky-400 bg-sky-400/25' : 'border-sky-500/50 bg-sky-500/15'} ${ring(sel.has(l.id))}`}
            style={{ left: shownL.start * scale, width: Math.max(2, (shownL.end - shownL.start) * scale), top: 2, height: SUB_ROW - 2 }}>
            {(shownL.end - shownL.start) * scale > 30 && <span className="khmer pointer-events-none block truncate px-1 text-[10px] leading-[1.5] text-sky-900 dark:text-sky-100">{l.text}</span>}
            {!locked && (shownL.end - shownL.start) * scale > 12 && (
              <>
                <Edge side="start" onDown={(e) => onLineEdge(e, l, 'start')} />
                <Edge side="end" onDown={(e) => onLineEdge(e, l, 'end')} />
              </>
            )}
          </div>
        );
      })}
      {clips.filter((c) => visible(shown(c, lane.trim), t0, t1)).map((c) => (
        <Block key={c.id} c={c} lane={lane} className="cursor-pointer overflow-hidden rounded border border-violet-500/60 bg-violet-500/20"
          style={{ top: SUB_ROW + 2 + (rows[c.id] || 0) * TEXT_ROW, height: TEXT_ROW - 2 }} title={`Text · ${formatTime(c.start)}–${formatTime(c.end)} · ${c.text}\nDrag it to change when it shows`}>
          {c.skipped && <div className="pointer-events-none absolute inset-0" style={SOFT_HATCH} />}
          {(c.end - c.start) * scale > 30 && <span className="khmer pointer-events-none block truncate px-1 text-[10px] leading-[1.5] text-violet-900 dark:text-violet-100">T {c.text}</span>}
        </Block>
      ))}
    </>
  );
}

// ---------- background: the video clips' own sound ----------

// One label for a piece that isn't simply at normal volume.
export function pieceLabel(b) {
  const bits = [];
  if (b.keep_voice) bits.push('🗣 original voice');
  if (b.muted) bits.push('🔇 muted');
  else if (b.keys?.length) bits.push('〰 volume line');
  else if (b.volume === 0) bits.push('🔇 silent');
  else if ((b.volume ?? 100) !== 100) bits.push(`${b.volume < 100 ? '🔉' : '🔊'} ${b.volume}%`);
  if (b.skipped) bits.push('⤼ skipped');
  return bits.join(' · ');
}

export function BackgroundLane({ clips, lane }) {
  const { scale, t0, t1 } = lane;
  return clips.filter((c) => visible(shown(c, lane.trim), t0, t1)).map((b) => {
    const s = shown(b, lane.trim);
    const label = pieceLabel(b);
    const silent = b.volume === 0 || b.muted || b.skipped;
    const tone = b.keep_voice ? 'border-emerald-500/60 bg-emerald-500/10' : silent ? 'border-line-strong bg-sunken/60'
      : b.keys?.length ? 'border-sky-500/60 bg-sky-500/10' : b.volume < 100 ? 'border-amber-500/60 bg-amber-500/10' : b.volume > 100 ? 'border-emerald-500/60 bg-emerald-500/10' : 'border-line-strong/70';
    return (
      <Block key={b.id} c={b} lane={lane} className={`inset-y-1 cursor-pointer rounded-md border ${tone}`}
        style={silent ? SOFT_HATCH : undefined}
        title={`Background · ${formatTime(s.start)}–${formatTime(s.end)}${label ? ` · ${label}` : ''}`}>
        {label && (s.end - s.start) * scale > 70 && <span className="pointer-events-none absolute left-1 top-0.5 truncate rounded bg-panel/90 px-1 text-[10px] leading-4 text-muted">{label}</span>}
      </Block>
    );
  });
}

// The sound's peaks under the background pieces, at each piece's level (drawn for the visible part).
// The upload's pieces use `waveform`; an added video's pieces, its own peaks from `waves`.
// A waveform bar's height: 100 % fills LOUD of the row, 200 % all of it.
const LOUD = 0.6;
const barHeight = (peak, level, room) => Math.min(room, peak * room * LOUD * level);

export function Waveform({ pieces, runs, waveform, waves = {}, view, scale, theme, height = HEIGHT.background }) {
  const canvas = useRef(null);
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const h = height;
    c.width = Math.round(view.width * dpr);
    c.height = h * dpr;
    const g = c.getContext('2d');
    g.scale(dpr, dpr);
    g.clearRect(0, 0, view.width, h);
    const colors = { normal: token('--muted'), ghost: token('--line'), voice: 'rgb(16 185 129 / 0.85)', loud: 'rgb(5 150 105 / 0.9)' };
    const room = h - 10;
    for (let x = 0; x < view.width; x += 2) {
      const t = (view.left + x) / scale;
      const b = clipAt(pieces, t);
      if (!b) continue;
      const wave = b.media === 'source' ? waveform : waves[b.media];
      if (!wave?.peaks?.length) continue;
      const { peaks, per_second: rate } = wave;
      const a = Math.floor(sourceTime(b, t, b.speed ?? 1) * rate);
      const z = Math.max(a + 1, Math.floor(sourceTime(b, (view.left + x + 2) / scale, b.speed ?? 1) * rate));
      let peak = 0;
      for (let k = a; k < z && k < peaks.length; k += 1) peak = Math.max(peak, peaks[k]);
      const level = b.skipped ? 0 : mediaLevel(runs, b.media, t);
      const ghost = Math.max(1, peak * room * LOUD);
      g.fillStyle = colors.ghost;
      g.fillRect(x, (h - ghost) / 2, 1.5, ghost);
      if (level <= 0) continue;
      const bar = Math.max(1, barHeight(peak, level, room));
      g.fillStyle = b.keep_voice ? colors.voice : level > 1.001 ? colors.loud : colors.normal;
      g.fillRect(x, (h - bar) / 2, 1.5, bar);
    }
  }, [pieces, runs, waveform, waves, view, scale, theme, height]);
  return <canvas ref={canvas} className="pointer-events-none absolute top-0" style={{ left: view.left, width: view.width, height }} />;
}

// ---------- music & sound effects ----------

export function AudioLane({ clips, media, lane }) {
  const { scale, t0, t1 } = lane;
  if (!clips.length) {
    return <div className="pointer-events-none sticky flex h-full w-fit items-center px-3 text-[11px] text-faint" style={{ left: HEADER_W }}>Music and sound effects you add go here — drop a file, or use the Media tab.</div>;
  }
  return clips.filter((c) => visible(shown(c, lane.trim), t0, t1)).map((c) => (
    <Block key={c.id} c={c} lane={lane} className="inset-y-1 cursor-pointer overflow-hidden rounded-md border border-teal-500/60 bg-teal-500/15"
      style={c.skipped ? SOFT_HATCH : undefined}
      title={`${media[c.media]?.name || 'Audio'} · ${formatTime(c.start)}–${formatTime(c.end)} · ${volumeText(c)}${c.fade_in || c.fade_out ? ` · fades ${c.fade_in || 0}s / ${c.fade_out || 0}s` : ''}`}>
      {(c.end - c.start) * scale > 40 && <span className="pointer-events-none relative z-[1] block truncate px-1.5 text-[10px] leading-[1.9] text-teal-900 dark:text-teal-100">♪ {media[c.media]?.name}{c.muted || c.keys?.length || (c.volume ?? 100) !== 100 ? ` · ${volumeText(c)}` : ''}</span>}
    </Block>
  ));
}

// The peaks of every music and sound clip on screen, at its level (fades included).
// A clip's volume in words: muted, its volume line, or its percent.
export const volumeText = (c) => (c.muted ? 'muted' : c.keys?.length ? 'volume line' : `${c.volume ?? 100}%`);

export function SoundWaves({ clips, waves, runs, view, scale, theme, height = HEIGHT.audio }) {
  const canvas = useRef(null);
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const h = height;
    c.width = Math.round(view.width * dpr);
    c.height = h * dpr;
    const g = c.getContext('2d');
    g.scale(dpr, dpr);
    g.clearRect(0, 0, view.width, h);
    const colors = { normal: token('--muted'), ghost: token('--line'), loud: 'rgb(5 150 105 / 0.9)' };
    const room = h - 12;
    for (let x = 0; x < view.width; x += 2) {
      const t = (view.left + x) / scale;
      for (const clip of clips) {
        if (t < clip.start || t >= clip.end || clip.skipped) continue;
        const wave = waves[clip.media];
        if (!wave?.peaks?.length) continue;
        const k = Math.floor((clip.source_in + (t - clip.start) * (clip.speed ?? 1)) * wave.per_second);
        const peak = wave.peaks[Math.min(wave.peaks.length - 1, Math.max(0, k))] || 0;
        const ghost = Math.max(1, peak * room * LOUD);
        g.fillStyle = colors.ghost;
        g.fillRect(x, (h - ghost) / 2, 1.5, ghost);
        const level = clipLevel(runs, clip, t);
        if (level <= 0) continue;
        const bar = Math.max(1, barHeight(peak, level, room));
        g.fillStyle = level > 1.001 ? colors.loud : colors.normal;
        g.fillRect(x, (h - bar) / 2, 1.5, bar);
      }
    }
  }, [clips, waves, runs, view, scale, theme, height]);
  return <canvas ref={canvas} className="pointer-events-none absolute top-0 opacity-80" style={{ left: view.left, width: view.width, height }} />;
}

// The Khmer voice clips' waveforms, at the level each plays at (its volume or volume line, its
// fades and the voice track's volume), in the lower part of their blocks.
export function VoiceWaves({ sentences, volume = 100, muted = false, view, scale, theme, height = HEIGHT.voice }) {
  const canvas = useRef(null);
  const [ready, setReady] = useState(0); // bumps when a clip's peaks arrive
  useEffect(() => onPeaks(() => setReady((n) => n + 1)), []);
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const band = 20; // px, under the text
    c.width = Math.round(view.width * dpr);
    c.height = band * dpr;
    const g = c.getContext('2d');
    g.scale(dpr, dpr);
    g.clearRect(0, 0, view.width, band);
    const colors = { normal: token('--accent'), ghost: token('--line-strong'), loud: 'rgb(5 150 105 / 0.95)' };
    const t0 = view.left / scale;
    const t1 = (view.left + view.width) / scale;
    for (const s of sentences) {
      if (s.end < t0 || s.start > t1 || !s.audio_url || !s.audio_duration) continue;
      const wave = peaksOf(s.audio_url);
      if (!wave) continue;
      const slot = s.end - s.start;
      const plays = Math.min(s.audio_duration, slot);
      const cut = s.audio_duration > slot;
      const from = Math.max(0, Math.floor(s.start * scale - view.left));
      const to = Math.min(view.width, Math.ceil((s.start + plays) * scale - view.left));
      for (let x = from - (from % 2); x < to; x += 2) {
        const local = (view.left + x) / scale - s.start;
        if (local < 0 || local >= plays) continue;
        const k = Math.floor(local * wave.per_second);
        const z = Math.max(k + 1, Math.floor((local + 2 / scale) * wave.per_second));
        let peak = 0;
        for (let i = k; i < z && i < wave.peaks.length; i += 1) peak = Math.max(peak, wave.peaks[i]);
        const ghost = Math.max(1, Math.min(band, peak * band));
        g.fillStyle = colors.ghost;
        g.fillRect(x, (band - ghost) / 2, 1.5, ghost);
        const level = muted || s.skipped ? 0 : voiceGain(s, local, plays, cut) * (volume / 100);
        if (level <= 0) continue;
        g.fillStyle = level > 1.001 ? colors.loud : colors.normal;
        const bar = Math.max(1, Math.min(band, peak * band * level));
        g.fillRect(x, (band - bar) / 2, 1.5, bar);
      }
    }
  }, [sentences, volume, muted, view, scale, theme, ready]);
  return <canvas ref={canvas} className="pointer-events-none absolute z-[11] opacity-70" style={{ left: view.left, width: view.width, height: 20, top: height - 28 }} />;
}

// ---------- a collapsed track, and tracks of other kinds ----------

const MINI_TONE = {
  video: 'bg-neutral-500/70', voice: 'bg-accent/60', text: 'bg-sky-500/60', background: 'bg-line-strong', audio: 'bg-teal-500/60',
};

// A collapsed track: its clips as thin bars (the selected ones ringed). Click one to select it.
export function MiniLane({ clips, kind, lane }) {
  const { scale, t0, t1, sel } = lane;
  const tone = MINI_TONE[kind] || 'bg-violet-500/50';
  const pack = scale < PACK_PX;
  const keep = (c) => sel.has(c.id);
  const bars = clips.filter((c) => visible(c, t0, t1) && (!pack || keep(c))).map((c) => (
    <div key={c.id} role="button" tabIndex={-1} data-clip={c.id} onPointerDown={(e) => lane.onPick(e, c)} onContextMenu={(e) => lane.onMenu(e, c)}
      title={`${formatTime(c.start)}–${formatTime(c.end)}${c.khmer_text || c.text ? ` · ${c.khmer_text || c.text}` : ''}`}
      className={`absolute inset-y-[3px] cursor-pointer rounded-sm ${tone} ${c.skipped ? 'opacity-40' : ''} ${ring(sel.has(c.id))}`}
      style={{ left: c.start * scale, width: Math.max(2, (c.end - c.start) * scale) }} />
  ));
  if (!pack) return bars;
  return [<Packed key="packed" runs={packRuns(clips, t0, t1, scale, keep)} scale={scale} className={`inset-y-[3px] ${tone}`} />, ...bars];
}

// A track of a kind this timeline has no lane of its own for: its clips as plain blocks.
export function GenericLane({ clips, lane }) {
  const { scale, t0, t1, sel } = lane;
  const pack = scale < PACK_PX;
  const keep = (c) => sel.has(c.id) || lane.trim?.id === c.id;
  const blocks = clips.filter((c) => visible(shown(c, lane.trim), t0, t1) && (!pack || keep(c))).map((c) => (
    <Block key={c.id} c={c} lane={lane} className="inset-y-1 cursor-pointer overflow-hidden rounded-md border border-violet-500/50 bg-violet-500/15"
      title={`${c.type || 'Clip'} · ${formatTime(c.start)}–${formatTime(c.end)}`}>
      {(c.end - c.start) * scale > 40 && <span className="pointer-events-none block truncate px-1.5 text-[10px] leading-[1.9] text-violet-900 dark:text-violet-100">{c.name || c.text || c.type}</span>}
    </Block>
  ));
  if (!pack) return blocks;
  return [<Packed key="packed" runs={packRuns(clips, t0, t1, scale, keep)} scale={scale} className="inset-y-1 border border-violet-500/40 bg-violet-500/15" />, ...blocks];
}

// ---------- watermarks ----------

// The watermark clips: the logo (or the text) on each, how long it shows, and "whole video" when
// it follows the video's length. Drag one to move it, its edges to show it for less or more time.
export const WATERMARK_ROW = 22; // watermarks shown at the same time go on rows of this height

export function WatermarkLane({ clips, media, lane, rows = {}, count = 1 }) {
  const { scale, t0, t1 } = lane;
  const rowHeight = Math.max(12, Math.min(WATERMARK_ROW, ((lane.height ?? HEIGHT.watermark) - 6) / Math.max(1, count)));
  if (!clips.length) {
    return <div className="pointer-events-none sticky flex h-full w-fit items-center px-3 text-[11px] text-faint" style={{ left: HEADER_W }}>Your logo goes here — Watermark, above the timeline.</div>;
  }
  return clips.filter((c) => visible(shown(c, lane.trim), t0, t1)).map((c) => {
    const s = shown(c, lane.trim);
    const m = media[c.media];
    const name = c.kind === 'text' ? c.text || 'Text' : m?.name || 'Logo';
    return (
      <Block key={c.id} c={c} lane={lane} className="cursor-pointer overflow-hidden rounded-md border border-fuchsia-500/60 bg-fuchsia-500/15"
        style={{ top: 3 + (rows[c.id] || 0) * rowHeight, height: rowHeight - 2, ...(c.skipped ? SOFT_HATCH : {}) }}
        title={`Watermark · ${name} · ${c.whole ? 'the whole video' : `${formatTime(s.start)}–${formatTime(s.end)}`} · ${c.opacity}%`}>
        <span className="pointer-events-none sticky left-0 flex h-full max-w-full items-center gap-1 px-1.5 text-[10px] text-fuchsia-950 dark:text-fuchsia-100">
          {c.kind !== 'text' && m && <img src={c.remove_bg && m.nobg_url ? m.nobg_url : m.url} alt="" className="h-4 max-w-8 shrink-0 object-contain" />}
          {(s.end - s.start) * scale > 60 && <span className="khmer truncate">{c.kind === 'tiled' ? '▦ ' : ''}{name}{c.whole ? ' · whole video' : ''}</span>}
        </span>
      </Block>
    );
  });
}
