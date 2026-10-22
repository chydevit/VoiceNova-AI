import { useEffect, useRef, useState } from 'react';
import { formatTime, timeAgo } from '../../api.js';
import { canvasSize, keptRanges, skippedRanges, timelineEnd, withVoice } from '../../lib/timeline.js';
import { Button, Progress, inputCss } from '../ui.jsx';

const FORMATS = [
  { key: 'mp4', label: 'Video', note: 'MP4 with the Khmer voice' },
  { key: 'mp4_subs', label: 'Video + subtitles', note: 'MP4 with burned-in Khmer subtitles' },
  { key: 'srt', label: 'Subtitles file', note: '.srt for YouTube, Facebook…' },
  { key: 'audio', label: 'Khmer audio only', note: 'The voice track' },
];
const FILE_LABEL = { mp4: 'Video', mp4_subs: 'Video + subtitles', srt: 'Subtitles', audio: 'Audio' };

function Downloads({ version, onWatch }) {
  const watchable = version.files.mp4_subs || version.files.mp4;
  return (
    <div className="flex flex-wrap gap-1.5">
      {watchable && (
        <Button size="sm" onClick={() => onWatch(watchable.url, version.label)}>
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15l13-7.5z" /></svg> Watch
        </Button>
      )}
      {Object.entries(version.files).map(([kind, f]) => (
        <a key={kind} href={f.download_url}
          className="inline-flex items-center gap-1 rounded-lg border border-line-strong bg-panel px-2.5 py-1.5 text-xs font-semibold text-ink hover:bg-raised">
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 4v12m0 0-4-4m4 4 4-4M5 20h14" /></svg>
          {FILE_LABEL[kind]} <span className="font-normal text-faint">.{f.ext}</span>
        </a>
      ))}
    </div>
  );
}

function WatchDialog({ url, title, onClose }) {
  const dialog = useRef(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return (
    <dialog ref={dialog} onClose={onClose} onClick={(e) => e.target === dialog.current && onClose()}
      className="m-auto w-[min(960px,calc(100vw-32px))] rounded-2xl bg-panel p-0 text-ink shadow-2xl backdrop:bg-black/70">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
        <h2 className="text-sm font-semibold">{title}</h2>
        <Button size="sm" variant="ghost" className="ml-auto" onClick={onClose}>Close</Button>
      </div>
      <video src={url} controls autoPlay playsInline className="max-h-[75vh] w-full bg-black" />
    </dialog>
  );
}

const SHAPES = [
  ['original', 'Original', null],
  ['16:9', '16:9', 'YouTube'],
  ['9:16', '9:16', 'TikTok · Reels'],
  ['1:1', '1:1', 'Square'],
];

function Choice({ value, options, onChange, disabled, label }) {
  return (
    <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }} role="radiogroup" aria-label={label}>
      {options.map(([key, name, note]) => (
        <button key={key} type="button" role="radio" aria-checked={value === key} disabled={disabled} onClick={() => onChange(key)}
          className={`rounded-lg border px-1.5 py-1.5 text-center text-xs leading-tight disabled:opacity-50 ${value === key ? 'border-accent bg-accent-soft font-semibold text-accent-ink' : 'border-line-strong hover:bg-raised'}`}>
          {name}{note && <span className="block text-[10px] font-normal text-muted">{note}</span>}
        </button>
      ))}
    </div>
  );
}

// How the exported picture comes out: its shape, its size, how a picture of another shape fits in,
// and how much it is compressed. The preview shows the shape at once.
function PictureSettings({ project, locked, actions }) {
  const settings = { resolution: 'original', aspect: 'original', fit: 'fit', quality: 'high', ...project.settings.export };
  const set = (patch) => actions.settings({ export: { ...settings, ...patch } });
  const { width, height } = canvasSize(project);
  const { width: w, height: h } = project.video;
  const differs = width / height !== w / h;
  return (
    <section className="space-y-2.5 rounded-xl border border-line p-3">
      <p className="flex items-baseline justify-between text-sm font-semibold">Picture <span className="font-mono text-xs font-normal text-muted">{width} × {height}</span></p>
      <div className="space-y-1"><span className="text-xs text-muted">Shape</span><Choice label="Shape" value={settings.aspect} disabled={locked} onChange={(aspect) => set({ aspect })} options={SHAPES} /></div>
      <div className="space-y-1"><span className="text-xs text-muted">Size</span>
        <Choice label="Size" value={settings.resolution} disabled={locked} onChange={(resolution) => set({ resolution })}
          options={[['original', 'Original', `${Math.min(w, h)}p`], ['720p', '720p', 'smaller'], ['1080p', '1080p', 'HD']]} />
      </div>
      {differs && (
        <div className="space-y-1"><span className="text-xs text-muted">A picture of another shape</span>
          <Choice label="Fit" value={settings.fit} disabled={locked} onChange={(fit) => set({ fit })}
            options={[['fit', 'Show it whole', 'black bars'], ['fill', 'Fill the frame', 'edges cut off']]} />
        </div>
      )}
      <div className="space-y-1"><span className="text-xs text-muted">Quality</span>
        <Choice label="Quality" value={settings.quality} disabled={locked} onChange={(quality) => set({ quality })}
          options={[['high', 'High', 'best'], ['medium', 'Medium', 'smaller file'], ['small', 'Small', 'smallest file']]} />
      </div>
    </section>
  );
}

