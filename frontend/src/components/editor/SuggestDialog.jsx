import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api.js';
import { Button, ErrorBox, Notice, inputCss } from '../ui.jsx';

const LABELS_KM = { natural: 'ធម្មជាតិជាង', shorter: 'ខ្លីជាង', formal: 'ផ្លូវការជាង' };
// one-click wishes; any other can be typed
const WISHES = [
  ['More polite', 'more polite and respectful'],
  ['Like friends talk', 'casual, the way friends talk'],
  ['Use បង / ប្អូន', 'address the listener as បង or ប្អូន'],
  ['Fewer words', 'say it with fewer words'],
  ['Keep the names', 'keep every name exactly as in the video'],
];

// "Improve translation": the AI suggests three Khmer lines (more natural, shorter, more formal), written
// with the lines around it and what the whole video is about. Add your own wish and ask again; if the
// speech recognition probably misheard the original, it says what was most likely said.
export default function SuggestDialog({ projectId, sentence, onPick, onClose }) {
  const [state, setState] = useState({ loading: true });
  const [wish, setWish] = useState('');
  const dialog = useRef(null);
  const asked = useRef(0);

  const ask = useCallback((instruction = '') => {
    const n = ++asked.current; // only the newest answer counts
    setState((s) => ({ ...s, loading: true, error: null }));
    api.suggest(projectId, sentence.id, instruction)
      .then((b) => n === asked.current && setState(b))
      .catch((err) => n === asked.current && setState({ error: err }));
  }, [projectId, sentence.id]);

  useEffect(() => {
    dialog.current?.showModal();
    ask();
    return () => { asked.current += 1; };
  }, [ask]);

  return (
    <dialog ref={dialog} onClose={onClose} onClick={(e) => e.target === dialog.current && onClose()}
      className="m-auto w-[min(680px,calc(100vw-32px))] rounded-2xl bg-panel p-0 text-ink shadow-2xl backdrop:bg-black/60">
      <div className="p-5">
        <h2 className="text-lg font-semibold">Improve translation <span className="khmer font-normal text-faint">· កែលម្អការបកប្រែ</span></h2>
        {sentence.original_text && <p className="mt-2 text-sm text-muted">{sentence.original_text}</p>}
        {state.meant && (
          <p className="mt-1 text-sm text-sky-800 dark:text-sky-200" title="The speech recognition probably heard this line wrong; the suggestions translate what was most likely said">
            Probably misheard. Most likely said: <span className="font-medium">{state.meant}</span>
          </p>
        )}
        <p className="khmer mt-2 rounded-lg bg-raised px-3 py-2 text-ink">{sentence.khmer_text ? <>Now: {sentence.khmer_text}</> : <span className="text-muted">No Khmer yet</span>}</p>

        <form className="mt-3 space-y-2" onSubmit={(e) => { e.preventDefault(); ask(wish); }}>
          <div className="flex gap-2">
            <input value={wish} onChange={(e) => setWish(e.target.value)} maxLength={300} aria-label="Your own wish for this line"
              placeholder="Your own wish (optional): “more polite”, “use បង”, “keep it short”…" className={`${inputCss} khmer min-w-0 flex-1`} />
            <Button type="submit" variant="soft" disabled={state.loading}>{state.loading ? 'Asking…' : '✨ Ask again'}</Button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {WISHES.map(([label, text]) => (
              <button key={label} type="button" disabled={state.loading} onClick={() => { setWish(text); ask(text); }}
                className={`khmer rounded-full border px-2.5 py-0.5 text-xs transition disabled:opacity-50 ${wish === text ? 'border-accent bg-accent-soft text-accent-ink' : 'border-line-strong text-muted hover:bg-raised hover:text-ink'}`}>
                {label}
              </button>
            ))}
          </div>
        </form>

        <div className="mt-4 space-y-2">
          {state.loading && !state.options && <p className="animate-pulse text-sm text-muted">Reading the lines around it and asking the AI for three versions…</p>}
          {state.error && <ErrorBox error={state.error} />}
          {state.backup && (
            <Notice className="py-2 text-xs">
              The AI’s main model is busy right now, so these came from its lighter backup model and may be weaker. Ask again in a minute for better ones.
            </Notice>
          )}
          <div className={state.loading && state.options ? 'opacity-50' : ''}>
            {state.options?.map((o) => {
              const over = state.budget && o.text.length > state.budget;
              return (
                <div key={o.style} className="mb-2 flex flex-col gap-2 rounded-xl border border-line p-3 sm:flex-row sm:items-center">
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-semibold text-violet-700 dark:text-violet-300">{o.label} · <span className="khmer font-normal">{LABELS_KM[o.style]}</span></p>
                    <p className="khmer text-base">{o.text}</p>
                    <p className={`text-xs ${over ? 'text-amber-700 dark:text-amber-300' : 'text-faint'}`}>{o.text.length}/{state.budget} characters{over ? ' — may need speeding up' : ''}</p>
                  </div>
                  <Button className="shrink-0" disabled={state.loading} onClick={() => onPick(o.text)}>Use this</Button>
                </div>
              );
            })}
          </div>
        </div>
        <div className="mt-4 flex items-center justify-end gap-3">
          {state.model && <span className="mr-auto text-[11px] text-faint">Written by {state.model}</span>}
          <Button variant="secondary" onClick={onClose}>Close</Button>
        </div>
      </div>
    </dialog>
  );
}
