import { useEffect, useRef, useState } from 'react';
import { formatTime } from '../../api.js';
import { ANIMATIONS, DEFAULT_TEXT_STYLE, FONTS } from '../../lib/subtitleImages.js';
import { voiceLabel } from '../../lib/voices.js';
import { VOLUME_MAX, keysAt, soundAt, speedOf, timecode } from '../../lib/timeline.js';
import { pieceLabel } from './timeline/lanes.jsx';
import { Button, Chip, inputCss } from '../ui.jsx';
import VolumeControl, { PercentField, SecondsControl } from './VolumeControl.jsx';

// A value that shows at once while a slider moves and is saved once it stops.
function useCommitted(value, commit, delay = 300) {
  const [local, setLocal] = useState(value);
  const timer = useRef(null);
  useEffect(() => { setLocal(value); }, [value]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return [local, (v) => { setLocal(v); clearTimeout(timer.current); timer.current = setTimeout(() => commit(v), delay); }];
}

// Seconds, typed: saved on Enter or when leaving the box.
function TimeField({ label, value, onCommit, disabled }) {
  const [text, setText] = useState(value.toFixed(2));
  useEffect(() => { setText(value.toFixed(2)); }, [value]);
  const commit = () => {
    const v = Number(text);
    if (Number.isFinite(v) && Math.abs(v - value) > 0.0005) onCommit(Math.max(0, v));
    else setText(value.toFixed(2));
  };
  return (
    <label className="flex items-center justify-between gap-2 text-xs">
      <span className="text-muted">{label}</span>
      <input type="number" step="0.01" min="0" inputMode="decimal" value={text} disabled={disabled} aria-label={`${label} (seconds)`}
        onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        className={`${inputCss} w-24 px-1.5 py-0.5 text-right font-mono text-xs tabular-nums`} />
    </label>
  );
}

function Slider({ label, value, min, max, step, shown, onChange, disabled }) {
  return (
    <label className="block text-xs">
      <span className="flex justify-between text-muted">{label} <span className="tabular-nums text-ink">{shown}</span></span>
      <input type="range" min={min} max={max} step={step} value={value} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} className="w-full" />
    </label>
  );
}

const Row = ({ children }) => <div className="flex flex-wrap gap-1.5">{children}</div>;
const Section = ({ title, children }) => (
  <section className="space-y-2.5 border-t border-line pt-3 first:border-t-0 first:pt-0">
    {title && <h3 className="text-xs font-semibold uppercase tracking-wide text-faint">{title}</h3>}
    {children}
  </section>
);

function Times({ clip, fps, onStart, onEnd, disabled }) {
  return (
    <Section title="Time">
      <TimeField label="Start" value={clip.start} onCommit={onStart} disabled={disabled || !onStart} />
      <TimeField label="End" value={clip.end} onCommit={onEnd} disabled={disabled || !onEnd} />
      <p className="flex justify-between text-xs text-muted">Duration <span className="font-mono tabular-nums text-ink">{(clip.end - clip.start).toFixed(2)}s · {timecode(clip.end - clip.start, fps)}</span></p>
    </Section>
  );
}

