import { useEffect, useRef, useState } from 'react';
import { api, formatTime } from '../api.js';
import { renderSubtitleImages } from '../lib/subtitleImages.js';
import EditorPage from './editor/EditorPage.jsx';
import SegmentEditor from './SegmentEditor.jsx';
import StepProgress from './StepProgress.jsx';
import { Button, Card, ErrorBox, Notice } from './ui.jsx';
import VoiceOptions from './VoiceOptions.jsx';

const RUNNING = ['uploaded', 'processing', 'generating'];
const DEFAULT_OPTIONS = { voice: 'female', speed: 1, background: 'duck', burn_subtitles: false };
const normalize = (text) => text.split(/\s+/).filter(Boolean).join(' ');

// Once the voice exists the project opens in the editor; before that: progress and the review step.
const inEditor = (p) => ['done', 'exporting'].includes(p.status) || (p.status === 'error' && p.phase === 'export');

export default function ProjectPage({ id, health }) {
  const [project, setProject] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [pollKey, setPollKey] = useState(0);
  const [texts, setTexts] = useState({}); // Khmer lines edited here and not yet saved: id -> text
  const [options, setOptions] = useState(DEFAULT_OPTIONS);
  const [optionsLoaded, setOptionsLoaded] = useState(false);
  const [sending, setSending] = useState(false);
  const [actionError, setActionError] = useState(null);
  const video = useRef(null);
  const saveTimer = useRef(null);

  // Load the project, and keep polling while a job runs.
  useEffect(() => {
    let stopped = false;
    let timer;
    async function tick() {
      try {
        const p = await api.get(id);
        if (stopped) return;
        setProject(p);
        setLoadError(null);
        if (RUNNING.includes(p.status)) timer = setTimeout(tick, 1200);
      } catch (err) {
        if (!stopped) setLoadError(err);
      }
    }
    tick();
    return () => { stopped = true; clearTimeout(timer); };
  }, [id, pollKey]);

  // Start from the project's settings (or the voice engine's first voice).
  useEffect(() => {
    if (!project || optionsLoaded || !health) return;
    const voices = health.tts?.genders || ['female'];
    const saved = project.settings || {};
    setOptions({
      ...DEFAULT_OPTIONS,
      ...(saved.background ? { speed: saved.speed, background: saved.background } : {}),
      voice: voices.includes(saved.voice) ? saved.voice : voices.includes('female') ? 'female' : voices[0],
    });
    setOptionsLoaded(true);
  }, [project, health, optionsLoaded]);

  // Save edits a second after typing stops.
  useEffect(() => {
    clearTimeout(saveTimer.current);
    const pending = Object.entries(texts);
    if (!pending.length) return undefined;
    saveTimer.current = setTimeout(async () => {
      try {
        let latest = null;
        for (const [sid, khmer] of pending) latest = (await api.patchSentence(id, sid, { khmer_text: khmer })).project;
        setProject(latest);
        setTexts((current) => {
          const next = { ...current };
          for (const s of latest.sentences) if (next[s.id] !== undefined && normalize(next[s.id]) === s.khmer_text) delete next[s.id];
          return next;
        });
      } catch (err) {
        setActionError(err);
      }
    }, 1000);
    return () => clearTimeout(saveTimer.current);
  }, [texts, id]);

  if (loadError && !project) {
    return <div className="mx-auto max-w-6xl px-4 py-6"><ErrorBox error={loadError}><Button variant="secondary" onClick={() => { window.location.hash = '#/projects'; }}>My projects</Button></ErrorBox></div>;
  }
  if (!project) return <p className="px-5 py-8 text-muted">Loading…</p>;
  if (inEditor(project)) return <EditorPage id={id} initial={project} health={health} />;

  const running = RUNNING.includes(project.status);
  const sentences = project.sentences || [];
  const canEdit = sentences.length > 0 && !running;
  const generating = project.status === 'generating';

  async function generate() {
    clearTimeout(saveTimer.current);
    setSending(true);
    setActionError(null);
    try {
      const lines = sentences.map((s) => ({ id: s.id, khmer_text: texts[s.id] ?? s.khmer_text }));
      const body = { ...options, sentences: lines.filter((l) => texts[l.id] !== undefined) };
      if (options.burn_subtitles) {
        const originals = new Map(sentences.map((s) => [s.id, s.original_text]));
        const items = lines.filter((l) => l.khmer_text.trim()).map((l) => ({ id: l.id, text: l.khmer_text, original: originals.get(l.id) }));
        const { images, layout } = await renderSubtitleImages(items, project.video.width, project.video.height, project.settings.subtitle_style);
        Object.assign(body, { subtitle_images: images, subtitle_layout: layout });
      }
      const p = await api.generate(id, body);
      setTexts({});
      setProject(p);
      setPollKey((k) => k + 1);
    } catch (err) {
      setActionError(err);
    } finally {
      setSending(false);
    }
  }

  async function retry() {
    setActionError(null);
    try {
      setProject(await api.retry(id));
      setPollKey((k) => k + 1);
    } catch (err) {
      setActionError(err);
    }
  }

  function seek(t) {
    if (!video.current) return;
    video.current.currentTime = t;
    video.current.play().catch(() => {});
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-6 sm:py-8">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <a href="#/projects" className="text-sm text-accent-ink hover:underline">← My projects</a>
          <h1 className="truncate text-xl font-semibold">{project.name}</h1>
          <p className="text-sm text-muted">
            {formatTime(project.video?.duration || 0)}
            {sentences.length > 0 && ` · ${sentences.length} sentences`}
            {project.detected_lang && ` · heard ${project.detected_lang}`}
          </p>
        </div>
        <Button variant="secondary" onClick={() => { window.location.hash = ''; }}>New video</Button>
      </div>

      <Card><StepProgress project={project} /></Card>

      {project.status === 'error' && (
        <ErrorBox error={project.error}><Button onClick={retry}>Try again</Button></ErrorBox>
      )}
      {project.warnings?.length > 0 && !running && (
        <Notice>
          <ul className="list-disc space-y-1 pl-5">{project.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
        </Notice>
      )}

      {sentences.length > 0 && (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
          <Card>
            <div className="mb-4">
              <h2 className="text-lg font-semibold">Khmer script <span className="khmer font-normal text-faint">· អត្ថបទខ្មែរ</span></h2>
              <p className="text-sm text-muted">Fix any line you like. Press ▶ on a line to hear the original there. After generating, the editor opens so you can change anything.</p>
            </div>
            <video ref={video} src={project.source_url} controls playsInline preload="metadata" className="mb-4 max-h-64 w-full rounded-xl bg-black" />
            <SegmentEditor sentences={sentences} texts={texts} onSeek={seek} duration={project.video.duration} disabled={!canEdit}
              onChange={(sid, value) => setTexts((t) => ({ ...t, [sid]: value }))} />
          </Card>

          <div className="self-start lg:sticky lg:top-6">
            <Card>
              <VoiceOptions options={options} setOptions={setOptions} health={health} disabled={!canEdit || sending} />
              <Button size="lg" className="mt-6 w-full" onClick={generate} disabled={!canEdit || sending}>
                {generating ? 'Generating…' : sending ? 'Starting…' : 'Generate Voice'}
                <span className="khmer font-normal opacity-80">· បង្កើតសំឡេង</span>
              </Button>
              {actionError && <div className="mt-3"><ErrorBox error={actionError} /></div>}
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
