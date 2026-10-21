import { voiceName, voiceTitle } from '../lib/voices.js';

export const BACKGROUNDS = [
  { key: 'replace', title: 'Replace the original audio', note: 'Only the Khmer voice — music and sounds are removed too.' },
  { key: 'separate', title: 'Remove the original voice', note: 'Cuts out the original speech but keeps music & sound effects (Demucs AI).' },
  { key: 'duck', title: 'Keep original quietly', note: 'The original audio plays softly under the Khmer voice.' },
];

export function Choice({ checked, disabled, onChange, title, note, name }) {
  return (
    <label className={`flex cursor-pointer gap-3 rounded-xl border p-3 transition ${checked ? 'border-accent bg-accent-soft' : 'border-line hover:border-line-strong'} ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}>
      <input type="radio" name={name} checked={checked} disabled={disabled} onChange={onChange} className="mt-1" />
      <span>
        <span className="block text-sm font-semibold">{title}</span>
        {note && <span className="block text-xs text-muted">{note}</span>}
      </span>
    </label>
  );
}

export default function VoiceOptions({ options, setOptions, health, disabled }) {
  const tts = health?.tts || { genders: ['male', 'female'] };
  const set = (patch) => setOptions((o) => ({ ...o, ...patch }));

  return (
    <div className="space-y-5">
      <fieldset disabled={disabled}>
        <legend className="mb-2 text-sm font-semibold text-ink">Khmer voice</legend>
        {tts.genders.length > 1 ? (
          <div className="grid grid-cols-2 gap-2">
            {tts.genders.map((g) => (
              <Choice key={g} name="voice" checked={options.voice === g} onChange={() => set({ voice: g })}
                title={voiceTitle(g)} note={voiceName(tts.provider, g)} />
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted">{tts.label} has one voice.</p>
        )}
      </fieldset>

      <fieldset disabled={disabled}>
        <legend className="mb-2 flex w-full justify-between text-sm font-semibold text-ink">
          Speed <span className="tabular-nums text-accent-ink">{options.speed.toFixed(2)}×</span>
        </legend>
        <input type="range" min="0.8" max="1.3" step="0.05" value={options.speed} onChange={(e) => set({ speed: Number(e.target.value) })} className="w-full" aria-label="Voice speed" />
        <div className="flex justify-between text-xs text-faint"><span>0.8× slower</span><span>1.3× faster</span></div>
      </fieldset>

      <fieldset disabled={disabled} className="space-y-2">
        <legend className="mb-2 text-sm font-semibold text-ink">Background audio</legend>
        {BACKGROUNDS.map((b) => {
          const unavailable = b.key === 'separate' && health && !health.demucs;
          return (
            <Choice key={b.key} name="background" checked={options.background === b.key} disabled={unavailable}
              onChange={() => set({ background: b.key })} title={b.title}
              note={unavailable ? 'Not installed — run pip install -r requirements-extra.txt' : b.note} />
          );
        })}
      </fieldset>

      <fieldset disabled={disabled}>
        <legend className="mb-2 text-sm font-semibold text-ink">Subtitles</legend>
        <label className="flex items-start gap-3 text-sm">
          <input type="checkbox" checked={options.burn_subtitles} onChange={(e) => set({ burn_subtitles: e.target.checked })} className="mt-1" />
          <span>Burn Khmer subtitles into the video<span className="block text-xs text-muted">A separate .srt file is always available to download.</span></span>
        </label>
      </fieldset>
    </div>
  );
}
