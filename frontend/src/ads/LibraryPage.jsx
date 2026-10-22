import { useEffect, useRef, useState } from 'react';
import { Button, Card, Chip, ErrorBox, Notice, Tabs, inputCss } from '../components/ui.jsx';
import BrandKits from './BrandKits.jsx';
import { ACCEPT, KIND_LABELS, formatBytes, formatSeconds, guessKind, libraryApi, uploadAsset } from './libraryApi.js';

// The Ad Library: logos, product pictures, ad clips and music every ad can reuse, the brand kits new
// ads start from, and saved colours. #/library, #/library/brands, #/library/colors.
const TABS = ['assets', 'brands', 'colors'];
const tabFromHash = () => TABS.find((t) => window.location.hash === `#/library/${t}`) || 'assets';

export default function LibraryPage() {
  const [lib, setLib] = useState(null);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState(tabFromHash);

  useEffect(() => { libraryApi.get().then(setLib).catch(setError); }, []);
  useEffect(() => {
    const onHash = () => setTab(tabFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const show = (t) => { window.location.hash = t === 'assets' ? '#/library' : `#/library/${t}`; };

  if (error && !lib) return <ErrorBox error={error} />;
  if (!lib) return <p className="text-muted">Loading…</p>;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <h1 className="text-2xl font-bold">Ad Library</h1>
          <p className="khmer text-muted">បណ្ណាល័យពាណិជ្ជកម្ម</p>
        </div>
        <p className="max-w-md text-sm text-muted sm:ml-auto sm:text-right">Logos, product pictures, ad clips, music and brand kits, saved once and used in every ad.</p>
      </div>
      <div className="max-w-md">
        <Tabs value={tab} onChange={show} tabs={[
          { key: 'assets', label: `Files · ${lib.assets.length}` },
          { key: 'brands', label: `Brand kits · ${lib.brands.length}` },
          { key: 'colors', label: `Colours · ${lib.colors.length}` },
        ]} />
      </div>
      {error && <ErrorBox error={error} />}
      {tab === 'assets' && <Assets lib={lib} onLib={setLib} onError={setError} />}
      {tab === 'brands' && <BrandKits lib={lib} onLib={setLib} />}
      {tab === 'colors' && <Colors lib={lib} onLib={setLib} />}
    </div>
  );
}

// ---------- files ----------

function Assets({ lib, onLib, onError }) {
  const [filter, setFilter] = useState('all');
  const [uploadKind, setUploadKind] = useState('auto');
  const [uploads, setUploads] = useState([]);
  const [dragging, setDragging] = useState(false);
  const input = useRef(null);

  const counts = Object.fromEntries(Object.keys(lib.kinds).map((k) => [k, lib.assets.filter((a) => a.kind === k).length]));
  const shown = lib.assets.filter((a) => filter === 'all' || a.kind === filter);

  async function upload(files) {
    onError(null);
    for (const file of files) {
      const key = `${file.name}-${file.size}-${Math.random()}`;
      const kind = uploadKind === 'auto' ? guessKind(file.name, filter === 'all' ? null : filter, lib.kinds) : uploadKind;
      setUploads((u) => [...u, { key, name: file.name, progress: 0, error: null }]);
      const patch = (fields) => setUploads((u) => u.map((x) => (x.key === key ? { ...x, ...fields } : x)));
      if (!kind) {
        patch({ error: { message: `“${file.name}” isn't a picture, video or music file.` } });
        continue;
      }
      try {
        const body = await uploadAsset(file, kind, (p) => patch({ progress: p }));
        onLib(body.library);
        setUploads((u) => u.filter((x) => x.key !== key));
      } catch (err) {
        patch({ error: err });
      }
    }
  }

  const onDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files?.length) upload([...e.dataTransfer.files]);
  };

  return (
    <div className="space-y-4" onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={onDrop}>
      <Card className={`flex flex-wrap items-center gap-3 border-dashed transition ${dragging ? 'border-accent bg-accent-soft' : ''}`}>
        <div className="min-w-[14rem] flex-1">
          <p className="font-semibold">Add files</p>
          <p className="text-sm text-muted">Drop pictures (PNG, JPG, WebP), videos or music here. A logo looks best as a PNG with a transparent background.</p>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted">Save as</span>
          <select value={uploadKind} onChange={(e) => setUploadKind(e.target.value)} className={inputCss}>
            <option value="auto">Automatic</option>
            {Object.keys(lib.kinds).map((k) => <option key={k} value={k}>{KIND_LABELS[k].one}</option>)}
          </select>
        </label>
        <Button onClick={() => input.current?.click()}>Choose files…</Button>
        <input ref={input} type="file" multiple accept={ACCEPT} className="hidden"
          onChange={(e) => { upload([...e.target.files]); e.target.value = ''; }} />
      </Card>

      {uploads.map((u) => (
        <div key={u.key} className="space-y-2">
          {u.error ? (
            <ErrorBox error={u.error} compact>
              <Button size="sm" variant="secondary" onClick={() => setUploads((x) => x.filter((y) => y.key !== u.key))}>Dismiss</Button>
            </ErrorBox>
          ) : (
            <div className="rounded-xl border border-line bg-panel p-3 text-sm">
              <p className="mb-2 truncate">Uploading {u.name}… {Math.round(u.progress * 100)}%</p>
              <div className="h-1.5 overflow-hidden rounded-full bg-raised"><div className="h-full bg-accent transition-all" style={{ width: `${Math.max(2, u.progress * 100)}%` }} /></div>
            </div>
          )}
        </div>
      ))}

      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Show">
        {[['all', `All · ${lib.assets.length}`], ...Object.keys(lib.kinds).map((k) => [k, `${KIND_LABELS[k].many} · ${counts[k]}`])].map(([k, label]) => (
          <button key={k} type="button" onClick={() => setFilter(k)} aria-pressed={filter === k}
            className={`rounded-lg px-2.5 py-1.5 text-xs font-semibold transition ${filter === k ? 'bg-accent-soft text-accent-ink' : 'text-muted hover:bg-raised hover:text-ink'}`}>
            {label}
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <p className="rounded-xl border border-line bg-panel p-8 text-center text-sm text-muted">
          {lib.assets.length ? 'Nothing of this kind yet.' : 'The library is empty. Add your logo and a few product photos to start.'}
        </p>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {shown.map((a) => <AssetCard key={a.id} asset={a} kinds={lib.kinds} onLib={onLib} onError={onError} />)}
        </ul>
      )}
    </div>
  );
}

const CHECKERS = {
  backgroundImage: 'linear-gradient(45deg, #8882 25%, transparent 25%), linear-gradient(-45deg, #8882 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #8882 75%), linear-gradient(-45deg, transparent 75%, #8882 75%)',
  backgroundSize: '16px 16px',
  backgroundPosition: '0 0, 0 8px, 8px -8px, -8px 0',
};

function AssetCard({ asset: a, kinds, onLib, onError }) {
  const [name, setName] = useState(null); // null: not renaming
  const [playing, setPlaying] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  async function act(fn) {
    setBusy(true);
    onError(null);
    try {
      onLib((await fn()).library);
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  }

  const saveName = () => {
    const next = name?.trim();
    setName(null);
    if (next && next !== a.name) act(() => libraryApi.patchAsset(a.id, { name: next }));
  };
  const kindsFor = Object.keys(kinds).filter((k) => kinds[k].includes(a.media));
  const details = a.media === 'audio' ? formatSeconds(a.duration)
    : a.media === 'video' ? `${formatSeconds(a.duration)} · ${a.width}×${a.height}${a.audio ? '' : ' · no sound'}`
      : `${a.width}×${a.height}${a.alpha ? ' · transparent' : ''}`;

  return (
    <li className={`flex flex-col overflow-hidden rounded-xl border border-line bg-panel ${busy ? 'opacity-60' : ''}`}>
      <div className="relative flex h-36 items-center justify-center bg-raised" style={a.alpha ? CHECKERS : undefined}>
        {a.media === 'audio' ? (
          <div className="flex w-full flex-col items-center gap-2 px-3">
            <span className="text-3xl" aria-hidden="true">♫</span>
            <audio controls preload="none" src={a.url} className="h-8 w-full" />
          </div>
        ) : a.media === 'video' && playing ? (
          <video src={a.url} controls autoPlay className="h-full w-full bg-black object-contain" />
        ) : (
          <>
            {a.thumb_url ? <img src={a.thumb_url} alt="" className="h-full w-full object-contain" loading="lazy" /> : <span className="text-sm text-faint">No preview</span>}
            {a.media === 'video' && (
              <button type="button" onClick={() => setPlaying(true)} aria-label={`Play ${a.name}`}
                className="absolute inset-0 flex items-center justify-center bg-black/0 text-white transition hover:bg-black/25">
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-black/55 text-lg">▶</span>
              </button>
            )}
          </>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-2 p-3">
        {name === null ? (
          <button type="button" onClick={() => setName(a.name)} title="Rename" className="khmer truncate text-left text-sm font-semibold hover:text-accent-ink">{a.name}</button>
        ) : (
          <input autoFocus value={name} maxLength={80} onChange={(e) => setName(e.target.value)} onBlur={saveName}
            onKeyDown={(e) => { if (e.key === 'Enter') saveName(); if (e.key === 'Escape') setName(null); }} className={`${inputCss} khmer w-full`} aria-label="Name" />
        )}
        <p className="text-xs text-muted">{details} · {formatBytes(a.bytes)}</p>
        <div className="mt-auto flex items-center gap-1.5">
          {kindsFor.length > 1 ? (
            <select value={a.kind} disabled={busy} onChange={(e) => act(() => libraryApi.patchAsset(a.id, { kind: e.target.value }))}
              className={`${inputCss} min-w-0 flex-1 py-1 text-xs`} aria-label="Kind">
              {kindsFor.map((k) => <option key={k} value={k}>{KIND_LABELS[k].one}</option>)}
            </select>
          ) : (
            <Chip className="mr-auto">{KIND_LABELS[a.kind].one}</Chip>
          )}
          {confirming ? (
            <>
              <Button size="sm" variant="danger" disabled={busy} onClick={() => act(() => libraryApi.deleteAsset(a.id))}>Delete</Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>Keep</Button>
            </>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setConfirming(true)} title="Delete from the library (projects that use it keep their copy)">🗑</Button>
          )}
        </div>
      </div>
    </li>
  );
}

// ---------- saved colours ----------

function Colors({ lib, onLib }) {
  const [colors, setColors] = useState(lib.colors);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const changed = JSON.stringify(colors) !== JSON.stringify(lib.colors);
  const brandColors = lib.brands.flatMap((b) => Object.values(b.colors).map((hex) => ({ name: b.name, hex })));

  const edit = (i, fields) => { setSaved(false); setColors((c) => c.map((x, j) => (j === i ? { ...x, ...fields } : x))); };
  const add = (color) => { setSaved(false); setColors((c) => [...c, color]); };

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const body = await libraryApi.setColors(colors);
      onLib(body);
      setColors(body.colors);
      setSaved(true);
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="max-w-3xl space-y-4">
      <p className="text-sm text-muted">Colours you use often, to pick from when you style captions, banners and end screens.</p>
      <ul className="grid gap-2 sm:grid-cols-2">
        {colors.map((c, i) => (
          <li key={i} className="flex items-center gap-2 rounded-lg border border-line p-2">
            <input type="color" value={/^#[0-9a-f]{6}$/i.test(c.hex) ? c.hex : '#000000'} onChange={(e) => edit(i, { hex: e.target.value.toUpperCase() })}
              className="h-9 w-11 shrink-0 cursor-pointer rounded border border-line-strong bg-panel" aria-label="Colour" />
            <input value={c.name} onChange={(e) => edit(i, { name: e.target.value })} placeholder="Name" className={`${inputCss} khmer min-w-0 flex-1`} aria-label="Name" />
            <input value={c.hex} onChange={(e) => edit(i, { hex: e.target.value })} className={`${inputCss} w-24 font-mono uppercase`} aria-label="Hex" />
            <Button size="sm" variant="ghost" onClick={() => { setSaved(false); setColors((x) => x.filter((_, j) => j !== i)); }} title="Remove">✕</Button>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" size="sm" onClick={() => add({ name: '', hex: '#5B4CF0' })}>+ Add a colour</Button>
        {brandColors.length > 0 && <span className="text-xs text-muted">or from a brand kit:</span>}
        {brandColors.filter((b) => !colors.some((c) => c.hex.toUpperCase() === b.hex)).slice(0, 12).map((b) => (
          <button key={`${b.name}-${b.hex}`} type="button" title={`Add ${b.hex} (${b.name})`} onClick={() => add({ name: b.name, hex: b.hex })}
            className="h-6 w-6 rounded-full border border-line-strong" style={{ background: b.hex }} />
        ))}
      </div>
      {error && <ErrorBox error={error} compact />}
      {saved && !changed && <Notice tone="green">Colours saved.</Notice>}
      <Button disabled={!changed || saving} onClick={save}>{saving ? 'Saving…' : 'Save colours'}</Button>
    </Card>
  );
}
