import { useEffect, useState } from 'react';
import { voiceLabel } from '../../lib/voices.js';
import { BACKGROUNDS, Choice } from '../VoiceOptions.jsx';

function ApplyButton({ onClick }) {
  return (
    <button type="button" onClick={onClick}
      className="shrink-0 rounded-lg border border-line-strong bg-panel px-2.5 py-1 text-xs font-semibold text-ink hover:bg-raised disabled:text-faint">
      Apply
    </button>
  );
}

// Progress of removing the original voice (it runs while you keep editing).
function VoiceRemoval({ project, onRetry }) {
  const job = project.separation;
  if (project.background_url) {
    return <p className="rounded-lg bg-emerald-500/10 px-3 py-2 text-xs text-emerald-800 dark:text-emerald-200">✓ Original voice removed — the preview now plays the music & sounds without it.</p>;
  }
  if (job?.state === 'running') {
    return (
      <div className="rounded-lg bg-accent-soft px-3 py-2 text-xs text-accent-ink">
        <p>{job.message || 'Removing the original voice…'} You can keep editing.</p>
        <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-accent-soft">
          <div className="h-full bg-accent transition-all duration-500" style={{ width: `${Math.max(3, job.progress * 100)}%` }} />
        </div>
      </div>
    );
  }
  return (
    <div className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-200">
      <p>{job?.state === 'error' ? job.error?.message : 'The original voice hasn’t been removed yet.'} {job?.state === 'error' && job.error?.hint}</p>
      <button type="button" onClick={onRetry} className="mt-1.5 rounded-lg bg-panel px-2.5 py-1 font-semibold shadow-sm hover:bg-amber-500/15">
        {job?.state === 'error' ? 'Try again' : 'Remove it now'}
      </button>
    </div>
  );
}

// Background audio for the whole video, and voice / speed / volume for every sentence at once.
export default function SettingsPanel({ project, health, locked, actions }) {
  const { settings } = project;
  const voices = health?.tts?.genders || ['female'];
  const provider = health?.tts?.provider;
  const [level, setLevel] = useState(settings.background_volume);
  const [all, setAll] = useState({ voice: settings.voice, speed: settings.speed, volume: 1 });
  useEffect(() => { setLevel(settings.background_volume); }, [settings.background_volume]);

  return (
    <div className="space-y-5">
      <fieldset disabled={locked} className="min-w-0 space-y-2">
        <legend className="mb-2 text-sm font-semibold text-ink">Background audio</legend>
        {BACKGROUNDS.map((b) => {
          const unavailable = b.key === 'separate' && health && !health.demucs;
          return (
            <Choice key={b.key} name="editor-background" checked={settings.background === b.key} disabled={unavailable}
              onChange={() => actions.settings({ background: b.key })} title={b.title}
              note={unavailable ? 'Not installed — run pip install -r requirements-extra.txt' : b.note} />
          );
        })}
        <label className={`block pt-1 ${settings.background === 'replace' ? 'opacity-40' : ''}`}>
          <span className="flex justify-between text-sm font-medium text-ink">
            Background volume <span className="tabular-nums text-accent-ink">{Math.round(level * 100)}%</span>
          </span>
          <input type="range" min="0" max="1" step="0.05" value={level} disabled={settings.background === 'replace'} className="w-full"
            onChange={(e) => setLevel(Number(e.target.value))}
            onPointerUp={() => level !== settings.background_volume && actions.settings({ background_volume: level })}
            onKeyUp={() => level !== settings.background_volume && actions.settings({ background_volume: level })} />
        </label>
        {settings.background === 'separate' && <VoiceRemoval project={project} onRetry={actions.separate} />}
      </fieldset>

      <fieldset disabled={locked} className="min-w-0 space-y-3 border-t border-line pt-4">
        <p className="text-sm font-semibold text-ink">All sentences at once</p>
        <div className="flex items-center gap-2 text-sm">
          <span className="w-14 shrink-0 text-muted">Voice</span>
          <select value={all.voice} onChange={(e) => setAll({ ...all, voice: e.target.value })} className="min-w-0 flex-1 rounded-lg border border-line-strong bg-panel px-2 py-1.5 text-sm">
            {voices.map((v) => <option key={v} value={v}>{voiceLabel(provider, v)}</option>)}
          </select>
          <ApplyButton onClick={() => actions.applyAll({ voice: all.voice })} />
        </div>
        <div className="flex items-center gap-2 text-sm">
          <span className="w-14 shrink-0 text-muted">Speed</span>
          <input type="range" min="0.8" max="1.3" step="0.05" value={all.speed} onChange={(e) => setAll({ ...all, speed: Number(e.target.value) })} className="min-w-0 flex-1" />
          <span className="w-10 shrink-0 text-right tabular-nums">{all.speed.toFixed(2)}×</span>
          <ApplyButton onClick={() => actions.applyAll({ speed: all.speed })} />
        </div>
        <div className="flex items-center gap-2 text-sm">
          <span className="w-14 shrink-0 text-muted">Volume</span>
          <input type="range" min="0" max="2" step="0.05" value={all.volume} onChange={(e) => setAll({ ...all, volume: Number(e.target.value) })} className="min-w-0 flex-1" />
          <span className="w-10 shrink-0 text-right tabular-nums">{Math.round(all.volume * 100)}%</span>
          <ApplyButton onClick={() => actions.applyAll({ volume: all.volume })} />
        </div>
        <p className="text-xs text-muted">A new voice or speed needs new clips — press “Voice all changed” or just export; only the changed sentences are voiced.</p>
      </fieldset>
    </div>
  );
}
