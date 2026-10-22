import { useEffect, useRef, useState } from 'react';
import { VOLUME_MAX } from '../../lib/timeline.js';

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// A volume one step up or down: 1 % (Shift: 10 %), whole percents, 0–max.
export const stepVolume = (v, dir, big = false, max = VOLUME_MAX) => clamp(Math.round(v) + dir * (big ? 10 : 1), 0, max);

// Seconds in tenths (fades).
export const tenths = (v) => Math.round(v * 10) / 10;

// − / + that repeats while it's held (Shift: big steps).
function StepButton({ dir, onStep, disabled, label }) {
  const timer = useRef(null);
  const stop = () => { clearTimeout(timer.current); timer.current = null; };
  useEffect(() => stop, []);
  const start = (e) => {
    if (disabled || e.button > 0) return;
    e.preventDefault();
    const big = e.shiftKey;
    onStep(dir, big);
    const again = (wait) => { timer.current = setTimeout(() => { onStep(dir, big); again(60); }, wait); };
    again(400);
  };
  return (
    <button type="button" aria-label={label} title={`${label} (hold to keep going; Shift: 10 at a time)`} disabled={disabled}
      onPointerDown={start} onPointerUp={stop} onPointerLeave={stop} onPointerCancel={stop}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onStep(dir, e.shiftKey); } }}
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-line-strong bg-panel text-sm font-bold text-ink hover:bg-raised disabled:opacity-40">
      {dir < 0 ? '−' : '+'}
    </button>
  );
}

// A number typed in a box: kept as text while typing, used on Enter or when leaving the box;
// ↑ / ↓ step it (Shift: big steps).
function NumberBox({ value, onCommit, onStep, disabled, label, width = 'w-12', step = 1, format = String }) {
  const [text, setText] = useState(format(value));
  const [typing, setTyping] = useState(false);
  useEffect(() => { if (!typing) setText(format(value)); }, [value, typing]); // eslint-disable-line react-hooks/exhaustive-deps
  const commit = () => {
    setTyping(false);
    const v = Number(String(text).replace(',', '.'));
    if (text !== '' && Number.isFinite(v)) onCommit(v);
    else setText(format(value));
  };
  return (
    <input type="text" inputMode={step < 1 ? 'decimal' : 'numeric'} value={typing ? text : format(value)} disabled={disabled} aria-label={label}
      onFocus={(e) => { setTyping(true); setText(format(value)); e.currentTarget.select(); }}
      onChange={(e) => { setTyping(true); setText(e.target.value); }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.currentTarget.blur(); return; }
        if (e.key === 'Escape') { setTyping(false); setText(format(value)); e.currentTarget.blur(); return; }
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault();
          setTyping(false);
          onStep(e.key === 'ArrowUp' ? 1 : -1, e.shiftKey);
        }
      }}
      className={`${width} shrink-0 rounded-md border border-line-strong bg-panel px-1 py-1 text-right font-mono text-xs tabular-nums text-ink focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25 disabled:opacity-50`} />
  );
}

// A percent without a slider (a point of a volume line): − / + (Shift: 10), a box, ↑ / ↓.
export function PercentField({ label, value, onChange, disabled = false, max = VOLUME_MAX }) {
  const latest = useRef(value);
  latest.current = value;
  const set = (v) => {
    const n = clamp(Math.round(v), 0, max);
    if (n !== latest.current) { latest.current = n; onChange(n); }
  };
  const step = (dir, big) => set(stepVolume(latest.current, dir, big, max));
  return (
    <span className="inline-flex items-center gap-1">
      <StepButton dir={-1} onStep={step} disabled={disabled || value <= 0} label={`${label}: 1% quieter`} />
      <NumberBox value={value} onCommit={set} onStep={step} disabled={disabled} label={`${label} in percent`} />
      <StepButton dir={1} onStep={step} disabled={disabled || value >= max} label={`${label}: 1% louder`} />
      <span className="text-xs text-muted">%</span>
    </span>
  );
}

