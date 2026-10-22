import { useEffect, useMemo, useRef, useState } from 'react';
import { formatTime } from '../../api.js';
import { canvasSize, trackOf } from '../../lib/timeline.js';
import {
  ANCHORS, WATERMARK_FONTS, awayFrom, isPortrait, overlapsBand, renderWatermark, subtitleBand,
} from '../../lib/watermark.js';
import { LOGO_ACCEPT, MAX_LOGO_MB, uploadLogo, watermarkApi } from '../../lib/watermarkApi.js';
import { Button, Chip, inputCss } from '../ui.jsx';
import { NumberControl, SecondsControl } from './VolumeControl.jsx';

const Section = ({ title, children, right }) => (
  <section className="space-y-2.5 border-t border-line pt-3 first:border-t-0 first:pt-0">
    {title && <h3 className="flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-faint">{title}{right}</h3>}
    {children}
  </section>
);

const Toggle = ({ checked, onChange, children, disabled, hint }) => (
  <label className="flex items-start gap-2 text-xs">
    <input type="checkbox" className="mt-0.5" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
    <span>{children}{hint && <span className="block text-faint">{hint}</span>}</span>
  </label>
);

const KIND_NAMES = { image: 'Logo', text: 'Text', tiled: 'Tiled logo' };
const HIDE_NAMES = [['ads', 'Ads'], ['intro', 'The intro'], ['outro', 'The outro']];
const ANIMATIONS = [['none', 'None'], ['fade', 'Fade in and out'], ['pulse', 'Gentle pulse'], ['corners', 'Corner switch']];

