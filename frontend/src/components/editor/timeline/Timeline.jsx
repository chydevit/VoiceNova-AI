import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { formatTime } from '../../../api.js';
import { useTheme } from '../../../lib/theme.js';
import { TRACK_INFO, edges, findClip, onFrame, skippedRanges, snapTo, soundRuns, speedOf, subtitleLines, timecode, trackOf } from '../../../lib/timeline.js';
import ContextMenu from './ContextMenu.jsx';
import { MEDIA_TYPE } from '../MediaBin.jsx';
import { AudioLane, BackgroundLane, GenericLane, HATCH, HEIGHT, MiniLane, SUB_ROW, SoundWaves, TEXT_ROW, TextLane, VideoLane, VoiceLane, VoiceWaves, WATERMARK_ROW, WatermarkLane, Waveform, textRows } from './lanes.jsx';
import VolumeLines from './VolumeLines.jsx';
import { DEFAULT_VIEW, HEADER_W, MAX_ROW, MIN_ROW, RULER, layoutRows, reveal, rowsHeight, visibleRowIds } from './layout.js';
import { useEdgeScroll, useTrackGestures } from './scrolling.js';
import { DockButtons } from './TimelineDock.jsx';

const MIN_LENGTH = 0.3; // shortest sentence; keep in sync with backend/sentences.py
const MIN_CLIP = 0.05; // shortest clip; keep in sync with backend/timeline.py
const MAX_PPS = 400; // most zoomed in: pixels per second
const TICK_STEPS = [1 / 30, 0.1, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round3 = (t) => Math.round(t * 1000) / 1000;
const EDGE_INSET = { left: HEADER_W, top: RULER }; // the sticky track names and ruler aren't part of the tracks' area
// A track's name, Khmer name and what its eye/speaker button does (tracks added later get a plain one).
const infoOf = (t) => TRACK_INFO[t.id] || TRACK_INFO[t.kind] || { name: t.name || t.id, km: '', toggle: 'muted' };

function usePref(key, initial) {
  const [value, setValue] = useState(() => {
    try { const v = localStorage.getItem(key); return v === null ? initial : JSON.parse(v); } catch { return initial; }
  });
  useEffect(() => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* not remembered */ } }, [key, value]);
  return [value, setValue];
}

export const Icon = ({ d, className = 'h-3.5 w-3.5' }) => (
  <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);
export const ICONS = {
  watermark: 'M4 4h16v16H4zM14 14l2.5 3M9 9.5a1.5 1.5 0 1 0 0 .01M4 17l5-5 4 4',
  lock: 'M7 11V7a5 5 0 0 1 10 0v4M5 11h14v10H5z',
  unlock: 'M7 11V7a5 5 0 0 1 9.9-1M5 11h14v10H5z',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  eyeOff: 'M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6C3.9 8.4 2 12 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6',
  sound: 'M11 5 6 9H2v6h4l5 4zM15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14',
  mute: 'M11 5 6 9H2v6h4l5 4zM22 9l-6 6M16 9l6 6',
  magnet: 'M6 3v8a6 6 0 0 0 12 0V3h-4v8a2 2 0 0 1-4 0V3zM6 7h4M14 7h4',
  split: 'M6 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM6 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM20 4 8.1 15.9M14.5 14.5 20 20M8.1 8.1 12 12',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  skip: 'M4 12h11M11 7l5 5-5 5M20 5v14',
  text: 'M4 7V4h16v3M9 20h6M12 4v16',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  voice: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM19 11a7 7 0 0 1-14 0M12 18v3',
  regen: 'M3 12a9 9 0 0 1 15.5-6.3L21 8M21 3v5h-5M21 12a9 9 0 0 1-15.5 6.3L3 16M3 21v-5h5',
  chevronDown: 'm6 9 6 6 6-6',
  chevronRight: 'm9 6 6 6-6 6',
};

// The playhead's time, updated by playback itself (the timeline doesn't redraw for it).
function Clock({ playback, fps }) {
  const [t, setT] = useState(playback.t);
  useEffect(() => playback.subscribe(({ t: now }) => setT(now)), [playback]);
  return <span className="font-mono text-xs tabular-nums text-muted">{timecode(t, fps)} / {timecode(playback.duration, fps)}</span>;
}

// A track's name column: it stays at the left while the tracks scroll sideways, and moves up and down
// with its row. ▸/▾ collapses the track to a thin row; drag its bottom edge to make it taller.
function TrackHeader({ track, row, onToggle, onMixer, onCollapse, resize }) {
  const info = infoOf(track);
  const toggle = info.toggle; // the video and text tracks can be hidden; the sound tracks muted
  const off = track[toggle];
  const base = `sticky left-0 z-[35] flex shrink-0 items-center gap-1 border-b border-r border-line px-1.5 ${track.locked ? 'bg-sunken' : 'bg-raised'}`;
  const arrow = (
    <button type="button" onClick={() => onCollapse(track.id, !row.collapsed)} aria-expanded={!row.collapsed}
      title={row.collapsed ? 'Expand this track' : 'Collapse this track to a thin row'} aria-label={`${row.collapsed ? 'Expand' : 'Collapse'} ${info.name}`}
      className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted hover:bg-panel hover:text-ink"><Icon d={row.collapsed ? ICONS.chevronRight : ICONS.chevronDown} className="h-3 w-3" /></button>
  );
  if (row.collapsed) {
    return (
      <div className={base} style={{ width: HEADER_W, height: row.height }}>
        {arrow}
        <span className={`truncate text-[10px] font-semibold leading-none ${off ? 'text-faint line-through' : 'text-muted'}`}>{info.name}</span>
      </div>
    );
  }
  const level = track.volume !== undefined && (
    <button type="button" onClick={onMixer} title="This track's volume — change it in the Audio tab"
      className={`ml-1 rounded px-1 font-mono text-[10px] tabular-nums hover:bg-raised ${off ? 'text-faint' : 'text-accent-ink'}`}>
      {track.volume}%{track.duck?.on ? ' ↓' : ''}
    </button>
  );
  return (
    <div className={`${base} relative`} style={{ width: HEADER_W, height: row.height }}>
      {arrow}
      <span className="min-w-0 flex-1 leading-tight">
        <span className={`block truncate text-[11px] font-semibold ${off ? 'text-faint line-through' : 'text-ink'}`}>{info.name}</span>
        <span className="flex items-center"><span className="khmer min-w-0 truncate text-[10px] leading-4 text-faint">{info.km}</span>{level}</span>
      </span>
      <button type="button" onClick={() => onToggle(track.id, { locked: !track.locked })} aria-pressed={track.locked}
        title={track.locked ? 'Unlock: allow changes to this track' : 'Lock: no edit changes this track (cuts don’t move it either)'} aria-label={track.locked ? `Unlock ${info.name}` : `Lock ${info.name}`}
        className={`rounded p-1 ${track.locked ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300' : 'text-faint hover:bg-raised hover:text-ink'}`}>
        <Icon d={track.locked ? ICONS.lock : ICONS.unlock} />
      </button>
      <button type="button" onClick={() => onToggle(track.id, { [toggle]: !off })} aria-pressed={off}
        title={toggle === 'hidden' ? (off ? 'Show this track' : 'Hide this track (preview and export)') : (off ? 'Unmute this track' : 'Mute this track (preview and export)')}
        aria-label={`${toggle === 'hidden' ? (off ? 'Show' : 'Hide') : (off ? 'Unmute' : 'Mute')} ${info.name}`}
        className={`rounded p-1 ${off ? 'bg-red-500/15 text-red-600 dark:text-red-400' : 'text-faint hover:bg-raised hover:text-ink'}`}>
        <Icon d={toggle === 'hidden' ? (off ? ICONS.eyeOff : ICONS.eye) : (off ? ICONS.mute : ICONS.sound)} />
      </button>
      <div role="separator" aria-orientation="horizontal" aria-label={`${info.name} track height`} title="Drag to make this track taller or shorter · double-click: usual height"
        onPointerDown={(e) => resize.start(e, track.id, row.height)} onPointerMove={resize.move} onPointerUp={resize.end} onPointerCancel={resize.cancel}
        onDoubleClick={() => resize.reset(track.id)}
        className="absolute inset-x-0 bottom-0 h-1.5 cursor-row-resize touch-none hover:bg-accent/40" />
    </div>
  );
}