// A volume in whole percents (0–200 %, 100 % = as it is): a slider, a box to type it in, − / +
// (1 %), ← → / ↑ ↓ on the slider or the box (1 %; Shift: 10 %), and Mute. With `onMute` the thing has
// its own mute, which keeps the volume; without, Mute goes to 0 % and brings the last volume back.
export default function VolumeControl({ label, value, onChange, muted = false, onMute, disabled = false, max = VOLUME_MAX, hint, compact = false, id }) {
  const remembered = useRef(value > 0 ? value : 100);
  const latest = useRef(value); // a held − / + steps on from the value it last set, before the parent re-renders
  latest.current = value;
  useEffect(() => { if (value > 0) remembered.current = value; }, [value]);
  const set = (v) => {
    const n = clamp(Math.round(v), 0, max);
    if (n !== latest.current) { latest.current = n; onChange(n); }
  };
  const step = (dir, big) => set(stepVolume(latest.current, dir, big, max));
  const silent = muted || value === 0;
  const toggleMute = () => {
    if (onMute) onMute(!muted);
    else if (value > 0) set(0);
    else set(remembered.current || 100);
  };
  const percent = (v) => `${(v / max) * 100}%`;
  const what = /volume/i.test(label) ? label : `${label} volume`; // for screen readers
  return (
    <div className={`min-w-0 ${compact ? 'space-y-1' : 'space-y-1.5'}`} id={id}>
      <div className="flex items-center gap-2 text-xs">
        <span className="min-w-0 flex-1 truncate text-muted">
          <span className="font-semibold text-ink">{label}:</span>{' '}
          <span className={`tabular-nums ${muted ? 'text-red-600 line-through dark:text-red-400' : 'text-accent-ink'}`}>{value}%</span>
          {muted && <span className="text-red-600 dark:text-red-400"> · muted</span>}
          {!muted && value > 100 && <span className="text-emerald-700 dark:text-emerald-300"> · louder</span>}
        </span>
        <button type="button" onClick={toggleMute} disabled={disabled} aria-pressed={silent}
          title={onMute ? (muted ? 'Unmute (back to its volume)' : 'Mute (keeps the volume for when you unmute)') : (value > 0 ? 'Silence (0 %)' : `Back to ${remembered.current}%`)}
          className={`inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-semibold disabled:opacity-40 ${silent ? 'border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300' : 'border-line-strong bg-panel text-ink hover:bg-raised'}`}>
          {silent ? '🔇' : '🔊'} {onMute ? (muted ? 'Unmute' : 'Mute') : (value > 0 ? 'Mute' : 'Unmute')}
        </button>
      </div>
      <div className={`flex items-center gap-1.5 ${muted ? 'opacity-55' : ''}`}>
        <StepButton dir={-1} onStep={step} disabled={disabled || value <= 0} label={`${label}: 1% quieter`} />
        <span className="relative flex min-w-0 flex-1 items-center">
          {/* 100 %: as it is */}
          {max > 100 && <span className="pointer-events-none absolute top-1/2 h-3 w-px -translate-y-1/2 bg-line-strong" style={{ left: percent(100) }} aria-hidden="true" />}
          <input type="range" min="0" max={max} step="1" value={value} disabled={disabled} aria-label={what} aria-valuetext={`${value}%${muted ? ', muted' : ''}`}
            onChange={(e) => set(Number(e.target.value))}
            onKeyDown={(e) => {
              const dir = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
              if (dir && e.shiftKey) { e.preventDefault(); step(dir, true); }
              if (e.key === 'PageUp' || e.key === 'PageDown') { e.preventDefault(); step(e.key === 'PageUp' ? 1 : -1, true); }
            }}
            className="relative w-full" />
        </span>
        <StepButton dir={1} onStep={step} disabled={disabled || value >= max} label={`${label}: 1% louder`} />
        <NumberBox value={value} onCommit={set} onStep={step} disabled={disabled} label={`${what} in percent`} />
        <span className="text-xs text-muted">%</span>
      </div>
      {hint && <p className="text-[11px] text-faint">{hint}</p>}
    </div>
  );
}

