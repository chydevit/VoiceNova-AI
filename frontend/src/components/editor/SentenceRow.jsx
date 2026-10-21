import { memo, useEffect, useRef, useState } from 'react';
import { formatTime } from '../../api.js';
import { budget, splitPoint } from '../../lib/khmer.js';
import { voiceLabel } from '../../lib/voices.js';
import { Chip, IconButton, inputCss, textareaCss } from '../ui.jsx';

const STATUS = {
  ok: { text: 'Ready', tone: 'green', dot: 'bg-emerald-500' },
  too_long: { text: '⚠ Too long', tone: 'amber', dot: 'bg-amber-500' },
  edited: { text: 'Needs voice', tone: 'accent', dot: 'bg-accent' },
  regenerating: { text: 'Voicing…', tone: 'accent', dot: 'bg-accent animate-pulse' },
  failed: { text: 'Voice failed', tone: 'red', dot: 'bg-red-500' },
  empty: { text: 'No text', tone: 'slate', dot: 'bg-faint' },
};

// A slider that shows its value at once and saves it once the user stops moving it.
function useCommitted(value, commit, delay = 350) {
  const [local, setLocal] = useState(value);
  const timer = useRef(null);
  useEffect(() => { setLocal(value); }, [value]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return [local, (v) => {
    setLocal(v);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => commit(v), delay);
  }];
}

function TimeInput({ value, onCommit, label, disabled }) {
  const [text, setText] = useState(value.toFixed(2));
  useEffect(() => { setText(value.toFixed(2)); }, [value]);
  const commit = () => {
    const v = Number(text);
    if (Number.isFinite(v) && Math.abs(v - value) > 0.0005) onCommit(Math.max(0, v));
    else setText(value.toFixed(2));
  };
  return (
    <input type="number" step="0.1" min="0" inputMode="decimal" aria-label={label} title={`${label} (seconds)`} value={text} disabled={disabled}
      onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      className={`${inputCss} w-[4.6rem] px-1.5 py-0.5 font-mono text-xs tabular-nums`} />
  );
}

const Icon = ({ d }) => (
  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);
const ICONS = {
  play: 'M7 4.5v15l13-7.5z',
  regenerate: 'M3 12a9 9 0 0 1 15.5-6.3L21 8M21 3v5h-5M21 12a9 9 0 0 1-15.5 6.3L3 16M3 21v-5h5',
  split: 'M6 3v18M18 3v18M6 12h3m6 0h3',
  merge: 'M8 12h8M5 7l3 5-3 5M19 7l-3 5 3 5',
  delete: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
};

