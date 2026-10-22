import { useEffect, useRef, useState } from 'react';
import { Button, Card, Chip, ErrorBox, Notice, inputCss, textareaCss } from '../components/ui.jsx';
import { MOOD_LOOK, STYLE_LOOK, advertsApi } from './advertsApi.js';
import { formatSeconds, uploadAsset } from './libraryApi.js';
import { PresetSelect } from '../components/editor/WatermarkPresets.jsx';

// Steps 1–4 of the ad wizard, and the last one (build). Each gets the draft and change(fields).
const CONTACT = [
  ['phone', 'Phone', '012 345 678'],
  ['facebook', 'Facebook page', 'facebook.com/yourshop'],
  ['telegram', 'Telegram', '@yourshop'],
  ['address', 'Address', 'ផ្លូវ ២៧១ ភ្នំពេញ'],
  ['website', 'Website', 'yourshop.com'],
];
const CTA_IDEAS = ['កុម្ម៉ង់ឥឡូវនេះ', 'ទូរស័ព្ទឥឡូវនេះ', 'ទិញឥឡូវនេះ', 'ផ្ញើសារមកយើង', 'កក់ទុកឥឡូវនេះ', 'មកលេងហាងយើង'];

function Field({ label, note, children }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 flex items-baseline gap-2 font-medium">{label}{note && <span className="text-xs font-normal text-faint">{note}</span>}</span>
      {children}
    </label>
  );
}

// ---------- 1. product ----------

export function ProductStep({ draft, lib, change, run }) {
  const b = draft.brief;
  const set = (fields) => change({ brief: fields });
  const brand = lib.brands.find((x) => x.id === draft.brand);
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
      <Card className="space-y-4">
        <h2 className="text-lg font-semibold">What are you selling?</h2>
        <Field label="Product or business name" note="required">
          <input value={b.product} onChange={(e) => set({ product: e.target.value })} maxLength={120} autoFocus
            placeholder="កាហ្វេទឹកដោះគោទឹកកក" className={`${inputCss} khmer w-full text-base`} />
        </Field>
        <Field label="About it" note="what it is, what makes it good, who it's for">
          <textarea value={b.description} onChange={(e) => set({ description: e.target.value })} rows={4} maxLength={1500}
            placeholder="កាហ្វេខ្មែរពីមណ្ឌលគិរី ឆុងស្រស់ៗរាល់ព្រឹក…" className={textareaCss} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Price"><input value={b.price} onChange={(e) => set({ price: e.target.value })} maxLength={60} placeholder="$2.50" className={`${inputCss} khmer w-full`} /></Field>
          <Field label="Promotion or discount"><input value={b.promo} onChange={(e) => set({ promo: e.target.value })} maxLength={200} placeholder="ទិញ ២ ថែម ១ ដល់ចុងខែ" className={`${inputCss} khmer w-full`} /></Field>
        </div>
        <Field label="Call to action" note="what viewers should do">
          <input value={b.cta} onChange={(e) => set({ cta: e.target.value })} maxLength={60} list="wizard-cta" className={`${inputCss} khmer w-full`} />
          <datalist id="wizard-cta">{CTA_IDEAS.map((c) => <option key={c} value={c} />)}</datalist>
        </Field>
        <div className="space-y-2">
          <h3 className="text-sm font-semibold">Contact</h3>
          <div className="grid gap-2 sm:grid-cols-2">
            {CONTACT.map(([key, label, example]) => (
              <Field key={key} label={<span className="font-normal text-muted">{label}</span>}>
                <input value={b.contact[key] || ''} onChange={(e) => set({ contact: { [key]: e.target.value } })} maxLength={200} placeholder={example} className={`${inputCss} khmer w-full`} />
              </Field>
            ))}
          </div>
        </div>
        <p className="text-xs text-muted">The AI uses only these facts: it won't invent prices, discounts or phone numbers.</p>
      </Card>
      <Card className="space-y-3 self-start">
        <h3 className="font-semibold">Brand kit</h3>
        {lib.brands.length ? (
          <>
            <select value={draft.brand || ''} onChange={(e) => change({ brand: e.target.value || null }, { now: true })} className={`${inputCss} w-full`}>
              <option value="">No brand kit</option>
              {lib.brands.map((x) => <option key={x.id} value={x.id}>{x.name}{x.default ? ' (default)' : ''}</option>)}
            </select>
            {brand && (
              <>
                <div className="flex gap-1">{['primary', 'secondary', 'accent', 'background'].map((r) => <span key={r} className="h-5 flex-1 rounded" style={{ background: brand.colors[r] }} />)}</div>
                <p className="text-xs text-muted">Its colours, fonts and logo style the ad. Contact details and the call to action were filled in from it.</p>
                <Button variant="secondary" size="sm" onClick={() => run(() => advertsApi.applyBrand(draft.id))}>Fill in from the brand kit again</Button>
              </>
            )}
          </>
        ) : (
          <p className="text-sm text-muted">Save your logo, colours and contact details once in a <a href="#/library/brands" className="text-accent-ink hover:underline">brand kit</a>, and every new ad starts with them.</p>
        )}
      </Card>
    </div>
  );
}

