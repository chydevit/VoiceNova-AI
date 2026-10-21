import { useEffect, useState } from 'react';
import { api, formatTime, timeAgo } from '../api.js';
import { Button, Card, ErrorBox } from './ui.jsx';

const STATUS = {
  uploaded: ['Uploading', 'bg-raised text-ink'],
  processing: ['Transcribing & translating…', 'bg-accent-soft text-accent-ink'],
  review: ['Ready to check', 'bg-amber-500/15 text-amber-800 dark:text-amber-300'],
  generating: ['Generating voice…', 'bg-accent-soft text-accent-ink'],
  exporting: ['Exporting…', 'bg-accent-soft text-accent-ink'],
  done: ['Ready to edit', 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'],
  error: ['Needs attention', 'bg-red-500/15 text-red-700 dark:text-red-300'],
};

// "My Projects": every video, newest edit first. Open one to keep editing.
export default function ProjectsPage() {
  const [projects, setProjects] = useState(null);
  const [error, setError] = useState(null);
  const [confirm, setConfirm] = useState(null);

  const load = () => api.list().then(setProjects).catch(setError);
  useEffect(() => { load(); }, []);

  async function remove(id) {
    setConfirm(null);
    try {
      await api.remove(id);
      load();
    } catch (err) {
      setError(err);
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">My projects</h1>
          <p className="khmer text-muted">គម្រោងរបស់ខ្ញុំ</p>
        </div>
        <Button onClick={() => { window.location.hash = ''; }}>+ New video</Button>
      </div>
      {error && <ErrorBox error={error} />}
      {projects === null && !error && <p className="text-muted">Loading…</p>}
      {projects?.length === 0 && (
        <Card className="text-center text-muted">No projects yet. <a href="#" className="font-semibold text-accent-ink hover:underline">Upload a video</a> to start.</Card>
      )}
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {projects?.map((p) => {
          const [label, css] = STATUS[p.status] || STATUS.error;
          return (
            <li key={p.id} className="group overflow-hidden rounded-2xl border border-line bg-panel shadow-sm transition hover:-translate-y-0.5 hover:border-accent/50 hover:shadow-md">
              <a href={`#/p/${p.id}`} className="block">
                <div className="relative aspect-video bg-black">
                  {p.thumb_url && <img src={p.thumb_url} alt="" loading="lazy" className="h-full w-full object-cover opacity-95 transition group-hover:opacity-100" />}
                  {p.duration && <span className="absolute bottom-2 right-2 rounded-md bg-black/70 px-1.5 py-0.5 font-mono text-[11px] text-white">{formatTime(p.duration).replace(/\.\d$/, '')}</span>}
                </div>
                <div className="p-3">
                  <p className="truncate font-semibold" title={p.name}>{p.name}</p>
                  <p className="text-xs text-muted">
                    {p.sentences} sentences · {p.versions} export{p.versions === 1 ? '' : 's'} · edited {timeAgo(p.updated_at)}
                  </p>
                  <div className="mt-2 flex items-center gap-2">
                    <span className={`rounded-md px-2 py-0.5 text-xs font-medium ${css}`}>{label}</span>
                    {p.status === 'done' && p.needs_work > 0 && <span className="text-xs text-amber-700 dark:text-amber-300">{p.needs_work} sentence{p.needs_work === 1 ? '' : 's'} to check</span>}
                  </div>
                </div>
              </a>
              <div className="flex justify-end border-t border-line px-3 py-2 text-xs">
                {confirm === p.id ? (
                  <span className="flex items-center gap-2 text-red-700 dark:text-red-300">
                    Delete the video and every export?
                    <button type="button" className="rounded-lg bg-red-600 px-2 py-1 font-semibold text-white hover:bg-red-700" onClick={() => remove(p.id)}>Delete</button>
                    <button type="button" className="px-1 py-1 underline" onClick={() => setConfirm(null)}>Cancel</button>
                  </span>
                ) : (
                  <button type="button" className="rounded-lg px-2 py-1 text-muted hover:bg-red-500/10 hover:text-red-600" onClick={() => setConfirm(p.id)}>🗑 Delete</button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
