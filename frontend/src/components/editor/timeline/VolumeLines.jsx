import { useRef, useState } from 'react';
import { formatTime } from '../../../api.js';
import { VOLUME_MAX, keysAt, soundAt } from '../../../lib/timeline.js';

const PAD = 3; // px between the clip's edge and 200 % / 0 %
const EDGE = 8; // px kept free at each end of a clip, for its trim handles
const NUDGE = 0.001; // seconds kept between two points

// The volume line of each sound clip on screen: its volume over time, 0 % at the bottom of the clip,
// 200 % at the top (100 % dashed). Clips with a line always show it; with `editing` on, every clip
// shows its volume and the line can be edited:
//   click on a clip: a point on its line there (keep the button down to drag it at once)
//   drag a point: its time and volume (the value shows in whole percents as it moves)
//   ↑ / ↓ on a point (Tab to it): 1 % (Shift: 10 %) · double-click or Delete: remove it
// Changes are heard at once (sound.clip) and saved when the point is let go.
export default function VolumeLines({ clips, tid, speedOf, lane, top, height, editing, sound, onSelect }) {
  const { scale, t0, t1, locked } = lane;
  return clips.filter((c) => c.end >= t0 && c.start <= t1 && (editing || c.keys?.length)).map((c) => (
    <ClipLine key={c.id} clip={c} tid={tid} speed={speedOf(c)} scale={scale} top={top} height={height}
      editing={editing && !locked} sound={sound} onSelect={onSelect} />
  ));
}