function VideoProps({ clip, tools, fps, locked, media }) {
  const m = media[clip.media];
  return (
    <>
      <Times clip={clip} fps={fps} disabled={locked} onStart={(t) => tools.trim(clip, 'start', t)} onEnd={(t) => tools.trim(clip, 'end', t)} />
      {clip.type === 'video' && (
        <Section title="From the file">
          <p className="text-xs text-muted">{m?.name || 'The video'} · {formatTime(clip.source_in)} → {formatTime(clip.source_out)}</p>
          <p className="text-xs text-faint">Trimming never changes the file itself: it stays whole, so you can always drag the clip longer again.</p>
          <label className="flex items-center gap-2 text-xs">
            <span className="w-14 text-muted">Speed</span>
            <select value={String(clip.speed)} disabled={locked} onChange={(e) => tools.speed(clip, Number(e.target.value))} className={`${inputCss} flex-1 py-1 text-xs`}>
              {[0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4].map((v) => <option key={v} value={String(v)}>{v}×{v === 1 ? ' (normal)' : ''}</option>)}
              {![0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4].includes(clip.speed) && <option value={String(clip.speed)}>{clip.speed}×</option>}
            </select>
          </label>
          <p className="text-xs text-faint">Faster makes the clip shorter (what follows moves up); its sentences and text keep their place in the picture.</p>
        </Section>
      )}
      {clip.type === 'image' && (
        <Section title="Picture">
          <p className="text-xs text-muted">{m?.name}{m?.width ? ` · ${m.width}×${m.height}` : ''}</p>
          <p className="text-xs text-faint">Drag its edges on the timeline (or type the times above) to show it longer or shorter.</p>
        </Section>
      )}
      <Section title="In the export">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={!clip.skipped} disabled={locked} onChange={() => tools.skip()} />
          {clip.skipped ? 'Skipped — left out (it stays here)' : 'Included'}
        </label>
        <p className="text-xs text-faint">A skipped part of the video is left out with everything that plays during it — the voice, text and sound.</p>
        <Row>
          <Button size="sm" variant="secondary" disabled={locked} onClick={tools.split}>✂ Split at playhead</Button>
          <Button size="sm" variant="secondary" disabled={locked} onClick={() => tools.remove('ripple')} title="Remove its time from every unlocked track; what follows moves up">Delete, close gap</Button>
          <Button size="sm" variant="danger" disabled={locked} onClick={() => tools.remove('gap')} title="Black and silent there; nothing else moves">Delete, leave gap</Button>
        </Row>
      </Section>
    </>
  );
}

// A sentence's subtitle: linked to the voice text (editing one changes both) or its own text,
// and shown during the sentence or at its own time.
function Subtitle({ s, locked, actions, tools }) {
  const own = s.subtitle_text !== null && s.subtitle_text !== undefined;
  return (
    <Section title="Subtitle">
      <Toggle checked={!own} disabled={locked} onChange={(linked) => actions.patch(s.id, linked ? { subtitle_synced: true } : { subtitle_text: s.khmer_text })}>
        Linked to the voice text (editing one changes the other)
      </Toggle>
      {own && (
        <textarea lang="km" rows={2} value={s.subtitle_text} disabled={locked} aria-label="Subtitle text"
          onChange={(e) => actions.setText(s.id, 'subtitle_text', e.target.value)}
          className="khmer w-full resize-y rounded-lg border border-line-strong bg-panel px-2.5 py-1.5 text-sm text-ink focus:border-accent focus:outline-none" />
      )}
      <p className="text-xs text-faint">
        {s.subtitle_timing ? 'It shows at its own time (drag it on the Text track). ' : 'It shows while the sentence plays; drag it on the Text track to change that. '}
        Double-click it on the preview or the timeline to type it.
      </p>
      {s.subtitle_timing && <Button size="sm" variant="secondary" disabled={locked} onClick={() => tools.subtitleTiming(s.id, null, null)}>↺ Show with the sentence again</Button>}
    </Section>
  );
}

