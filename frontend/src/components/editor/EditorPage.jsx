import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, formatTime } from '../../api.js';
import { VoicePreview } from '../../lib/previewAudio.js';
import { DEFAULT_TITLE, renderSubtitleImages, renderTitleImage } from '../../lib/subtitleImages.js';
import { useEditor } from '../../lib/useEditor.js';
import { Button, Chip, ErrorBox, IconButton, Notice, Panel, Tabs, inputCss } from '../ui.jsx';
import CoverPanel from './CoverPanel.jsx';
import ExportPanel from './ExportPanel.jsx';
import Player from './Player.jsx';
import SentenceRow from './SentenceRow.jsx';
import SettingsPanel from './SettingsPanel.jsx';
import SubtitlePanel from './SubtitlePanel.jsx';
import TitlePanel from './TitlePanel.jsx';
import SuggestDialog from './SuggestDialog.jsx';
import Timeline from './Timeline.jsx';

const ATTENTION = ['edited', 'failed', 'too_long', 'empty'];
const toCheck = (s) => ATTENTION.includes(s.status) || (!!s.voice_warning && !!s.audio_url); // incl. a voice that may be wrong
const subtitleText = (s) => (s.subtitle_text ?? s.khmer_text).trim();

// Edit after generating: change any sentence, hear it at once, export only what changed.
//
// Desktop: a one-screen studio — sentences | preview | inspector (export · subtitles · audio),
// with the timeline along the bottom. Phones and tablets: the same panels, one under another.
export default function EditorPage({ id, initial, health }) {
  const { project, sentences, busy, error, toast, actions, saving } = useEditor(id, initial);
  const [selectedId, setSelectedId] = useState(null);
  const [time, setTime] = useState(0);
  const [suggestFor, setSuggestFor] = useState(null);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState('export');
  const [hiddenWarnings, setHiddenWarnings] = useState('');
  const [media, setMedia] = useState({ filmstrip: null, waveform: null });
  const [subtitleDraft, setSubtitleDraft] = useState(null); // style being tried out, not saved yet
  const [showSubtitles, setShowSubtitles] = useState(true);
  const [titleDraft, setTitleDraft] = useState(null); // title being written, not saved yet
  const [coverDraft, setCoverDraft] = useState(null); // covering area being placed, not saved yet
  const [editingCover, setEditingCover] = useState(false);
  const control = useMemo(() => ({ video: { current: null }, preview: new VoicePreview(), stopAt: { current: null } }), []);
  const focusNext = useRef(null);
  const list = useRef(null);

  const locked = project.status === 'exporting';
  const voices = health?.tts?.genders || ['female'];
  const provider = health?.tts?.provider;

  useEffect(() => {
    api.filmstrip(id).then((filmstrip) => setMedia((m) => ({ ...m, filmstrip }))).catch(() => {});
    api.waveform(id).then((waveform) => setMedia((m) => ({ ...m, waveform }))).catch(() => {});
  }, [id]);

  const musicUrl = project.background_url; // the background without the original voice, once it exists
  useEffect(() => {
    if (musicUrl) api.waveform(id, 'background').then((music) => setMedia((m) => ({ ...m, music }))).catch(() => {});
  }, [id, musicUrl]);
  const voiceRemoved = project.settings.background === 'separate' && !!media.music;

  const seek = useCallback((t) => {
    const v = control.video.current;
    if (!v) return;
    control.stopAt.current = null;
    v.currentTime = t;
  }, [control]);

  const play = useCallback((s) => {
    const v = control.video.current;
    if (!v) return;
    v.currentTime = s.start;
    control.stopAt.current = s.end;
    v.play().catch(() => {});
  }, [control]);

  // Select a sentence and move the playhead to it.
  const go = useCallback((s) => {
    if (!s) return;
    setSelectedId(s.id);
    seek(s.start);
  }, [seek]);

  const numbers = useMemo(() => new Map(sentences.map((s, i) => [s.id, i + 1])), [sentences]);
  const latest = useRef({ sentences, selectedId });
  latest.current = { sentences, selectedId };

  // Keyboard (outside text boxes, where the browser's own text undo applies):
  // Ctrl/⌘+Z undo · Ctrl+Y or Ctrl/⌘+Shift+Z redo · Space play/pause · ↑/↓ previous/next sentence.
  useEffect(() => {
    const onKey = (e) => {
      if (e.target.closest?.('input, textarea, select, dialog')) return;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && key === 'z') {
        e.preventDefault();
        if (e.shiftKey) actions.redo(); else actions.undo();
      } else if (mod && key === 'y') {
        e.preventDefault();
        actions.redo();
      } else if (key === ' ' && !e.target.closest?.('button, a, video')) {
        e.preventDefault();
        const v = control.video.current;
        if (v) { control.stopAt.current = null; if (v.paused) v.play().catch(() => {}); else v.pause(); }
      } else if ((key === 'arrowdown' || key === 'arrowup') && !mod) {
        e.preventDefault();
        const { sentences: items, selectedId: sid } = latest.current;
        const i = items.findIndex((s) => s.id === sid);
        go(items[key === 'arrowdown' ? Math.min(items.length - 1, i + 1) : Math.max(0, i - 1)]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [actions, control, go]);

  // Show the selected sentence in the list (and put the cursor in a newly added one).
  useEffect(() => {
    if (!selectedId) return;
    const row = document.getElementById(`row-${selectedId}`);
    row?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    if (focusNext.current === selectedId) {
      focusNext.current = null;
      setTimeout(() => row?.querySelector('textarea')?.focus(), 50);
    }
  }, [selectedId, sentences.length]);

  // While playing, the list follows the sentence being spoken (unless you're typing in it).
  const playingId = sentences.find((s) => time >= s.start && time < s.end)?.id;
  useEffect(() => {
    const v = control.video.current;
    if (!playingId || !v || v.paused || list.current?.contains(document.activeElement)) return;
    document.getElementById(`row-${playingId}`)?.scrollIntoView({ block: 'nearest' });
  }, [playingId, control]);

  const add = useCallback(async (start) => {
    const body = await actions.add({ start });
    if (body?.id) {
      focusNext.current = body.id;
      setFilter('all');
      setSearch('');
      setSelectedId(body.id);
    }
  }, [actions]);

  async function exportVideo(formats, audioFormat, style = project.settings.subtitle_style, title = project.settings.title) {
    setTab('export');
    const body = { formats, audio_format: audioFormat };
    if (formats.includes('mp4') || formats.includes('mp4_subs')) {
      const image = await renderTitleImage(title, project.video.width, project.video.height);
      if (image) body.title_image = image;
    }
    if (formats.includes('mp4_subs')) {
      const items = sentences.filter(subtitleText).map((s) => ({ id: s.id, text: subtitleText(s), original: s.original_text }));
      const { images, layout } = await renderSubtitleImages(items, project.video.width, project.video.height, style);
      Object.assign(body, { subtitle_images: images, subtitle_layout: layout });
    }
    actions.exportVideo(body);
  }

  const exportWithPrefs = () => {
    const prefs = project.export_prefs || { formats: ['mp4', 'srt'], audio_format: 'mp3' };
    exportVideo(prefs.formats, prefs.audio_format);
  };

  async function applySubtitles(style) {
    const body = await actions.settings({ subtitle_style: style });
    if (body) setSubtitleDraft(null);
    return body;
  }

  async function applySubtitlesAndExport(style) {
    if (!(await applySubtitles(style))) return;
    const prefs = project.export_prefs || {};
    const formats = [...new Set([...(prefs.formats || []).filter((f) => f !== 'mp4'), 'mp4_subs', 'srt'])];
    exportVideo(formats, prefs.audio_format || 'mp3', style);
  }

  async function applyTitle(title) {
    const body = await actions.settings({ title });
    if (body) setTitleDraft(null);
    return body;
  }

  async function applyTitleAndExport(title) {
    if (!(await applyTitle(title))) return;
    const prefs = project.export_prefs || { formats: ['mp4', 'srt'], audio_format: 'mp3' };
    const formats = prefs.formats.some((f) => f.startsWith('mp4')) ? prefs.formats : ['mp4', ...prefs.formats];
    exportVideo(formats, prefs.audio_format || 'mp3', project.settings.subtitle_style, title);
  }

  async function applyCover(cover) {
    const body = await actions.settings({ cover });
    if (body) setCoverDraft(null);
    return body;
  }

  // Jump to the middle of a sentence near the playhead, where a burned-in subtitle is on screen.
  const showSpeech = () => {
    const t = control.video.current?.currentTime || 0;
    const s = sentences.find((x) => x.start >= t && x.end - x.start >= 1) || sentences.find((x) => x.end - x.start >= 1);
    if (s) seek((s.start + s.end) / 2);
  };

  async function pickSuggestion(text) {
    const sid = suggestFor;
    setSuggestFor(null);
    const body = await actions.patch(sid, { khmer_text: text });
    if (body) actions.regenerate(sid);
  }

  const suggesting = suggestFor && sentences.find((s) => s.id === suggestFor);
  const query = search.trim().toLowerCase();
  const shown = sentences.filter((s) => (filter === 'all' || toCheck(s) || s.id === selectedId)
    && (!query || s.khmer_text.toLowerCase().includes(query) || s.original_text.toLowerCase().includes(query)));
  const counts = project.counts;
  const attention = sentences.filter(toCheck).length;
  const changed = (counts.edited || 0) + (counts.failed || 0);
  const { history } = project;
  const warningsKey = (project.warnings || []).join('|');
  const exporting = project.status === 'exporting';
  const videoCuts = project.settings.video_cuts || [];
  const removedLength = videoCuts.reduce((sum, c) => sum + (c.end - c.start), 0);
  const isRemoved = (s) => videoCuts.some((c) => c.start - 0.01 <= s.start && s.end <= c.end + 0.01);

  return (
    <div className="flex flex-col lg:h-[calc(100dvh-3.5rem)]">
      {/* top bar */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line bg-panel px-3 py-2 sm:px-4">
        <IconButton label="My projects" onClick={() => { window.location.hash = '#/projects'; }}>
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
        </IconButton>
        <div className="min-w-0 flex-1 basis-48">
          <h1 className="truncate text-sm font-semibold sm:text-base">{project.name}</h1>
          <p className="truncate text-xs text-muted">
            {formatTime(project.video.duration)}{removedLength > 0 && <span className="text-red-600 dark:text-red-400"> → {formatTime(project.video.duration - removedLength)} after cuts</span>} · {sentences.length} sentences · <span className={saving ? 'text-accent-ink' : ''}>{saving ? 'Saving…' : 'All changes saved'}</span>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {counts.too_long > 0 && (
            <button type="button" onClick={() => setFilter('attention')} title="Show the sentences to check"><Chip tone="amber">⚠ {counts.too_long} too long</Chip></button>
          )}
          {counts.check_voice > 0 && (
            <button type="button" onClick={() => setFilter('attention')} title="Voices that may have come out wrong, even after voicing them again"><Chip tone="amber">⚠ {counts.check_voice} check voice</Chip></button>
          )}
          {changed > 0 && (
            <button type="button" onClick={() => setFilter('attention')} title="Show the sentences to check"><Chip tone="accent">{changed} need{changed === 1 ? 's' : ''} voice</Chip></button>
          )}
          <span className="mx-1 hidden h-5 w-px bg-line sm:block" />
          <IconButton label={history.undo_label ? `Undo: ${history.undo_label} (Ctrl+Z)` : 'Nothing to undo'} disabled={locked || !history.undo} onClick={actions.undo}>
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" /></svg>
          </IconButton>
          <IconButton label={history.redo_label ? `Redo: ${history.redo_label} (Ctrl+Y)` : 'Nothing to redo'} disabled={locked || !history.redo} onClick={actions.redo}>
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m15 14 5-5-5-5" /><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" /></svg>
          </IconButton>
          <Button variant="soft" size="sm" disabled={locked || busy['#check'] || busy['*'] || !sentences.some((s) => s.audio_url)} onClick={actions.checkVoices}
            title="Check every voice clip for mistakes (silent, cut off, skipped words, long pauses, other-language letters) and voice the wrong ones again">
            {busy['#check'] ? 'Checking…' : 'Check voices'}
          </Button>
          <Button variant="soft" size="sm" disabled={locked || !changed || busy['*']} onClick={actions.regenerateChanged} title="Make the voice of every sentence that changed">
            {busy['*'] ? 'Voicing…' : `Voice changed${changed ? ` (${changed})` : ''}`}
          </Button>
          <Button size="sm" className="px-3.5" disabled={exporting} onClick={exportWithPrefs} title="Export with the formats chosen in the Export tab">
            {exporting ? `Exporting ${Math.round((project.progress || 0) * 100)}%` : 'Export'}
            <span className="khmer hidden font-normal opacity-80 sm:inline">· នាំចេញ</span>
          </Button>
        </div>
      </div>

      {/* messages */}
      {(project.status === 'error' || error || (project.warnings?.length > 0 && !locked && hiddenWarnings !== warningsKey)) && (
        <div className="space-y-2 px-3 pt-3">
          {project.status === 'error' && <ErrorBox compact error={project.error}><Button size="sm" variant="secondary" onClick={actions.retry}>OK</Button></ErrorBox>}
          {error && <ErrorBox compact error={error}><Button size="sm" variant="secondary" onClick={actions.dismissError}>Dismiss</Button></ErrorBox>}
          {project.warnings?.length > 0 && !locked && hiddenWarnings !== warningsKey && (
            <Notice className="flex items-start gap-2 py-2">
              <ul className="flex-1 space-y-0.5">{project.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
              <button type="button" className="shrink-0 text-xs font-semibold underline" onClick={() => setHiddenWarnings(warningsKey)}>Hide</button>
            </Notice>
          )}
        </div>
      )}

      {/* studio */}
      <div className="grid min-h-0 flex-1 gap-3 p-3 lg:grid-cols-[minmax(300px,380px)_minmax(0,1fr)_340px] xl:grid-cols-[400px_minmax(0,1fr)_360px]">
        <Panel
          className="order-2 max-lg:max-h-[85vh] lg:order-1"
          title={<span>Sentences <span className="khmer font-normal text-faint">· ប្រយោគ</span></span>}
          actions={<Button size="sm" variant="soft" disabled={locked} onClick={() => add(Math.round((control.video.current?.currentTime || 0) * 100) / 100)} title="Add a sentence at the playhead">+ Add at {formatTime(time)}</Button>}
          bodyClassName="flex flex-col"
        >
          <div className="flex items-center gap-2 border-b border-line px-3 py-2">
            <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search text…" aria-label="Search the sentences" className={`${inputCss} min-w-0 flex-1 py-1 text-xs`} />
            <span className="inline-flex shrink-0 overflow-hidden rounded-lg border border-line-strong text-xs">
              <button type="button" className={`px-2 py-1 ${filter === 'all' ? 'bg-ink text-canvas' : 'hover:bg-raised'}`} onClick={() => setFilter('all')}>All</button>
              <button type="button" className={`px-2 py-1 ${filter === 'attention' ? 'bg-ink text-canvas' : 'hover:bg-raised'}`} onClick={() => setFilter('attention')}>To check {attention}</button>
            </span>
          </div>
          {shown.length ? (
            <ol ref={list} className="scroll-quiet min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2">
              {shown.map((s) => (
                <SentenceRow
                  key={s.id} s={s} number={numbers.get(s.id)} isLast={s === sentences[sentences.length - 1]}
                  voices={voices} provider={provider} selected={s.id === selectedId} playing={s.id === playingId}
                  busy={busy[s.id] || (busy['*'] && ATTENTION.includes(s.status) ? 'regenerate' : undefined)} locked={locked} removed={isRemoved(s)}
                  actions={actions} onSelect={go} onPlay={play} onSuggest={setSuggestFor}
                />
              ))}
            </ol>
          ) : (
            <p className="p-6 text-center text-sm text-muted">
              {query ? 'No sentence contains that text.' : 'Nothing to check — every sentence is voiced and fits its time. 🎉'}
            </p>
          )}
          <p className="hidden border-t border-line px-3 py-1.5 text-[11px] text-faint lg:block">↑ ↓ move between sentences · Space play/pause · Ctrl+Z undo</p>
        </Panel>

        <Panel className="order-1 overflow-hidden lg:order-2" bodyClassName="flex flex-col">
          <Player project={project} sentences={sentences} control={control} onTime={setTime} time={time}
            subtitleStyle={subtitleDraft} showSubtitles={showSubtitles} setShowSubtitles={setShowSubtitles}
            numbers={numbers} onStep={go} cover={coverDraft} editingCover={editingCover} onCoverChange={setCoverDraft} title={titleDraft}
            onSubtitleMove={tab === 'subtitles' && !locked ? (pos) => setSubtitleDraft((cur) => ({ ...(cur || project.settings.subtitle_style), ...pos })) : null} />
        </Panel>

        <Panel className="order-3" bodyClassName="flex flex-col">
          <div className="border-b border-line p-2">
            <Tabs value={tab} onChange={setTab} tabs={[
              { key: 'export', label: 'Export', dot: exporting },
              { key: 'subtitles', label: 'Subtitles', dot: !!subtitleDraft || !!coverDraft || !!titleDraft },
              { key: 'audio', label: 'Audio', dot: project.separation?.state === 'running' },
            ]} />
          </div>
          <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto p-4">
            {tab === 'export' && <ExportPanel key={project.versions.length} project={project} locked={locked} onExport={exportVideo} actions={actions} />}
            {tab === 'subtitles' && (
              <>
                <SubtitlePanel saved={project.settings.subtitle_style} draft={subtitleDraft} setDraft={setSubtitleDraft} show={showSubtitles} setShow={setShowSubtitles}
                  locked={locked} onApply={applySubtitles} onApplyExport={applySubtitlesAndExport} />
                <TitlePanel saved={project.settings.title || DEFAULT_TITLE} draft={titleDraft} setDraft={setTitleDraft}
                  locked={locked} onApply={applyTitle} onApplyExport={applyTitleAndExport} />
                <CoverPanel projectId={id} saved={project.settings.cover} draft={coverDraft} setDraft={setCoverDraft}
                  editing={editingCover} setEditing={setEditingCover} locked={locked} onApply={applyCover} onShowSpeech={showSpeech} />
              </>
            )}
            {tab === 'audio' && <SettingsPanel project={project} health={health} locked={locked} actions={actions} />}
          </div>
        </Panel>
      </div>

      <div className="hidden px-3 pb-3 md:block">
        <Panel>
          <Timeline
            project={project} sentences={sentences} videoRef={control.video} selectedId={selectedId}
            onSelect={setSelectedId} onSeek={seek} onTiming={(sid, start, end) => actions.patch(sid, { start, end })} onAdd={add}
            onCuts={actions.backgroundCuts} onVideoCuts={actions.videoCuts} onOpenAudio={() => setTab('audio')}
            filmstrip={media.filmstrip} waveform={voiceRemoved ? media.music : media.waveform} voiceRemoved={voiceRemoved}
          />
        </Panel>
      </div>

      {suggesting && (
        <SuggestDialog projectId={id} sentence={suggesting} onPick={pickSuggestion} onClose={() => setSuggestFor(null)} />
      )}
      {toast && (
        <div role="status" className="pointer-events-none fixed inset-x-0 bottom-4 z-50 mx-auto w-fit max-w-[calc(100vw-32px)] rounded-xl bg-ink px-4 py-2.5 text-sm text-canvas shadow-lg">
          {toast.text}
        </div>
      )}
    </div>
  );
}