function WatermarkRow({ w, media, active, onPick }) {
  const m = media[w.media];
  return (
    <button type="button" onClick={onPick}
      className={`flex w-full items-center gap-2 rounded-lg border px-2 py-1.5 text-left text-xs ${active ? 'border-accent bg-accent-soft' : 'border-line hover:border-line-strong'}`}>
      <span className="flex h-8 w-12 shrink-0 items-center justify-center overflow-hidden rounded bg-[repeating-conic-gradient(#8884_0_25%,transparent_0_50%)] bg-[length:10px_10px]">
        {w.kind === 'text' ? <span className="khmer truncate px-0.5 text-[10px]" style={{ color: w.color, fontFamily: `"${w.font}"` }}>{w.text || 'Aa'}</span>
          : m && <img src={w.remove_bg && m.nobg_url ? m.nobg_url : m.url} alt="" className="max-h-full max-w-full object-contain" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-semibold text-ink">{w.kind === 'text' ? w.text || 'Text' : m?.name || KIND_NAMES[w.kind]}</span>
        <span className="block text-faint">{KIND_NAMES[w.kind]} · {w.whole ? 'the whole video' : `${formatTime(w.start)}–${formatTime(w.end)}`}{w.skipped ? ' · skipped' : ''}</span>
      </span>
    </button>
  );
}

// Choose the logo: upload one (PNG, JPG, SVG, WebP), or one saved in the Brand Kit.
function LogoPicker({ project, actions, current, onPicked, locked, say }) {
  const input = useRef(null);
  const [kit, setKit] = useState(null);
  const [saveToKit, setSaveToKit] = useState(true);
  const [busy, setBusy] = useState(false);
  useEffect(() => { watermarkApi.kitLogos().then(setKit).catch(() => setKit([])); }, []);
  const upload = async (file) => {
    if (!file) return;
    setBusy(true);
    try {
      const body = await actions.run(() => uploadLogo(project.id, file, { saveToKit }));
      if (body?.id) {
        onPicked(body.id);
        if (body.asset) { say?.('Logo added — it is in the Brand Kit for your other projects too.'); watermarkApi.kitLogos().then(setKit).catch(() => {}); }
      }
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };
  const fromKit = async (asset) => {
    const body = await actions.run(() => watermarkApi.fromKit(project.id, asset.id));
    if (body?.id) onPicked(body.id);
  };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <input ref={input} type="file" accept={LOGO_ACCEPT} className="hidden" onChange={(e) => upload(e.target.files?.[0])} aria-label="Upload a logo" />
        <Button size="sm" disabled={locked || busy} onClick={() => input.current?.click()}>{busy ? 'Uploading…' : '⬆ Upload a logo'}</Button>
        <label className="flex items-center gap-1.5 text-xs text-muted">
          <input type="checkbox" checked={saveToKit} onChange={(e) => setSaveToKit(e.target.checked)} /> Save in the Brand Kit
        </label>
      </div>
      <p className="text-[11px] text-faint">PNG with a transparent background works best; JPG, WebP and SVG too. At most {MAX_LOGO_MB} MB.</p>
      {kit?.length > 0 && (
        <div>
          <p className="mb-1 text-[11px] font-semibold text-muted">From the Brand Kit</p>
          <div className="grid grid-cols-4 gap-1.5">
            {kit.map((a) => (
              <button key={a.id} type="button" disabled={locked} onClick={() => fromKit(a)} title={a.name}
                className={`flex aspect-square items-center justify-center overflow-hidden rounded-lg border bg-[repeating-conic-gradient(#8884_0_25%,transparent_0_50%)] bg-[length:10px_10px] p-1 ${project.media?.[current]?.library === a.id ? 'border-accent ring-2 ring-accent/30' : 'border-line hover:border-line-strong'}`}>
                <img src={a.thumb_url || a.url} alt={a.name} className="max-h-full max-w-full object-contain" />
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// The selected watermark's settings. `change(patch, now)` shows a change at once and saves it a
// moment later (now: at once).
function WatermarkSettings({ w, project, tracks, tools, actions, change, locked, say, playback }) {
  const media = project.media || {};
  const m = media[w.media];
  const { width: W, height: H } = canvasSize(project);
  const rendered = renderWatermark(w, W, H, media);
  const band = subtitleBand(project.settings.subtitle_style, W, H);
  const hasSubtitles = tracks && trackOf(tracks, 'voice').clips.some((s) => (s.subtitle_text ?? s.khmer_text)?.trim());
  const covers = hasSubtitles && rendered && overlapsBand(w, W, H, rendered.size, band);
  const set = (patch, now = false) => {
    const full = { ...patch };
    for (const k of ['effects', 'animation', 'tile']) if (patch[k]) full[k] = { ...w[k], ...patch[k] };
    change(w, full, now);
  };
  const [tolerance, setTolerance] = useState(m?.nobg_tolerance || 40);
  const [removing, setRemoving] = useState(false);
  const removeBackground = async () => {
    setRemoving(true);
    const body = await actions.run(() => watermarkApi.removeBackground(project.id, w.media, tolerance));
    setRemoving(false);
    if (body) { set({ remove_bg: true }, true); say?.(`Background removed (${Math.round(body.removed * 100)}% of the picture was ${body.color}).`); }
  };
  const full = tools.full;
  return (
    <div className="space-y-3">
      {(w.kind === 'image' || w.kind === 'tiled') && (
        <Section title="Logo">
          <LogoPicker project={project} actions={actions} current={w.media} onPicked={(mid) => set({ media: mid, remove_bg: false }, true)} locked={locked} say={say} />
          {m && !m.transparent && (
            <div className="space-y-2 rounded-lg bg-raised p-2.5">
              <p className="text-xs text-muted">This logo has a solid background{m.nobg ? '' : ' — remove it to see only the logo'}.</p>
              <NumberControl label="How close to the background colour" value={tolerance} min={5} max={150} step={1} unit="" onChange={setTolerance}
                hint="Higher removes more (also colours close to the background)." />
              <div className="flex flex-wrap gap-1.5">
                <Button size="sm" variant="soft" disabled={locked || removing} onClick={removeBackground}>{removing ? 'Removing…' : m.nobg ? '↻ Remove again' : '✂ Remove background'}</Button>
                {m.nobg && <Toggle checked={!!w.remove_bg} disabled={locked} onChange={(v) => set({ remove_bg: v }, true)}>Use it without its background</Toggle>}
              </div>
            </div>
          )}
        </Section>
      )}
      {w.kind === 'text' && (
        <Section title="Text">
          <input lang="km" value={w.text} disabled={locked} onChange={(e) => set({ text: e.target.value })} placeholder="facebook.com/mypage · ឈ្មោះហាង" aria-label="The watermark's text"
            className={`${inputCss} khmer w-full`} />
          <select value={w.font} disabled={locked} onChange={(e) => set({ font: e.target.value }, true)} className={`${inputCss} w-full text-sm`} style={{ fontFamily: `"${w.font}"` }} aria-label="Font">
            {WATERMARK_FONTS.map((f) => <option key={f} value={f} style={{ fontFamily: `"${f}"` }}>{f}</option>)}
          </select>
          <NumberControl label="Text size" value={w.size} min={1} max={30} step={0.5} unit="%" onChange={(v) => set({ size: v })} disabled={locked} hint="% of the picture's shorter side" />
          <div className="flex items-center gap-2 text-xs">
            <span className="text-muted">Colour</span>
            <input type="color" value={w.color} disabled={locked} onChange={(e) => set({ color: e.target.value })} className="h-7 w-10 cursor-pointer rounded border border-line-strong bg-panel" aria-label="Text colour" />
            <Toggle checked={!!w.bold} disabled={locked} onChange={(v) => set({ bold: v }, true)}>Bold</Toggle>
          </div>
        </Section>
      )}

      {w.kind !== 'tiled' && (
        <Section title="Position">
          <div className="grid w-36 grid-cols-3 gap-1" role="group" aria-label="Position">
            {ANCHORS.map(([a, arrow, name]) => (
              <button key={a} type="button" disabled={locked} title={name} aria-label={name} aria-pressed={w.anchor === a} onClick={() => set({ anchor: a }, true)}
                className={`flex h-9 items-center justify-center rounded-md border text-sm ${w.anchor === a ? 'border-accent bg-accent text-white' : 'border-line-strong bg-panel text-muted hover:bg-raised hover:text-ink'}`}>
                {arrow}
              </button>
            ))}
          </div>
          {w.anchor === 'free' && <p className="text-xs text-muted">Placed by hand at {w.x}% across, {w.y}% down. Pick a position above to snap it back.</p>}
          <p className="text-[11px] text-faint">Or drag it on the preview (pause first): it snaps to the edges and the middle.</p>
          <NumberControl label="Margin from the edge" value={w.margin} min={0} max={40} onChange={(v) => set({ margin: v })} disabled={locked || w.anchor === 'free'}
            hint="% of the picture's shorter side, so it stays in the same place at any size." />
          <Toggle checked={!!w.safe_area} disabled={locked} onChange={(v) => set({ safe_area: v }, true)}
            hint={isPortrait(W, H) ? 'This video is 9:16: the dashed box on the preview is where the apps leave the picture clear.' : 'Used when the video is 9:16 (exported for TikTok, Reels or Shorts).'}>
            Keep inside the TikTok / Reels / Shorts safe area
          </Toggle>
          {covers && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg bg-amber-500/10 px-2.5 py-2 text-xs text-amber-900 dark:text-amber-200">
              <span className="flex-1">⚠ The watermark covers the Khmer subtitles.</span>
              <Button size="sm" variant="secondary" disabled={locked} onClick={() => set({ anchor: awayFrom(w.anchor, project.settings.subtitle_style?.position) }, true)}>Move it away</Button>
            </div>
          )}
        </Section>
      )}

      <Section title={w.kind === 'tiled' ? 'Logos' : 'Size and look'}>
        {w.kind !== 'text' && (
          <>
            <NumberControl label={w.kind === 'tiled' ? 'Each logo' : 'Size'} value={w.width} min={1} max={100} onChange={(v) => set({ width: v })} disabled={locked} hint="% of the picture's width" />
            {w.kind === 'image' && (
              <div className="space-y-2">
                <Toggle checked={w.height === null || w.height === undefined} disabled={locked}
                  onChange={(lock) => set({ height: lock ? null : Math.max(1, Math.round(rendered ? (rendered.size.height / H) * 100 : w.width)) }, true)}>
                  🔒 Keep the logo's shape
                </Toggle>
                {w.height !== null && w.height !== undefined && (
                  <NumberControl label="Height" value={w.height} min={1} max={100} onChange={(v) => set({ height: v })} disabled={locked} hint="% of the picture's height" />
                )}
              </div>
            )}
          </>
        )}
        {w.kind === 'tiled' && (
          <>
            <NumberControl label="Space between them" value={w.tile.spacing} min={5} max={200} onChange={(v) => set({ tile: { spacing: v } })} disabled={locked} hint="% of the picture's width" />
            <NumberControl label="Angle" value={w.tile.angle} min={-90} max={90} unit="°" onChange={(v) => set({ tile: { angle: v } })} disabled={locked} />
          </>
        )}
        <NumberControl label="Opacity" value={w.opacity} min={0} max={100} onChange={(v) => set({ opacity: v })} disabled={locked}
          hint={w.kind === 'tiled' ? 'Faint (10–20%) protects the video without hiding it.' : '70–80% looks like a watermark.'} />
        <NumberControl label="Rotation" value={w.rotation} min={-180} max={180} unit="°" onChange={(v) => set({ rotation: v })} disabled={locked} />
      </Section>

      <Section title="Effects">
        <div className="grid grid-cols-2 gap-1.5">
          <Toggle checked={!!w.effects.shadow} disabled={locked} onChange={(v) => set({ effects: { shadow: v } }, true)}>Drop shadow</Toggle>
          <Toggle checked={!!w.effects.glow} disabled={locked} onChange={(v) => set({ effects: { glow: v } }, true)}>Glow</Toggle>
          <Toggle checked={!!w.effects.outline} disabled={locked} onChange={(v) => set({ effects: { outline: v } }, true)}>Outline</Toggle>
          <Toggle checked={!!w.effects.soft} disabled={locked} onChange={(v) => set({ effects: { soft: v } }, true)}>Soft (lighter)</Toggle>
        </div>
        {w.kind !== 'text' && (
          <>
            <div className="flex gap-1" role="group" aria-label="Logo colour">
              {[['original', 'Its colours'], ['white', 'All white'], ['black', 'All black']].map(([k, name]) => (
                <button key={k} type="button" disabled={locked} onClick={() => set({ effects: { color: k } }, true)} aria-pressed={w.effects.color === k}
                  className={`flex-1 rounded-md border px-2 py-1 text-xs ${w.effects.color === k ? 'border-accent bg-accent-soft text-accent-ink' : 'border-line-strong hover:bg-raised'}`}>{name}</button>
              ))}
            </div>
            <NumberControl label="Rounded corners" value={w.effects.radius} min={0} max={50} onChange={(v) => set({ effects: { radius: v } })} disabled={locked}
              hint="For square logos: 50% makes a circle." />
          </>
        )}
      </Section>

      <Section title="Animation">
        <select value={w.animation.type} disabled={locked} onChange={(e) => set({ animation: { type: e.target.value } }, true)} className={`${inputCss} w-full text-sm`} aria-label="Animation">
          {ANIMATIONS.filter(([k]) => w.kind !== 'tiled' || k === 'none' || k === 'fade').map(([k, name]) => <option key={k} value={k}>{name}</option>)}
        </select>
        {w.animation.type === 'fade' && <SecondsControl label="Fade" value={w.animation.fade} min={0.1} max={5} disabled={locked} onChange={(v) => set({ animation: { fade: v } })} />}
        {w.animation.type === 'pulse' && <SecondsControl label="One pulse" value={w.animation.period} min={1} max={20} disabled={locked} onChange={(v) => set({ animation: { period: v } })} />}
        {w.animation.type === 'corners' && (
          <NumberControl label="Move to the next corner every" value={w.animation.every} min={2} max={600} step={1} unit="s" onChange={(v) => set({ animation: { every: v } })} disabled={locked}
            hint="It moves round the four corners, so it's harder to crop out." />
        )}
      </Section>

      <Section title="When">
        <p className="text-xs text-muted">{w.whole ? 'The whole video (it follows every cut).' : `${formatTime(w.start)}–${formatTime(w.end)} · ${(w.end - w.start).toFixed(1)}s`}</p>
        <div className="flex flex-wrap gap-1.5">
          {!w.whole && <Button size="sm" variant="secondary" disabled={locked} onClick={() => tools.watermarkTimes(w, null)}>The whole video</Button>}
          <Button size="sm" variant="secondary" disabled={locked || !full} onClick={() => tools.watermarkTimes(w, full)} title={full ? '' : 'Set In (I) and Out (O) on the timeline first'}>
            Only the In/Out part{full ? ` (${formatTime(full.start)}–${formatTime(full.end)})` : ''}
          </Button>
        </div>
        <p className="text-[11px] text-faint">On the Watermark track you can also drag its edges, split it (S), move it or delete it.</p>
        <div className="space-y-1">
          <p className="text-xs font-semibold text-ink">Hide it during</p>
          <div className="flex flex-wrap gap-3">
            {HIDE_NAMES.map(([k, name]) => (
              <Toggle key={k} checked={w.hide_during.includes(k)} disabled={locked}
                onChange={(on) => set({ hide_during: on ? [...w.hide_during, k] : w.hide_during.filter((x) => x !== k) }, true)}>{name}</Toggle>
            ))}
          </div>
          <p className="text-[11px] text-faint">Intro and outro: added clips before or after your video; ads: clips from the Ad Library.</p>
        </div>
      </Section>

      <Section>
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" variant="secondary" disabled={locked} onClick={() => playback.seek(Math.max(w.start, Math.min(w.end - 0.05, playback.t)))}>Show it on the preview</Button>
          <Button size="sm" variant="danger" disabled={locked} onClick={() => tools.removeIds([w.id])}>Delete this watermark</Button>
        </div>
      </Section>
    </div>
  );
}

// The Watermark tab: every watermark of the project, adding one, and the selected one's settings.
export default function WatermarkPanel({ project, tracks, tools, actions, change, selection, onSelect, locked, say, playback, presets }) {
  const track = trackOf(tracks, 'watermark');
  const list = track?.clips || [];
  const picked = list.find((w) => selection.includes(w.id));
  const [current, setCurrent] = useState(null);
  const w = picked || list.find((x) => x.id === current) || list[0] || null;
  useEffect(() => { if (picked) setCurrent(picked.id); }, [picked]);
  const media = project.media || {};
  const add = async (fields) => {
    const body = await actions.edit({ op: 'add_watermark', fields }, fields.kind === 'image' ? 'Watermark added — drag it on the preview, or pick a position.' : 'Watermark added.');
    if (body?.id) { setCurrent(body.id); onSelect([body.id]); }
  };
  const [adding, setAdding] = useState(null); // 'image' | 'tiled': choosing its logo first
  const firstLogo = useMemo(() => Object.entries(media).find(([, m]) => m.role === 'watermark' && !m.removed)?.[0], [media]);
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <p className="text-sm font-semibold text-ink">Watermark <span className="khmer font-normal text-faint">· ស្លាកសញ្ញា</span></p>
          {track?.hidden && <Chip tone="red">hidden</Chip>}
        </div>
        {list.map((x) => <WatermarkRow key={x.id} w={x} media={media} active={x.id === w?.id} onPick={() => { setCurrent(x.id); onSelect([x.id]); }} />)}
        {!list.length && <p className="text-xs text-muted">Put your logo on the video: it shows in the preview as it will in the export, at the same place at every size.</p>}
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" disabled={locked || track?.locked} onClick={() => (firstLogo ? add({ kind: 'image', media: firstLogo }) : setAdding('image'))}>+ Logo</Button>
          <Button size="sm" variant="secondary" disabled={locked || track?.locked} onClick={() => add({ kind: 'text', text: '' })}>+ Text</Button>
          <Button size="sm" variant="secondary" disabled={locked || track?.locked} onClick={() => (firstLogo ? add({ kind: 'tiled', media: firstLogo }) : setAdding('tiled'))}>+ Tiled logo</Button>
          {firstLogo && <Button size="sm" variant="ghost" disabled={locked || track?.locked} onClick={() => setAdding('image')}>+ Another logo…</Button>}
        </div>
        {adding && (
          <div className="space-y-2 rounded-xl border border-accent/40 bg-accent-soft/40 p-3">
            <p className="text-xs font-semibold text-ink">Choose the logo</p>
            <LogoPicker project={project} actions={actions} locked={locked} say={say} onPicked={(mid) => { const kind = adding; setAdding(null); add({ kind, media: mid }); }} />
            <button type="button" className="text-xs text-muted underline" onClick={() => setAdding(null)}>Cancel</button>
          </div>
        )}
        {track?.locked && <p className="text-xs text-amber-700 dark:text-amber-300">🔒 The Watermark track is locked (unlock it on the timeline to change it).</p>}
      </div>
      {presets}
      {w && <WatermarkSettings key={w.id} w={w} project={project} tracks={tracks} tools={tools} actions={actions} change={change} locked={locked || track?.locked} say={say} playback={playback} />}
    </div>
  );
}

export { WatermarkSettings };