function VoiceProps({ s, number, fps, locked, actions, voices, provider, onPlay, onEditText, tools, sound, playback }) {
  const change = async (fields) => {
    const body = await actions.patch(s.id, fields);
    if (body && s.khmer_text) actions.regenerate(s.id);
  };
  const [speed, setSpeed] = useCommitted(s.speed, (v) => change({ speed: v }));
  const fits = s.status !== 'too_long';
  return (
    <>
      <Section>
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold text-accent-ink">#{number}</span>
          {s.status === 'too_long' && <Chip tone="amber">⚠ too long for its time</Chip>}
          {s.skipped && <Chip tone="red">⤼ skipped</Chip>}
        </div>
        <button type="button" onClick={onEditText} className="khmer block w-full rounded-lg bg-raised px-2.5 py-1.5 text-left text-sm text-ink hover:bg-sunken" title="Edit the text in the sentence list">
          {s.khmer_text || <span className="italic text-faint">No Khmer text yet</span>}
        </button>
        {!fits && <p className="text-xs text-amber-700 dark:text-amber-300">The voice is {(s.audio_duration - (s.end - s.start)).toFixed(1)}s longer than its time — make the time longer, or use ⚡ Fix automatically in the sentence list.</p>}
      </Section>
      <Subtitle s={s} locked={locked} actions={actions} tools={tools} />
      <Times clip={s} fps={fps} disabled={locked} onStart={(t) => actions.patch(s.id, { start: t })} onEnd={(t) => actions.patch(s.id, { end: t })} />
      <Section title="Voice">
        <label className="flex items-center gap-2 text-xs">
          <span className="w-14 text-muted">Voice</span>
          <select value={s.voice} disabled={locked || voices.length < 2} onChange={(e) => change({ voice: e.target.value })} className={`${inputCss} min-w-0 flex-1 py-1 text-xs`}>
            {voices.map((v) => <option key={v} value={v}>{voiceLabel(provider, v)}</option>)}
          </select>
        </label>
        <Slider label="Speed" value={speed} min={0.8} max={1.3} step={0.05} shown={`${Number(speed).toFixed(2)}×`} onChange={setSpeed} disabled={locked} />
        <Row>
          <Button size="sm" variant="secondary" onClick={() => onPlay(s)}>▶ Play</Button>
          <Button size="sm" variant="soft" disabled={locked || !s.khmer_text} onClick={() => actions.regenerate(s.id, true)}>↻ Regenerate</Button>
          <Button size="sm" variant="secondary" disabled={locked} onClick={tools.skip}>{s.skipped ? 'Bring back' : '⤼ Skip'}</Button>
          <Button size="sm" variant="danger" disabled={locked} onClick={() => tools.remove('gap')} title="Delete it; silence there">Delete</Button>
        </Row>
      </Section>
      <SoundSettings clip={s} tid="voice" speed={1} locked={locked} sound={sound} playback={playback} longest={Math.min(5, Math.max(0.5, (s.end - s.start) / 2))}
        note="The voice clip's own volume; the Khmer voice track's volume (Audio tab) applies on top." />
    </>
  );
}

// A sound clip's volume (or its volume line), mute and fades — heard at once while they change.
function SoundSettings({ clip, tid, speed, locked, sound, playback, longest = 5, note }) {
  const keys = clip.keys || [];
  const top = keys.length ? Math.max(...keys.map((k) => k.v)) : 0;
  return (
    <>
      <Section title="Volume">
        {keys.length ? (
          <VolumeControl label="Volume line (its highest point)" value={top} muted={!!clip.muted} disabled={locked}
            onChange={(v) => sound.clip(clip, { keys: keys.map((k) => ({ ...k, v: Math.min(VOLUME_MAX, Math.max(0, k.v + v - top)) })) })}
            onMute={(m) => sound.clip(clip, { muted: m }, true)} hint="Moves the whole line up or down; its points are below." />
        ) : (
          <VolumeControl label="Volume" value={clip.volume ?? 100} muted={!!clip.muted} disabled={locked}
            onChange={(v) => sound.clip(clip, { volume: v })} onMute={(m) => sound.clip(clip, { muted: m }, true)} hint={note} />
        )}
        <SecondsControl label="Fade in" value={clip.fade_in || 0} max={longest} disabled={locked} onChange={(v) => sound.clip(clip, { fade_in: v })} />
        <SecondsControl label="Fade out" value={clip.fade_out || 0} max={longest} disabled={locked} onChange={(v) => sound.clip(clip, { fade_out: v })} />
      </Section>
      <VolumeLine clip={clip} tid={tid} speed={speed} locked={locked} sound={sound} playback={playback} />
    </>
  );
}