const tool = 'inline-flex items-center gap-1 rounded-lg border border-line-strong px-2 py-1 text-xs font-medium text-ink hover:bg-raised disabled:cursor-not-allowed disabled:opacity-40';
const small = 'rounded-md px-2 py-0.5 text-[11px] font-semibold shadow-sm ring-1 ring-line-strong bg-panel text-ink hover:bg-raised disabled:opacity-40';

// How to delete a video clip: close the gap (what follows moves up) or leave it (black there).
export function DeleteChoice({ tools }) {
  const { asking } = tools;
  if (!asking) return null;
  const n = asking.ids.length;
  return (
    <div role="dialog" aria-label="How to delete" className="flex flex-wrap items-center gap-1.5 rounded-lg border border-red-500/30 bg-red-500/10 px-2.5 py-1.5 text-xs text-red-900 dark:text-red-100">
      <span className="font-semibold">Delete {n === 1 ? 'this clip' : `${n} clips`}:</span>
      <button type="button" autoFocus className={small} onClick={() => tools.remove('ripple')} title="Its time is removed from every unlocked track; everything after moves up (Shift+Delete)">⇤ Close the gap</button>
      <button type="button" className={small} onClick={() => tools.remove('gap')} title="Its time stays: black and silent there, other tracks unchanged (Alt+Delete)">▭ Leave a gap</button>
      <button type="button" className="px-1.5 py-0.5 underline" onClick={() => tools.setAsking(null)}>Cancel</button>
    </div>
  );
}

const RANGE_TRACKS = [['background', 'Background'], ['voice', 'Khmer voice'], ['audio', 'Music & sound']];

