import { useState } from 'react';
import { api } from '../../api.js';
import { Button, ErrorBox } from '../ui.jsx';

function Slider({ label, value, min = 0, max = 100, onChange }) {
  return (
    <label className="block text-xs">
      <span className="flex justify-between font-medium text-muted">{label}<span className="tabular-nums text-accent-ink">{value.toFixed(1)}%</span></span>
      <input type="range" min={min} max={max} step="0.5" value={value} onChange={(e) => onChange(Number(e.target.value))} className="w-full" />
    </label>
  );
}

// Hide the original video's burned-in subtitles (blur or a dark box) so the Khmer ones
// don't sit on top of them. Changes show at once in the preview; "Apply" saves them.
export default function CoverPanel({ projectId, saved, draft, setDraft, editing, setEditing, locked, onApply, onShowSpeech }) {
  const cover = draft || saved;
  const dirty = JSON.stringify(cover) !== JSON.stringify(saved);
  const [finding, setFinding] = useState(false);
  const [found, setFound] = useState(null);
  const [error, setError] = useState(null);
  const set = (patch) => setDraft((current) => ({ ...(current || saved), ...patch }));

  async function find() {
    setFinding(true);
    setError(null);
    setFound(null);
    try {
      const result = await api.detectCover(projectId);
      setFound(result);
      if (result.found) {
        setDraft({ ...cover, ...result.cover, mode: cover.mode });
        onShowSpeech(); // jump to someone talking, so the covered subtitle is on screen
      }
    } catch (err) {
      setError(err);
    } finally {
      setFinding(false);
    }
  }

  return (
    <section className="mt-6 border-t border-line pt-5">
      <label className="flex cursor-pointer items-start justify-between gap-3">
        <span>
          <span className="block text-sm font-semibold">Cover the original subtitles</span>
          <span className="block text-xs text-muted">Hide subtitles already burned into the video, under the Khmer ones.</span>
        </span>
        <input type="checkbox" className="mt-1 h-4 w-4" checked={cover.enabled} disabled={locked} onChange={(e) => { set({ enabled: e.target.checked }); setEditing(e.target.checked); }} />
      </label>

      {cover.enabled && (
        <fieldset disabled={locked} className="mt-4 space-y-4">
          <div className="flex items-center gap-2 text-sm">
            <span className="text-xs font-medium text-muted">Style</span>
            <span className="inline-flex overflow-hidden rounded-lg border border-line-strong text-xs">
              {[['blur', 'Blur'], ['box', 'Dark box']].map(([mode, label]) => (
                <button key={mode} type="button" onClick={() => set({ mode })}
                  className={`px-3 py-1 ${cover.mode === mode ? 'bg-ink text-canvas' : 'hover:bg-raised'}`}>{label}</button>
              ))}
            </span>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="soft" disabled={finding} onClick={find}>{finding ? 'Looking…' : '🔍 Find them automatically'}</Button>
            <Button size="sm" variant={editing ? 'primary' : 'secondary'} onClick={() => setEditing(!editing)}>
              {editing ? 'Done adjusting' : '✥ Adjust on the video'}
            </Button>
          </div>
          {finding && <p className="text-xs text-muted">Comparing frames while people talk with the pauses… (a few seconds)</p>}
          {found && (found.found
            ? <p className="rounded-lg bg-emerald-500/10 px-3 py-2 text-xs text-emerald-800 dark:text-emerald-200">Found burned-in subtitles at {Math.round(found.cover.y)}–{Math.round(found.cover.y + found.cover.h)}% of the height. Check the preview, adjust if needed, then Apply.</p>
            : <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-200">{found.reason} Place the area by hand with “Adjust on the video”.</p>)}
          <ErrorBox compact error={error} />
          {editing && <p className="text-xs text-accent-ink">Drag the dashed area on the video to move it; drag its white handles to resize it.</p>}

          <div className="grid grid-cols-2 gap-x-4 gap-y-3">
            <Slider label="From the top" value={cover.y} max={100 - cover.h} onChange={(y) => set({ y })} />
            <Slider label="Height" value={cover.h} min={2} max={100 - cover.y} onChange={(h) => set({ h })} />
            <Slider label="From the left" value={cover.x} max={100 - cover.w} onChange={(x) => set({ x })} />
            <Slider label="Width" value={cover.w} min={2} max={100 - cover.x} onChange={(w) => set({ w })} />
          </div>
        </fieldset>
      )}

      <div className="mt-4 flex flex-col gap-2">
        <Button disabled={locked || !dirty} onClick={async () => { if (await onApply(cover)) setEditing(false); }}>Apply</Button>
        {dirty && <button type="button" className="py-1 text-sm text-muted underline" onClick={() => { setDraft(null); setEditing(false); }}>Cancel changes</button>}
      </div>
      <p className="mt-2 text-xs text-muted">
        {cover.enabled ? 'Covering changes the picture, so exported videos are re-encoded — exports take a little longer.' : 'Off — the original picture is kept as it is.'}
      </p>
    </section>
  );
}