// The volume over time: points (at a time of the clip, a volume), drawn on the clip on the timeline
// (〰 Volume lines there: click to add a point, drag one, double-click one to remove it).
function VolumeLine({ clip, tid, speed, locked, sound, playback }) {
  const keys = clip.keys || [];
  const when = (at) => (tid === 'voice' ? clip.start + at : clip.start + (at - clip.source_in) / speed);
  const set = (next, now = false) => sound.clip(clip, { keys: next }, now);
  const add = () => {
    const t = Math.min(clip.end, Math.max(clip.start, playback.t));
    const at = Math.round(soundAt(clip, tid, t, speed) * 1000) / 1000;
    const v = keys.length ? Math.round(keysAt(keys, at)) : clip.volume ?? 100;
    set([...keys.filter((k) => Math.abs(k.at - at) > 0.0005), { at, v }].sort((a, b) => a.at - b.at), true);
  };
  return (
    <Section title="Volume line">
      {!keys.length && <p className="text-xs text-faint">Make the volume change along the clip: add points here at the playhead, or turn on 〰 Volume lines above the timeline, click on the clip and drag the points.</p>}
      {keys.map((k) => (
        <div key={k.at} className="flex items-center gap-2 text-xs">
          <button type="button" className="w-16 shrink-0 text-left font-mono tabular-nums text-muted hover:text-ink" title="Move the playhead here" onClick={() => playback.seek(when(k.at))}>
            {formatTime(when(k.at))}
          </button>
          <PercentField label={`Point at ${formatTime(when(k.at))}`} value={k.v} disabled={locked}
            onChange={(v) => set(keys.map((x) => (x === k ? { ...x, v } : x)))} />
          <button type="button" disabled={locked} onClick={() => set(keys.filter((x) => x !== k), true)} aria-label={`Remove the point at ${formatTime(when(k.at))}`}
            className="ml-auto rounded px-1.5 py-0.5 text-muted hover:bg-red-500/10 hover:text-red-600 disabled:opacity-40">✕</button>
        </div>
      ))}
      <Row>
        <Button size="sm" variant="secondary" disabled={locked} onClick={add}>+ Point at the playhead</Button>
        {keys.length > 0 && <Button size="sm" variant="ghost" disabled={locked} onClick={() => set([], true)}>Remove the volume line</Button>}
      </Row>
    </Section>
  );
}

const COLORS = ['#ffffff', '#fde047', '#f87171', '#67e8f9', '#86efac', '#000000'];

function Colors({ value, onChange, label }) {
  return (
    <div className="flex items-center gap-1.5" role="group" aria-label={label}>
      {COLORS.map((c) => (
        <button key={c} type="button" aria-label={c} title={c} onClick={() => onChange(c)}
          className={`h-6 w-6 rounded-full border-2 ${value === c ? 'border-accent ring-2 ring-accent/30' : 'border-line-strong'}`} style={{ background: c }} />
      ))}
      <label className="relative h-6 w-6 cursor-pointer overflow-hidden rounded-full border-2 border-line-strong" title="Any colour" style={{ background: value }}>
        <input type="color" value={value} onChange={(e) => onChange(e.target.value)} className="absolute -inset-2 h-10 w-10 cursor-pointer opacity-0" aria-label={`${label}: any colour`} />
      </label>
    </div>
  );
}

function Toggle({ checked, onChange, children, disabled }) {
  return (
    <label className="flex items-center gap-2 text-xs">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {children}
    </label>
  );
}