// Any number in steps (a watermark's size, opacity, margin, rotation…): a slider, a box to type it in,
// − / + (one step; hold to keep going; Shift: ten), ↑ / ↓ in the box and ← → on the slider (Shift: ten).
export function NumberControl({ label, value, onChange, min = 0, max = 100, step = 1, unit = '%', disabled = false, hint, shown }) {
  const latest = useRef(value);
  latest.current = value;
  const digits = step < 1 ? String(step).split('.')[1].length : 0;
  const fix = (v) => Number(clamp(Math.round(v / step) * step, min, max).toFixed(digits));
  const set = (v) => {
    const n = fix(v);
    if (Math.abs(n - latest.current) > 1e-9) { latest.current = n; onChange(n); }
  };
  const stepBy = (dir, big) => set(latest.current + dir * step * (big ? 10 : 1));
  return (
    <div className="min-w-0 space-y-1">
      <p className="text-xs"><span className="font-semibold text-ink">{label}:</span> <span className="tabular-nums text-accent-ink">{shown ?? `${value}${unit}`}</span></p>
      <div className="flex items-center gap-1.5">
        <StepButton dir={-1} onStep={stepBy} disabled={disabled || value <= min} label={`${label}: ${step}${unit} less`} />
        <input type="range" min={min} max={max} step={step} value={value} disabled={disabled} aria-label={label} aria-valuetext={`${value}${unit}`}
          onChange={(e) => set(Number(e.target.value))}
          onKeyDown={(e) => {
            const dir = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
            if (dir && e.shiftKey) { e.preventDefault(); stepBy(dir, true); }
          }}
          className="min-w-0 flex-1" />
        <StepButton dir={1} onStep={stepBy} disabled={disabled || value >= max} label={`${label}: ${step}${unit} more`} />
        <NumberBox value={value} onCommit={set} onStep={stepBy} disabled={disabled} label={`${label} (${unit.trim() || 'number'})`} step={step} format={(v) => Number(v).toFixed(digits)} />
        <span className="w-3 text-xs text-muted">{unit}</span>
      </div>
      {hint && <p className="text-[11px] text-faint">{hint}</p>}
    </div>
  );
}

// Seconds in 0.1 s steps (fades): a slider, a box, − / +.
export function SecondsControl({ label, value, onChange, min = 0, max = 5, disabled = false, hint }) {
  const latest = useRef(value);
  latest.current = value;
  const set = (v) => {
    const n = clamp(tenths(v), min, max);
    if (Math.abs(n - latest.current) > 1e-9) { latest.current = n; onChange(n); }
  };
  const step = (dir, big) => set(tenths(latest.current) + dir * (big ? 1 : 0.1));
  return (
    <div className="min-w-0 space-y-1">
      <p className="text-xs"><span className="font-semibold text-ink">{label}:</span> <span className="tabular-nums text-accent-ink">{value > 0 ? `${tenths(value).toFixed(1)} s` : 'none'}</span></p>
      <div className="flex items-center gap-1.5">
        <StepButton dir={-1} onStep={step} disabled={disabled || value <= min} label={`${label}: 0.1 s shorter`} />
        <input type="range" min={min} max={max} step="0.1" value={tenths(value)} disabled={disabled} aria-label={`${label} (seconds)`} aria-valuetext={`${tenths(value).toFixed(1)} seconds`}
          onChange={(e) => set(Number(e.target.value))} className="min-w-0 flex-1" />
        <StepButton dir={1} onStep={step} disabled={disabled || value >= max} label={`${label}: 0.1 s longer`} />
        <NumberBox value={tenths(value)} onCommit={set} onStep={step} disabled={disabled} label={`${label} in seconds`} step={0.1} format={(v) => tenths(v).toFixed(1)} />
        <span className="text-xs text-muted">s</span>
      </div>
      {hint && <p className="text-[11px] text-faint">{hint}</p>}
    </div>
  );
}