// ---------- 2. pictures ----------

function Thumb({ asset, className = '' }) {
  if (!asset) return <span className={`flex items-center justify-center bg-raised text-xs text-faint ${className}`}>gone</span>;
  return (
    <span className={`relative block overflow-hidden bg-raised ${className}`}>
      {asset.thumb_url ? <img src={asset.thumb_url} alt="" className="h-full w-full object-cover" loading="lazy" /> : null}
      {asset.media === 'video' && <span className="absolute bottom-1 right-1 rounded bg-black/65 px-1 text-[10px] font-semibold text-white">▶ {formatSeconds(asset.duration)}</span>}
    </span>
  );
}

export function MediaStep({ draft, lib, setLib, change }) {
  const [uploading, setUploading] = useState(null);
  const [error, setError] = useState(null);
  const input = useRef(null);
  const logoInput = useRef(null);
  const byId = Object.fromEntries(lib.assets.map((a) => [a.id, a]));
  const pickable = lib.assets.filter((a) => (a.media === 'image' || a.media === 'video') && a.kind !== 'logo');
  const logos = lib.assets.filter((a) => a.media === 'image').sort((a, b) => (a.kind === 'logo' ? 0 : 1) - (b.kind === 'logo' ? 0 : 1));
  const chosen = draft.media;

  const setMedia = (ids) => change({ media: ids }, { now: true });
  const toggle = (aid) => setMedia(chosen.includes(aid) ? chosen.filter((x) => x !== aid) : [...chosen, aid]);
  const move = (i, by) => {
    const ids = [...chosen];
    [ids[i], ids[i + by]] = [ids[i + by], ids[i]];
    setMedia(ids);
  };

  async function upload(files, kind) {
    setError(null);
    const added = [];
    for (const file of files) {
      setUploading(`${file.name} 0%`);
      try {
        const body = await uploadAsset(file, kind, (p) => setUploading(`${file.name} ${Math.round(p * 100)}%`));
        setLib(body.library);
        added.push(body.asset.id);
      } catch (err) {
        setError(err);
      }
    }
    setUploading(null);
    if (kind === 'logo' && added.length) change({ logo: added[0] }, { now: true });
    else if (added.length) setMedia([...chosen, ...added]);
  }

  return (
    <div className="space-y-4">
      <Card className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold">Pictures and clips in this ad</h2>
          <Chip tone={chosen.length ? 'accent' : 'slate'}>{chosen.length} chosen</Chip>
          <Button className="ml-auto" size="sm" disabled={Boolean(uploading)} onClick={() => input.current?.click()}>+ Upload photos or clips</Button>
          <input ref={input} type="file" multiple accept=".png,.jpg,.jpeg,.webp,.mp4,.mov,.mkv,.webm" className="hidden"
            onChange={(e) => { upload([...e.target.files], 'product'); e.target.value = ''; }} />
        </div>
        {uploading && <p className="text-sm text-accent-ink">Uploading {uploading}…</p>}
        {error && <ErrorBox error={error} compact />}
        {chosen.length ? (
          <ol className="flex gap-2 overflow-x-auto pb-1">
            {chosen.map((aid, i) => (
              <li key={aid} className="w-28 shrink-0 overflow-hidden rounded-lg border border-line bg-panel">
                <span className="relative block">
                  <Thumb asset={byId[aid]} className="h-28 w-28" />
                  <span className="absolute left-1 top-1 flex h-5 w-5 items-center justify-center rounded bg-accent text-[11px] font-bold text-white">{i + 1}</span>
                </span>
                <span className="flex items-center justify-between px-1 py-0.5">
                  <button type="button" disabled={i === 0} onClick={() => move(i, -1)} className="px-1 text-muted hover:text-ink disabled:opacity-30" aria-label="Move earlier">←</button>
                  <button type="button" onClick={() => toggle(aid)} className="px-1 text-xs text-muted hover:text-red-600" aria-label="Remove from this ad">✕</button>
                  <button type="button" disabled={i === chosen.length - 1} onClick={() => move(i, 1)} className="px-1 text-muted hover:text-ink disabled:opacity-30" aria-label="Move later">→</button>
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <Notice tone="sky">Add 3 to 8 photos or short clips of the product. Without any, the ad uses your brand colours and logo.</Notice>
        )}
        {pickable.length > 0 && (
          <>
            <p className="pt-2 text-sm font-medium">From your Ad Library <span className="font-normal text-muted">(click to add or remove)</span></p>
            <ul className="grid grid-cols-3 gap-2 sm:grid-cols-5 lg:grid-cols-8">
              {pickable.map((a) => {
                const n = chosen.indexOf(a.id);
                return (
                  <li key={a.id}>
                    <button type="button" onClick={() => toggle(a.id)} title={a.name} aria-pressed={n >= 0}
                      className={`relative block w-full overflow-hidden rounded-lg border-2 ${n >= 0 ? 'border-accent' : 'border-transparent hover:border-line-strong'}`}>
                      <Thumb asset={a} className="aspect-square w-full" />
                      {n >= 0 && <span className="absolute left-1 top-1 flex h-5 w-5 items-center justify-center rounded bg-accent text-[11px] font-bold text-white">{n + 1}</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </Card>

      <Card className="space-y-3">
        <h2 className="font-semibold">Logo</h2>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => change({ logo: null }, { now: true })} aria-pressed={!draft.logo}
            className={`flex h-16 w-16 items-center justify-center rounded-lg border text-xs text-muted ${!draft.logo ? 'border-accent ring-2 ring-accent/30' : 'border-line'}`}>None</button>
          {logos.map((a) => (
            <button key={a.id} type="button" onClick={() => change({ logo: a.id }, { now: true })} title={a.name} aria-pressed={draft.logo === a.id}
              className={`h-16 w-16 overflow-hidden rounded-lg border bg-raised p-1 ${draft.logo === a.id ? 'border-accent ring-2 ring-accent/30' : 'border-line'}`}>
              <img src={a.thumb_url || a.url} alt={a.name} className="h-full w-full object-contain" />
            </button>
          ))}
          <button type="button" onClick={() => logoInput.current?.click()} disabled={Boolean(uploading)}
            className="flex h-16 w-16 items-center justify-center rounded-lg border border-dashed border-line-strong text-xs text-muted hover:bg-raised">+ Upload</button>
          <input ref={logoInput} type="file" accept=".png,.jpg,.jpeg,.webp" className="hidden" onChange={(e) => { upload([...e.target.files].slice(0, 1), 'logo'); e.target.value = ''; }} />
        </div>
        <p className="text-xs text-muted">Shown in a corner during the ad and big on the end screen. A PNG with a transparent background looks best.</p>
      </Card>

      <Card className="space-y-2">
        <h2 className="font-semibold">Watermark</h2>
        <PresetSelect label="Preset" withDefault={false} value={draft.watermark || 'none'} onChange={(v) => change({ watermark: v === 'none' ? null : v }, { now: true })} />
        <p className="text-xs text-muted">A saved watermark (logo, place, size, opacity) put on the finished ad. Make presets in the editor’s Watermark tab.</p>
      </Card>
    </div>
  );
}

// ---------- 3. style ----------

// A rough sketch of a template in the brand's colours (the real look is drawn when the video is built).
const PRICE_SHAPE = { price_tag: 'rounded-md -rotate-6', burst: 'rounded-full', ribbon: 'rounded-none w-full', pill: 'rounded-full', bold_box: 'rounded', highlight: 'rounded-sm', outline: 'rounded', headline: 'rounded', button: 'rounded-xl' };

function TemplateSketch({ t, colors, fonts }) {
  const f = t.fonts || fonts;
  const price = t.captions.price || t.captions.default;
  const bg = t.end_screen.background === 'brand' ? colors.primary : `linear-gradient(160deg, ${colors.background}, ${colors.primary})`;
  return (
    <span className="relative mx-auto flex aspect-[9/16] w-20 flex-col items-center justify-between overflow-hidden rounded-lg p-1.5 text-center shadow" style={{ background: bg, color: colors.text }}>
      <span className="khmer w-full truncate text-[10px] leading-tight" style={{ fontFamily: `"${f.title}"` }}>ឆ្ងាញ់ណាស់</span>
      <span className={`px-1.5 text-[10px] font-bold ${PRICE_SHAPE[price.preset] || 'rounded'}`} style={{ background: price.preset === 'burst' ? colors.accent : colors.secondary, color: colors.background }}>$2.50</span>
      <span className="khmer rounded px-1.5 text-[8px] font-bold" style={{ background: colors.accent, color: colors.background, fontFamily: `"${f.body}"` }}>កុម្ម៉ង់</span>
    </span>
  );
}

export function StyleStep({ draft, options, lib, change }) {
  const brand = lib.brands.find((b) => b.id === draft.brand) || lib.new_brand;
  const templates = [...options.templates].sort((a, b) => (b.style === draft.style) - (a.style === draft.style));
  return (
    <Card className="space-y-4">
      <h2 className="text-lg font-semibold">What kind of ad?</h2>
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {options.styles.map((s) => (
          <li key={s.key}>
            <button type="button" onClick={() => change({ style: s.key }, { now: true })} aria-pressed={draft.style === s.key}
              className={`flex h-full w-full flex-col items-start gap-1 rounded-xl border p-4 text-left transition ${draft.style === s.key ? 'border-accent bg-accent-soft ring-2 ring-accent/25' : 'border-line hover:bg-raised'}`}>
              <span className="text-3xl" aria-hidden="true">{STYLE_LOOK[s.key]?.icon}</span>
              <span className="font-semibold">{s.label}</span>
              <span className="khmer text-sm text-muted">{STYLE_LOOK[s.key]?.km}</span>
              <span className="text-xs text-muted">{s.about[0].toUpperCase() + s.about.slice(1)}.</span>
            </button>
          </li>
        ))}
      </ul>
      <h2 className="pt-2 text-lg font-semibold">Look</h2>
      <p className="-mt-2 text-sm text-muted">Fonts, captions, how the shots move and change, and the end screen, in your brand colours. It follows the kind of ad unless you pick one.</p>
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {templates.map((t) => (
          <li key={t.id}>
            <button type="button" onClick={() => change({ template: t.id }, { now: true })} aria-pressed={draft.template === t.id} title={t.about}
              className={`flex h-full w-full flex-col gap-1.5 rounded-xl border p-2.5 text-left transition ${draft.template === t.id ? 'border-accent bg-accent-soft ring-2 ring-accent/25' : 'border-line hover:bg-raised'}`}>
              <TemplateSketch t={t} colors={brand.colors} fonts={brand.fonts} />
              <span className="text-sm font-semibold leading-tight">{t.name}</span>
              <span className="khmer text-xs leading-snug text-muted">{t.km}{!t.builtin && ' · yours'}</span>
            </button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

// ---------- 4. format and sound ----------

const SHAPE = { '9:16': 'aspect-[9/16] h-24', '1:1': 'aspect-square h-20', '16:9': 'aspect-video h-14' };

function Choice({ active, onClick, children, className = '' }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={active}
      className={`rounded-xl border p-3 text-left transition ${active ? 'border-accent bg-accent-soft ring-2 ring-accent/25' : 'border-line hover:bg-raised'} ${className}`}>
      {children}
    </button>
  );
}

// Plays one built-in piece at a time (the first of each mood); stops when the step is left.
function useListen() {
  const [playing, setPlaying] = useState(null);
  const audio = useRef(null);
  useEffect(() => () => audio.current?.pause(), []);
  const toggle = (mood) => {
    audio.current?.pause();
    if (playing === mood) { setPlaying(null); return; }
    audio.current = new Audio(`/api/library/music/${mood}_1.m4a`);
    audio.current.volume = 0.6;
    audio.current.onended = () => setPlaying(null);
    audio.current.play().then(() => setPlaying(mood)).catch(() => setPlaying(null));
  };
  return [playing, toggle];
}

export function FormatStep({ draft, options, lib, change }) {
  const music = lib.assets.filter((a) => a.media === 'audio');
  const [playing, listen] = useListen();
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card className="space-y-4">
        <h2 className="text-lg font-semibold">Shape</h2>
        <div className="grid grid-cols-3 gap-2">
          {options.formats.map((f) => (
            <Choice key={f.key} active={draft.format === f.key} onClick={() => change({ format: f.key }, { now: true })} className="flex flex-col items-center gap-2 text-center">
              <span className="flex h-24 items-center"><span className={`block rounded-md border-2 border-current opacity-60 ${SHAPE[f.key]}`} /></span>
              <span className="text-sm font-semibold">{f.key} {f.label}</span>
              <span className="text-xs text-muted">{f.where}</span>
            </Choice>
          ))}
        </div>
        <p className="text-xs text-muted">You can export the other two shapes too, later, with the layout adjusted for each.</p>
        <h2 className="pt-2 text-lg font-semibold">Length</h2>
        <div className="grid grid-cols-3 gap-2">
          {options.lengths.map((l) => (
            <Choice key={l.seconds} active={draft.length === l.seconds} onClick={() => change({ length: l.seconds }, { now: true })} className="text-center">
              <span className="block text-lg font-bold">{l.seconds} s</span>
              <span className="text-xs text-muted">{l.scenes[0]}–{l.scenes[1]} shots</span>
            </Choice>
          ))}
        </div>
        {draft.scripts_length && draft.scripts_length !== draft.length && (
          <Notice>The scripts were written for {draft.scripts_length} seconds. Write them again in the Script step to fit {draft.length}.</Notice>
        )}
        <h2 className="pt-2 text-lg font-semibold">Quality</h2>
        <div className="flex gap-2">
          {options.resolutions.map((r) => (
            <Choice key={r} active={draft.resolution === r} onClick={() => change({ resolution: r }, { now: true })} className="flex-1 text-center">
              <span className="font-semibold">{r}</span> <span className="text-xs text-muted">{r === '1080p' ? 'sharpest' : 'smaller file'}</span>
            </Choice>
          ))}
        </div>
      </Card>
      <Card className="space-y-4">
        <h2 className="text-lg font-semibold">Voice</h2>
        <div className="grid grid-cols-2 gap-2">
          {[['female', 'Female', 'ស្រី'], ['male', 'Male', 'ប្រុស']].map(([key, label, km]) => (
            <Choice key={key} active={draft.voice === key} onClick={() => change({ voice: key }, { now: true })}>
              <span className="font-semibold">{label}</span> <span className="khmer text-muted">· {km}</span>
            </Choice>
          ))}
        </div>
        <h2 className="pt-2 text-lg font-semibold">Music</h2>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {options.moods.map((m) => {
            const [label, km, icon] = MOOD_LOOK[m];
            return (
              <div key={m} className="flex flex-col gap-1">
                <Choice active={draft.music.mood === m && !draft.music.asset} onClick={() => change({ music: { mood: m, asset: null } }, { now: true })} className="text-center">
                  <span className="block text-2xl" aria-hidden="true">{icon}</span>
                  <span className="block text-sm font-semibold">{label}</span>
                  <span className="khmer text-xs text-muted">{km}</span>
                </Choice>
                <button type="button" onClick={() => listen(m)} className="rounded-lg py-1 text-xs font-medium text-muted hover:bg-raised hover:text-ink">
                  {playing === m ? '■ Stop' : '▶ Listen'}
                </button>
              </div>
            );
          })}
        </div>
        <label className="block text-sm">
          <span className="mb-1 block text-muted">Or your own music from the Ad Library</span>
          <select value={draft.music.asset || ''} onChange={(e) => change({ music: { asset: e.target.value || null } }, { now: true })} className={`${inputCss} w-full`}>
            <option value="">Built-in music ({MOOD_LOOK[draft.music.mood][0]})</option>
            {music.map((a) => <option key={a.id} value={a.id}>{a.name} · {formatSeconds(a.duration)}</option>)}
          </select>
        </label>
        <p className="text-xs text-muted">The music gets quieter by itself while the voice speaks. Only music that comes with the app or that you upload is used.</p>
      </Card>
    </div>
  );
}

// ---------- 6. build ----------

export function BuildStep({ draft, lib }) {
  const script = draft.chosen != null ? draft.scripts[draft.chosen] : null;
  const byId = Object.fromEntries(lib.assets.map((a) => [a.id, a]));
  const music = draft.music.asset ? byId[draft.music.asset]?.name : `${MOOD_LOOK[draft.music.mood][0]} (built-in)`;
  return (
    <Card className="space-y-4">
      <h2 className="text-lg font-semibold">Build the video</h2>
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        {[
          ['Script', script ? `${script.label}: ${script.title} · ${script.scenes.length} shots · about ${Math.round(script.seconds)} s of voice` : 'not chosen yet'],
          ['Shape', `${draft.format} · ${draft.resolution} · ${draft.length} seconds`],
          ['Pictures and clips', `${draft.media.length}`],
          ['Voice', draft.voice === 'male' ? 'Male · ប្រុស' : 'Female · ស្រី'],
          ['Music', music || '—'],
          ['Logo', draft.logo ? byId[draft.logo]?.name || '—' : 'none'],
          ['Watermark', draft.watermark ? 'a saved preset' : 'none'],
        ].map(([k, v]) => (
          <div key={k} className="flex gap-2 border-b border-line pb-1.5"><dt className="w-36 shrink-0 text-muted">{k}</dt><dd className="khmer min-w-0">{v}</dd></div>
        ))}
      </dl>
      <Notice tone="sky">
        Building the video (Khmer voice, pictures with motion, captions, music and the end screen, then opening it in the editor) is the next stage. It waits for the new timeline editor to be finished. Your draft is saved; come back to it then.
      </Notice>
      <div className="flex flex-wrap gap-2">
        <Button disabled title="Comes with the next stage">Build the video</Button>
        {script && <a href={advertsApi.scriptUrl(draft.id)} className="inline-flex items-center rounded-xl border border-line-strong px-4 py-2.5 text-sm font-semibold hover:bg-raised">Download the script (.txt)</a>}
      </div>
    </Card>
  );
}