// Text on the picture: the words, how they look, where they sit and how they come in and go out.
// `edit(patch)` shows a change at once and saves it a moment later (one undo step for a slider drag).
function TextProps({ clip, fps, locked, tools, edit, focusText }) {
  const style = { ...DEFAULT_TEXT_STYLE, ...clip.style };
  const setStyle = (patch) => edit({ style: patch }); // just what changed (the editor keeps the rest)
  const box = useRef(null);
  useEffect(() => { if (focusText) setTimeout(() => { box.current?.focus(); box.current?.select(); }, 30); }, [focusText, clip.id]);
  return (
    <>
      <Section>
        <textarea ref={box} lang="km" rows={3} value={clip.text} disabled={locked} placeholder="Type the text… (Enter: a new line)" aria-label="The text"
          onChange={(e) => edit({ text: e.target.value })}
          className="khmer w-full resize-y rounded-lg border border-line-strong bg-panel px-2.5 py-1.5 text-base text-ink placeholder:text-faint focus:border-accent focus:outline-none" />
        <p className="text-xs text-faint">Drag the text on the picture to place it (pause first).</p>
      </Section>
      <Times clip={clip} fps={fps} disabled={locked} onStart={(t) => tools.trim(clip, 'start', t)} onEnd={(t) => tools.trim(clip, 'end', t)} />
      <Section title="Look">
        <label className="block text-xs">
          <span className="mb-1 block text-muted">Font</span>
          <select value={style.font} disabled={locked} onChange={(e) => setStyle({ font: e.target.value })} className={`${inputCss} w-full text-sm`} style={{ fontFamily: `"${style.font}", sans-serif` }}>
            {FONTS.map(([name, label]) => <option key={name} value={name} style={{ fontFamily: `"${name}", sans-serif` }}>{label}</option>)}
          </select>
        </label>
        <Slider label="Size" value={style.size} min={2} max={25} step={0.5} shown={Number(style.size).toFixed(1)} onChange={(size) => setStyle({ size })} disabled={locked} />
        <div className="space-y-1 text-xs"><span className="text-muted">Colour</span><Colors value={style.color} onChange={(color) => setStyle({ color })} label="Text colour" /></div>
        <Toggle checked={style.bold} onChange={(bold) => setStyle({ bold })} disabled={locked}>Bold</Toggle>
        <Toggle checked={style.outline} onChange={(outline) => setStyle({ outline })} disabled={locked}>Outline</Toggle>
        {style.outline && (
          <>
            <Colors value={style.outline_color} onChange={(c) => setStyle({ outline_color: c })} label="Outline colour" />
            <Slider label="Outline thickness" value={style.outline_width} min={2} max={60} step={1} shown={style.outline_width} onChange={(w) => setStyle({ outline_width: w })} disabled={locked} />
          </>
        )}
        <Toggle checked={style.box} onChange={(b) => setStyle({ box: b })} disabled={locked}>Box behind the text</Toggle>
        {style.box && (
          <>
            <Colors value={style.box_color} onChange={(c) => setStyle({ box_color: c })} label="Box colour" />
            <Slider label="Box opacity" value={style.box_opacity} min={0.1} max={1} step={0.05} shown={`${Math.round(style.box_opacity * 100)}%`} onChange={(o) => setStyle({ box_opacity: o })} disabled={locked} />
          </>
        )}
        <Toggle checked={style.shadow} onChange={(shadow) => setStyle({ shadow })} disabled={locked}>Soft shadow</Toggle>
      </Section>
      <Section title="Place">
        <Slider label="Left ↔ right" value={clip.x ?? 50} min={0} max={100} step={0.5} shown={clip.x === 50 ? 'centre' : `${clip.x}%`} onChange={(x) => edit({ x })} disabled={locked} />
        <Slider label="Top ↕ bottom" value={clip.y ?? 50} min={0} max={100} step={0.5} shown={`${clip.y}%`} onChange={(y) => edit({ y })} disabled={locked} />
        <Slider label="Line width before wrapping" value={clip.width ?? 90} min={20} max={100} step={1} shown={`${clip.width ?? 90}%`} onChange={(width) => edit({ width })} disabled={locked} />
        <div className="flex gap-1">
          {[['left', '⇤ Left'], ['center', 'Centre'], ['right', 'Right ⇥']].map(([a, label]) => (
            <button key={a} type="button" disabled={locked} onClick={() => edit({ align: a })}
              className={`flex-1 rounded-md border px-2 py-1 text-xs ${clip.align === a ? 'border-accent bg-accent-soft text-accent-ink' : 'border-line-strong hover:bg-raised'}`}>{label}</button>
          ))}
        </div>
      </Section>
      <Section title="Animation">
        {[['in', 'Comes in'], ['out', 'Goes out']].map(([side, label]) => (
          <label key={side} className="flex items-center gap-2 text-xs">
            <span className="w-16 text-muted">{label}</span>
            <select value={clip.animation?.[side] || 'none'} disabled={locked} onChange={(e) => edit({ animation: { [side]: e.target.value } })} className={`${inputCss} min-w-0 flex-1 py-1 text-xs`}>
              {ANIMATIONS.map(([key, name]) => <option key={key} value={key}>{name}</option>)}
            </select>
          </label>
        ))}
        <Row>
          <Button size="sm" variant="secondary" disabled={locked} onClick={tools.split}>✂ Split</Button>
          <Button size="sm" variant="secondary" disabled={locked} onClick={tools.skip}>{clip.skipped ? 'Bring back' : '⤼ Skip'}</Button>
          <Button size="sm" variant="danger" disabled={locked} onClick={() => tools.remove()}>Delete</Button>
        </Row>
      </Section>
    </>
  );
}

