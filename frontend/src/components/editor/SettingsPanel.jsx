import { useState } from 'react';
import { trackOf } from '../../lib/timeline.js';
import { voiceLabel } from '../../lib/voices.js';
import { BACKGROUNDS, Choice } from '../VoiceOptions.jsx';
import VolumeControl, { SecondsControl } from './VolumeControl.jsx';

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

// Lower a track while the Khmer voice speaks: on/off, its level then (1 % steps), and how fast it goes.
function Ducking({ track, label, locked, sound, note }) {
  const duck = track.duck || { on: false, level: 10, fade: 0.3 };
  const set = (patch, now) => sound.track(track.id, { duck: { ...duck, ...patch } }, now);
  return (
    <div className="space-y-2 rounded-lg bg-raised p-2.5">
      <label className="flex items-start gap-2 text-xs">
        <input type="checkbox" className="mt-0.5" checked={!!duck.on} disabled={locked} onChange={(e) => set({ on: e.target.checked }, true)} />
        <span><span className="font-semibold text-ink">Lower {label} when the Khmer voice speaks</span>{note && <span className="block text-faint">{note}</span>}</span>
      </label>
      {duck.on && (
        <>
          <VolumeControl compact label="While the voice speaks" value={duck.level} disabled={locked} onChange={(v) => set({ level: v })}
            hint={duck.level >= (track.volume ?? 100) ? `At ${track.volume ?? 100}% or more nothing changes: set it below the ${label}'s ${track.volume ?? 100}%.` : `${track.volume ?? 100}% normally, ${duck.level}% while a sentence plays.`} />
          <SecondsControl label="Going down and back up" value={duck.fade ?? 0.3} min={0.1} max={2} disabled={locked} onChange={(v) => set({ fade: v })}
            hint="It's already down when the voice starts, and comes back up after it." />
        </>
      )}
    </div>
  );
}

// The sound tracks' volumes, side by side: the background, the Khmer voice, the music.
function Mixer({ project, tracks, locked, sound }) {
  const background = trackOf(tracks, 'background');
  const voice = trackOf(tracks, 'voice');
  const music = trackOf(tracks, 'audio');
  const replace = project.settings.background === 'replace';
  const hasMusic = music.clips.length > 0;
  return (
    <fieldset disabled={locked} className="min-w-0 space-y-3 border-t border-line pt-4">
      <legend className="sr-only">Volumes</legend>
      <p className="text-sm font-semibold text-ink">Volumes <span className="khmer font-normal text-faint">· កម្រិតសំឡេង</span></p>
      <p className="text-xs text-muted">1 % steps up to 200 % (louder than the file). Drag, type a number, use − / +, or the arrow keys (Shift: 10 %). You hear every change at once.</p>
      <div className={`space-y-2 ${replace ? 'opacity-50' : ''}`}>
        <VolumeControl label="Background" value={background.volume ?? 100} muted={background.muted} disabled={locked || replace}
          onChange={(v) => sound.track('background', { volume: v })} onMute={(m) => sound.track('background', { muted: m }, true)}
          hint={replace ? 'The original audio is off (Replace). Choose another option above to hear it.' : 'The video’s own sound. Each part of it can have its own volume too (select it on the timeline).'} />
        {!replace && <Ducking track={background} label="the background" locked={locked} sound={sound} />}
      </div>
      <VolumeControl label="Khmer voice" value={voice.volume ?? 100} muted={voice.muted} disabled={locked}
        onChange={(v) => sound.track('voice', { volume: v })} onMute={(m) => sound.track('voice', { muted: m }, true)}
        hint="Every sentence together; each sentence has its own volume too." />
      <div className={`space-y-2 ${hasMusic ? '' : 'opacity-60'}`}>
        <VolumeControl label="Music & sound" value={music.volume ?? 100} muted={music.muted} disabled={locked}
          onChange={(v) => sound.track('audio', { volume: v })} onMute={(m) => sound.track('audio', { muted: m }, true)}
          hint={hasMusic ? 'Every clip on the music track together.' : 'Add music in the Media tab (or drop a file on the timeline).'} />
        {hasMusic && <Ducking track={music} label="the music" locked={locked} sound={sound} />}
      </div>
    </fieldset>
  );
}

// Background audio for the whole video, the volumes of the sound tracks, and voice / speed / volume
// for every sentence at once.
export default function SettingsPanel({ project, tracks, health, locked, actions, sound }) {
  const { settings } = project;
  const voices = health?.tts?.genders || ['female'];
  const provider = health?.tts?.provider;
  const [all, setAll] = useState({ voice: settings.voice, speed: settings.speed, volume: 100 });

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
        <p className="text-xs text-faint">Choosing one sets the background to its usual volume; change it below.</p>
        {settings.background === 'separate' && <VoiceRemoval project={project} onRetry={actions.separate} />}
      </fieldset>

      <Mixer project={project} tracks={tracks} locked={locked} sound={sound} />

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
        <div className="flex items-end gap-2 text-sm">
          <div className="min-w-0 flex-1"><VolumeControl compact label="Every sentence's volume" value={all.volume} onChange={(v) => setAll({ ...all, volume: v })} /></div>
          <ApplyButton onClick={() => actions.applyAll({ volume: all.volume })} />
        </div>
        <p className="text-xs text-muted">A new voice or speed needs new clips — press “Voice all changed” or just export; only the changed sentences are voiced.</p>
      </fieldset>
    </div>
  );
}
