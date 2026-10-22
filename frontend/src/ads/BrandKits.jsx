import { useEffect, useRef, useState } from 'react';
import { Button, Card, Chip, ErrorBox, Notice, inputCss } from '../components/ui.jsx';
import { PresetLibrary } from '../components/editor/WatermarkPresets.jsx';
import { libraryApi, uploadAsset } from './libraryApi.js';

// Brand kits: a logo, colours, fonts, contact details and the words every new ad starts from.
const COLOR_ROLES = [
  ['primary', 'Main', 'Buttons, price tags'],
  ['secondary', 'Second', 'Gradients, banners'],
  ['accent', 'Highlight', 'Discounts, stickers'],
  ['text', 'Text', 'Words on the colours'],
  ['background', 'Background', 'End screen'],
];
const CONTACT = [
  ['phone', 'Phone', '012 345 678'],
  ['facebook', 'Facebook page', 'facebook.com/yourshop'],
  ['telegram', 'Telegram', '@yourshop'],
  ['address', 'Address', 'ផ្លូវ ២៧១ ភ្នំពេញ'],
  ['website', 'Website', 'yourshop.com'],
];
const CTA_IDEAS = ['កុម្ម៉ង់ឥឡូវនេះ', 'ទូរស័ព្ទឥឡូវនេះ', 'ទិញឥឡូវនេះ', 'ផ្ញើសារមកយើង', 'កក់ទុកឥឡូវនេះ', 'មកលេងហាងយើង'];
const FONT_NOTES = { Moul: 'decorative titles', Koulen: 'bold headlines', 'Kantumruy Pro': 'clean', 'Noto Sans Khmer': 'plain', Battambang: 'classic', Hanuman: 'book' };
const KEYS = ['name', 'logo', 'colors', 'fonts', 'contact', 'cta', 'sponsored_label'];
const pick = (b) => Object.fromEntries(KEYS.map((k) => [k, b[k]]));

export default function BrandKits({ lib, onLib }) {
  const [selected, setSelected] = useState(() => lib.brands.find((b) => b.default)?.id ?? lib.brands[0]?.id ?? null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const brand = lib.brands.find((b) => b.id === selected);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const body = await libraryApi.createBrand({ name: lib.brands.length ? `Brand ${lib.brands.length + 1}` : 'My brand' });
      onLib(body.library);
      setSelected(body.brand.id);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
    <div className="grid gap-4 lg:grid-cols-[16rem_minmax(0,1fr)]">
      <div className="space-y-2">
        {lib.brands.map((b) => {
          const logo = lib.assets.find((a) => a.id === b.logo);
          return (
            <button key={b.id} type="button" onClick={() => setSelected(b.id)} aria-pressed={b.id === selected}
              className={`flex w-full items-center gap-3 rounded-xl border p-2.5 text-left transition ${b.id === selected ? 'border-accent bg-accent-soft' : 'border-line bg-panel hover:bg-raised'}`}>
              <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg" style={{ background: b.colors.background }}>
                {logo?.thumb_url ? <img src={logo.thumb_url} alt="" className="h-full w-full object-contain p-1" /> : <span className="text-xs font-bold" style={{ color: b.colors.text }}>{b.name.slice(0, 2)}</span>}
              </span>
              <span className="min-w-0 flex-1">
                <span className="khmer block truncate text-sm font-semibold">{b.name}</span>
                <span className="mt-0.5 flex gap-1">{['primary', 'secondary', 'accent'].map((r) => <span key={r} className="h-2.5 w-5 rounded-full" style={{ background: b.colors[r] }} />)}</span>
              </span>
              {b.default && <Chip tone="green">Default</Chip>}
            </button>
          );
        })}
        <Button variant="secondary" className="w-full" disabled={busy} onClick={create}>+ New brand kit</Button>
        {error && <ErrorBox error={error} compact />}
      </div>
      {brand ? (
        <BrandEditor key={brand.id} brand={brand} lib={lib} onLib={onLib} onDeleted={() => setSelected(lib.brands.find((b) => b.id !== brand.id)?.id ?? null)} />
      ) : (
        <Card className="text-center">
          <p className="font-semibold">No brand kit yet</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted">Save your logo, colours, fonts and contact details once. Every new ad then starts with them, and the end screen fills itself in.</p>
          <Button className="mt-4" disabled={busy} onClick={create}>Create a brand kit</Button>
        </Card>
      )}
    </div>
    <Card><PresetLibrary /></Card>
    </div>
  );
}

