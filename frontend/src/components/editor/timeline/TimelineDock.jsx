import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { timecode } from '../../../lib/timeline.js';
import { BAR, defaultPanelHeight, panelBounds } from './layout.js';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
// The panel's icons (drawn, not font glyphs: ▴ ▾ come out as dots in the Khmer fonts).
export const PANEL_ICONS = {
  up: 'm6 15 6-6 6 6', down: 'm6 9 6 6 6-6', right: 'm9 6 6 6-6 6', close: 'M18 6 6 18M6 6l12 12',
  max: 'M8 3H3v5M16 3h5v5M21 16v5h-5M3 16v5h5', restore: 'M3 8h5V3M21 8h-5V3M16 21v-5h5M8 21v-5H3',
};
export const PanelIcon = ({ name, className = 'h-3.5 w-3.5' }) => (
  <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={PANEL_ICONS[name]} /></svg>
);
const KEY_STEP = 24; // px per arrow key on the resize handle

function useWindowHeight() {
  const [h, setH] = useState(() => window.innerHeight);
  useEffect(() => {
    const on = () => setH(window.innerHeight);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return h;
}

// The playhead's time and a thin line showing where it is in the whole video (click or drag it to
// move the playhead): for the collapsed panel. `line={false}`: the time only.
export function MiniProgress({ playback, fps, line: withLine = true }) {
  const line = useRef(null);
  const [t, setT] = useState(playback.t);
  useEffect(() => playback.subscribe(({ t: now }) => setT(now)), [playback]);
  const end = Math.max(playback.duration, 0.001);
  const seek = (e) => {
    const r = line.current.getBoundingClientRect();
    playback.seek(clamp((e.clientX - r.left) / r.width, 0, 1) * end);
  };
  const time = <span className="font-mono text-xs tabular-nums text-muted">{timecode(t, fps)} / {timecode(playback.duration, fps)}</span>;
  if (!withLine) return time;
  return (
    <>
      {time}
      <span ref={line} role="slider" tabIndex={0} aria-label="Playhead" aria-valuemin={0} aria-valuemax={Math.round(end)} aria-valuenow={Math.round(t)}
        className="relative h-4 min-w-24 flex-1 cursor-pointer touch-none"
        onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); seek(e); }}
        onPointerMove={(e) => { if (e.currentTarget.hasPointerCapture(e.pointerId)) seek(e); }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); playback.seek(clamp(t + (e.key === 'ArrowRight' ? 5 : -5), 0, end)); }
        }}>
        <span className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-raised" />
        <span className="absolute left-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-accent" style={{ width: `${(t / end) * 100}%` }} />
        <span className="absolute top-1/2 h-3 w-0.5 -translate-y-1/2 bg-red-500" style={{ left: `${(t / end) * 100}%` }} />
      </span>
    </>
  );
}

const barButton = 'inline-flex h-7 min-w-7 items-center justify-center rounded-lg border border-line-strong px-2 text-xs font-medium text-ink hover:bg-raised';