// Music or a sound effect: when it plays, how loud, and how it fades in and out.
function SoundProps({ clip, fps, locked, tools, media, sound, playback }) {
  const longest = Math.min(10, Math.max(0.5, (clip.end - clip.start) / 2));
  return (
    <>
      <Section>
        <p className="text-sm font-semibold text-ink">♪ {media[clip.media]?.name || 'Sound'}</p>
        <p className="text-xs text-faint">From {formatTime(clip.source_in)} to {formatTime(clip.source_out)} of the file. Drag it on the timeline to move it; drag its edges to trim it.</p>
      </Section>
      <Times clip={clip} fps={fps} disabled={locked} onStart={(t) => tools.trim(clip, 'start', t)} onEnd={(t) => tools.trim(clip, 'end', t)} />
      <SoundSettings clip={clip} tid="audio" speed={clip.speed ?? 1} locked={locked} sound={sound} playback={playback} longest={longest}
        note="This clip's own volume; the music track's volume (Audio tab) applies on top." />
      <Section>
        <Row>
          <Button size="sm" variant="secondary" disabled={locked} onClick={tools.split}>✂ Split</Button>
          <Button size="sm" variant="secondary" disabled={locked} onClick={tools.duplicate}>Duplicate</Button>
          <Button size="sm" variant="secondary" disabled={locked} onClick={tools.skip} title="Leave it out of the export (it stays on the timeline)">{clip.skipped ? 'Bring back' : '⤼ Skip'}</Button>
          <Button size="sm" variant="danger" disabled={locked} onClick={() => tools.remove()}>Delete</Button>
        </Row>
      </Section>
    </>
  );
}

function BackgroundProps({ b, fps, locked, tools, project, sound, playback, speed }) {
  const off = project.settings.background === 'replace' && !b.keep_voice;
  return (
    <>
      <Section>
        <p className="text-sm font-semibold text-ink">Background sound <span className="font-normal text-muted">{pieceLabel(b)}</span></p>
        <p className="text-xs text-faint">The video’s own sound here. Split it (S) to change the volume of just one part.</p>
        {off && <p className="rounded-lg bg-amber-500/10 px-2 py-1.5 text-xs text-amber-900 dark:text-amber-200">The background is off for the whole video (Audio tab), so this part is silent unless it plays the original voice.</p>}
      </Section>
      <Times clip={b} fps={fps} disabled={locked} onStart={(t) => tools.trim(b, 'start', t)} onEnd={(t) => tools.trim(b, 'end', t)} />
      <SoundSettings clip={b} tid="background" speed={speed} locked={locked} sound={sound} playback={playback} longest={Math.min(5, Math.max(0.5, (b.end - b.start) / 2))}
        note={b.media === 'source' ? 'This part, compared with the rest: the background’s volume (Audio tab) applies on top.' : 'The added video’s own sound here.'} />
      <Section>
        <label className="flex items-start gap-2 text-xs">
          <input type="checkbox" className="mt-0.5" checked={!!b.keep_voice} disabled={locked} onChange={(e) => tools.setProps(b, { keep_voice: e.target.checked })} />
          <span>Play the original audio, with its voice, here — at this part’s volume, whatever the background’s (for example where a sentence was deleted)</span>
        </label>
        <Row>
          <Button size="sm" variant="secondary" disabled={locked} onClick={tools.split}>✂ Split at playhead</Button>
        </Row>
      </Section>
    </>
  );
}

