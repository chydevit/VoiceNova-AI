import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api.js';
import { watermarkApi } from '../../lib/watermarkApi.js';
import { Button, Chip, inputCss } from '../ui.jsx';

const KINDS = { image: 'logo', text: 'text', tiled: 'tiled logo' };

// The saved presets (shared by every project), loaded once per component.
export function usePresets() {
  const [data, setData] = useState(null);
  const reload = useCallback(() => watermarkApi.presets().then(setData).catch(() => setData({ presets: [], default: null, auto: false })), []);
  useEffect(() => { reload(); }, [reload]);
  return [data, setData, reload];
}

function PresetThumbs({ preset }) {
  return (
    <span className="flex shrink-0 items-center gap-0.5">
      {preset.watermarks.slice(0, 3).map((w, i) => (
        <span key={i} className="flex h-7 w-9 items-center justify-center overflow-hidden rounded bg-[repeating-conic-gradient(#8884_0_25%,transparent_0_50%)] bg-[length:8px_8px]">
          {w.logo_url ? <img src={w.logo_url} alt="" className="max-h-full max-w-full object-contain" />
            : <span className="khmer truncate px-0.5 text-[9px]" style={{ color: w.color, fontFamily: `"${w.font}"` }}>{w.text || 'Aa'}</span>}
        </span>
      ))}
    </span>
  );
}

const describe = (p) => p.watermarks.map((w) => `${KINDS[w.kind]} ${w.kind === 'text' ? `“${w.text}”` : `${w.width}%`} · ${w.anchor.replace('-', ' ')}`).join(' + ');

// One-click presets in the Watermark tab: use one here, save these watermarks as one, put one on
// every project, and choose the one new projects get.
export default function WatermarkPresets({ project, actions, locked, say, hasWatermarks }) {
  const [data, setData] = usePresets();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState('');
  const [confirmAll, setConfirmAll] = useState(null);
  if (!data) return null;
  const run = async (key, fn) => {
    setBusy(key);
    try { return await fn(); } finally { setBusy(''); }
  };
  const save = () => run('save', async () => {
    const body = await actions.run(() => watermarkApi.savePreset(name.trim() || 'My watermark', project.id));
    if (body) { setData(body); setName(''); say?.('Saved as a preset — use it on any project in one click.'); }
  });
  const use = (p) => run(p.id, () => actions.run(() => watermarkApi.applyPreset(project.id, p.id)).then((b) => b && say?.(`“${p.name}” is on this video.`)));
  const applyAll = (p) => run(`all-${p.id}`, async () => {
    setConfirmAll(null);
    try {
      const r = await watermarkApi.applyToAll(p.id);
      say?.(`“${p.name}” is on ${r.done} project${r.done === 1 ? '' : 's'}${r.skipped ? ` · ${r.skipped} left as they were (busy, locked or without a video)` : ''}. Each can undo it.`);
      actions.run(async () => ({ project: await api.get(project.id) })); // this one changed too
    } catch (err) { say?.(err.message); }
  });
  const setDefault = (fields) => watermarkApi.setDefault(fields).then(setData).catch((err) => say?.(err.message));
  return (
    <section className="space-y-2 rounded-xl border border-line bg-raised/50 p-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-faint">Presets</p>
      {data.presets.map((p) => (
        <div key={p.id} className="space-y-1.5 rounded-lg border border-line bg-panel p-2">
          <div className="flex items-center gap-2">
            <PresetThumbs preset={p} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-semibold text-ink">{p.name} {data.default === p.id && <Chip tone="accent">default</Chip>}</span>
              <span className="block truncate text-[11px] text-faint" title={describe(p)}>{describe(p)}</span>
            </span>
          </div>
          <div className="flex flex-wrap gap-1">
            <Button size="sm" disabled={locked || !!busy} onClick={() => use(p)}>{busy === p.id ? 'Adding…' : 'Use on this video'}</Button>
            {confirmAll === p.id ? (
              <>
                <Button size="sm" variant="soft" disabled={!!busy} onClick={() => applyAll(p)}>Yes, every project</Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmAll(null)}>Cancel</Button>
              </>
            ) : <Button size="sm" variant="secondary" disabled={locked || !!busy} onClick={() => setConfirmAll(p.id)}>{busy === `all-${p.id}` ? 'Applying…' : 'Apply to all projects'}</Button>}
            {data.default !== p.id && <Button size="sm" variant="ghost" onClick={() => setDefault({ preset: p.id })}>Make default</Button>}
            <Button size="sm" variant="danger" onClick={() => watermarkApi.deletePreset(p.id).then(setData)}>Delete</Button>
          </div>
        </div>
      ))}
      {data.presets.length > 0 && (
        <label className="flex items-start gap-2 text-xs">
          <input type="checkbox" className="mt-0.5" checked={!!data.auto} onChange={(e) => setDefault({ auto: e.target.checked })} />
          <span>Add the default preset to every new video<span className="block text-faint">You can still choose another one (or none) when you upload.</span></span>
        </label>
      )}
      {hasWatermarks && (
        <div className="flex gap-1.5">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Preset name (e.g. My shop)" aria-label="Preset name" className={`${inputCss} min-w-0 flex-1 py-1 text-xs`} />
          <Button size="sm" variant="secondary" disabled={locked || busy === 'save'} onClick={save} title="Logo, position, size, opacity and animation of every watermark here">Save as preset</Button>
        </div>
      )}
      {!data.presets.length && !hasWatermarks && <p className="text-xs text-faint">Add a watermark, then save it as a preset to use it on other videos in one click.</p>}
    </section>
  );
}