// One volume for the In/Out part of a sound track: which track, the volume (1 % steps), Set.
function RangeVolume({ tools, locked }) {
  const [track, setTrack] = useState('background');
  const [level, setLevel] = useState(50);
  const set = (v) => setLevel(Math.min(200, Math.max(0, Math.round(Number(v) || 0))));
  return (
    <span className="inline-flex items-center gap-1">
      <select value={track} onChange={(e) => setTrack(e.target.value)} disabled={locked} aria-label="Which track" className="rounded-md border border-line-strong bg-panel px-1 py-0.5 text-[11px] text-ink">
        {RANGE_TRACKS.map(([k, name]) => <option key={k} value={k}>{name}</option>)}
      </select>
      <button type="button" className={small} disabled={locked || level <= 0} onClick={() => set(level - 1)} aria-label="1% quieter" title="1% quieter (Shift: 10%)"
        onPointerDown={(e) => { if (e.shiftKey) { e.preventDefault(); set(level - 10); } }}>−</button>
      <input type="number" min="0" max="200" step="1" value={level} disabled={locked} aria-label="Volume for this part, in percent"
        onChange={(e) => set(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') tools.rangeAction('volume', { track, volume: level }); }}
        className="w-12 rounded-md border border-line-strong bg-panel px-1 py-0.5 text-right font-mono text-[11px] tabular-nums text-ink" />
      <button type="button" className={small} disabled={locked || level >= 200} onClick={() => set(level + 1)} aria-label="1% louder" title="1% louder">+</button>
      <span className="text-muted">%</span>
      <button type="button" className={small} disabled={locked} onClick={() => tools.rangeAction('volume', { track, volume: level })}
        title="This part of the track plays at this volume (compared with the rest of the track)">Set</button>
      <button type="button" className={small} disabled={locked} onClick={() => tools.rangeAction('volume', { track, volume: 0 })} title="Silence this part of the track">🔇</button>
      <button type="button" className={small} disabled={locked} onClick={() => tools.rangeAction('volume', { track, volume: 100 })} title="Back to normal (100%) in this part">100%</button>
    </span>
  );
}

// The tools above the timeline.
function Toolbar({ tools, selection, locked }) {
  const { picked, full, range, gap } = tools;
  const any = picked.length > 0 || !!gap;
  const allSkipped = picked.length > 0 && picked.every(({ clip }) => clip.skipped);
  return (
    <div className="mb-2 flex flex-wrap items-center gap-1.5">
      <button type="button" className={tool} disabled={locked} onClick={tools.split} title="Split the selected clip (or the video) at the playhead (S)">
        <Icon d={ICONS.split} /> Split <kbd className="text-faint">S</kbd>
      </button>
      <button type="button" className={tool} disabled={locked || !any} onClick={() => tools.remove()} title="Delete the selected clips (Delete). Shift+Delete closes the gap.">
        <Icon d={ICONS.trash} /> Delete
      </button>
      <button type="button" className={tool} disabled={locked || !picked.length} onClick={tools.skip} title="Leave the selected clips out of the export without deleting them; press again to bring them back">
        <Icon d={ICONS.skip} /> {allSkipped ? 'Bring back' : 'Skip'}
      </button>
      <button type="button" className={tool} disabled={locked || !picked.length} onClick={tools.duplicate} title="A copy of the selected clips right after them (Ctrl+D)">
        <Icon d={ICONS.copy} /> Duplicate
      </button>
      <button type="button" className={tool} disabled={locked || tools.locked('text')} onClick={tools.addText} title="Add text at the playhead (T)">
        <Icon d={ICONS.text} /> + Text <kbd className="text-faint">T</kbd>
      </button>
      <button type="button" className={tool} disabled={locked || tools.locked('voice')} onClick={tools.addVoice} title="Type a new Khmer line, choose a voice and generate it at the playhead">
        <Icon d={ICONS.voice} /> + Voice line
      </button>
      <button type="button" className={tool} disabled={locked} onClick={tools.watermark} title="Put your logo (or a line of text) on the video: the Watermark tab">
        <Icon d={ICONS.watermark} /> Watermark
      </button>
      <button type="button" className={tool} disabled={locked} onClick={() => tools.regenerate()} title="Voice again, translate again (natural, shorter, formal, casual), change the voice or fit the timing — of the selected sentences, the In/Out part, from the playhead, or the whole video">
        <Icon d={ICONS.regen} /> Regenerate…
      </button>
      <span className="mx-1 h-5 w-px bg-line" />
      <button type="button" className={tool} onClick={tools.markIn} title="Set the In point at the playhead (I)">In <kbd className="text-faint">I</kbd></button>
      <button type="button" className={tool} onClick={tools.markOut} title="Set the Out point at the playhead (O)">Out <kbd className="text-faint">O</kbd></button>
      {range && (
        <span className="inline-flex flex-wrap items-center gap-1.5 rounded-lg bg-accent-soft px-2 py-1 text-xs text-accent-ink">
          <span className="font-mono tabular-nums">{range.start !== null ? formatTime(range.start) : '…'} → {range.end !== null ? formatTime(range.end) : '…'}</span>
          {full ? (
            <>
              <span className="tabular-nums text-muted">{(full.end - full.start).toFixed(1)}s</span>
              <button type="button" className={small} disabled={locked} onClick={() => tools.rangeAction('remove')} title="Remove this part from every unlocked track; what follows moves up">✂ Remove</button>
              <button type="button" className={small} disabled={locked} onClick={() => tools.rangeAction('skip')} title="Leave this part out of the export, but keep it on the timeline">⤼ Skip</button>
              <button type="button" className={small} disabled={locked} onClick={() => tools.rangeAction('unskip')} title="Bring this part back into the export">↺ Bring back</button>
              <span className="text-muted">Volume:</span>
              <RangeVolume tools={tools} locked={locked} />
            </>
          ) : <span className="text-muted">{range.start === null ? 'now set In (I)' : 'now set Out (O)'}</span>}
          <button type="button" onClick={tools.clearRange} aria-label="Clear the In and Out points" title="Clear (Esc)" className="px-1 text-muted hover:text-ink">✕</button>
        </span>
      )}
      {selection.length > 1 && <span className="text-xs text-muted">{selection.length} selected</span>}
    </div>
  );
}

// The multi-track timeline (desktop): Video, Khmer voice, Text, Background, Music & sound.
//  - the red playhead follows playback; drag it (or click the ruler) to move it
//  - zoom with the slider, the − / + buttons or Ctrl/⌘ + mouse wheel; Fit shows everything
//  - snapping (magnet) makes the playhead and dragged clips stick to clip edges
//  - click a clip to select it (Shift/⌘: add to the selection); drag its edges to trim it;
//    drag a voice clip to move it; right-click for its actions; double-click empty space on the
//    voice track to add a sentence; click a gap in the video, then Delete closes it
//  - In / Out (I / O) mark a part, shaded on every track, for Remove / Skip / a track's volume there
//  - 〰 Volume lines: every sound clip shows its volume over time; click a clip to add a point, drag points
//  - the tracks scroll up and down (wheel, PageUp/PageDown) under the ruler, which stays at the top, and
//    sideways (Shift + wheel, a sideways swipe) under the track names, which stay at the left; Ctrl/⌘ +
//    wheel or a pinch zooms; dragging near an edge scrolls; Follow keeps the playhead in view while playing
//  - each track collapses (▸/▾) and has its own height (drag the bottom of its name); empty ones can hide
// Only what's on screen is drawn (the clips in view, the rows in view), so long videos stay smooth.
// layout / onLayout / onTrackLayout: the panel's saved look (usePanelView); controls: the panel's
// collapse / maximise / close buttons (TimelineDock); onMeasure: tells the dock how tall the tools are.
function Timeline({ project, tracks, sentences, media, playback, selection, onSelect, onTiming, onAdd, onTrack, tools, menuFor, onSubtitleEdit, onClipDouble,
  onDropMedia, onDropFiles, waves, filmstrip, waveform, voiceRemoved, locked: busy, sound, onMixer,
  layout = DEFAULT_VIEW, onLayout, onTrackLayout, controls, onMeasure }) {
  const theme = useTheme();
  const root = useRef(null);
  const scroller = useRef(null);
  const content = useRef(null);
  const origin = useRef(null); // the tracks' area: time 0 is its left edge, the first row its top
  const playhead = useRef(null);
  const rulerHead = useRef(null); // the playhead's handle on the ruler
  // the part of the tracks' area on screen, in its own pixels (the sticky names and ruler excluded)
  const [view, setView] = useState({ left: 0, top: 0, width: 800, height: 240 });
  const [rowDrag, setRowDrag] = useState(null); // a track's bottom edge being dragged: {id, y0, h0, h}
  const [pps, setPps] = useState(null); // pixels per second; null = default zoom
  const [snap, setSnap] = usePref('kva-snap', true);
  const [volumeLines, setVolumeLines] = usePref('kva-volume-lines', false); // edit the sound clips' volume lines
  const [drag, setDrag] = useState(null); // a voice clip being moved or retimed
  const [move, setMove] = useState(null); // text / sound clips being moved: {ids, x0, by, moved}
  const [subDrag, setSubDrag] = useState(null); // a subtitle being retimed: {id, mode, start, end}
  const [inline, setInline] = useState(null); // a subtitle being typed on the timeline: {id, text}
  const [shift, setShift] = useState(null); // a video clip being rearranged: {id, lead, x0, start, insert, to, moved}
  const [dropAt, setDropAt] = useState(null); // a file dragged over the timeline: {t, lane}
  const [trim, setTrim] = useState(null); // a clip edge being dragged: {id, side, start, end, lo, hi}
  const [scrubbing, setScrubbing] = useState(null); // 'playhead' | 'in' | 'out'
  const [menu, setMenu] = useState(null); // {x, y, clip, at}
  const anchor = useRef(null); // {t, x}: keep moment t at x pixels while zooming
  const fps = project.video.fps || 30;
  const end = Math.max(playback.duration, 1);
  const sel = useMemo(() => new Set(selection), [selection]);

  const fitScale = Math.max(0.05, (view.width - 24) / end);
  const scale = pps ?? Math.max(fitScale, view.width / Math.min(end, 40));
  const live = useRef({});
  live.current = { scale, fitScale, follow: layout.follow, busy: !!drag || !!scrubbing || !!trim || !!move || !!subDrag || !!shift };

  const readView = (el) => ({ left: el.scrollLeft, top: el.scrollTop, width: Math.max(1, el.clientWidth - HEADER_W), height: Math.max(1, el.clientHeight - RULER) });
  useLayoutEffect(() => {
    const el = scroller.current;
    const measure = () => setView(readView(el));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // Scrolling redraws at most once a frame.
  const scrollFrame = useRef(0);
  const onScroll = () => {
    if (scrollFrame.current) return;
    scrollFrame.current = requestAnimationFrame(() => {
      scrollFrame.current = 0;
      if (scroller.current) setView(readView(scroller.current));
    });
  };
  useEffect(() => () => cancelAnimationFrame(scrollFrame.current), []);

  // After zooming, keep the anchored moment where it was.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!anchor.current) return;
    el.scrollLeft = anchor.current.t * scale - anchor.current.x;
    anchor.current = null;
    setView(readView(el));
  }, [scale]);

  const zoomTo = (next, x = view.width / 2) => {
    const el = scroller.current;
    anchor.current = { t: (el.scrollLeft + x) / scale, x };
    setPps(clamp(next, fitScale, MAX_PPS));
  };

  // Wheel, trackpad and pinch (scrolling.js): zoom around the pointer, keeping that moment under it.
  useTrackGestures(scroller, (factor, clientX) => {
    const el = scroller.current;
    const s = live.current.scale;
    const x = clamp(clientX - el.getBoundingClientRect().left - HEADER_W, 0, el.clientWidth - HEADER_W);
    anchor.current = { t: (el.scrollLeft + x) / s, x };
    setPps((cur) => clamp((cur ?? s) * factor, live.current.fitScale, MAX_PPS));
  });

  // The playhead follows playback; when it leaves the view (playing, stepping, a jump to a sentence)
  // the timeline scrolls to it — but not while you drag it or a clip yourself, and while playing only
  // with Follow on.
  useEffect(() => {
    let frame;
    let last = -1;
    const loop = () => {
      const el = scroller.current;
      if (el && playhead.current) {
        const x = playback.t * live.current.scale;
        playhead.current.style.transform = `translateX(${x}px)`;
        if (rulerHead.current) rulerHead.current.style.transform = `translateX(${x}px)`;
        const moved = playback.t !== last;
        last = playback.t;
        const width = el.clientWidth - HEADER_W;
        if (moved && !live.current.busy && (live.current.follow || !playback.playing) && (x < el.scrollLeft || x > el.scrollLeft + width * 0.85)) {
          el.scrollLeft = x - width * 0.15;
        }
      }
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [playback]);

  // Bring the selected clip into view (a sentence picked with ↑ / ↓ in the list, say): sideways, and
  // up or down to its track.
  const primary = selection[selection.length - 1];
  useEffect(() => {
    const el = scroller.current;
    const found = findClip(tracks, primary);
    if (!found || !el) return;
    const width = el.clientWidth - HEADER_W;
    const a = found.clip.start * scale;
    const b = found.clip.end * scale;
    const left = a < el.scrollLeft || b > el.scrollLeft + width ? a - width * 0.3 : el.scrollLeft;
    const row = rows.find((r) => r.id === found.track.id);
    const top = row ? reveal(el.scrollTop, el.clientHeight - RULER, row.top, row.top + row.height, 0) : el.scrollTop;
    if (Math.abs(left - el.scrollLeft) > 1 || Math.abs(top - el.scrollTop) > 1) el.scrollTo({ left, top });
  }, [primary]); // eslint-disable-line react-hooks/exhaustive-deps

  // PageUp / PageDown scroll the tracks (when nothing else has the keyboard).
  useEffect(() => {
    const onKey = (e) => {
      const el = scroller.current;
      if ((e.key !== 'PageUp' && e.key !== 'PageDown') || !el || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.target.closest?.('input, textarea, select, [contenteditable=true]')) return;
      if (e.target !== document.body && !root.current?.contains(e.target)) return;
      e.preventDefault();
      el.scrollBy({ top: (e.key === 'PageDown' ? 1 : -1) * Math.max(40, el.clientHeight - RULER - 24), behavior: 'smooth' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const t0 = view.left / scale - 2;
  const t1 = (view.left + view.width) / scale + 2;
  const timeAt = (clientX) => clamp((clientX - origin.current.getBoundingClientRect().left) / scale, 0, end);
  const snapPoints = useMemo(() => edges(tracks), [tracks]);
  // A dragged time sticks to the nearest clip edge, the playhead or an In/Out point (with snapping
  // on), and otherwise lands on a whole frame.
  const stick = (t, skip = []) => {
    if (snap) {
      const extra = [playback.t];
      if (tools.range?.start != null) extra.push(tools.range.start);
      if (tools.range?.end != null) extra.push(tools.range.end);
      const snapped = snapTo(t, [...snapPoints.filter((p) => !skip.includes(p)), ...extra], scale);
      if (snapped !== t) return snapped;
    }
    return onFrame(t, fps);
  };

  // ---------- the playhead and the In / Out points on the ruler ----------
  function startScrub(e, what = 'playhead') {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    setScrubbing(what);
    if (what === 'playhead') {
      if (playback.playing) playback.pause();
      playback.seek(stick(timeAt(e.clientX)));
    }
  }
  function moveScrub(e) {
    if (!scrubbing) return;
    if (scrubbing === 'playhead') { playback.seek(stick(timeAt(e.clientX))); return; }
    const t = stick(timeAt(e.clientX), [tools.range?.[scrubbing === 'in' ? 'start' : 'end']]);
    if (scrubbing === 'in') tools.setRange((r) => ({ ...r, start: Math.min(t, (r.end ?? end) - MIN_CLIP) }));
    else tools.setRange((r) => ({ ...r, end: Math.max(t, (r.start ?? 0) + MIN_CLIP) }));
  }

  // ---------- picking ----------
  const locked = (tid) => !!trackOf(tracks, tid)?.locked;

  // Click a clip: select it (Shift/⌘: add or remove it). Click empty space: move the playhead there.
  // Text and sound clips can also be dragged to another time.
  function pick(e, clip) {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (e.shiftKey || e.metaKey || e.ctrlKey) { onSelect(sel.has(clip.id) ? selection.filter((x) => x !== clip.id) : [...selection, clip.id]); return; }
    const tid = findClip(tracks, clip.id)?.track.id;
    if (tid === 'video' && !locked('video') && !busy) { // drag it to rearrange
      e.currentTarget.setPointerCapture(e.pointerId);
      setShift({ id: clip.id, lead: clip, x0: e.clientX, start: clip.start, insert: false, to: clip.start, moved: false });
      onSelect([clip.id]);
      return;
    }
    if ((tid === 'text' || tid === 'audio' || tid === 'watermark') && !locked(tid) && !busy) {
      const ids = sel.has(clip.id) ? selection.filter((x) => ['text', 'audio', 'watermark'].includes(findClip(tracks, x)?.track.id)) : [clip.id];
      e.currentTarget.setPointerCapture(e.pointerId); // on the clip itself, so its clicks and double-clicks stay its own
      setMove({ ids, lead: clip, x0: e.clientX, by: 0, moved: false });
      if (!sel.has(clip.id)) onSelect([clip.id]);
      return;
    }
    onSelect([clip.id]);
  }
  function emptyClick(e) {
    if (e.button !== 0 || e.target !== e.currentTarget) return;
    onSelect([]);
    playback.seek(stick(timeAt(e.clientX)));
  }
  function openMenu(e, clip) {
    e.preventDefault();
    e.stopPropagation();
    if (clip && !sel.has(clip.id)) onSelect([clip.id]);
    setMenu({ x: e.clientX, y: e.clientY, clip, at: timeAt(e.clientX) });
  }

  // ---------- trimming a clip's edge ----------
  // How far an edge can go (the server keeps to the same limits).
  function trimBounds(track, c, side) {
    let lo = 0;
    let hi = Infinity;
    if (track.id === 'video' || track.id === 'background') {
      const v = track.id === 'background' ? findClip(tracks, c.link)?.clip : null;
      if (v) { lo = v.start; hi = v.end; }
      for (const o of track.clips) {
        if (o.id === c.id || (track.id === 'background' && o.link !== c.link)) continue;
        if (o.end <= c.start + 0.001) lo = Math.max(lo, o.end);
        if (o.start >= c.end - 0.001) hi = Math.min(hi, o.start);
      }
    }
    if (c.source_in !== undefined && track.id !== 'background') {
      const speed = speedOf(tracks, c);
      lo = Math.max(lo, c.start - c.source_in / speed);
      const length = media[c.media]?.kind === 'image' ? null : media[c.media]?.duration;
      if (length) hi = Math.min(hi, c.start + (length - c.source_in) / speed);
    }
    return side === 'start' ? { lo, hi: c.end - MIN_CLIP } : { lo: c.start + MIN_CLIP, hi };
  }

  function startTrim(e, clip, side) {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const found = findClip(tracks, clip.id);
    if (!found || found.track.locked || busy) return;
    content.current.setPointerCapture(e.pointerId);
    if (!sel.has(clip.id)) onSelect([clip.id]);
    setTrim({ id: clip.id, side, x0: e.clientX, start: clip.start, end: clip.end, from: clip[side], ...trimBounds(found.track, clip, side), moved: false });
  }

  function moveTrim(e) {
    if (!trim.moved && Math.abs(e.clientX - trim.x0) < 3) return;
    const t = clamp(stick(timeAt(e.clientX), [trim.from]), trim.lo, trim.hi);
    setTrim({ ...trim, [trim.side]: t, moved: true });
  }

  function endTrim() {
    const original = findClip(tracks, trim.id)?.clip;
    const t = round3(trim[trim.side]);
    if (trim.moved && original && Math.abs(t - original[trim.side]) > 0.0005) tools.trim(original, trim.side, t);
    setTrim(null);
  }

  // ---------- moving and retiming a voice clip ----------
  function startDrag(e, s, mode) {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    if (e.shiftKey || e.metaKey || e.ctrlKey) { pick(e, s); return; }
    if (locked('voice') || busy) { onSelect([s.id]); playback.seek(s.start); return; }
    const i = sentences.findIndex((x) => x.id === s.id);
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({
      id: s.id, mode, x0: e.clientX, start0: s.start, end0: s.end, start: s.start, end: s.end, moved: false,
      prevEnd: i > 0 ? sentences[i - 1].end : 0,
      nextStart: i + 1 < sentences.length ? sentences[i + 1].start : end,
    });
  }

  // Rearranging a video clip: where there's room it just moves there; over other clips it goes in
  // between them, at the clip edge nearest the pointer (shown by a line), and what's there moves later.
  function moveShift(e) {
    const d = shift;
    if (!d.moved && Math.abs(e.clientX - d.x0) < 5) return;
    const { lead } = d;
    const length = lead.end - lead.start;
    const others = trackOf(tracks, 'video').clips.filter((c) => c.id !== lead.id);
    const start = Math.max(0, stick(lead.start + (e.clientX - d.x0) / scale, [lead.start, lead.end]));
    const free = !others.some((c) => c.start < start + length - 0.001 && c.end > start + 0.001);
    if (free) { setShift({ ...d, start, insert: false, to: start, moved: true }); return; }
    const t = timeAt(e.clientX);
    const bounds = [0, ...others.flatMap((c) => [c.start, c.end])];
    const to = bounds.reduce((best, b) => (Math.abs(b - t) < Math.abs(best - t) ? b : best), bounds[0]);
    setShift({ ...d, start, insert: true, to, moved: true });
  }
  function endShift() {
    const d = shift;
    setShift(null);
    if (!d.moved) return;
    if (d.insert || Math.abs(d.to - d.lead.start) > 0.0005) tools.moveVideo(d.id, round3(d.to), d.insert);
  }

  // Files and media items dropped on the timeline go where they're dropped: pictures and videos on
  // the video track (inserted), sound on the music track.
  const dropLane = (e) => {
    const y = e.clientY - origin.current.getBoundingClientRect().top;
    const row = rows.find((r) => y >= r.top && y < r.top + r.height);
    const kind = row && (trackOf(tracks, row.id)?.kind ?? row.id);
    return kind === 'audio' || kind === 'background' ? 'audio' : 'video';
  };
  const dragging = (e) => [...e.dataTransfer.types].some((x) => x === MEDIA_TYPE || x === 'Files');
  function overDrop(e) {
    if (!dragging(e) || busy) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setDropAt({ t: stick(timeAt(e.clientX)), lane: dropLane(e) });
  }
  function onDrop(e) {
    if (!dragging(e) || busy) return;
    e.preventDefault();
    const t = round3(stick(timeAt(e.clientX)));
    setDropAt(null);
    const mid = e.dataTransfer.getData(MEDIA_TYPE);
    if (mid) onDropMedia(mid, t);
    else if (e.dataTransfer.files?.length) onDropFiles([...e.dataTransfer.files], t);
  }

  function moveDrag(e) {
    if (trim) { moveTrim(e); return; }
    if (shift) { moveShift(e); return; }
    if (move) {
      if (!move.moved && Math.abs(e.clientX - move.x0) < 4) return;
      const raw = (e.clientX - move.x0) / scale;
      const { lead } = move;
      const length = lead.end - lead.start;
      let start = stick(lead.start + raw, [lead.start, lead.end]);
      const finish = stick(lead.start + raw + length, [lead.start, lead.end]);
      if (Math.abs(finish - (lead.start + raw + length)) < Math.abs(start - (lead.start + raw))) start = finish - length;
      setMove({ ...move, by: Math.max(start, 0) - lead.start, moved: true });
      return;
    }
    if (subDrag) { moveSub(e); return; }
    if (!drag) return;
    if (!drag.moved && Math.abs(e.clientX - drag.x0) < 4) return;
    const dt = (e.clientX - drag.x0) / scale;
    const near = (t) => (snap ? stick(t, [drag.start0, drag.end0]) : Math.round(t / 0.05) * 0.05);
    let { start, end: finish } = drag;
    if (drag.mode === 'move') {
      const length = drag.end0 - drag.start0;
      let a = near(drag.start0 + dt);
      const b = near(drag.start0 + dt + length);
      if (Math.abs(b - (drag.start0 + dt + length)) < Math.abs(a - (drag.start0 + dt))) a = b - length; // the end is nearer an edge
      start = clamp(a, drag.prevEnd, drag.nextStart - length);
      finish = start + length;
    } else if (drag.mode === 'start') {
      start = clamp(near(drag.start0 + dt), drag.prevEnd, drag.end0 - MIN_LENGTH);
    } else {
      finish = clamp(near(drag.end0 + dt), drag.start0 + MIN_LENGTH, drag.nextStart);
    }
    setDrag({ ...drag, start, end: finish, moved: true });
  }

  function endDrag() {
    if (trim) { endTrim(); return; }
    if (shift) { endShift(); return; }
    if (move) {
      if (move.moved && Math.abs(move.by) > 0.0005) tools.move(move.ids, round3(move.by));
      setMove(null);
      return;
    }
    if (subDrag) { endSub(); return; }
    if (!drag) return;
    if (drag.moved) {
      if (round3(drag.start) !== drag.start0 || round3(drag.end) !== drag.end0) onTiming(drag.id, round3(drag.start), round3(drag.end));
    } else {
      onSelect([drag.id]);
      playback.seek(drag.start0);
    }
    setDrag(null);
  }

  // ---------- a subtitle's own timing (it moves with its sentence) ----------
  function startSub(e, line, mode) {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const s = sentences.find((x) => x.id === line.id);
    if (!s) return;
    if (e.shiftKey || e.metaKey || e.ctrlKey || locked('text') || busy) { pick(e, s); return; }
    e.currentTarget.setPointerCapture(e.pointerId);
    setSubDrag({ id: line.id, mode, x0: e.clientX, start0: line.start, end0: line.end, start: line.start, end: line.end, moved: false });
  }
  function moveSub(e) {
    const d = subDrag;
    if (!d.moved && Math.abs(e.clientX - d.x0) < 4) return;
    const dt = (e.clientX - d.x0) / scale;
    let { start, end: finish } = d;
    if (d.mode === 'move') { start = Math.max(0, stick(d.start0 + dt, [d.start0, d.end0])); finish = start + (d.end0 - d.start0); }
    else if (d.mode === 'start') start = clamp(stick(d.start0 + dt, [d.start0]), 0, d.end0 - 0.2);
    else finish = Math.max(stick(d.end0 + dt, [d.end0]), d.start0 + 0.2);
    setSubDrag({ ...d, start, end: finish, moved: true });
  }
  function endSub() {
    const d = subDrag;
    setSubDrag(null);
    const s = sentences.find((x) => x.id === d.id);
    if (!d.moved) { if (s) { onSelect([s.id]); playback.seek(d.start0); } return; }
    if (Math.abs(d.start - d.start0) > 0.0005 || Math.abs(d.end - d.end0) > 0.0005) tools.subtitleTiming(d.id, round3(d.start), round3(d.end));
  }

  // ---------- a track's height (drag the bottom edge of its name) ----------
  const resize = {
    start(e, id, h) {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      e.currentTarget.setPointerCapture(e.pointerId);
      setRowDrag({ id, y0: e.clientY, h0: h, h });
    },
    move(e) {
      if (rowDrag) setRowDrag({ ...rowDrag, h: clamp(rowDrag.h0 + e.clientY - rowDrag.y0, MIN_ROW, MAX_ROW) });
    },
    end() {
      const d = rowDrag;
      setRowDrag(null);
      if (d && Math.abs(d.h - d.h0) >= 1) onTrackLayout?.(d.id, { height: Math.round(d.h), collapsed: false });
    },
    cancel() { setRowDrag(null); },
    reset(id) { onTrackLayout?.(id, { height: null }); },
  };
  const collapse = (id, on) => onTrackLayout?.(id, { collapsed: on });

  // Dragging near an edge of the tracks scrolls them (the ruler's playhead and In/Out: sideways only).
  const dragAxes = scrubbing ? 'x' : drag || move || trim || subDrag || shift ? 'xy' : null;
  useEdgeScroll(scroller, dragAxes, EDGE_INSET, (e) => (scrubbing ? moveScrub(e) : moveDrag(e)));

  // ---------- drawing ----------
  const step = TICK_STEPS.find((s) => s * scale >= 64) || 600;
  const ticks = [];
  for (let t = Math.max(0, Math.floor(t0 / step) * step); t <= Math.min(end, t1); t += step) ticks.push(t);
  const label = (t) => (step < 1 ? timecode(t, fps) : timecode(t, fps).replace(/\.\d+$/, ''));

  const video = trackOf(tracks, 'video');
  const text = trackOf(tracks, 'text');
  const background = trackOf(tracks, 'background');
  const audio = trackOf(tracks, 'audio');
  const lines = useMemo(() => subtitleLines(tracks.map((t) => (t.id === 'text' ? { ...t, hidden: false } : t))), [tracks]);
  const runs = useMemo(() => soundRuns(tracks, project.settings, !!project.background_url), [tracks, project.settings, project.background_url]);
  const pieces = useMemo(() => background.clips.map((b) => ({ ...b, speed: speedOf(tracks, b) })), [background.clips, tracks]);
  const skipped = useMemo(() => skippedRanges(tracks), [tracks]);
  const lane = (tid) => ({
    scale, t0, t1, sel, trim: trim || (move?.moved ? movedAsTrim : null) || (shift?.moved && !shift.insert && tid === 'video' ? { id: shift.id, start: shift.start, end: shift.start + shift.lead.end - shift.lead.start } : null),
    locked: locked(tid) || busy, onPick: pick, onMenu: openMenu, onEdge: startTrim, onDouble: onClipDouble, height: heights[tid],
  });
  const { rows: textRowOf, count } = useMemo(() => textRows(text.clips), [text.clips]);
  const marks = trackOf(tracks, 'watermark');
  const { rows: markRowOf, count: markRows } = useMemo(() => textRows(marks?.clips || []), [marks?.clips]); // watermarks at the same time: one row each
  // The rows: each track in order, at its usual height (the text track: as many rows as its clips
  // need), or the height chosen for it, or collapsed; empty ones left out with "Hide empty".
  const usual = { ...HEIGHT, text: SUB_ROW + 4 + count * TEXT_ROW, watermark: Math.max(HEIGHT.watermark, 6 + markRows * WATERMARK_ROW) };
  const shownLayout = rowDrag ? { ...layout, tracks: { ...layout.tracks, [rowDrag.id]: { collapsed: false, height: rowDrag.h } } } : layout;
  const isEmpty = (t) => (t.id === 'voice' ? !sentences.length : t.id === 'text' ? !lines.length && !t.clips.length : !t.clips.length);
  const rows = layoutRows(tracks, { base: usual, view: shownLayout, empty: isEmpty });
  const rowsTotal = rowsHeight(rows);
  const rowOf = Object.fromEntries(rows.map((r) => [r.id, r]));
  const heights = Object.fromEntries(rows.map((r) => [r.id, r.height]));
  const top = (tid) => rowOf[tid]?.top ?? 0; // in the tracks' area, under the ruler
  const inView = visibleRowIds(rows, view.top, view.height);
  const hiddenEmpty = layout.hide_empty ? tracks.filter(isEmpty).length : 0;
  const laneWidth = end * scale + 40;
  // while text or sound clips are dragged, the lead clip is drawn at its new time (as a "trim")
  const movedAsTrim = move?.moved ? { id: move.lead.id, start: move.lead.start + move.by, end: move.lead.end + move.by } : null;
  const rangeStart = tools.range?.start ?? null;
  const rangeEnd = tools.range?.end ?? null;
  const trimRow = trim?.moved ? rowOf[findClip(tracks, trim.id)?.track.id] : null;

  // The dock needs the height of everything but the tracks (title, tools, borders) for its limits.
  const firstRow = rows[0]?.height ?? 0;
  useLayoutEffect(() => {
    if (!onMeasure) return undefined;
    const report = () => {
      const r = root.current;
      const el = scroller.current;
      if (!r || !el) return;
      const next = { chrome: r.offsetHeight + 2 - el.clientHeight, firstRow, rowsTotal };
      onMeasure((m) => (m && Math.abs(m.chrome - next.chrome) < 1 && m.firstRow === next.firstRow && m.rowsTotal === next.rowsTotal ? m : next));
    };
    report();
    const ro = new ResizeObserver(report);
    ro.observe(root.current);
    return () => ro.disconnect();
  }, [onMeasure, firstRow, rowsTotal]);

  const box = (r, look = '', extra = {}) => ({
    className: `relative shrink-0 border-b border-line ${look}`, style: { width: laneWidth, height: r.height }, onPointerDown: emptyClick, ...extra,
  });
  // One track's lane: collapsed, a thin row of bars; out of view, an empty box of its size.
  function laneFor(track, r) {
    const kind = track.kind ?? track.id;
    if (r.collapsed) {
      const clips = kind === 'voice' ? sentences : kind === 'text' ? [...lines, ...track.clips] : track.clips;
      return <div {...box(r, 'bg-sunken')}><MiniLane clips={clips} kind={kind} lane={lane(track.id)} /></div>;
    }
    if (!inView.has(r.id)) return <div {...box(r)} />;
    if (kind === 'video') {
      return (
        <div {...box(r, `bg-black/85 ${track.hidden ? 'opacity-40' : ''}`)}>
          <VideoLane clips={track.clips} media={media} filmstrip={filmstrip} lane={lane(track.id)} />
        </div>
      );
    }
    if (kind === 'voice') {
      return (
        <div {...box(r, `bg-raised ${track.muted ? 'opacity-50' : ''}`, { onDoubleClick: (e) => { if (e.target === e.currentTarget && !locked('voice')) onAdd(round3(stick(timeAt(e.clientX)))); } })}>
          <VoiceLane sentences={sentences} lane={lane('voice')} drag={drag} onDragStart={startDrag} />
          <VoiceWaves sentences={sentences} volume={track.volume} muted={track.muted} view={view} scale={scale} theme={theme} height={r.height} />
          <VolumeLines clips={sentences} tid="voice" speedOf={() => 1} lane={lane('voice')} top={6} height={r.height - 12} editing={volumeLines} sound={sound} onSelect={(c) => onSelect([c.id])} />
        </div>
      );
    }
    if (kind === 'text') {
      return (
        <div {...box(r, `overflow-hidden bg-panel ${track.hidden ? 'opacity-40' : ''}`, { onDoubleClick: (e) => { if (e.target === e.currentTarget && !locked('text')) { playback.seek(stick(timeAt(e.clientX))); tools.addText(); } } })}>
          <TextLane lines={lines} clips={track.clips} rows={textRowOf} lane={lane('text')} subDrag={subDrag}
            onLine={(e, l) => startSub(e, l, 'move')} onLineEdge={(e, l, side) => startSub(e, l, side)}
            onLineEdit={(l) => { if (!locked('text') && !busy) setInline({ id: l.id, text: l.text, start: l.start, end: l.end }); }} />
          {inline && (
            <input autoFocus lang="km" value={inline.text} aria-label="Edit the subtitle"
              onChange={(e) => setInline({ ...inline, text: e.target.value })}
              onBlur={() => { if (inline.text.trim()) onSubtitleEdit(inline.id, inline.text.trim()); setInline(null); }}
              onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') setInline(null); }}
              className="khmer absolute top-0 z-30 rounded border-2 border-accent bg-panel px-1 text-xs text-ink shadow-lg focus:outline-none"
              style={{ left: inline.start * scale, width: Math.max(220, (inline.end - inline.start) * scale), height: SUB_ROW + 6 }} />
          )}
        </div>
      );
    }
    if (kind === 'background') {
      return (
        <div {...box(r, `bg-panel ${track.muted ? 'opacity-40' : ''}`, { title: voiceRemoved ? 'Music & sounds, with the original voice removed' : 'The video’s own sound' })}>
          <Waveform pieces={pieces} runs={runs} waveform={waveform} waves={waves} view={view} scale={scale} theme={theme} height={r.height} />
          <BackgroundLane clips={track.clips} lane={lane('background')} />
          <VolumeLines clips={pieces} tid="background" speedOf={(c) => c.speed ?? 1} lane={lane('background')} top={4} height={r.height - 8} editing={volumeLines} sound={sound} onSelect={(c) => onSelect([c.id])} />
        </div>
      );
    }
    if (kind === 'audio') {
      return (
        <div {...box(r, `bg-raised ${track.muted ? 'opacity-40' : ''}`)}>
          <SoundWaves clips={track.clips} waves={waves} runs={runs} view={view} scale={scale} theme={theme} height={r.height} />
          <AudioLane clips={track.clips} media={media} lane={lane(track.id)} />
          <VolumeLines clips={track.clips} tid={track.id} speedOf={(c) => c.speed ?? 1} lane={lane(track.id)} top={4} height={r.height - 8} editing={volumeLines} sound={sound} onSelect={(c) => onSelect([c.id])} />
        </div>
      );
    }
    if (kind === 'watermark') {
      return <div {...box(r, `bg-panel ${track.hidden ? 'opacity-40' : ''}`)}><WatermarkLane clips={track.clips} media={media} lane={lane(track.id)} rows={markRowOf} count={markRows} /></div>;
    }
    return <div {...box(r, 'bg-panel')}><GenericLane clips={track.clips} lane={lane(track.id)} /></div>;
  }

  const toggle = (on, look) => `inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-xs font-medium ${on ? look : 'border-line-strong text-muted hover:bg-raised'}`;

  return (
    <div ref={root} className="flex h-full min-h-0 flex-col p-2.5">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
        <span className="font-semibold text-ink">Timeline</span>
        <Clock playback={playback} fps={fps} />
        <span className="ml-auto flex flex-wrap items-center gap-1.5">
          <button type="button" onClick={() => setSnap(!snap)} aria-pressed={snap} title={snap ? 'Snapping on: clips and the playhead stick to clip edges' : 'Snapping off'}
            className={toggle(snap, 'border-accent/50 bg-accent-soft text-accent-ink')}>
            <Icon d={ICONS.magnet} /> Snap
          </button>
          <button type="button" onClick={() => setVolumeLines(!volumeLines)} aria-pressed={volumeLines}
            title={volumeLines ? 'Volume lines on: click a sound clip to add a point, drag points to change the volume over time (double-click removes one)' : 'Show and edit the volume of each sound clip over time'}
            className={toggle(volumeLines, 'border-sky-500/60 bg-sky-500/15 text-sky-800 dark:text-sky-200')}>
            〰 Volume lines
          </button>
          <button type="button" onClick={() => onLayout?.({ follow: !layout.follow })} aria-pressed={layout.follow}
            title={layout.follow ? 'Follow playhead on: while playing, the timeline scrolls along' : 'Follow playhead off: the timeline stays where you put it while playing'}
            className={toggle(layout.follow, 'border-accent/50 bg-accent-soft text-accent-ink')}>
            ⇥ Follow
          </button>
          <button type="button" onClick={() => onLayout?.({ hide_empty: !layout.hide_empty })} aria-pressed={layout.hide_empty}
            title={layout.hide_empty ? `Empty tracks hidden${hiddenEmpty ? ` (${hiddenEmpty})` : ''} — click to show them` : 'Hide tracks with nothing on them'}
            className={toggle(layout.hide_empty, 'border-accent/50 bg-accent-soft text-accent-ink')}>
            Hide empty{layout.hide_empty && hiddenEmpty > 0 ? ` · ${hiddenEmpty}` : ''}
          </button>
          <span className="inline-flex items-center overflow-hidden rounded-lg border border-line-strong text-muted">
            <button type="button" className="px-2 py-1 hover:bg-raised" onClick={() => zoomTo(scale / 1.6)} aria-label="Zoom out" title="Zoom out (Ctrl + wheel, or pinch)">−</button>
            <input type="range" aria-label="Zoom" title="Zoom (Ctrl + mouse wheel, or pinch)" className="w-24 sm:w-32" min={Math.log(fitScale)} max={Math.log(MAX_PPS)} step="0.01" value={Math.log(scale)}
              onChange={(e) => zoomTo(Math.exp(Number(e.target.value)))} />
            <button type="button" className="px-2 py-1 hover:bg-raised" onClick={() => zoomTo(scale * 1.6)} aria-label="Zoom in" title="Zoom in (Ctrl + wheel, or pinch)">+</button>
            <button type="button" className="border-l border-line-strong px-2 py-1 text-xs hover:bg-raised" onClick={() => { anchor.current = { t: 0, x: 0 }; setPps(fitScale); }} title="Show the whole timeline">Fit</button>
          </span>
          <DockButtons controls={controls} />
        </span>
      </div>
      <Toolbar tools={tools} selection={selection} locked={busy} />
      {tools.asking && <div className="mb-2"><DeleteChoice tools={tools} /></div>}
      {/* One scroll area for everything: the ruler sticks to its top, the track names to its left. */}
      <div ref={scroller} onScroll={onScroll} className="timeline-scroll relative min-h-0 flex-1 overflow-auto overscroll-contain rounded-lg border border-line bg-sunken">
        <div ref={content} className="relative" style={{ width: HEADER_W + laneWidth, height: RULER + rowsTotal }} onPointerMove={moveDrag} onPointerUp={endDrag}
          onPointerCancel={() => { setDrag(null); setTrim(null); setMove(null); setSubDrag(null); setShift(null); }} onContextMenu={(e) => openMenu(e, null)}
          onDragOver={overDrop} onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDropAt(null); }} onDrop={onDrop}>
          <div className="sticky top-0 z-40 flex" style={{ height: RULER }}>
            <div className="sticky left-0 z-10 flex shrink-0 items-center border-b border-r border-line bg-raised px-2 text-[10px] text-faint" style={{ width: HEADER_W }}>
              {hiddenEmpty > 0 ? `${hiddenEmpty} empty track${hiddenEmpty === 1 ? '' : 's'} hidden` : ''}
            </div>
            <div className="relative shrink-0 cursor-pointer select-none border-b border-line bg-panel" style={{ width: laneWidth }}
              onPointerDown={startScrub} onPointerMove={moveScrub} onPointerUp={() => setScrubbing(null)} onPointerCancel={() => setScrubbing(null)}>
              {ticks.map((t) => (
                <span key={t} className="pointer-events-none absolute top-0 h-full border-l border-line-strong pl-1 font-mono text-[10px] leading-[26px] text-muted" style={{ left: t * scale }}>{label(t)}</span>
              ))}
              {rangeStart !== null && rangeEnd !== null && <div className="pointer-events-none absolute inset-y-0 bg-accent/25" style={{ left: rangeStart * scale, width: (rangeEnd - rangeStart) * scale }} />}
              {[['in', rangeStart, 'In (I) · drag to move it'], ['out', rangeEnd, 'Out (O) · drag to move it']].map(([what, t, tip]) => t !== null && (
                <span key={what} role="slider" aria-label={tip} aria-valuenow={t} tabIndex={-1} title={tip}
                  onPointerDown={(e) => startScrub(e, what)} onPointerMove={moveScrub} onPointerUp={() => setScrubbing(null)}
                  className={`absolute top-0 z-10 flex h-full w-3 cursor-ew-resize items-center justify-center bg-accent text-[9px] font-bold text-white ${what === 'in' ? 'rounded-l' : '-translate-x-full rounded-r'}`}
                  style={{ left: t * scale }}>{what === 'in' ? 'I' : 'O'}</span>
              ))}
              <div ref={rulerHead} className="pointer-events-none absolute left-0 top-0 z-20 h-full w-0.5 bg-red-500">
                <span className="absolute -left-[5px] top-0 h-3 w-3 rounded-b-sm bg-red-500" />
              </div>
            </div>
          </div>
          {rows.map((r) => {
            const track = trackOf(tracks, r.id);
            return (
              <div key={r.id} className="flex" style={{ height: r.height }}>
                <TrackHeader track={track} row={r} onToggle={onTrack} onMixer={onMixer} onCollapse={collapse} resize={resize} />
                {laneFor(track, r)}
              </div>
            );
          })}
          {!rows.length && (
            <p className="sticky left-0 px-3 py-4 text-xs text-muted" style={{ width: 'min(100%, 28rem)' }}>Every track is empty. Turn off “Hide empty” to see them.</p>
          )}
          {/* across the tracks (in their area, under the ruler) */}
          <div ref={origin} className="pointer-events-none absolute" style={{ left: HEADER_W, top: RULER, width: laneWidth, height: rowsTotal }}>
            {shift?.moved && shift.insert && rowOf.video && (
              <>
                <div className="absolute z-30 w-1 -translate-x-1/2 rounded bg-accent shadow-[0_0_0_3px_rgb(91_76_240/0.35)]" style={{ top: top('video'), height: heights.video, left: shift.to * scale }} />
                <div className="absolute z-20 rounded-md border-2 border-dashed border-accent bg-accent/20" style={{ top: top('video') + 4, height: heights.video - 8, left: shift.start * scale, width: (shift.lead.end - shift.lead.start) * scale }} />
                <span className="absolute z-30 -translate-x-1/2 rounded bg-accent px-1.5 py-0.5 text-[10px] font-semibold text-white shadow" style={{ top: top('video') + heights.video + 2, left: shift.to * scale }}>put it here</span>
              </>
            )}
            {dropAt && (
              <div className="absolute z-30 w-0.5 bg-accent" style={{ top: dropAt.lane === 'audio' ? top('audio') : top('video'), height: (dropAt.lane === 'audio' ? heights.audio : heights.video) ?? rowsTotal, left: dropAt.t * scale }}>
                <span className="absolute left-1 top-0 whitespace-nowrap rounded bg-accent px-1 text-[10px] font-semibold text-white">{dropAt.lane === 'audio' ? '♪ add here' : '+ insert here'}</span>
              </div>
            )}
            {/* skipped parts are left out of the export on every track: shade all of them */}
            {skipped.filter((r) => r.end >= t0 && r.start <= t1).map((r) => (
              <div key={r.start} className="absolute bottom-0 z-[5] bg-black/30" style={{ top: rowOf.video ? top('video') + heights.video : 0, left: r.start * scale, width: (r.end - r.start) * scale, ...HATCH, opacity: 0.45 }} />
            ))}
            {rangeStart !== null && rangeEnd !== null && (
              <div className="absolute inset-y-0 z-[7] border-x-2 border-accent bg-accent/10" style={{ left: rangeStart * scale, width: (rangeEnd - rangeStart) * scale }} />
            )}
            {rows.filter((r) => locked(r.id)).map((r) => (
              <div key={r.id} className="absolute left-0 right-0 z-[6] bg-sunken/35" style={{ top: r.top, height: r.height }} />
            ))}
            {trim?.moved && (
              <span className="absolute z-30 -translate-x-1/2 rounded bg-ink px-1.5 py-0.5 font-mono text-[10px] text-canvas shadow" style={{ left: trim[trim.side] * scale, top: (trimRow?.top ?? 0) + 2 }}>
                {timecode(trim[trim.side], fps)} · {(trim.end - trim.start).toFixed(2)}s
              </span>
            )}
            <div ref={playhead} className="absolute inset-y-0 left-0 z-20 w-0.5 bg-red-500" />
          </div>
        </div>
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} {...menuFor(menu.clip, menu.at)} onClose={() => setMenu(null)} />}
    </div>
  );
}

export default memo(Timeline);