// One sentence. Collapsed it's two lines; selected, it opens with every control.
function SentenceRow({ s, number, isLast, voices, provider, selected, playing, busy, locked, actions, onSelect, onPlay, onSuggest }) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const caret = useRef(null);
  const slot = s.end - s.start;
  const limit = budget(slot);
  const long = s.khmer_text.length > limit * 1.3;
  const separateSubtitle = s.subtitle_text !== null && s.subtitle_text !== undefined;
  const disabled = locked || !!busy;
  const status = busy === 'regenerate' ? STATUS.regenerating : STATUS[s.status] || STATUS.edited;

  // Voice and speed changes need a new clip: make it right away (speed changes don't even need the internet).
  const change = async (fields) => {
    const body = await actions.patch(s.id, fields);
    if (body && s.khmer_text) actions.regenerate(s.id);
  };
  const [speed, setSpeed] = useCommitted(s.speed, (v) => change({ speed: v }));
  const [volume, setVolume] = useCommitted(s.volume, (v) => actions.patch(s.id, { volume: v }));
  useEffect(() => { if (!selected) setConfirmDelete(false); }, [selected]);

  const frame = `rounded-xl border transition ${selected ? 'border-accent bg-panel shadow-md ring-1 ring-accent/30' : playing ? 'border-sky-500/40 bg-sky-500/5' : 'border-transparent hover:border-line hover:bg-raised'}`;

  if (!selected) {
    return (
      <li id={`row-${s.id}`} className={frame} style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 64px' }}>
        <div role="button" tabIndex={0} onClick={() => onSelect(s)} onKeyDown={(e) => e.key === 'Enter' && onSelect(s)} className="flex cursor-pointer gap-2.5 px-2.5 py-2">
          <div className="w-9 shrink-0 pt-0.5 text-right">
            <span className="block text-xs font-semibold text-faint">{number}</span>
            <span className={`ml-auto mt-1.5 block h-2 w-2 rounded-full ${status.dot}`} title={status.text} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-1.5 font-mono text-[11px] text-faint">
              {formatTime(s.start)} · {slot.toFixed(1)}s
              {s.status === 'too_long' && <span className="font-sans font-semibold text-amber-600 dark:text-amber-400">too long</span>}
              {s.shortened && <span className="font-sans text-sky-600 dark:text-sky-400">shortened</span>}
            </p>
            <p className={`khmer line-clamp-2 text-sm ${s.khmer_text ? 'text-ink' : 'italic text-faint'}`}>{s.khmer_text || 'No Khmer text yet'}</p>
          </div>
          <IconButton label="Play this sentence" className="self-center" onClick={(e) => { e.stopPropagation(); onPlay(s); }}><Icon d={ICONS.play} /></IconButton>
        </div>
      </li>
    );
  }

  return (
    <li id={`row-${s.id}`} className={`${frame} p-3`}>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-sm font-bold text-accent-ink">#{number}</span>
        <Chip tone={status.tone}>{status.text}</Chip>
        {s.shortened && <Chip tone="sky" title="The translation was shortened to fit the time">shortened</Chip>}
        <span className="ml-auto flex items-center">
          <IconButton label="Play" onClick={() => onPlay(s)}><Icon d={ICONS.play} /></IconButton>
          <IconButton label="Regenerate the voice" active={s.status === 'edited' || s.status === 'failed'} disabled={disabled || !s.khmer_text}
            onClick={() => actions.regenerate(s.id, s.status === 'ok' || s.status === 'too_long')}><Icon d={ICONS.regenerate} /></IconButton>
          <IconButton label="Split at the cursor" disabled={disabled || s.khmer_text.length < 2}
            onClick={() => actions.split(s.id, { index: splitPoint(s.khmer_text, caret.current) })}><Icon d={ICONS.split} /></IconButton>
          <IconButton label="Merge with the next sentence" disabled={disabled || isLast} onClick={() => actions.merge(s.id)}><Icon d={ICONS.merge} /></IconButton>
          <IconButton label="Delete" disabled={disabled} className="hover:!bg-red-500/10 hover:!text-red-600" onClick={() => setConfirmDelete(true)}><Icon d={ICONS.delete} /></IconButton>
        </span>
      </div>

      {confirmDelete && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 rounded-lg bg-red-500/10 p-2 text-xs text-red-800 dark:text-red-200">
          <span className="w-full font-medium sm:w-auto">Delete? Its time becomes:</span>
          <button type="button" className="rounded-md bg-panel px-2 py-1 font-semibold shadow-sm hover:bg-red-500/10" onClick={() => { setConfirmDelete(false); actions.remove(s.id, 'silence'); }}>Silence</button>
          <button type="button" className="rounded-md bg-panel px-2 py-1 font-semibold shadow-sm hover:bg-red-500/10" onClick={() => { setConfirmDelete(false); actions.remove(s.id, 'original'); }}>Original audio</button>
          <button type="button" className="px-1.5 py-1 underline" onClick={() => setConfirmDelete(false)}>Cancel</button>
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted">
        <TimeInput label="Start time" value={s.start} disabled={disabled} onCommit={(v) => actions.patch(s.id, { start: v })} />
        <span>→</span>
        <TimeInput label="End time" value={s.end} disabled={disabled} onCommit={(v) => actions.patch(s.id, { end: v })} />
        <span className="tabular-nums">{slot.toFixed(1)}s</span>
      </div>

      {s.original_text && <p className="mt-2 text-xs leading-relaxed text-faint" lang="und">{s.original_text}</p>}

      <textarea
        lang="km"
        rows={Math.max(2, Math.ceil(s.khmer_text.length / 40))}
        value={s.khmer_text}
        disabled={locked}
        placeholder="Type the Khmer line…"
        onChange={(e) => { caret.current = e.target.selectionStart; actions.setText(s.id, 'khmer_text', e.target.value); }}
        onSelect={(e) => { caret.current = e.target.selectionStart; }}
        className={`${textareaCss} mt-1.5`}
        aria-label={`Khmer text of sentence ${number}`}
      />
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <span className={`tabular-nums ${long ? 'font-semibold text-amber-700 dark:text-amber-300' : 'text-faint'}`} title="Characters / what fits comfortably in this time">
          {s.khmer_text.length}/{limit}
        </span>
        {s.status === 'too_long' && (
          <button type="button" disabled={disabled} onClick={() => actions.fix(s.id)}
            className="rounded-md bg-amber-500 px-2 py-0.5 font-semibold text-white hover:bg-amber-600 disabled:opacity-50">
            {busy === 'fix' ? 'Fixing…' : '⚡ Fix automatically'}
          </button>
        )}
        <button type="button" disabled={locked} onClick={() => onSuggest(s.id)} className="ml-auto rounded-md px-1.5 py-0.5 font-semibold text-violet-700 hover:bg-violet-500/10 disabled:opacity-40 dark:text-violet-300">
          ✨ Improve translation
        </button>
      </div>
      {s.error && <p className="mt-1 text-xs text-red-700 dark:text-red-300">{s.error}</p>}

      <label className="mt-2.5 inline-flex items-center gap-2 text-xs text-muted">
        <input type="checkbox" checked={!separateSubtitle} disabled={locked}
          onChange={(e) => actions.patch(s.id, e.target.checked ? { subtitle_synced: true } : { subtitle_text: s.khmer_text })} />
        Subtitle = the voice text
      </label>
      {separateSubtitle && (
        <textarea lang="km" rows={1} value={s.subtitle_text} disabled={locked} placeholder="Subtitle text…" aria-label={`Subtitle of sentence ${number}`}
          onChange={(e) => actions.setText(s.id, 'subtitle_text', e.target.value)} className={`${textareaCss} mt-1 text-sm`} />
      )}

      <div className="mt-3 grid gap-2 rounded-lg bg-raised p-2.5 text-xs">
        <label className="flex items-center gap-2">
          <span className="w-12 shrink-0 font-medium text-muted">Voice</span>
          <select value={s.voice} disabled={disabled || voices.length < 2} onChange={(e) => change({ voice: e.target.value })} className={`${inputCss} min-w-0 flex-1 py-1 text-xs`}>
            {voices.map((v) => <option key={v} value={v}>{voiceLabel(provider, v)}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-2">
          <span className="w-12 shrink-0 font-medium text-muted">Speed</span>
          <input type="range" min="0.8" max="1.3" step="0.05" value={speed} disabled={disabled} onChange={(e) => setSpeed(Number(e.target.value))} className="min-w-0 flex-1" />
          <span className="w-10 shrink-0 text-right tabular-nums">{Number(speed).toFixed(2)}×</span>
        </label>
        <label className="flex items-center gap-2">
          <span className="w-12 shrink-0 font-medium text-muted">Volume</span>
          <input type="range" min="0" max="2" step="0.05" value={volume} disabled={locked} onChange={(e) => setVolume(Number(e.target.value))} className="min-w-0 flex-1" />
          <span className="w-10 shrink-0 text-right tabular-nums">{Math.round(volume * 100)}%</span>
        </label>
      </div>
    </li>
  );
}

export default memo(SentenceRow);