function BrandEditor({ brand, lib, onLib, onDeleted }) {
  const [draft, setDraft] = useState(() => pick(brand));
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [role, setRole] = useState('primary'); // the colour a saved colour is put into
  const logoInput = useRef(null);
  const changed = JSON.stringify(draft) !== JSON.stringify(pick(brand));

  // Another tab may have replaced the library (an asset deleted, say): keep the draft, but drop a logo that's gone.
  useEffect(() => {
    if (draft.logo && !lib.assets.some((a) => a.id === draft.logo)) setDraft((d) => ({ ...d, logo: null }));
  }, [lib.assets, draft.logo]);

  const set = (fields) => { setSaved(false); setDraft((d) => ({ ...d, ...fields })); };
  const setIn = (group, key, value) => set({ [group]: { ...draft[group], [key]: value } });
  const pictures = lib.assets.filter((a) => a.media === 'image').sort((a, b) => (a.kind === 'logo' ? 0 : 1) - (b.kind === 'logo' ? 0 : 1));
  const badHex = COLOR_ROLES.filter(([r]) => !/^#[0-9a-f]{6}$/i.test(draft.colors[r])).map(([, label]) => label);

  async function run(fn, after) {
    setBusy(true);
    setError(null);
    try {
      const body = await fn();
      onLib(body.library || body);
      after?.(body);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const save = () => run(() => libraryApi.patchBrand(brand.id, draft), (body) => { setDraft(pick(body.brand)); setSaved(true); });
  const uploadLogo = (file) => run(() => uploadAsset(file, 'logo'), (body) => set({ logo: body.asset.id }));

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_17rem]">
      <Card className="space-y-5">
        <div className="flex flex-wrap items-center gap-2">
          <input value={draft.name} onChange={(e) => set({ name: e.target.value })} maxLength={60} aria-label="Brand name"
            className={`${inputCss} khmer min-w-0 flex-1 text-base font-semibold`} />
          {brand.default ? <Chip tone="green">Used for new ads</Chip> : (
            <Button variant="soft" size="sm" disabled={busy} onClick={() => run(() => libraryApi.makeDefault(brand.id))}>Use for new ads</Button>
          )}
        </div>

        <section className="space-y-2">
          <h3 className="text-sm font-semibold">Logo</h3>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => set({ logo: null })} aria-pressed={!draft.logo}
              className={`flex h-16 w-16 items-center justify-center rounded-lg border text-xs text-muted ${!draft.logo ? 'border-accent ring-2 ring-accent/30' : 'border-line'}`}>None</button>
            {pictures.map((a) => (
              <button key={a.id} type="button" onClick={() => set({ logo: a.id })} title={a.name} aria-pressed={draft.logo === a.id}
                className={`h-16 w-16 overflow-hidden rounded-lg border bg-raised p-1 ${draft.logo === a.id ? 'border-accent ring-2 ring-accent/30' : 'border-line'}`}>
                <img src={a.thumb_url || a.url} alt={a.name} className="h-full w-full object-contain" />
              </button>
            ))}
            <button type="button" onClick={() => logoInput.current?.click()} disabled={busy}
              className="flex h-16 w-16 items-center justify-center rounded-lg border border-dashed border-line-strong text-xs text-muted hover:bg-raised">+ Upload</button>
            <input ref={logoInput} type="file" accept=".png,.jpg,.jpeg,.webp" className="hidden" onChange={(e) => { if (e.target.files[0]) uploadLogo(e.target.files[0]); e.target.value = ''; }} />
          </div>
        </section>

        <section className="space-y-2">
          <h3 className="text-sm font-semibold">Colours</h3>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            {COLOR_ROLES.map(([r, label, note]) => (
              <label key={r} title={note} onFocus={() => setRole(r)} onClick={() => setRole(r)}
                className={`flex min-w-0 flex-col gap-1 rounded-lg border p-2 ${lib.colors.length && role === r ? 'border-accent' : 'border-line'}`}>
                <span className="truncate text-xs font-medium">{label}</span>
                <input type="color" value={/^#[0-9a-f]{6}$/i.test(draft.colors[r]) ? draft.colors[r] : '#000000'}
                  onChange={(e) => setIn('colors', r, e.target.value.toUpperCase())} className="h-9 w-full cursor-pointer rounded border border-line-strong bg-panel" />
                <input value={draft.colors[r]} onChange={(e) => setIn('colors', r, e.target.value)} aria-label={`${label} colour`} className={`${inputCss} w-full px-1.5 py-1 font-mono text-xs uppercase`} />
              </label>
            ))}
          </div>
          {lib.colors.length > 0 && (
            <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
              <span>Saved colours — click one to use it as <b>{COLOR_ROLES.find(([r]) => r === role)[1]}</b>:</span>
              {lib.colors.map((c) => (
                <button key={`${c.name}-${c.hex}`} type="button" title={`${c.name} ${c.hex}`} onClick={() => setIn('colors', role, c.hex)}
                  className="h-5 w-5 rounded-full border border-line-strong" style={{ background: c.hex }} />
              ))}
            </p>
          )}
        </section>

        <section className="grid gap-3 sm:grid-cols-2">
          {[['title', 'Title font'], ['body', 'Text font']].map(([role, label]) => (
            <label key={role} className="block text-sm">
              <span className="mb-1 block font-medium">{label}</span>
              <select value={draft.fonts[role]} onChange={(e) => setIn('fonts', role, e.target.value)} className={`${inputCss} w-full`}>
                {lib.fonts.map((f) => <option key={f} value={f}>{f}{FONT_NOTES[f] ? ` — ${FONT_NOTES[f]}` : ''}</option>)}
              </select>
              <span className="khmer mt-1 block truncate text-lg" style={{ fontFamily: `"${draft.fonts[role]}"` }}>សួស្តី ការផ្សាយពាណិជ្ជកម្ម ១២៣</span>
            </label>
          ))}
        </section>

        <section className="space-y-2">
          <h3 className="text-sm font-semibold">Contact</h3>
          <div className="grid gap-2 sm:grid-cols-2">
            {CONTACT.map(([key, label, example]) => (
              <label key={key} className="block text-sm">
                <span className="mb-1 block text-muted">{label}</span>
                <input value={draft.contact[key] || ''} onChange={(e) => setIn('contact', key, e.target.value)} placeholder={example} maxLength={200}
                  className={`${inputCss} khmer w-full`} />
              </label>
            ))}
          </div>
        </section>

        <section className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="mb-1 block font-medium">Call to action</span>
            <input value={draft.cta} onChange={(e) => set({ cta: e.target.value })} maxLength={60} list="cta-ideas" className={`${inputCss} khmer w-full`} />
            <datalist id="cta-ideas">{CTA_IDEAS.map((c) => <option key={c} value={c} />)}</datalist>
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium">“Sponsored” label</span>
            <input value={draft.sponsored_label} onChange={(e) => set({ sponsored_label: e.target.value })} maxLength={40} className={`${inputCss} khmer w-full`} />
          </label>
        </section>

        {error && <ErrorBox error={error} compact />}
        {badHex.length > 0 && <Notice>Write colours as #RRGGBB: {badHex.join(', ')}.</Notice>}
        {saved && !changed && <Notice tone="green">Brand kit saved.</Notice>}
        <div className="flex flex-wrap items-center gap-2">
          <Button disabled={!changed || busy || badHex.length > 0} onClick={save}>{busy ? 'Saving…' : 'Save brand kit'}</Button>
          {changed && <Button variant="ghost" onClick={() => setDraft(pick(brand))}>Undo changes</Button>}
          <span className="ml-auto">
            {confirming ? (
              <>
                <Button variant="danger" size="sm" disabled={busy} onClick={() => run(() => libraryApi.deleteBrand(brand.id), onDeleted)}>Delete this brand kit</Button>
                <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>Keep</Button>
              </>
            ) : <Button variant="danger" size="sm" onClick={() => setConfirming(true)}>Delete…</Button>}
          </span>
        </div>
      </Card>
      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-faint">End screen preview</p>
        <EndScreenPreview brand={draft} logo={lib.assets.find((a) => a.id === draft.logo)} />
      </div>
    </div>
  );
}

// A rough look at an end screen in these colours and fonts (the real one is drawn for the video).
function EndScreenPreview({ brand, logo }) {
  const c = brand.colors;
  const contact = CONTACT.filter(([k]) => brand.contact[k]).slice(0, 4);
  return (
    <div className="relative mx-auto aspect-[9/16] w-full max-w-[17rem] overflow-hidden rounded-2xl shadow-lg"
      style={{ background: `linear-gradient(160deg, ${c.background} 0%, ${c.background} 45%, ${c.primary} 130%)`, color: c.text }}>
      {brand.sponsored_label && (
        <span className="khmer absolute left-3 top-3 rounded px-1.5 text-[10px] font-semibold" style={{ background: '#0008', fontFamily: `"${brand.fonts.body}"` }}>{brand.sponsored_label}</span>
      )}
      <div className="flex h-full flex-col items-center justify-center gap-3 px-5 text-center">
        <div className="flex h-20 w-20 items-center justify-center overflow-hidden rounded-2xl" style={{ background: logo ? 'transparent' : c.primary }}>
          {logo ? <img src={logo.url} alt="" className="h-full w-full object-contain" /> : <span className="text-2xl font-bold">{brand.name.slice(0, 2)}</span>}
        </div>
        <p className="khmer text-xl leading-snug" style={{ fontFamily: `"${brand.fonts.title}"` }}>{brand.name}</p>
        <p className="khmer rounded-full px-3 py-0.5 text-sm font-bold" style={{ background: c.accent, color: c.background, fontFamily: `"${brand.fonts.body}"` }}>បញ្ចុះតម្លៃ ២០%</p>
        <span className="khmer mt-1 rounded-xl px-5 py-2 text-base font-bold shadow" style={{ background: c.primary, color: c.text, fontFamily: `"${brand.fonts.body}"` }}>{brand.cta || 'កុម្ម៉ង់ឥឡូវនេះ'}</span>
        <ul className="khmer mt-2 space-y-0.5 text-xs" style={{ fontFamily: `"${brand.fonts.body}"` }}>
          {contact.length ? contact.map(([k]) => <li key={k}>{{ phone: '☎', facebook: 'f', telegram: '✈', address: '⌂', website: '🌐' }[k]} {brand.contact[k]}</li>) : <li className="opacity-60">Add a phone number or page</li>}
        </ul>
      </div>
      <div className="absolute inset-x-0 bottom-0 h-1.5" style={{ background: `linear-gradient(90deg, ${c.primary}, ${c.secondary}, ${c.accent})` }} />
    </div>
  );
}
