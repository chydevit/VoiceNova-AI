import { useState } from 'react';
import { Button, Card, Chip, Notice, inputCss, textareaCss } from '../components/ui.jsx';
import { ROLE_LABELS, ROLE_SHORT, advertsApi } from './advertsApi.js';

// Step 5: the AI writes three scripts (friendly, energetic, professional); pick one and change anything.
// keep in sync with backend services/adscript.py (CHARS_PER_SECOND, SCENE_PAUSE, MIN_SCENE)
const CHARS_PER_SECOND = 11;
const sceneSeconds = (voice) => Math.max(1.2, voice.length / CHARS_PER_SECOND + 0.25);
const totals = (script) => ({
  chars: script.scenes.reduce((n, s) => n + s.voice.length, 0),
  seconds: script.scenes.reduce((n, s) => n + sceneSeconds(s.voice), 0),
});

function Meter({ script, budget, length }) {
  const { chars, seconds } = totals(script);
  const over = chars > budget.chars * 1.1;
  return (
    <div className="space-y-1">
      <div className="h-1.5 overflow-hidden rounded-full bg-raised">
        <div className={`h-full rounded-full ${over ? 'bg-red-500' : 'bg-emerald-500'}`} style={{ width: `${Math.min(100, (chars / budget.chars) * 100)}%` }} />
      </div>
      <p className={`text-xs ${over ? 'text-red-600 dark:text-red-400' : 'text-muted'}`}>
        {chars} / {budget.chars} characters · about {Math.round(seconds)} of {length} seconds{over ? ' — too long to say in time' : ''}
      </p>
    </div>
  );
}

export default function ScriptStep({ draft, options, lib, change, run }) {
  const [writing, setWriting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [copied, setCopied] = useState(false);
  const budget = options.lengths.find((l) => l.seconds === draft.length);
  const tones = Object.fromEntries(options.tones.map((t) => [t.key, t]));
  const scripts = draft.scripts;
  const chosen = draft.chosen;

  async function write() {
    setConfirming(false);
    setWriting(true);
    await run(() => advertsApi.writeScripts(draft.id));
    setWriting(false);
  }

  const setScript = (i, script) => change({ scripts: scripts.map((s, j) => (j === i ? script : s)) });

  if (!scripts.length) {
    return (
      <Card className="space-y-4 text-center">
        <h2 className="text-lg font-semibold">Write the script</h2>
        <p className="mx-auto max-w-lg text-sm text-muted">
          The AI writes three {draft.length}-second scripts in natural spoken Khmer: a strong hook in the first 3 seconds, the benefits, the price and offer, and a clear call to action with your contact details. Then pick one and change anything.
        </p>
        {!options.writer.ok && <Notice>The AI isn't set up: {options.writer.reason}. <a href="#/settings" className="font-semibold underline">Open Settings</a></Notice>}
        <Button size="lg" disabled={writing || !options.writer.ok} onClick={write}>{writing ? 'Writing three scripts… (up to a minute)' : '✨ Write 3 scripts'}</Button>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold">Pick a script</h2>
        <span className="text-sm text-muted">{draft.length} seconds · about {budget.chars} characters of voice fit</span>
        <span className="ml-auto flex gap-1.5">
          {confirming ? (
            <>
              <span className="self-center text-xs text-muted">This replaces all three, with your changes.</span>
              <Button size="sm" variant="secondary" disabled={writing} onClick={write}>Write again</Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>Keep</Button>
            </>
          ) : <Button size="sm" variant="secondary" disabled={writing || !options.writer.ok} onClick={() => setConfirming(true)}>{writing ? 'Writing…' : '✨ Write again'}</Button>}
        </span>
      </div>
      {draft.scripts_length && draft.scripts_length !== draft.length && (
        <Notice>These scripts were written for {draft.scripts_length} seconds; the ad is now {draft.length}. Write them again, or shorten one.</Notice>
      )}

      <ul className="grid gap-3 lg:grid-cols-3">
        {scripts.map((s, i) => (
          <li key={i} className={`flex flex-col gap-2 rounded-xl border p-3 ${chosen === i ? 'border-accent bg-accent-soft/40 ring-2 ring-accent/25' : 'border-line bg-panel'}`}>
            <div className="flex items-center gap-2">
              <Chip tone="accent">{s.label}</Chip>
              <span className="khmer text-xs text-muted">{tones[s.tone]?.km}</span>
            </div>
            <p className="khmer font-semibold leading-snug">{s.title}</p>
            <Meter script={s} budget={budget} length={draft.length} />
            <ol className="khmer space-y-1 text-sm">
              {s.scenes.map((sc) => (
                <li key={sc.id} className="flex gap-2">
                  <span className="w-16 shrink-0 pt-0.5 text-[11px] font-semibold uppercase tracking-wide text-faint">{ROLE_SHORT[sc.role]}</span>
                  <span className="min-w-0">{sc.voice}{sc.caption && <span className="ml-1 rounded bg-raised px-1 text-xs text-muted">{sc.caption}</span>}</span>
                </li>
              ))}
            </ol>
            {s.warnings?.length > 0 && <Notice className="text-xs">{s.warnings.join(' · ')}</Notice>}
            <Button className="mt-auto" variant={chosen === i ? 'soft' : 'secondary'} size="sm" onClick={() => change({ chosen: i }, { now: true })}>
              {chosen === i ? '✓ Using this script' : 'Use this script'}
            </Button>
          </li>
        ))}
      </ul>

      {chosen != null && scripts[chosen] && (
        <ScriptEditor script={scripts[chosen]} draft={draft} lib={lib} budget={budget} roles={options.roles}
          onChange={(s) => setScript(chosen, s)} copied={copied} onCopy={() => {
            navigator.clipboard?.writeText(scripts[chosen].post).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); });
          }} />
      )}
    </div>
  );
}

