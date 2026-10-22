import { useRef, useState } from 'react';
import { formatTime } from '../../api.js';
import { Button } from '../ui.jsx';

export const MEDIA_ACCEPT = '.mp4,.mov,.mkv,.webm,.m4v,.png,.jpg,.jpeg,.webp,.mp3,.wav,.m4a,.aac,.ogg,.flac,.opus';
export const MEDIA_TYPE = 'application/x-kva-media'; // what a media item carries when dragged to the timeline

const KIND = { video: ['🎞', 'Video'], image: ['🖼', 'Picture'], audio: ['♪', 'Sound'] };

// Upload files one after another; `done(id)` gets each new media id.
export function useUploads(actions) {
  const [uploads, setUploads] = useState([]); // {key, name, progress, error}
  const add = async (files, done) => {
    for (const file of files) {
      const key = `${file.name}-${Date.now()}-${Math.random()}`;
      setUploads((u) => [...u, { key, name: file.name, progress: 0 }]);
      const body = await actions.addMedia(file, (f) => setUploads((u) => u.map((x) => (x.key === key ? { ...x, progress: f } : x))));
      setUploads((u) => u.filter((x) => x.key !== key));
      if (body?.id && done) await done(body.id);
    }
  };
  return [uploads, add];
}

// The project's media: the upload, and every video, picture, music or sound effect added to it.
// Drop files here (or on the timeline), insert one at the playhead, or drag one onto the timeline.
export default function MediaBin({ project, tracks, actions, uploads, upload, onInsert, locked }) {
  const input = useRef(null);
  const [over, setOver] = useState(false);
  const used = new Set(tracks.flatMap((t) => t.clips.map((c) => c.media)).filter(Boolean));
  const items = Object.entries(project.media || {}).filter(([, m]) => !m.removed && m.file);

  const drop = (e) => {
    e.preventDefault();
    setOver(false);
    if (e.dataTransfer.files?.length) upload([...e.dataTransfer.files]);
  };

  return (
    <div className={`flex min-h-0 flex-1 flex-col ${over ? 'bg-accent-soft' : ''}`}
      onDragOver={(e) => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); setOver(true); } }}
      onDragLeave={() => setOver(false)} onDrop={drop}>
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <Button size="sm" disabled={locked} onClick={() => input.current?.click()}>+ Add files</Button>
        <span className="text-xs text-muted">Videos, pictures, music, sound effects — or drop them here.</span>
        <input ref={input} type="file" multiple accept={MEDIA_ACCEPT} className="hidden"
          onChange={(e) => { upload([...e.target.files]); e.target.value = ''; }} />
      </div>
      <ul className="scroll-quiet min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2">
        {uploads.map((u) => (
          <li key={u.key} className="rounded-lg border border-line p-2 text-xs">
            <p className="truncate font-medium">{u.name}</p>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-raised"><div className="h-full bg-accent transition-all" style={{ width: `${Math.max(3, u.progress * 100)}%` }} /></div>
            <p className="mt-1 text-faint">{u.progress < 1 ? `Uploading… ${Math.round(u.progress * 100)}%` : 'Reading the file…'}</p>
          </li>
        ))}
        {items.map(([mid, m]) => {
          const [icon, label] = KIND[m.kind] || ['•', m.kind];
          const thumb = m.kind === 'image' ? m.url : m.poster_url;
          return (
            <li key={mid} draggable={!locked} onDragStart={(e) => { e.dataTransfer.setData(MEDIA_TYPE, mid); e.dataTransfer.effectAllowed = 'copy'; }}
              className="group flex items-center gap-2.5 rounded-lg border border-line bg-panel p-1.5 hover:border-line-strong" title="Drag it onto the timeline, or press + to put it at the playhead">
              <span className="flex h-12 w-16 shrink-0 items-center justify-center overflow-hidden rounded bg-black text-lg text-white">
                {thumb ? <img src={thumb} alt="" className="h-full w-full object-cover" draggable={false} /> : icon}
              </span>
              <span className="min-w-0 flex-1 leading-tight">
                <span className="block truncate text-sm font-medium">{mid === 'source' ? `${m.name} (the original)` : m.name}</span>
                <span className="text-xs text-muted">{icon} {label}{m.duration ? ` · ${formatTime(m.duration)}` : ''}{m.width ? ` · ${m.width}×${m.height}` : ''}{used.has(mid) ? ' · on the timeline' : ''}</span>
              </span>
              <span className="flex shrink-0 flex-col gap-1">
                <Button size="sm" variant="soft" disabled={locked} onClick={() => onInsert(mid)} title={m.kind === 'audio' ? 'Add it to the Music & sound track at the playhead' : 'Insert it at the playhead (what follows moves later)'}>+</Button>
                {mid !== 'source' && (
                  <button type="button" disabled={locked || used.has(mid)} title={used.has(mid) ? 'It’s on the timeline: delete its clips first' : 'Remove it from this list'}
                    onClick={() => actions.removeMedia(mid)}
                    className="rounded px-1 text-xs text-faint hover:text-red-600 disabled:opacity-30">✕</button>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
