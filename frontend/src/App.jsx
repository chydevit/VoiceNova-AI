import { useEffect, useState } from 'react';
import { api } from './api.js';
import ProjectPage from './components/ProjectPage.jsx';
import ProjectsPage from './components/ProjectsPage.jsx';
import { IconButton, Notice } from './components/ui.jsx';
import UploadZone from './components/UploadZone.jsx';
import { setTheme, useTheme } from './lib/theme.js';

// Pages: #/ upload · #/projects My projects · #/p/<id> one project (progress, review or editor).
function route() {
  const hash = window.location.hash;
  const id = hash.match(/^#\/p\/([A-Za-z0-9]+)/)?.[1];
  if (id) return { page: 'project', id };
  if (hash.startsWith('#/projects')) return { page: 'projects' };
  return { page: 'home' };
}

function SetupWarnings({ health }) {
  if (!health) return null;
  if (health.offline) {
    return <Notice>Can’t reach the server. Start the backend with <code>python main.py</code> in the <code>backend</code> folder, then reload.</Notice>;
  }
  const problems = [];
  if (!health.ffmpeg) problems.push('FFmpeg is not installed — see the README.');
  for (const [name, part] of [['Speech-to-text', health.transcribe], ['Translation', health.translate], ['Khmer voice', health.tts]]) {
    if (part && !part.ok) problems.push(`${name}: ${part.reason}.`);
  }
  if (!problems.length) return null;
  return (
    <Notice>
      <p className="font-semibold">Setup needed</p>
      <ul className="mt-1 list-disc pl-5">{problems.map((p) => <li key={p}>{p}</li>)}</ul>
    </Notice>
  );
}

function ThemeToggle() {
  const theme = useTheme();
  const next = theme === 'dark' ? 'light' : 'dark';
  return (
    <IconButton label={`Switch to ${next} theme`} onClick={() => setTheme(next)}>
      {theme === 'dark' ? (
        <svg viewBox="0 0 24 24" className="h-4.5 w-4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
      ) : (
        <svg viewBox="0 0 24 24" className="h-4.5 w-4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" /></svg>
      )}
    </IconButton>
  );
}

const STEPS = [
  ['1', 'Upload', 'Any language, up to 500 MB'],
  ['2', 'Check the Khmer', 'Every line, before voicing'],
  ['3', 'Edit & export', 'Fix anything, export only changes'],
];

export default function App() {
  const [where, setWhere] = useState(route);
  const [health, setHealth] = useState(null);

  useEffect(() => {
    const onHash = () => { setWhere(route()); window.scrollTo(0, 0); };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    api.health().then(setHealth).catch(() => setHealth({ offline: true }));
  }, []);

  const nav = (page) => `rounded-lg px-2.5 py-1.5 text-sm font-medium whitespace-nowrap transition ${where.page === page ? 'bg-accent-soft text-accent-ink' : 'text-muted hover:bg-raised hover:text-ink'}`;

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 h-14 border-b border-line bg-panel/85 backdrop-blur">
        <div className="flex h-full items-center gap-3 px-3 sm:px-5">
          <a href="#" className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 to-fuchsia-500 text-base font-bold text-white shadow-sm">ក</span>
            <span className="hidden leading-tight min-[420px]:block">
              <span className="block whitespace-nowrap text-sm font-semibold">Khmer Voice AI</span>
              <span className="khmer hidden text-[11px] text-muted sm:block">បញ្ចូលសំឡេងខ្មែរដោយ AI</span>
            </span>
          </a>
          <nav className="ml-auto flex items-center gap-1">
            {health?.tts?.label && <span className="mr-2 hidden text-xs text-faint xl:block">Voice: {health.tts.label}</span>}
            <a href="#/projects" className={nav('projects')}>My projects</a>
            <a href="#" className={nav('home')}>New video</a>
            <ThemeToggle />
          </nav>
        </div>
      </header>

      {where.page === 'project' ? (
        <main>
          {health && (health.offline || !health.ffmpeg) && <div className="px-3 pt-3 sm:px-5"><SetupWarnings health={health} /></div>}
          <ProjectPage key={where.id} id={where.id} health={health} />
        </main>
      ) : (
        <main className="mx-auto max-w-6xl space-y-6 px-4 py-6 sm:py-10">
          <SetupWarnings health={health} />
          {where.page === 'projects' && <ProjectsPage />}
          {where.page === 'home' && (
            <div className="mx-auto max-w-3xl space-y-8">
              <div className="text-center">
                <p className="mb-3 inline-flex items-center gap-1.5 rounded-full border border-line bg-panel px-3 py-1 text-xs font-medium text-muted">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> Transcribe · translate · voice · edit
                </p>
                <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
                  Give any video a{' '}
                  <span className="bg-gradient-to-r from-indigo-500 to-fuchsia-500 bg-clip-text text-transparent">Khmer voice</span>
                </h1>
                <p className="khmer mt-1 text-lg text-muted">បំលែងវីដេអូណាមួយ ឱ្យនិយាយភាសាខ្មែរ</p>
                <p className="mx-auto mt-3 max-w-xl text-sm text-muted">
                  Upload a video. It’s transcribed, translated into natural spoken Khmer and voiced — timed to the original. Then change anything in the editor.
                </p>
              </div>
              <UploadZone health={health} onUploaded={(p) => { window.location.hash = `#/p/${p.id}`; }} />
              <ol className="grid gap-3 sm:grid-cols-3">
                {STEPS.map(([n, title, note]) => (
                  <li key={n} className="flex items-start gap-3 rounded-xl border border-line bg-panel p-3">
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-sm font-bold text-accent-ink">{n}</span>
                    <span className="leading-tight"><span className="block text-sm font-semibold">{title}</span><span className="text-xs text-muted">{note}</span></span>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </main>
      )}
    </div>
  );
}
