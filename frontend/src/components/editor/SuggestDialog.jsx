import { useEffect, useRef, useState } from 'react';
import { api } from '../../api.js';
import { Button, ErrorBox } from '../ui.jsx';

const LABELS_KM = { natural: 'ធម្មជាតិជាង', shorter: 'ខ្លីជាង', formal: 'ផ្លូវការជាង' };

// "Improve translation": the AI suggests three Khmer lines; the user picks one (or none).
export default function SuggestDialog({ projectId, sentence, onPick, onClose }) {
  const [state, setState] = useState({ loading: true });
  const dialog = useRef(null);

  useEffect(() => {
    dialog.current?.showModal();
    let cancelled = false;
    api.suggest(projectId, sentence.id)
      .then((b) => !cancelled && setState({ options: b.options, budget: b.budget }))
      .catch((err) => !cancelled && setState({ error: err }));
    return () => { cancelled = true; };
  }, [projectId, sentence.id]);

  return (
    <dialog ref={dialog} onClose={onClose} onClick={(e) => e.target === dialog.current && onClose()}
      className="m-auto w-[min(640px,calc(100vw-32px))] rounded-2xl bg-panel p-0 text-ink shadow-2xl backdrop:bg-black/60">
      <div className="p-5">
        <h2 className="text-lg font-semibold">Improve translation <span className="khmer font-normal text-faint">· កែលម្អការបកប្រែ</span></h2>
        {sentence.original_text && <p className="mt-2 text-sm text-muted">{sentence.original_text}</p>}
        <p className="khmer mt-1 rounded-lg bg-raised px-3 py-2 text-ink">Now: {sentence.khmer_text}</p>

        <div className="mt-4 space-y-2">
          {state.loading && <p className="animate-pulse text-sm text-muted">Asking the AI for three alternatives…</p>}
          {state.error && <ErrorBox error={state.error} />}
          {state.options?.map((o) => {
            const over = state.budget && o.text.length > state.budget;
            return (
              <div key={o.style} className="flex flex-col gap-2 rounded-xl border border-line p-3 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold text-violet-700 dark:text-violet-300">{o.label} · <span className="khmer font-normal">{LABELS_KM[o.style]}</span></p>
                  <p className="khmer text-base">{o.text}</p>
                  <p className={`text-xs ${over ? 'text-amber-700 dark:text-amber-300' : 'text-faint'}`}>{o.text.length}/{state.budget} characters{over ? ' — may need speeding up' : ''}</p>
                </div>
                <Button className="shrink-0" onClick={() => onPick(o.text)}>Use this</Button>
              </div>
            );
          })}
        </div>
        <div className="mt-4 flex justify-end">
          <Button variant="secondary" onClick={onClose}>Close</Button>
        </div>
      </div>
    </dialog>
  );
}