// Which preset a new video (or an ad) gets: the default one, another one, or none.
// value: '' (the default, when it's on), 'none', or a preset id.
// withDefault false: only the presets and 'none' (a choice already made, like an ad draft's).
export function PresetSelect({ value, onChange, disabled, label = 'Watermark', className = '', withDefault = true }) {
  const [data] = usePresets();
  if (!data?.presets.length) return null;
  const def = data.presets.find((p) => p.id === data.default);
  return (
    <label className={`flex items-center gap-2 text-sm text-muted ${className}`}>
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} className="rounded-lg border border-line-strong bg-panel px-2 py-1.5 text-sm">
        {withDefault && <option value="">{data.auto && def ? `Default (${def.name})` : 'No watermark'}</option>}
        {data.presets.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        {(!withDefault || (data.auto && def)) && <option value="none">No watermark</option>}
      </select>
    </label>
  );
}

// The presets on the Brand Kit page: the default one for new videos, putting one on every project,
// renaming and deleting. (Make them in the editor's Watermark tab.)
export function PresetLibrary() {
  const [data, setData] = usePresets();
  const [note, setNote] = useState('');
  const [confirmAll, setConfirmAll] = useState(null);
  if (!data) return null;
  const setDefault = (fields) => watermarkApi.setDefault(fields).then(setData);
  const all = async (p) => {
    setConfirmAll(null);
    const r = await watermarkApi.applyToAll(p.id);
    setNote(`“${p.name}” is on ${r.done} project${r.done === 1 ? '' : 's'}${r.skipped ? ` · ${r.skipped} left as they were` : ''}.`);
  };
  return (
    <div className="space-y-3">
      <div>
        <h2 className="font-semibold">Watermarks</h2>
        <p className="text-sm text-muted">Saved watermarks (logo, place, size, opacity, animation). Save one from the editor’s Watermark tab; use it on any video in one click.</p>
      </div>
      {!data.presets.length && <p className="text-sm text-faint">No watermark preset yet.</p>}
      {data.presets.map((p) => (
        <div key={p.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-panel p-2.5">
          <PresetThumbs preset={p} />
          <input defaultValue={p.name} aria-label="Preset name" onBlur={(e) => e.target.value.trim() && e.target.value !== p.name && watermarkApi.renamePreset(p.id, e.target.value).then(setData)}
            className={`${inputCss} min-w-0 flex-1 py-1 text-sm`} />
          {data.default === p.id ? <Chip tone="green">Default</Chip> : <Button size="sm" variant="ghost" onClick={() => setDefault({ preset: p.id })}>Make default</Button>}
          {confirmAll === p.id
            ? <><Button size="sm" variant="soft" onClick={() => all(p)}>Yes, every project</Button><Button size="sm" variant="ghost" onClick={() => setConfirmAll(null)}>Cancel</Button></>
            : <Button size="sm" variant="secondary" onClick={() => setConfirmAll(p.id)}>Apply to all projects</Button>}
          <Button size="sm" variant="danger" onClick={() => watermarkApi.deletePreset(p.id).then(setData)}>Delete</Button>
        </div>
      ))}
      {data.presets.length > 0 && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={!!data.auto} onChange={(e) => setDefault({ auto: e.target.checked })} /> Add the default watermark to every new video (and new ads)
        </label>
      )}
      {note && <p className="text-sm text-emerald-700 dark:text-emerald-300">{note}</p>}
    </div>
  );
}