// The timeline panel along the bottom of the editor (desktop). It can be:
//  - open: drag its top edge to make it taller or shorter; double-click the edge for the usual height
//  - maximised: most of the window, for detailed editing
//  - collapsed: one slim bar with the time and a progress line
//  - closed: gone, with a "Show timeline" button in its place
// view / update: the saved layout (usePanelView). children({controls, onMeasure}) draws the timeline:
// it reports its own size (onMeasure({chrome, firstRow, rowsTotal})) and shows `controls`' buttons.
export default function TimelineDock({ view, update, playback, fps, children }) {
  const windowHeight = useWindowHeight();
  const [measure, setMeasure] = useState({ chrome: 96, firstRow: 52, rowsTotal: 234 });
  const [drag, setDrag] = useState(null); // {y0, h0, h}: the top edge being dragged
  const { mode } = view;
  const bounds = panelBounds({ windowHeight, chrome: measure.chrome, firstRow: measure.firstRow });
  const usual = defaultPanelHeight({ windowHeight, chrome: measure.chrome, rowsTotal: measure.rowsTotal });
  const open = clamp(view.height ?? usual, bounds.min, bounds.max);
  const target = drag ? drag.h : { open, max: bounds.max, collapsed: BAR, closed: 0 }[mode];

  // The height is changed one frame after the new target is drawn, so CSS animates it (not while dragging).
  const [height, setHeight] = useState(target);
  useLayoutEffect(() => {
    if (drag) { setHeight(target); return undefined; }
    const frame = requestAnimationFrame(() => setHeight(target));
    return () => cancelAnimationFrame(frame);
  }, [target, drag]);
  // Once closed (after its animation), the timeline isn't drawn at all.
  const [gone, setGone] = useState(mode === 'closed');
  useEffect(() => {
    if (mode !== 'closed') { setGone(false); return undefined; }
    const timer = setTimeout(() => setGone(true), 220);
    return () => clearTimeout(timer);
  }, [mode]);

  const controls = useMemo(() => ({ // the same object until the mode changes, so the timeline isn't redrawn for nothing
    mode,
    collapse: () => update({ mode: 'collapsed' }),
    expand: () => update({ mode: 'open' }),
    close: () => update({ mode: 'closed' }),
    toggleMax: () => update({ mode: mode === 'max' ? 'open' : 'max' }),
  }), [mode, update]);

  function startResize(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ y0: e.clientY, h0: mode === 'max' ? bounds.max : open, h: mode === 'max' ? bounds.max : open });
  }
  function moveResize(e) {
    if (!drag) return;
    setDrag({ ...drag, h: clamp(drag.h0 + drag.y0 - e.clientY, bounds.min, bounds.max) });
  }
  function endResize() {
    if (!drag) return;
    if (Math.abs(drag.h - drag.h0) > 2) update({ mode: 'open', height: Math.round(drag.h) });
    setDrag(null);
  }
  function keyResize(e) {
    const by = { ArrowUp: KEY_STEP, ArrowDown: -KEY_STEP }[e.key];
    if (by) { e.preventDefault(); e.stopPropagation(); update({ mode: 'open', height: clamp(open + by, bounds.min, bounds.max) }); }
    if (e.key === 'Home') { e.preventDefault(); update({ mode: 'open', height: null }); }
  }

  if (gone) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-line bg-panel px-3 py-1.5">
        <span className="text-sm font-semibold">Timeline</span>
        <span className="text-xs text-faint">hidden</span>
        <button type="button" className={`${barButton} ml-auto gap-1`} onClick={controls.expand} title="Show the timeline again (Shift+T)"><PanelIcon name="up" /> Show timeline</button>
      </div>
    );
  }

  return (
    <div className={`relative ${drag ? '' : 'transition-[height] duration-200 ease-out'}`} style={{ height }}>
      {(mode === 'open' || mode === 'max') && (
        <div role="separator" aria-orientation="horizontal" aria-label="Timeline height: drag, or use the arrow keys; double-click or Home for the usual height"
          aria-valuemin={bounds.min} aria-valuemax={bounds.max} aria-valuenow={Math.round(drag ? drag.h : height)} tabIndex={0}
          title="Drag to resize · double-click: usual height"
          onPointerDown={startResize} onPointerMove={moveResize} onPointerUp={endResize} onPointerCancel={() => setDrag(null)}
          onDoubleClick={() => update({ mode: 'open', height: null })} onKeyDown={keyResize}
          className="group absolute -top-2 left-0 right-0 z-40 flex h-3 cursor-ns-resize touch-none items-center justify-center focus:outline-none">
          <span className={`h-1 w-12 rounded-full transition ${drag ? 'bg-accent' : 'bg-line-strong group-hover:bg-accent group-focus-visible:bg-accent'}`} />
        </div>
      )}
      <div className="h-full overflow-hidden rounded-xl border border-line bg-panel">
        {mode === 'collapsed' ? (
          <div className="flex h-full items-center gap-3 px-3">
            <span className="text-sm font-semibold">Timeline</span>
            <MiniProgress playback={playback} fps={fps} />
            <button type="button" className={barButton} onClick={controls.expand} title="Expand the timeline" aria-label="Expand the timeline"><PanelIcon name="up" /></button>
            <button type="button" className={barButton} onClick={controls.close} title="Close the timeline (Shift+T)" aria-label="Close the timeline"><PanelIcon name="close" /></button>
          </div>
        ) : children({ controls, onMeasure: setMeasure })}
      </div>
    </div>
  );
}

// The buttons at the top right of the timeline, next to Fit: collapse, maximise / restore, close.
export function DockButtons({ controls }) {
  if (!controls) return null;
  const maxed = controls.mode === 'max';
  return (
    <span className="inline-flex items-center gap-1">
      <button type="button" className={barButton} onClick={controls.collapse} title="Collapse to a slim bar" aria-label="Collapse the timeline"><PanelIcon name="down" /></button>
      <button type="button" className={barButton} onClick={controls.toggleMax} aria-pressed={maxed}
        title={maxed ? 'Restore the timeline’s height' : 'Maximise: the timeline takes most of the screen'} aria-label={maxed ? 'Restore the timeline' : 'Maximise the timeline'}>
        <PanelIcon name={maxed ? 'restore' : 'max'} />
      </button>
      <button type="button" className={barButton} onClick={controls.close} title="Close the timeline (Shift+T)" aria-label="Close the timeline"><PanelIcon name="close" /></button>
    </span>
  );
}