// Export only what changed, show progress, and keep every export as a version.
export default function ExportPanel({ project, locked, onExport, actions }) {
  const prefs = project.export_prefs || { formats: ['mp4', 'srt'], audio_format: 'mp3' };
  const [formats, setFormats] = useState(prefs.formats);
  const [audioFormat, setAudioFormat] = useState(prefs.audio_format);
  const [withMarks, setWithMarks] = useState(prefs.watermark !== false); // export with the watermarks
  const [watch, setWatch] = useState(null);
  const exporting = project.status === 'exporting';
  const versions = [...project.versions].reverse();
  const [latest, ...older] = versions;
  const changed = (project.counts.edited || 0) + (project.counts.failed || 0);
  const tooLong = project.counts.too_long || 0;
  const toggle = (key) => setFormats((f) => (f.includes(key) ? f.filter((k) => k !== key) : [...f, key]));
  const tracks = withVoice(project.timeline, project.sentences);
  const length = keptRanges(skippedRanges(tracks), timelineEnd(tracks)).reduce((sum, [a, b]) => sum + b - a, 0);
  const marks = (tracks.find((t) => t.id === 'watermark')?.clips || []).filter((w) => !w.skipped).length;

  return (
    <div className="space-y-4">
      <PictureSettings project={project} locked={locked || exporting} actions={actions} />
      <fieldset disabled={locked || exporting} className="space-y-1.5">
        {FORMATS.map((f) => {
          const on = formats.includes(f.key);
          return (
            <label key={f.key} className={`flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 transition ${on ? 'border-accent bg-accent-soft' : 'border-line hover:border-line-strong'}`}>
              <input type="checkbox" checked={on} onChange={() => toggle(f.key)} />
              <span className="min-w-0 flex-1 leading-tight">
                <span className="block text-sm font-semibold">{f.label}</span>
                <span className="text-xs text-muted">{f.note}</span>
              </span>
              {f.key === 'audio' && (
                <select value={audioFormat} onChange={(e) => setAudioFormat(e.target.value)} onClick={(e) => e.stopPropagation()} className={`${inputCss} py-0.5 text-xs`} aria-label="Audio format">
                  <option value="mp3">.mp3</option>
                  <option value="wav">.wav</option>
                </select>
              )}
            </label>
          );
        })}
        {marks > 0 && (
          <div className="flex gap-1 pt-1" role="group" aria-label="Watermark">
            {[[true, `With watermark${marks > 1 ? 's' : ''}`], [false, 'Without']].map(([on, label]) => (
              <button key={label} type="button" onClick={() => setWithMarks(on)} aria-pressed={withMarks === on}
                className={`flex-1 rounded-lg border px-2 py-1.5 text-xs font-semibold ${withMarks === on ? 'border-accent bg-accent-soft text-accent-ink' : 'border-line-strong text-muted hover:bg-raised'}`}>
                {label}
              </button>
            ))}
          </div>
        )}
      </fieldset>

      {exporting ? (
        <div className="rounded-lg bg-accent-soft p-3">
          <p className="mb-2 text-sm font-semibold text-accent-ink">Exporting… {Math.round((project.progress || 0) * 100)}%</p>
          <Progress value={project.progress || 0} />
          <p className="mt-2 text-xs text-muted">{project.message || 'Starting…'}</p>
        </div>
      ) : (
        <div>
          <Button size="lg" className="w-full" disabled={locked || !formats.length} onClick={() => onExport(formats, audioFormat, undefined, undefined, withMarks)}>
            Export <span className="khmer font-normal opacity-80">· នាំចេញ</span>
          </Button>
          <p className="mt-2 text-xs text-muted">
            {formatTime(length)} long, with every track: cuts and skipped parts left out, added clips, text and the sound mixed. {' '}
            {changed ? `${changed} changed sentence${changed === 1 ? '' : 's'} will be voiced; every other clip is reused.` : 'Every clip is ready — nothing needs voicing again.'}
            {tooLong > 0 && ` ${tooLong} too long — they'll be cut at the end.`}
          </p>
        </div>
      )}

      {latest && !exporting && (
        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3">
          <p className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-emerald-800 dark:text-emerald-200">
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m5 12 5 5L20 7" /></svg>
            {latest.label} · {timeAgo(latest.at)}
          </p>
          {Object.keys(latest.files).length ? <Downloads version={latest} onWatch={(url, title) => setWatch({ url, title })} /> : <p className="text-xs text-muted">Files removed to save space.</p>}
        </div>
      )}

      {older.length > 0 && (
        <details className="group">
          <summary className="cursor-pointer text-sm font-semibold text-accent-ink">Earlier versions ({older.length})</summary>
          <ol className="mt-2 space-y-2">
            {older.map((v) => (
              <li key={v.n} className="rounded-lg border border-line p-2.5">
                <div className="mb-1.5 flex items-center gap-2 text-sm">
                  <span className="font-semibold">{v.label}</span>
                  <span className="text-xs text-faint">{timeAgo(v.at)}</span>
                  {v.restorable && (
                    <Button variant="ghost" size="sm" className="ml-auto" disabled={locked || exporting} onClick={() => actions.restore(v.n)} title="Bring back the sentences as they were in this export">Restore edits</Button>
                  )}
                </div>
                {Object.keys(v.files).length ? <Downloads version={v} onWatch={(url, title) => setWatch({ url, title })} /> : <p className="text-xs text-faint">Files removed to save space (edits can still be restored).</p>}
              </li>
            ))}
          </ol>
        </details>
      )}

      {watch && <WatchDialog url={watch.url} title={watch.title} onClose={() => setWatch(null)} />}
    </div>
  );
}
