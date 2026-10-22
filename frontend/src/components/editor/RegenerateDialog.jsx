import { useEffect, useMemo, useRef, useState } from 'react';
import { formatTime } from '../../api.js';
import { voiceLabel } from '../../lib/voices.js';
import { Button, inputCss } from '../ui.jsx';

const STYLES = [
  ['natural', 'Natural', 'ធម្មជាតិ', 'The way a Cambodian would say it'],
  ['shorter', 'Shorter', 'ខ្លីជាង', 'Easier to say in its time'],
  ['formal', 'Formal', 'ផ្លូវការ', 'Like a presenter or a teacher'],
  ['casual', 'Casual', 'ធម្មតា', 'Like friends talking'],
];

const WHAT = [
  ['voice', 'Voice again', 'Make each voice clip again (the text stays as it is).'],
  ['restyle', 'Translate again', 'The AI translates them again in the style you choose, then they’re voiced.'],
  ['change', 'Change the voice', 'Give them another voice, then voice them.'],
  ['fit', 'Fit to their time', 'The ones too long for their time use the pause after them, speed up a little or get a shorter line.'],
];

// Regenerate many sentences: which ones (the selected ones, the In/Out part, from the playhead, the whole
// video) and what to do with them. It runs in the background; editing goes on.
export default function RegenerateDialog({ sentences, scopes, initialScope, initialWhat = 'voice', voices, provider, defaultVoice, translator, onRun, onClose }) {
  const dialog = useRef(null);
  const [scope, setScope] = useState(initialScope);
  const [what, setWhat] = useState(initialWhat);
  const [style, setStyle] = useState('natural');
  const [voice, setVoice] = useState(defaultVoice);
  const [busy, setBusy] = useState(false);
  useEffect(() => { dialog.current?.showModal(); }, []);

  const chosen = scopes.find((s) => s.key === scope) || scopes[0];
  const ids = useMemo(() => {
    const items = sentences.filter((s) => chosen.ids.includes(s.id));
    if (what === 'fit') return items.filter((s) => s.status === 'too_long').map((s) => s.id);
    if (what === 'restyle') return items.map((s) => s.id);
    return items.filter((s) => s.khmer_text).map((s) => s.id);
  }, [sentences, chosen, what]);

  async function run() {
    setBusy(true);
    const ok = await onRun({ what, ids, style, voice });
    setBusy(false);
    if (ok) onClose();
  }

  return (
    <dialog ref={dialog} onClose={onClose} onClick={(e) => e.target === dialog.current && onClose()}
      className="m-auto w-[min(640px,calc(100vw-32px))] rounded-2xl bg-panel p-0 text-ink shadow-2xl backdrop:bg-black/60">
      <div className="space-y-4 p-5">
        <h2 className="text-lg font-semibold">Regenerate <span className="khmer font-normal text-faint">· បង្កើតឡើងវិញ</span></h2>

        <fieldset className="space-y-1.5">
          <legend className="mb-1 text-sm font-semibold">Which sentences</legend>
          {scopes.map((s) => (
            <label key={s.key} className={`flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 ${scope === s.key ? 'border-accent bg-accent-soft' : 'border-line hover:border-line-strong'} ${s.ids.length ? '' : 'opacity-45'}`}>
              <input type="radio" name="regenerate-scope" checked={scope === s.key} disabled={!s.ids.length} onChange={() => setScope(s.key)} />
              <span className="flex-1 text-sm">{s.label}</span>
              <span className="text-xs tabular-nums text-muted">{s.ids.length} sentence{s.ids.length === 1 ? '' : 's'}</span>
            </label>
          ))}
        </fieldset>

        <fieldset className="space-y-1.5">
          <legend className="mb-1 text-sm font-semibold">What to do</legend>
          {WHAT.map(([key, label, note]) => {
            const off = key === 'restyle' && !translator;
            return (
              <label key={key} className={`flex cursor-pointer gap-3 rounded-lg border px-3 py-2 ${what === key ? 'border-accent bg-accent-soft' : 'border-line hover:border-line-strong'} ${off ? 'opacity-45' : ''}`}>
                <input type="radio" name="regenerate-what" className="mt-1" checked={what === key} disabled={off} onChange={() => setWhat(key)} />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold">{label}</span>
                  <span className="block text-xs text-muted">{off ? 'Needs a translation key (Settings).' : note}</span>
                  {what === key && key === 'restyle' && (
                    <span className="mt-2 grid grid-cols-2 gap-1.5 sm:grid-cols-4">
                      {STYLES.map(([k, name, km, tip]) => (
                        <button key={k} type="button" onClick={() => setStyle(k)} title={tip}
                          className={`rounded-lg border px-2 py-1.5 text-left text-xs ${style === k ? 'border-accent bg-panel font-semibold text-accent-ink' : 'border-line-strong bg-panel hover:bg-raised'}`}>
                          {name} <span className="khmer block font-normal text-faint">{km}</span>
                        </button>
                      ))}
                    </span>
                  )}
                  {what === key && key === 'change' && (
                    <select value={voice} onChange={(e) => setVoice(e.target.value)} className={`${inputCss} mt-2 text-sm`} aria-label="The new voice">
                      {voices.map((v) => <option key={v} value={v}>{voiceLabel(provider, v)}</option>)}
                    </select>
                  )}
                </span>
              </label>
            );
          })}
        </fieldset>

        <div className="flex items-center gap-2">
          <p className="mr-auto text-xs text-muted">
            {ids.length ? `${ids.length} sentence${ids.length === 1 ? '' : 's'} · it runs in the background, and you can keep editing.` : what === 'fit' ? 'Nothing there is too long for its time.' : 'There are no sentences there.'}
            {what !== 'voice' && ids.length > 0 && ' Undo brings the old text back.'}
          </p>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button disabled={busy || !ids.length} onClick={run}>{busy ? 'Starting…' : 'Start'}</Button>
        </div>
      </div>
    </dialog>
  );
}

// The sets of sentences the dialog offers.
export function regenerateScopes({ sentences, tracks, selection, range, at }) {
  const selected = new Set(selection);
  const picked = [];
  for (const t of tracks) {
    for (const c of t.clips) {
      if (!selected.has(c.id)) continue;
      if (t.id === 'voice') picked.push(c.id);
      else for (const s of sentences) if (s.start < c.end && s.end > c.start) picked.push(s.id); // the sentences on a selected clip
    }
  }
  const scopes = [];
  if (picked.length) scopes.push({ key: 'selected', label: 'The selected sentences (and those on the selected clips)', ids: [...new Set(picked)] });
  if (range) scopes.push({ key: 'range', label: `The In/Out part · ${formatTime(range.start)}–${formatTime(range.end)}`, ids: sentences.filter((s) => s.start < range.end && s.end > range.start).map((s) => s.id) });
  scopes.push({ key: 'from', label: `From the playhead (${formatTime(at)}) to the end`, ids: sentences.filter((s) => s.end > at).map((s) => s.id) });
  scopes.push({ key: 'all', label: 'The whole video', ids: sentences.map((s) => s.id) });
  return scopes;
}
