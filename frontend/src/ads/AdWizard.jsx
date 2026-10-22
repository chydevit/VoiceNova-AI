import { useEffect, useRef, useState } from 'react';
import { timeAgo } from '../api.js';
import { Button, Card, Chip, ErrorBox } from '../components/ui.jsx';
import { STEPS, STYLE_LOOK, advertsApi } from './advertsApi.js';
import { libraryApi } from './libraryApi.js';
import ScriptStep from './ScriptStep.jsx';
import { BuildStep, FormatStep, MediaStep, ProductStep, StyleStep } from './WizardSteps.jsx';

// Make an advertorial video from scratch: #/ad lists the drafts, #/ad/<id> is one draft's wizard.
// Every change saves itself (a moment after you stop typing).
export default function AdWizard({ id }) {
  return id ? <Wizard key={id} id={id} /> : <Drafts />;
}

function Drafts() {
  const [drafts, setDrafts] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(null);

  useEffect(() => { advertsApi.list().then((b) => setDrafts(b.drafts)).catch(setError); }, []);

  async function start() {
    setBusy(true);
    try {
      const d = await advertsApi.create();
      window.location.hash = `#/ad/${d.id}`;
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  async function remove(did) {
    setError(null);
    try {
      await advertsApi.remove(did);
      setDrafts((ds) => ds.filter((d) => d.id !== did));
    } catch (err) {
      setError(err);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="text-center">
        <h1 className="text-3xl font-bold tracking-tight">Make an ad</h1>
        <p className="khmer mt-1 text-lg text-muted">បង្កើតវីដេអូផ្សាយពាណិជ្ជកម្ម ជាមួយសំឡេងខ្មែរ AI</p>
        <p className="mx-auto mt-3 max-w-xl text-sm text-muted">
          Tell it about your product and add a few photos. The AI writes the script in natural Khmer, and the video is put together for you, with a Khmer voice, captions and music.
        </p>
        <Button size="lg" className="mt-5" disabled={busy} onClick={start}>{busy ? 'Starting…' : 'Start a new ad'}</Button>
      </div>
      {error && <ErrorBox error={error} />}
      {drafts?.length > 0 && (
        <Card className="space-y-2">
          <h2 className="font-semibold">Continue an ad</h2>
          <ul className="divide-y divide-line">
            {drafts.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center gap-3 py-2.5">
                <a href={`#/ad/${d.id}`} className="flex min-w-0 flex-1 items-center gap-3 hover:text-accent-ink">
                  <span className="text-2xl" aria-hidden="true">{STYLE_LOOK[d.style]?.icon}</span>
                  <span className="min-w-0">
                    <span className="khmer block truncate font-medium">{d.brief.product || 'Untitled ad'}</span>
                    <span className="text-xs text-muted">{d.format} · {d.length} s · step: {STEPS.find(([k]) => k === d.step)?.[1]} · edited {timeAgo(d.updated_at)}</span>
                  </span>
                </a>
                {confirming === d.id ? (
                  <span className="flex gap-1">
                    <Button size="sm" variant="danger" onClick={() => remove(d.id)}>Delete</Button>
                    <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>Keep</Button>
                  </span>
                ) : <Button size="sm" variant="ghost" onClick={() => setConfirming(d.id)} title="Delete this draft">🗑</Button>}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

// brief and its contact are merged; everything else is replaced
function mergeFields(into, fields) {
  const out = { ...into, ...fields };
  if (fields.brief) {
    out.brief = { ...into.brief, ...fields.brief };
    if (fields.brief.contact) out.brief.contact = { ...into.brief?.contact, ...fields.brief.contact };
  }
  return out;
}

function useDraft(id) {
  const [draft, setDraft] = useState(null);
  const [options, setOptions] = useState(null);
  const [lib, setLib] = useState(null);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const pending = useRef({});
  const timer = useRef(null);
  const edits = useRef(0);

  useEffect(() => {
    Promise.all([advertsApi.get(id), libraryApi.get()])
      .then(([d, l]) => { setDraft(d.draft); setOptions(d.options); setLib(l); })
      .catch(setError);
    return () => clearTimeout(timer.current);
  }, [id]);

  async function flush() {
    clearTimeout(timer.current);
    const fields = pending.current;
    pending.current = {};
    if (!Object.keys(fields).length) return;
    const mark = edits.current;
    setSaving(true);
    try {
      const saved = await advertsApi.patch(id, fields);
      // Nothing changed since: take the saved draft, but keep the text as typed (the server tidies
      // spaces, which would move the cursor) and only the warnings worked out for the scripts.
      if (edits.current === mark) {
        setDraft((local) => ({
          ...saved,
          brief: fields.brief ? local.brief : saved.brief,
          scripts: fields.scripts ? local.scripts.map((s, i) => ({ ...s, warnings: saved.scripts[i]?.warnings ?? s.warnings })) : saved.scripts,
        }));
      }
      setError(null);
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  }

  // Change fields now on the page, and save them a moment later (or at once).
  function change(fields, { now = false } = {}) {
    edits.current += 1;
    setDraft((d) => mergeFields(d, fields));
    pending.current = mergeFields(pending.current, fields);
    clearTimeout(timer.current);
    if (now) return flush();
    timer.current = setTimeout(flush, 600);
    return Promise.resolve();
  }

  // A server action that returns the whole draft (write scripts, apply the brand kit).
  async function run(fn) {
    await flush();
    setError(null);
    try {
      edits.current += 1;
      setDraft(await fn());
    } catch (err) {
      setError(err);
    }
  }

  return { draft, options, lib, setLib, error, saving, change, flush, run };
}

function Wizard({ id }) {
  const state = useDraft(id);
  const { draft, options, lib, error, saving, change } = state;

  if (!draft) return error ? <ErrorBox error={error} /> : <p className="text-muted">Loading…</p>;

  const at = STEPS.findIndex(([k]) => k === draft.step);
  const go = (i) => { change({ step: STEPS[i][0] }, { now: true }); window.scrollTo(0, 0); };
  const blocked = {
    product: !draft.brief.product.trim() && 'Write the product or business name first.',
    script: draft.chosen == null && 'Write the scripts and pick one first.',
  }[draft.step];
  const props = { ...state, draft, options, lib };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <a href="#/ad" className="text-sm text-muted hover:text-ink">← All ads</a>
        <h1 className="khmer min-w-0 flex-1 truncate text-xl font-bold">{draft.brief.product || 'New ad'}</h1>
        <span className={`text-xs ${saving ? 'text-accent-ink' : 'text-muted'}`}>{saving ? 'Saving…' : 'All changes saved'}</span>
      </div>

      <ol className="grid grid-cols-3 gap-1.5 sm:grid-cols-6" aria-label="Steps">
        {STEPS.map(([key, label, km], i) => (
          <li key={key}>
            <button type="button" onClick={() => go(i)} aria-current={i === at ? 'step' : undefined}
              className={`flex w-full items-center gap-2 rounded-xl border px-2.5 py-2 text-left transition ${i === at ? 'border-accent bg-accent-soft' : 'border-line bg-panel hover:bg-raised'}`}>
              <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-xs font-bold ${i < at ? 'bg-emerald-500/20 text-emerald-700 dark:text-emerald-300' : i === at ? 'bg-accent text-white' : 'bg-raised text-muted'}`}>
                {i < at ? '✓' : i + 1}
              </span>
              <span className="min-w-0 leading-tight">
                <span className="block truncate text-sm font-semibold">{label}</span>
                <span className="khmer block truncate text-[11px] leading-snug text-muted">{km}</span>
              </span>
            </button>
          </li>
        ))}
      </ol>

      {error && <ErrorBox error={error} />}

      {draft.step === 'product' && <ProductStep {...props} />}
      {draft.step === 'media' && <MediaStep {...props} />}
      {draft.step === 'style' && <StyleStep {...props} />}
      {draft.step === 'format' && <FormatStep {...props} />}
      {draft.step === 'script' && <ScriptStep {...props} />}
      {draft.step === 'build' && <BuildStep {...props} />}

      <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
        {at > 0 && <Button variant="secondary" onClick={() => go(at - 1)}>← Back</Button>}
        {blocked && <p className="text-sm text-muted">{blocked}</p>}
        {at < STEPS.length - 1 && (
          <Button className="ml-auto" disabled={Boolean(blocked)} onClick={() => go(at + 1)}>Next: {STEPS[at + 1][1]} →</Button>
        )}
      </div>
      {draft.step !== 'script' && draft.step !== 'build' && (
        <p className="text-right text-xs text-faint"><Chip>{options.writer.ok ? `Script AI: ${options.writer.model}` : `Script AI not set up: ${options.writer.reason}`}</Chip></p>
      )}
    </div>
  );
}