// The selected clip's settings (the inspector's Clip tab).
export default function ClipPanel({ project, tools, sentences, numbers, actions, voices, provider, onPlay, onEditText, busy, textDraft, editText, focusText, sound, tracks, playback }) {
  const { picked, gap } = tools;
  const fps = project.video.fps || 30;
  if (gap) {
    return (
      <div className="space-y-3">
        <p className="text-sm font-semibold">Empty space <span className="font-normal text-muted">{formatTime(gap.start)}–{formatTime(gap.end)} · {(gap.end - gap.start).toFixed(1)}s</span></p>
        <p className="text-xs text-muted">Nothing is on the video track here, so the export is black. Close the gap to move everything after it up.</p>
        <Button size="sm" disabled={busy || tools.locked('video')} onClick={() => tools.remove()}>⇤ Close the gap</Button>
      </div>
    );
  }
  if (!picked.length) {
    return (
      <div className="space-y-2 text-sm text-muted">
        <p className="font-semibold text-ink">Select a clip on the timeline to see its settings.</p>
        <ul className="list-disc space-y-1 pl-4 text-xs">
          <li><b>S</b> splits at the playhead · <b>Delete</b> deletes (Shift+Delete closes the gap)</li>
          <li><b>I</b> and <b>O</b> mark a part: remove it, skip it, or set the volume of a track there</li>
          <li>Drag a clip’s edges to make it shorter or longer · right-click for more</li>
          <li><b>Space</b> plays · <b>← →</b> one frame · <b>Ctrl+Z</b> undo</li>
        </ul>
      </div>
    );
  }
  if (picked.length > 1) {
    const allSkipped = picked.every(({ clip }) => clip.skipped);
    return (
      <div className="space-y-3">
        <p className="text-sm font-semibold">{picked.length} clips selected</p>
        <Row>
          <Button size="sm" variant="secondary" disabled={busy} onClick={tools.skip}>{allSkipped ? 'Bring back' : '⤼ Skip all'}</Button>
          <Button size="sm" variant="danger" disabled={busy} onClick={() => tools.remove()}>Delete</Button>
        </Row>
      </div>
    );
  }
  const { track, clip } = picked[0];
  const locked = busy || track.locked;
  return (
    <div className="space-y-3">
      {track.locked && <p className="rounded-lg bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-900 dark:text-amber-200">🔒 This track is locked. Unlock it (next to its name on the timeline) to change it.</p>}
      {track.id === 'video' && <VideoProps clip={clip} tools={tools} fps={fps} locked={locked} media={project.media} />}
      {track.id === 'voice' && (
        <VoiceProps s={sentences.find((x) => x.id === clip.id) || clip} number={numbers.get(clip.id)} fps={fps} locked={locked} actions={actions}
          voices={voices} provider={provider} onPlay={onPlay} onEditText={() => onEditText(clip.id)} tools={tools} sound={sound} playback={playback} />
      )}
      {track.id === 'background' && (
        <BackgroundProps key={clip.id} b={clip} fps={fps} locked={locked} tools={tools} project={project} sound={sound} playback={playback} speed={speedOf(tracks, clip)} />
      )}
      {track.id === 'text' && (
        <TextProps clip={textDraft?.id === clip.id ? { ...clip, ...textDraft.fields } : clip} fps={fps} locked={locked} tools={tools}
          edit={(patch) => editText(clip, patch)} focusText={focusText} />
      )}
      {track.id === 'audio' && <SoundProps key={clip.id} clip={clip} fps={fps} locked={locked} tools={tools} media={project.media} sound={sound} playback={playback} />}
    </div>
  );
}
