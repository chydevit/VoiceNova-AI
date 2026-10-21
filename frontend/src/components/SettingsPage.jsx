import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Button, Card, Chip, ErrorBox, Notice, inputCss } from './ui.jsx';

const TRANSLATE = { auto: 'Automatic (first key found)', gemini: 'Google Gemini', anthropic: 'Anthropic Claude', openai: 'OpenAI' };
const VOICES = { edge: 'Microsoft Edge voices — free', azure: 'Azure Speech — official, paid', google: 'Google Cloud TTS', mms: 'Meta MMS — offline (needs extras)' };
const TRANSLATE_KEYS = ['GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY'];
const VOICE_KEYS = { azure: ['AZURE_SPEECH_KEY'], google: ['GOOGLE_TTS_API_KEY'] };

function Status({ part }) {
  if (!part) return null;
  return part.ok ? <Chip tone="green">✓ Ready{part.model ? ` · ${part.model}` : ''}</Chip> : <Chip tone="amber">{part.reason}</Chip>;
}

function SecretField({ secret, value, onChange }) {
  return (
    <label className="block">
      <span className="mb-1 flex flex-wrap items-center gap-2 text-sm font-medium">
        {secret.label}
        {secret.set && value === undefined && <Chip tone="green">saved{secret.ending ? ` · …${secret.ending}` : ''}</Chip>}
        <a href={secret.link} target="_blank" rel="noreferrer" className="ml-auto text-xs font-normal text-accent-ink hover:underline">Get a key ↗</a>
      </span>
      <span className="flex gap-2">
        <input type="password" autoComplete="off" spellCheck="false" value={value ?? ''} onChange={(e) => onChange(e.target.value)}
          placeholder={secret.set ? 'Saved — type a new key to replace it' : 'Paste the key here'} className={`${inputCss} min-w-0 flex-1 font-mono`} />
        {secret.set && (
          <Button variant="ghost" size="sm" onClick={() => onChange('')} title="Remove this key">{value === '' ? 'Will be removed' : 'Remove'}</Button>
        )}
      </span>
    </label>
  );
}

// API keys and which services to use. Saved on this computer only, applied at once.
export default function SettingsPage({ onSaved }) {
  const [data, setData] = useState(null);
  const [edits, setEdits] = useState({});
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => { api.appSettings().then(setData).catch(setError); }, []);
  if (error && !data) return <ErrorBox error={error} />;
  if (!data) return <p className="text-muted">Loading…</p>;

  const secrets = Object.fromEntries(data.secrets.map((s) => [s.name, s]));
  const value = (name) => (name in edits ? edits[name] : data.values[name]);
  const set = (name, v) => { setSaved(false); setEdits((e) => ({ ...e, [name]: v })); };
  const voice = value('TTS_PROVIDER');

  async function save() {
    setSaving(true);
    setError(null);
    try {
      setData(await api.saveAppSettings(edits));
      setEdits({});
      setSaved(true);
      onSaved?.();
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div>
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="khmer text-muted">ការកំណត់</p>
      </div>

      <Card className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold">Translation (AI)</h2>
          <span className="ml-auto"><Status part={data.status.translate} /></span>
        </div>
        <p className="text-sm text-muted">Translating into natural Khmer needs one AI service. Google Gemini has a free tier — a good place to start.</p>
        <label className="block text-sm">
          <span className="mb-1 block font-medium">Use</span>
          <select value={value('TRANSLATE_PROVIDER')} onChange={(e) => set('TRANSLATE_PROVIDER', e.target.value)} className={`${inputCss} w-full`}>
            {data.choices.TRANSLATE_PROVIDER.map((c) => <option key={c} value={c}>{TRANSLATE[c] || c}</option>)}
          </select>
        </label>
        {TRANSLATE_KEYS.map((name) => <SecretField key={name} secret={secrets[name]} value={edits[name]} onChange={(v) => set(name, v)} />)}
      </Card>

      <Card className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold">Khmer voice</h2>
          <span className="ml-auto"><Status part={data.status.tts} /></span>
        </div>
        <label className="block text-sm">
          <span className="mb-1 block font-medium">Voice engine</span>
          <select value={voice} onChange={(e) => set('TTS_PROVIDER', e.target.value)} className={`${inputCss} w-full`}>
            {data.choices.TTS_PROVIDER.map((c) => <option key={c} value={c}>{VOICES[c] || c}</option>)}
          </select>
        </label>
        {(VOICE_KEYS[voice] || []).map((name) => <SecretField key={name} secret={secrets[name]} value={edits[name]} onChange={(v) => set(name, v)} />)}
        {voice === 'azure' && (
          <label className="block text-sm">
            <span className="mb-1 block font-medium">Azure region <span className="font-normal text-faint">(e.g. southeastasia)</span></span>
            <input value={value('AZURE_SPEECH_REGION')} onChange={(e) => set('AZURE_SPEECH_REGION', e.target.value)} className={`${inputCss} w-full`} />
          </label>
        )}
        {voice === 'edge' && <p className="text-xs text-muted">Free and needs no key (Piseth ♂ / Sreymom ♀). It's an unofficial service — for commercial work use Azure, which has the same voices.</p>}
      </Card>

      <Card className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold">Speech-to-text</h2>
          <span className="ml-auto"><Status part={data.status.transcribe} /></span>
        </div>
        <p className="text-sm text-muted">Runs on this computer with Whisper — free. The first video downloads the speech model (about 500 MB).</p>
      </Card>

      {error && <ErrorBox error={error} />}
      {saved && <Notice tone="green">Saved — the new settings are already in use.</Notice>}
      <div className="flex flex-wrap items-center gap-3">
        <Button size="lg" disabled={saving || !Object.keys(edits).length} onClick={save}>{saving ? 'Saving…' : 'Save settings'}</Button>
        <p className="text-xs text-muted">Keys are saved only on this computer, in <code className="break-all">{data.file}</code>, readable by your user account alone.</p>
      </div>
    </div>
  );
}
