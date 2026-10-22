import { useEffect, useRef, useState } from 'react';
import { formatTime } from '../../api.js';
import { budget } from '../../lib/khmer.js';
import { voiceLabel } from '../../lib/voices.js';
import { Button, inputCss, textareaCss } from '../ui.jsx';

// + Voice line: type a new Khmer line, choose its voice, and generate it at the playhead.
export default function VoiceLineDialog({ at, voices, provider, defaultVoice, room, onGenerate, onClose }) {
  const dialog = useRef(null);
  const [text, setText] = useState('');
  const [voice, setVoice] = useState(voices.includes(defaultVoice) ? defaultVoice : voices[0]);
  const [busy, setBusy] = useState(false);
  useEffect(() => { dialog.current?.showModal(); }, []);
  const fits = room === null ? null : budget(room);

  async function generate() {
    if (!text.trim()) return;
    setBusy(true);
    const ok = await onGenerate({ text: text.trim(), voice });
    setBusy(false);
    if (ok) onClose();
  }

  return (
    <dialog ref={dialog} onClose={onClose} onClick={(e) => e.target === dialog.current && onClose()}
      className="m-auto w-[min(560px,calc(100vw-32px))] rounded-2xl bg-panel p-0 text-ink shadow-2xl backdrop:bg-black/60">
      <div className="space-y-3 p-5">
        <h2 className="text-lg font-semibold">New voice line <span className="khmer font-normal text-faint">· បន្ថែមសំឡេង</span></h2>
        <p className="text-sm text-muted">
          At {formatTime(at)}{room !== null ? ` · ${room.toFixed(1)}s of free time here (about ${fits} characters)` : ''}. It becomes a sentence like the others: its subtitle follows it, and you can change it later.
        </p>
        <textarea autoFocus lang="km" rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="វាយអត្ថបទខ្មែរនៅទីនេះ… (type the Khmer line)"
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) generate(); }} className={textareaCss} aria-label="The Khmer line" />
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted">Voice</span>
            <select value={voice} onChange={(e) => setVoice(e.target.value)} disabled={voices.length < 2} className={`${inputCss} text-sm`}>
              {voices.map((v) => <option key={v} value={v}>{voiceLabel(provider, v)}</option>)}
            </select>
          </label>
          <span className={`text-xs tabular-nums ${fits !== null && text.length > fits * 1.3 ? 'font-semibold text-amber-700 dark:text-amber-300' : 'text-faint'}`}>{text.length}{fits !== null ? `/${fits}` : ''} characters</span>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button disabled={busy || !text.trim()} onClick={generate}>{busy ? 'Generating…' : 'Generate'}</Button>
        </div>
      </div>
    </dialog>
  );
}