function ClipLine({ clip, tid, speed, scale, top, height, editing, sound, onSelect }) {
  const svg = useRef(null);
  const [drag, setDrag] = useState(null); // {index, keys}: a point being moved
  const [focus, setFocus] = useState(null); // index of the point under the pointer or the keyboard
  const lastDown = useRef({ i: -1, at: 0 }); // a second press on the same point soon after: a double-click
  const width = Math.max(2, (clip.end - clip.start) * scale);
  const keys = drag?.keys || clip.keys || [];
  const room = height - 2 * PAD;
  const y = (v) => PAD + (1 - v / VOLUME_MAX) * room;
  const valueAt = (py) => Math.round(Math.min(VOLUME_MAX, Math.max(0, (1 - (py - PAD) / room) * VOLUME_MAX)));
  const at = (px) => soundAt(clip, tid, clip.start + px / scale, speed); // seconds in the clip's sound
  const x = (a) => (tid === 'voice' ? a : (a - clip.source_in) / speed) * scale;
  const [lo, hi] = [at(0), at(width)];
  const flat = clip.volume ?? 100;
  const line = keys.length
    ? [[0, keysAt(keys, lo)], ...keys.filter((k) => k.at > lo && k.at < hi).map((k) => [x(k.at), k.v]), [width, keysAt(keys, hi)]]
    : [[0, flat], [width, flat]];
  const visible = keys.map((k, i) => ({ ...k, i })).filter((k) => k.at >= lo - NUDGE && k.at <= hi + NUDGE);
  const save = (next, now) => sound.clip(clip, { keys: next }, now);

  const where = (e) => {
    const r = svg.current.getBoundingClientRect();
    return [Math.min(width, Math.max(0, e.clientX - r.left)), e.clientY - r.top];
  };
  // a point moved to (px, py): between its neighbours, inside the clip
  const moved = (list, i, px, py) => {
    const min = i > 0 ? list[i - 1].at + NUDGE : lo;
    const max = i + 1 < list.length ? list[i + 1].at - NUDGE : hi;
    const next = [...list];
    next[i] = { at: Math.round(Math.min(max, Math.max(min, at(px))) * 1000) / 1000, v: valueAt(py) };
    return next;
  };
  const grab = (e, list, i) => {
    e.preventDefault();
    e.stopPropagation();
    svg.current.setPointerCapture(e.pointerId);
    setDrag({ index: i, keys: list });
    setFocus(i);
    onSelect?.(clip);
  };
  const addAt = (e) => {
    if (e.button !== 0) return;
    const [px] = where(e);
    const a = Math.round(at(px) * 1000) / 1000;
    const v = Math.round(keys.length ? keysAt(keys, a) : flat); // on the line: nothing changes until it's dragged
    const next = [...keys.filter((k) => Math.abs(k.at - a) > NUDGE / 2), { at: a, v }].sort((p, q) => p.at - q.at);
    save(next, false);
    grab(e, next, next.findIndex((k) => k.at === a));
  };
  const onMove = (e) => {
    if (!drag) return;
    const [px, py] = where(e);
    const next = moved(drag.keys, drag.index, px, py);
    setDrag({ ...drag, keys: next });
    save(next, false);
  };
  const onUp = () => {
    if (!drag) return;
    save(drag.keys, true);
    setDrag(null);
  };
  const remove = (i) => { save(keys.filter((_, k) => k !== i), true); setFocus(null); };
  const nudge = (i, dir, big) => {
    const next = keys.map((k, j) => (j === i ? { ...k, v: Math.min(VOLUME_MAX, Math.max(0, k.v + dir * (big ? 10 : 1))) } : k));
    save(next, false);
  };

  const shown = focus !== null && keys[focus] ? keys[focus] : null;
  const label = shown && `${shown.v}% · ${formatTime(tid === 'voice' ? clip.start + shown.at : clip.start + (shown.at - clip.source_in) / speed)}`;
  const tone = clip.muted ? 'stroke-line-strong' : 'stroke-sky-500';
  return (
    <svg ref={svg} width={width} height={height} className="pointer-events-none absolute z-[12] overflow-visible"
      style={{ left: clip.start * scale, top }} aria-hidden={!editing}
      onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={() => setDrag(null)}>
      {editing && (
        <>
          <rect x={Math.min(EDGE, width / 3)} y={0} width={Math.max(0, width - 2 * Math.min(EDGE, width / 3))} height={height}
            className="pointer-events-auto cursor-crosshair fill-transparent" onPointerDown={addAt}>
            <title>Click to add a point on the volume line (drag to move it)</title>
          </rect>
          <line x1={0} x2={width} y1={y(100)} y2={y(100)} className="stroke-line-strong" strokeDasharray="3 3" strokeWidth={1} />
        </>
      )}
      <polyline points={line.map(([px, v]) => `${px},${y(v)}`).join(' ')} fill="none" strokeWidth={keys.length ? 2 : 1.5}
        className={`${tone} ${keys.length ? '' : 'opacity-60'}`} strokeDasharray={keys.length ? undefined : '4 3'} />
      {editing && visible.map((k) => (
        <circle key={`${k.i}-${k.at}`} cx={x(k.at)} cy={y(k.v)} r={focus === k.i ? 5 : 4} tabIndex={0} role="slider"
          aria-label={`Volume point at ${formatTime(clip.start + (tid === 'voice' ? k.at : (k.at - clip.source_in) / speed))}`}
          aria-valuemin={0} aria-valuemax={VOLUME_MAX} aria-valuenow={k.v} aria-valuetext={`${k.v}%`}
          className={`pointer-events-auto cursor-grab stroke-white outline-none ${clip.muted ? 'fill-line-strong' : 'fill-sky-500'} focus:fill-accent`}
          strokeWidth={1.5}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            const now = performance.now();
            const twice = lastDown.current.i === k.i && now - lastDown.current.at < 400;
            lastDown.current = twice ? { i: -1, at: 0 } : { i: k.i, at: now };
            if (!twice) { grab(e, keys, k.i); return; }
            e.preventDefault();
            e.stopPropagation();
            remove(k.i); // (dblclick itself goes to the svg, which held the pointer)
          }}
          onPointerEnter={() => !drag && setFocus(k.i)} onPointerLeave={() => !drag && setFocus(null)}
          onFocus={() => setFocus(k.i)} onBlur={() => !drag && setFocus(null)}
          onKeyDown={(e) => {
            const dir = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
            if (dir) { e.preventDefault(); e.stopPropagation(); nudge(k.i, dir, e.shiftKey); }
            if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); e.stopPropagation(); remove(k.i); }
          }} />
      ))}
      {label && editing && (
        <g transform={`translate(${Math.min(width - 4, Math.max(4, x(shown.at)))},${Math.max(10, y(shown.v) - 8)})`} className="pointer-events-none">
          <rect x={-42} y={-10} width={84} height={14} rx={3} className="fill-ink opacity-90" />
          <text x={0} y={1} textAnchor="middle" className="fill-canvas font-mono text-[10px]">{label}</text>
        </g>
      )}
    </svg>
  );
}