function ScriptEditor({ script, draft, lib, budget, roles, onChange, copied, onCopy }) {
  const byId = Object.fromEntries(lib.assets.map((a) => [a.id, a]));
  const scenes = script.scenes;
  const setScenes = (next) => onChange({ ...script, scenes: next });
  const setScene = (i, fields) => setScenes(scenes.map((s, j) => (j === i ? { ...s, ...fields } : s)));
  const move = (i, by) => {
    const next = [...scenes];
    [next[i], next[i + by]] = [next[i + by], next[i]];
    setScenes(next);
  };
  const add = () => setScenes([...scenes.slice(0, -1), { id: `new${Date.now()}`, role: 'benefit', voice: '', caption: '', media: null }, ...scenes.slice(-1)]);

  return (
    <Card className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold">Edit the script</h2>
        <input value={script.title} onChange={(e) => onChange({ ...script, title: e.target.value })} aria-label="Title" maxLength={120}
          className={`${inputCss} khmer min-w-0 flex-1 font-semibold`} />
      </div>
      <Meter script={script} budget={budget} length={draft.length} />
      <ol className="space-y-3">
        {scenes.map((s, i) => (
          <li key={s.id} className="grid gap-2 rounded-xl border border-line p-3 sm:grid-cols-[2rem_minmax(0,1fr)_12rem]">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-raised text-sm font-bold text-muted">{i + 1}</span>
            <div className="min-w-0 space-y-2">
              <textarea value={s.voice} onChange={(e) => setScene(i, { voice: e.target.value })} rows={2} aria-label={`Shot ${i + 1}: what the voice says`}
                placeholder="What the voice says (in Khmer)" className={textareaCss} />
              <div className="flex flex-wrap items-center gap-2">
                <input value={s.caption} onChange={(e) => setScene(i, { caption: e.target.value })} maxLength={80} aria-label={`Shot ${i + 1}: caption`}
                  placeholder="Caption on screen (optional)" className={`${inputCss} khmer min-w-0 flex-1`} />
                <span className={`text-xs ${s.caption.length > 24 ? 'text-amber-700 dark:text-amber-300' : 'text-faint'}`}>{s.caption.length}/24</span>
              </div>
              <p className="text-xs text-faint">{s.voice.length} characters · about {sceneSeconds(s.voice).toFixed(1)} s{i === 0 && s.voice.length > budget.hook_chars ? ` · a hook should take at most 3 s (${budget.hook_chars} characters)` : ''}</p>
            </div>
            <div className="space-y-2">
              <select value={s.role} onChange={(e) => setScene(i, { role: e.target.value })} aria-label="Kind of shot" className={`${inputCss} w-full`}>
                {roles.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
              </select>
              <select value={s.media || ''} onChange={(e) => setScene(i, { media: e.target.value || null })} aria-label="Picture" className={`${inputCss} w-full`}>
                <option value="">Logo and brand colours</option>
                {draft.media.map((aid, n) => <option key={aid} value={aid}>{n + 1}. {byId[aid]?.name || 'deleted'}</option>)}
              </select>
              <div className="flex justify-end gap-1">
                <Button size="sm" variant="ghost" disabled={i === 0} onClick={() => move(i, -1)} title="Move up">↑</Button>
                <Button size="sm" variant="ghost" disabled={i === scenes.length - 1} onClick={() => move(i, 1)} title="Move down">↓</Button>
                <Button size="sm" variant="danger" disabled={scenes.length <= 1} onClick={() => setScenes(scenes.filter((_, j) => j !== i))} title="Remove this shot">✕</Button>
              </div>
            </div>
          </li>
        ))}
      </ol>
      <Button variant="secondary" size="sm" onClick={add}>+ Add a shot</Button>

      <div className="space-y-2 border-t border-line pt-4">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-semibold">Text to post with the video</h3>
          <span className="ml-auto flex gap-2">
            <Button size="sm" variant="secondary" onClick={onCopy}>{copied ? '✓ Copied' : 'Copy'}</Button>
            <a href={advertsApi.scriptUrl(draft.id)} className="inline-flex items-center rounded-lg border border-line-strong px-2.5 py-1.5 text-xs font-semibold hover:bg-raised">Download script + captions (.txt)</a>
          </span>
        </div>
        <textarea value={script.post} onChange={(e) => onChange({ ...script, post: e.target.value })} rows={5} aria-label="Text to post" className={textareaCss} />
      </div>
    </Card>
  );
}
