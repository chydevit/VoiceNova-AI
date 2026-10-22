import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, formatTime } from '../../api.js';
import { Playback } from '../../lib/playback.js';
import { DEFAULT_TITLE, renderSubtitleImages, renderTextImage, renderTitleImage } from '../../lib/subtitleImages.js';
import { canvasSize, findClip, inside, keptRanges, skippedRanges, timelineEnd, trackOf, withDrafts, withVoice } from '../../lib/timeline.js';
import { useEditor } from '../../lib/useEditor.js';
import { Button, Chip, ErrorBox, IconButton, Notice, Panel, Tabs, inputCss } from '../ui.jsx';
import ClipPanel from './ClipPanel.jsx';
import CoverPanel from './CoverPanel.jsx';
import ExportPanel from './ExportPanel.jsx';
import MediaBin, { useUploads } from './MediaBin.jsx';
import Player from './Player.jsx';
import SentenceRow from './SentenceRow.jsx';
import SettingsPanel from './SettingsPanel.jsx';
import SubtitlePanel from './SubtitlePanel.jsx';
import TitlePanel from './TitlePanel.jsx';
import SuggestDialog from './SuggestDialog.jsx';
import RegenerateDialog, { regenerateScopes } from './RegenerateDialog.jsx';
import VoiceLineDialog from './VoiceLineDialog.jsx';
import { renderWatermarkImages } from '../../lib/watermark.js';
import WatermarkPanel from './WatermarkPanel.jsx';
import WatermarkPresets from './WatermarkPresets.jsx';
import BottomSheet from './timeline/BottomSheet.jsx';
import MobileTimeline from './timeline/MobileTimeline.jsx';
import Timeline, { DeleteChoice } from './timeline/Timeline.jsx';
import TimelineDock, { MiniProgress } from './timeline/TimelineDock.jsx';
import { useTimelineTools } from './timeline/tools.js';
import { usePanelView } from './timeline/usePanelView.js';

const ATTENTION = ['edited', 'failed', 'too_long', 'empty'];
const toCheck = (s) => ATTENTION.includes(s.status) || (!!s.voice_warning && !!s.audio_url); // incl. a voice that may be wrong
const subtitleText = (s) => (s.subtitle_text ?? s.khmer_text).trim();

// Edit after generating: change any sentence, hear it at once, export only what changed.
//
// Desktop: a one-screen studio — sentences | preview | inspector (export · subtitles · audio),
// with the multi-track timeline along the bottom. Phones and tablets: the same panels, one under
// another, and a simplified one-strip timeline.
export default function EditorPage({ id, initial, health }) {
  const { project, sentences, busy, error, toast, actions, saving, say } = useEditor(id, initial);
  const [selection, setSelection] = useState([]); // selected clips (and sentences); the last one is the main one
  const selectedId = selection[selection.length - 1] ?? null;
  const setSelectedId = useCallback((sid) => setSelection(sid ? [sid] : []), []);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [suggestFor, setSuggestFor] = useState(null);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState('export');
  const [side, setSide] = useState('sentences'); // the left panel: sentences | media
  const [voiceLine, setVoiceLine] = useState(null); // + Voice line: {at, room}
  const [regen, setRegen] = useState(null); // the Regenerate dialog: {scope, what}
  const [resync, setResync] = useState(null); // after an edit, sentences that no longer fit: {ids}
  const [waves, setWaves] = useState({}); // media id -> its sound's peaks (for the music track)
  const [hiddenWarnings, setHiddenWarnings] = useState('');
  const [hideUntranslated, setHideUntranslated] = useState(0); // "Hide" on the untranslated notice: for that many
  const [media, setMedia] = useState({ filmstrip: null, waveform: null });
  const [subtitleDraft, setSubtitleDraft] = useState(null); // style being tried out, not saved yet
  const [showSubtitles, setShowSubtitles] = useState(true);
  const [titleDraft, setTitleDraft] = useState(null); // title being written, not saved yet
  const [coverDraft, setCoverDraft] = useState(null); // covering area being placed, not saved yet
  const [editingCover, setEditingCover] = useState(false);
  const control = useMemo(() => ({ playback: new Playback() }), []);
  const { playback } = control;
  const focusNext = useRef(null);
  const list = useRef(null);
  const savedTracks = useMemo(() => withVoice(project.timeline, sentences), [project.timeline, sentences]);
  const [soundDraft, setSoundDraft] = useState({}); // volumes being changed: clip id or "track:<id>" -> fields not saved yet
  const tracks = useMemo(() => withDrafts(savedTracks, soundDraft), [savedTracks, soundDraft]); // what is shown and heard
  const shownSentences = useMemo(() => trackOf(tracks, 'voice').clips, [tracks]);
  const tools = useTimelineTools({ projectId: id, tracks, playback, actions, selection, setSelection, fps: project.video.fps || 30, say });
  const panel = usePanelView(id, project.view); // the timeline panel's size and look, kept with the project

  // A volume being changed (a slider, − / +, a point of a volume line dragged): heard and drawn at
  // once, saved a moment after the last change (the server makes a burst of them one undo step).
  const pendingSound = useRef({}); // key -> {fields, timer}
  const editSound = useCallback((key, patch, save, now = false) => {
    const prev = pendingSound.current[key];
    const fields = { ...prev?.fields, ...patch };
    clearTimeout(prev?.timer);
    setSoundDraft((d) => ({ ...d, [key]: fields }));
    const commit = async () => {
      if (pendingSound.current[key]?.fields === fields) delete pendingSound.current[key];
      await save(fields);
      setSoundDraft((d) => { // nothing newer meanwhile: the saved project shows it now
        if (d[key] !== fields) return d;
        const next = { ...d };
        delete next[key];
        return next;
      });
    };
    pendingSound.current[key] = { fields, commit, timer: now ? null : setTimeout(commit, 350) };
    if (now) commit();
  }, []);
  // Save the volumes still waiting now (before undo, redo, an export, leaving the editor).
  const flushSound = useCallback(() => Promise.all(Object.values(pendingSound.current).map((p) => {
    if (!p.timer) return null; // already being saved
    clearTimeout(p.timer);
    p.timer = null;
    return p.commit();
  })), []);
  useEffect(() => () => { flushSound(); }, [flushSound]);
  const undo = useCallback(async () => { await flushSound(); actions.undo(); }, [flushSound, actions]);
  const redo = useCallback(async () => { await flushSound(); actions.redo(); }, [flushSound, actions]);
  const toolsNow = useRef(tools);
  toolsNow.current = tools;
  const sound = useMemo(() => ({ // stable, so the sentence rows don't redraw for it
    track: (tid, patch, now) => editSound(`track:${tid}`, patch, (f) => actions.track(tid, f), now),
    clip: (clip, patch, now) => editSound(clip.id, patch, (f) => toolsNow.current.setProps(clip, f), now),
  }), [editSound, actions]);
  const [uploads, upload] = useUploads(actions);

  // Insert media where it was dropped (several files: one after the other).
  const dropFiles = useCallback((files, t) => {
    let at = t;
    upload(files, async (mid) => {
      const body = await tools.insert(mid, at);
      const placed = body && withVoice(body.project.timeline, body.project.sentences).flatMap((tr) => tr.clips).find((c) => c.id === body.id);
      if (placed && placed.type !== 'audio') at = placed.end;
    });
  }, [upload, tools]);

  const dropMedia = useCallback((mid, t) => tools.insert(mid, t), [tools]);
  const openMixer = useCallback(() => setTab('audio'), []);

  // The peaks of every sound file on the music track (for its waveform).
  useEffect(() => {
    for (const [mid, m] of Object.entries(project.media || {})) {
      if (mid !== 'source' && m.wave_url && !waves[mid]) { // music, sound effects, and added videos' sound
        setWaves((w) => ({ ...w, [mid]: { loading: true } }));
        fetch(m.wave_url).then((r) => r.json()).then((wave) => setWaves((w) => ({ ...w, [mid]: wave }))).catch(() => {});
      }
    }
  }, [project.media]); // eslint-disable-line react-hooks/exhaustive-deps

  // + Voice line: a new sentence at the playhead, voiced right away.
  const openVoiceLine = useCallback(() => {
    const at = Math.round(playback.t * 100) / 100;
    const next = sentences.find((s) => s.start > at + 0.001);
    const inside = sentences.find((s) => s.start - 0.001 <= at && at < s.end - 0.001);
    if (inside) { say(`There's already a sentence at ${formatTime(at)} — move the playhead to a pause.`); return; }
    setVoiceLine({ at, room: (next ? next.start : timelineEnd(tracks)) - at });
  }, [playback, sentences, tracks, say]);
  // Regenerate: the dialog opens on the selected sentences, the In/Out part, or from the playhead.
  const openRegenerate = useCallback((scope, what = 'voice') => {
    const t = latest.current.tools;
    setRegen({ scope: scope || (t.picked.length ? 'selected' : t.full ? 'range' : 'from'), what, at: playback.t });
  }, [playback]);
  const runRegenerate = useCallback(async ({ what, ids, style, voice }) => {
    let body;
    if (what === 'change') {
      if (!(await actions.applyAll({ voice, ids }))) return false;
      body = await actions.batch({ kind: 'voice', ids, force: false });
    } else {
      body = await actions.batch({ kind: what, ids, style: what === 'restyle' ? style : null, force: true });
    }
    return !!body;
  }, [actions]);
  const voiceChanged = useCallback(() => {
    const ids = sentences.filter((s) => s.khmer_text && (s.status === 'edited' || s.status === 'failed')).map((s) => s.id);
    if (ids.length > 10) actions.batch({ kind: 'voice', ids, force: false }); // many: in the background, with progress
    else actions.regenerateChanged();
  }, [sentences, actions]);

  // When an edit (a cut, a trim, a move…) leaves sentences too long for their new time, say so.
  const tooLong = useMemo(() => sentences.filter((s) => s.status === 'too_long').map((s) => s.id), [sentences]);
  const lastTooLong = useRef(new Set(tooLong));
  const historyKey = `${project.history.undo}|${project.history.undo_label}|${project.history.redo}`;
  const lastHistory = useRef(historyKey); // as it was when the too-long sentences were last looked at
  useEffect(() => {
    const fresh = tooLong.filter((x) => !lastTooLong.current.has(x));
    lastTooLong.current = new Set(tooLong);
    const edited = historyKey !== lastHistory.current; // an edit came with it (not just new voice clips)
    if (fresh.length && edited && project.batch?.state !== 'running') setResync({ ids: fresh });
    else if (!tooLong.length) setResync(null);
  }, [tooLong]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { lastHistory.current = historyKey; }, [historyKey]); // after the check above

  const generateVoiceLine = useCallback(async ({ text, voice }) => {
    const body = await actions.add({ start: voiceLine.at, khmer_text: text, voice });
    if (!body?.id) return false;
    setSelection([body.id]);
    actions.regenerate(body.id);
    return true;
  }, [actions, voiceLine]);
  // Clips selected on the timeline open their settings in the Clip tab.
  const selectOnTimeline = useCallback((ids) => {
    setSelection(ids);
    if (!ids.length) return;
    const last = ids[ids.length - 1];
    setTab(trackOf(latest.current.tracks, 'watermark')?.clips.some((w) => w.id === last) ? 'watermark' : 'clip'); // a watermark's settings are in its own tab
  }, []);

  // A watermark being changed (a slider, dragged on the preview): shown at once, saved a moment later.
  const editWatermark = useCallback((clip, patch, now = false) => editSound(clip.id, patch,
    (f) => actions.edit({ op: 'set_watermark', clip: clip.id, fields: f }), now), [editSound, actions]);
  const openWatermarks = useCallback(() => setTab('watermark'), []);

  // A text clip being edited: shown as it is at once, saved a moment after the last change.
  const [textDraft, setTextDraft] = useState(null); // {id, fields}
  const [focusText, setFocusText] = useState(null); // a new text clip: put the cursor in its text
  const pendingText = useRef(null);
  const editText = useCallback((clip, patch, now = false) => {
    const prev = pendingText.current?.id === clip.id ? pendingText.current.fields : {};
    const fields = { ...prev, ...patch };
    for (const key of ['style', 'animation']) { // these change one setting at a time: keep the others
      if (patch[key]) fields[key] = { ...clip[key], ...prev[key], ...patch[key] };
    }
    clearTimeout(pendingText.current?.timer);
    setTextDraft({ id: clip.id, fields });
    const save = async () => {
      pendingText.current = null;
      await tools.setProps(clip, fields);
      setTextDraft((d) => (d?.id === clip.id && d.fields === fields ? null : d)); // nothing newer typed meanwhile
    };
    pendingText.current = { id: clip.id, fields, timer: now ? null : setTimeout(save, 450) };
    if (now) save();
  }, [tools]);
  const addText = useCallback(async () => {
    const body = await tools.addText();
    if (body?.id) { setTab('clip'); setFocusText(body.id); }
  }, [tools]);
  const editorTools = useMemo(() => ({ ...tools, addText, addVoice: openVoiceLine, regenerate: openRegenerate, watermark: openWatermarks }), [tools, addText, openVoiceLine, openRegenerate, openWatermarks]); // + Text also opens it for typing
  // Double-click a text clip: type in it.
  const editClipText = useCallback((clip) => {
    if (findClip(tracks, clip.id)?.track.id !== 'text') return;
    setSelection([clip.id]);
    setTab('clip');
    setFocusText(`${clip.id}#${Date.now()}`);
  }, [tracks]);
  const primaryClip = findClip(tracks, selectedId);
  const selectedText = primaryClip?.track.id === 'text' ? primaryClip.clip : null;
  const selectedWatermark = primaryClip?.track.id === 'watermark' ? primaryClip.clip : null;

  // A subtitle typed on the preview or the timeline: while it's linked to the voice text, the voice
  // text changes with it (and needs voicing again); otherwise only the subtitle changes.
  const editSubtitle = useCallback(async (sid, text) => {
    const s = sentences.find((x) => x.id === sid);
    if (!s) return;
    if (s.subtitle_text === null || s.subtitle_text === undefined) {
      if (text !== s.khmer_text) actions.setText(sid, 'khmer_text', text);
    } else if (text !== s.subtitle_text) {
      actions.setText(sid, 'subtitle_text', text);
    }
  }, [sentences, actions]);

  // The preview plays the latest edit list.
  useEffect(() => {
    playback.update({ tracks, settings: project.settings, media: project.media, fps: project.video.fps, stemUrl: project.background_url });
  }, [playback, tracks, project.settings, project.media, project.video.fps, project.background_url]);
  useEffect(() => playback.subscribe(({ t, playing: on }) => { setTime(t); setPlaying(on); }), [playback]);
  useEffect(() => () => playback.pause(), [playback]);

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

  const seek = useCallback((t) => playback.seek(t), [playback]);
  const play = useCallback((s) => playback.playRange(s.start, s.end), [playback]);

  // Select a sentence and move the playhead to it.
  const go = useCallback((s) => {
    if (!s) return;
    setSelectedId(s.id);
    seek(s.start);
  }, [seek]);

  const numbers = useMemo(() => new Map(sentences.map((s, i) => [s.id, i + 1])), [sentences]);
  const latest = useRef({ sentences, selectedId, tools, addText, tracks });
  latest.current = { sentences, selectedId, tools, addText, tracks };

  // Keyboard (outside text boxes, where the browser's own text undo applies):
  // Ctrl/⌘+Z undo · Ctrl+Y or Ctrl/⌘+Shift+Z redo · Space play/pause · ←/→ one frame (Shift: one second)
  // · ↑/↓ previous/next sentence · S split · Delete (Shift: close the gap, Alt: leave it) · I / O In and
  // Out points · Esc clears the selection and the In/Out points.
  useEffect(() => {
    const onKey = (e) => {
      if (e.target.closest?.('input, textarea, select, dialog, [role=dialog]')) return;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      const t = latest.current.tools;
      if (!mod && !e.altKey && key === 's') { e.preventDefault(); t.split(); return; }
      if (!mod && (key === 'delete' || key === 'backspace')) { e.preventDefault(); t.remove(e.shiftKey ? 'ripple' : e.altKey ? 'gap' : undefined); return; }
      if (!mod && key === 'i') { e.preventDefault(); t.markIn(); return; }
      if (!mod && key === 'o') { e.preventDefault(); t.markOut(); return; }
      if (!mod && !e.altKey && e.shiftKey && key === 't') { // Shift+T: show / hide the timeline (T adds text)
        e.preventDefault();
        panel.update((v) => ({ ...v, mode: v.mode === 'closed' ? 'open' : 'closed' }));
        return;
      }
      if (!mod && key === 't') { e.preventDefault(); latest.current.addText(); return; }
      if (mod && key === 'd') { e.preventDefault(); t.duplicate(); return; }
      if (mod && key === 'c' && !window.getSelection()?.toString()) { const n = t.copy(); if (n) say(`Copied ${n} clip${n === 1 ? '' : 's'} — Ctrl+V pastes at the playhead.`); return; }
      if (mod && key === 'v') { e.preventDefault(); t.paste(); return; }
      if (key === 'escape') { t.setAsking(null); if (t.range) t.clearRange(); else setSelection([]); return; }
      if (mod && key === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo(); else undo();
      } else if (mod && key === 'y') {
        e.preventDefault();
        redo();
      } else if (key === ' ' && !e.target.closest?.('button, a, video')) {
        e.preventDefault();
        playback.toggle();
      } else if ((key === 'arrowleft' || key === 'arrowright') && !mod) {
        e.preventDefault();
        const dir = key === 'arrowright' ? 1 : -1;
        if (e.shiftKey) { playback.pause(); playback.seek(playback.t + dir); } else playback.step(dir);
      } else if ((key === 'arrowdown' || key === 'arrowup') && !mod) {
        e.preventDefault();
        const { sentences: items, selectedId: sid } = latest.current;
        const i = items.findIndex((s) => s.id === sid);
        go(items[key === 'arrowdown' ? Math.min(items.length - 1, i + 1) : Math.max(0, i - 1)]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [actions, playback, go, undo, redo, panel.update]);

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
    if (!playingId || !playback.playing || list.current?.contains(document.activeElement)) return;
    document.getElementById(`row-${playingId}`)?.scrollIntoView({ block: 'nearest' });
  }, [playingId, playback]);

  const add = useCallback(async (start) => {
    const body = await actions.add({ start });
    if (body?.id) {
      focusNext.current = body.id;
      setFilter('all');
      setSearch('');
      setSelectedId(body.id);
    }
  }, [actions]);

  const retime = useCallback((sid, start, end) => actions.patch(sid, { start, end }), [actions]);

  // The right-click menu of a clip, a gap or empty space.
  const menuFor = useCallback((clip, at) => {
    const { tools: t } = latest.current;
    const split = { label: '✂ Split at the playhead', key: 'S', onClick: t.split };
    const copies = [{ label: 'Duplicate', key: '⌘D', onClick: t.duplicate }, { label: 'Copy', key: '⌘C', onClick: () => { const n = t.copy(); if (n) say(`Copied ${n} clip${n === 1 ? '' : 's'}.`); } }];
    if (!clip) {
      return { title: `At ${formatTime(at)}`, items: [
        { label: '▶ Play from here', onClick: () => { playback.seek(at); playback.play(); } },
        { label: 'Paste here', key: '⌘V', onClick: () => { playback.seek(at); t.paste(); } },
        { label: '+ Add a sentence here', onClick: () => add(Math.round(at * 100) / 100) },
        { label: '🎙 New voice line here…', onClick: () => { playback.seek(at); openVoiceLine(); } },
        { label: '↻ Recreate from here…', onClick: () => { playback.seek(at); openRegenerate('from', 'restyle'); } },
        '-', { label: 'Set In here', key: 'I', onClick: () => { playback.seek(at); t.markIn(); } }, { label: 'Set Out here', key: 'O', onClick: () => { playback.seek(at); t.markOut(); } },
      ] };
    }
    if (clip.gap) return { title: 'Empty space', items: [{ label: '⇤ Close the gap', key: 'Delete', onClick: () => t.remove() }] };
    const found = tracks.find((tr) => tr.clips.some((c) => c.id === clip.id));
    const kind = found?.id;
    const skipItem = { label: clip.skipped ? '↺ Bring back into the export' : '⤼ Skip (leave out, keep it here)', onClick: t.skip };
    const props = { label: 'Settings…', onClick: () => setTab('clip') };
    if (kind === 'video') {
      return { title: 'Video clip', items: [split, skipItem, ...copies, '-',
        { label: 'Delete, close the gap', key: '⇧ Delete', onClick: () => t.remove('ripple'), danger: true },
        { label: 'Delete, leave a gap', key: '⌥ Delete', onClick: () => t.remove('gap'), danger: true }, '-', props] };
    }
    if (kind === 'voice') {
      return { title: `Sentence #${numbers.get(clip.id)}`, items: [
        { label: '▶ Play', onClick: () => play(clip) }, split,
        { label: '↻ Regenerate the voice', onClick: () => actions.regenerate(clip.id, true), disabled: !clip.khmer_text },
        { label: '✨ Improve translation…', onClick: () => setSuggestFor(clip.id) }, skipItem, ...copies, '-',
        { label: 'Delete — silence there', key: 'Delete', onClick: () => t.remove('gap'), danger: true },
        { label: 'Delete — play the original audio there', onClick: () => t.remove('original'), danger: true }, '-', props] };
    }
    if (kind === 'background') {
      return { title: 'Background sound', items: [split,
        { label: clip.muted ? '🔈 Unmute this part' : '🔇 Mute this part', onClick: () => t.setProps(clip, { muted: !clip.muted }) },
        { label: clip.keep_voice ? 'Don’t play the original voice here' : '🗣 Play the original voice here', onClick: () => t.setProps(clip, { keep_voice: !clip.keep_voice }) },
        skipItem, '-', props] };
    }
    return { title: kind === 'text' ? 'Text' : 'Sound', items: [split, skipItem, ...copies, '-', { label: 'Delete', key: 'Delete', onClick: () => t.remove(), danger: true }, '-', props] };
  }, [tracks, playback, add, play, actions, numbers, say, openVoiceLine, openRegenerate]);

  // The browser draws the title, the text clips and the burned-in subtitles (it shapes Khmer
  // correctly), at the size of the exported picture.
  async function exportVideo(formats, audioFormat, style = project.settings.subtitle_style, title = project.settings.title, withMarks = project.export_prefs?.watermark !== false) {
    setTab('export');
    await flushSound(); // a volume just changed is in the export
    const body = { formats, audio_format: audioFormat, watermark: withMarks };
    const { width, height } = canvasSize(project);
    if (formats.includes('mp4') || formats.includes('mp4_subs')) {
      const image = await renderTitleImage(title, width, height);
      if (image) body.title_image = image;
      const texts = trackOf(tracks, 'text').clips.filter((c) => !c.skipped && c.text?.trim());
      if (texts.length) {
        body.text_images = {};
        for (const c of texts) {
          const drawn = await renderTextImage(c, width, height);
          if (drawn) body.text_images[c.id] = drawn;
        }
      }
      if (withMarks && trackOf(tracks, 'watermark')?.clips.some((w) => !w.skipped)) {
        body.watermark_images = await renderWatermarkImages(tracks, project.media, width, height); // as the preview draws them, at this size
      }
    }
    if (formats.includes('mp4_subs')) {
      const items = sentences.filter(subtitleText).map((s) => ({ id: s.id, text: subtitleText(s), original: s.original_text }));
      const { images, layout } = await renderSubtitleImages(items, width, height, style);
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
    const t = playback.t;
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
  const shown = shownSentences.filter((s) => (filter === 'all' || toCheck(s) || s.id === selectedId)
    && (!query || s.khmer_text.toLowerCase().includes(query) || s.original_text.toLowerCase().includes(query)));
  const counts = project.counts;
  const attention = sentences.filter(toCheck).length;
  const changed = (counts.edited || 0) + (counts.failed || 0);
  const { history } = project;
  const warningsKey = (project.warnings || []).join('|');
  // sentences the translation left without Khmer (silent in the video)
  const untranslated = sentences.filter((s) => !s.khmer_text?.trim() && s.original_text?.trim()).map((s) => s.id);
  const showUntranslated = untranslated.length > 0 && hideUntranslated !== untranslated.length;
  const exporting = project.status === 'exporting';
  const skipped = skippedRanges(tracks);
  const length = timelineEnd(tracks);
  const exportLength = keptRanges(skipped, length).reduce((sum, [a, b]) => sum + b - a, 0);
  const isSkipped = (s) => s.skipped || inside(s.start, s.end, skipped);

  return (
    <div className="flex flex-col max-md:overflow-x-clip lg:h-[calc(100dvh-3.5rem)]">
      {/* top bar */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line bg-panel px-3 py-2 sm:px-4">
        <IconButton label="My projects" onClick={() => { window.location.hash = '#/projects'; }}>
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
        </IconButton>
        <div className="min-w-0 flex-1 basis-48">
          <h1 className="truncate text-sm font-semibold sm:text-base">{project.name}</h1>
          <p className="truncate text-xs text-muted">
            {formatTime(length)}{exportLength < length - 0.05 && <span className="text-red-600 dark:text-red-400"> → {formatTime(exportLength)} without the skipped parts</span>} · {sentences.length} sentences · <span className={saving || Object.keys(soundDraft).length ? 'text-accent-ink' : ''}>{saving || Object.keys(soundDraft).length ? 'Saving…' : 'All changes saved'}</span>
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
          <IconButton label={history.undo_label ? `Undo: ${history.undo_label} (Ctrl+Z)` : 'Nothing to undo'} disabled={locked || !history.undo} onClick={undo}>
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" /></svg>
          </IconButton>
          <IconButton label={history.redo_label ? `Redo: ${history.redo_label} (Ctrl+Y)` : 'Nothing to redo'} disabled={locked || !history.redo} onClick={redo}>
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m15 14 5-5-5-5" /><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" /></svg>
          </IconButton>
          <Button variant="soft" size="sm" disabled={locked || busy['#check'] || busy['*'] || !sentences.some((s) => s.audio_url)} onClick={actions.checkVoices}
            title="Check every voice clip for mistakes (silent, cut off, skipped words, long pauses, other-language letters) and voice the wrong ones again">
            {busy['#check'] ? 'Checking…' : 'Check voices'}
          </Button>
          {project.batch?.state === 'running' ? (
            <span className="inline-flex min-w-40 flex-col gap-1 rounded-lg bg-accent-soft px-2.5 py-1 text-xs text-accent-ink" role="status">
              <span className="font-semibold">{project.batch.message || `${project.batch.label}…`}</span>
              <span className="h-1 overflow-hidden rounded-full bg-accent/20"><span className="block h-full bg-accent transition-all duration-500" style={{ width: `${Math.max(3, (project.batch.progress || 0) * 100)}%` }} /></span>
            </span>
          ) : (
            <Button variant="soft" size="sm" disabled={locked || !changed || busy['*']} onClick={voiceChanged} title="Make the voice of every sentence that changed">
              {busy['*'] ? 'Voicing…' : `Voice changed${changed ? ` (${changed})` : ''}`}
            </Button>
          )}
          <Button size="sm" className="px-3.5" disabled={exporting} onClick={exportWithPrefs} title="Export with the formats chosen in the Export tab">
            {exporting ? `Exporting ${Math.round((project.progress || 0) * 100)}%` : 'Export'}
            <span className="khmer hidden font-normal opacity-80 sm:inline">· នាំចេញ</span>
          </Button>
        </div>
      </div>

      {/* messages */}
      {(project.status === 'error' || error || resync || showUntranslated || (project.batch?.state === 'error' && hiddenWarnings !== `batch:${project.batch.error?.message}`)
        || (project.warnings?.length > 0 && !locked && hiddenWarnings !== warningsKey)) && (
        <div className="space-y-2 px-3 pt-3">
          {showUntranslated && (
            <Notice className="flex flex-wrap items-center gap-2 py-2">
              <span className="flex-1">
                <b>{untranslated.length} sentence{untranslated.length === 1 ? ' has' : 's have'} no Khmer yet</b>, so {untranslated.length === 1 ? 'it is' : 'they are'} silent in the video.
                {' '}The AI can translate {untranslated.length === 1 ? 'it' : 'them'}: it reads the whole video first, so names stay the same and misheard words are understood.
              </span>
              <Button size="sm" variant="secondary" onClick={() => { setFilter('attention'); setSide('sentences'); go(sentences.find((s) => s.id === untranslated[0])); }}>Show</Button>
              <Button size="sm" disabled={locked || project.batch?.state === 'running' || health?.translate?.ok === false}
                title={health?.translate?.ok === false ? `No translator: ${health.translate.reason}` : 'Translate them, then make their voice'}
                onClick={() => actions.batch({ kind: 'restyle', style: 'natural', ids: untranslated, force: false })}>
                ✨ Translate {untranslated.length === 1 ? 'it' : 'them'}
              </Button>
              <button type="button" className="text-xs font-semibold underline" onClick={() => setHideUntranslated(untranslated.length)}>Hide</button>
            </Notice>
          )}
          {project.batch?.state === 'error' && hiddenWarnings !== `batch:${project.batch.error?.message}` && (
            <ErrorBox compact error={project.batch.error}><Button size="sm" variant="secondary" onClick={() => setHiddenWarnings(`batch:${project.batch.error?.message}`)}>OK</Button></ErrorBox>
          )}
          {resync && (
            <Notice className="flex flex-wrap items-center gap-2 py-2">
              <span className="flex-1">
                <b>{resync.ids.length} sentence{resync.ids.length === 1 ? ' no longer fits its' : 's no longer fit their'} time</b> after this change — {resync.ids.length === 1 ? 'its' : 'their'} voice would be cut at the end.
              </span>
              <Button size="sm" variant="secondary" onClick={() => { setFilter('attention'); setSide('sentences'); go(sentences.find((s) => s.id === resync.ids[0])); }}>Show</Button>
              <Button size="sm" disabled={locked || project.batch?.state === 'running'} onClick={() => { actions.batch({ kind: 'fit', ids: tooLong }); setResync(null); }}>⚡ Fix all automatically</Button>
              <button type="button" className="text-xs font-semibold underline" onClick={() => setResync(null)}>Hide</button>
            </Notice>
          )}
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
          title={(
            <span className="inline-flex rounded-lg bg-raised p-0.5 text-xs" role="tablist">
              {[['sentences', 'Sentences', 'ប្រយោគ'], ['media', 'Media', 'ឯកសារ']].map(([key, label, km]) => (
                <button key={key} type="button" role="tab" aria-selected={side === key} onClick={() => setSide(key)}
                  className={`rounded-md px-2.5 py-1 font-semibold ${side === key ? 'bg-panel text-ink shadow-sm' : 'text-muted hover:text-ink'}`}>
                  {label} <span className="khmer font-normal text-faint">· {km}</span>{key === 'media' && uploads.length > 0 && ' ⏳'}
                </button>
              ))}
            </span>
          )}
          actions={side === 'sentences' && <Button size="sm" variant="soft" disabled={locked} onClick={() => add(Math.round(playback.t * 100) / 100)} title="Add a sentence at the playhead">+ Add at {formatTime(time)}</Button>}
          bodyClassName="flex flex-col"
        >
          {side === 'media' && (
            <MediaBin project={project} tracks={tracks} actions={actions} uploads={uploads} upload={upload} locked={locked}
              onInsert={(mid) => tools.insert(mid)} />
          )}
          {side === 'sentences' && (<>
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
                  key={s.id} s={s} number={numbers.get(s.id)} isLast={s.id === sentences[sentences.length - 1]?.id}
                  voices={voices} provider={provider} selected={s.id === selectedId} playing={s.id === playingId}
                  busy={busy[s.id] || (busy['*'] && ATTENTION.includes(s.status) ? 'regenerate' : undefined)} locked={locked} removed={isSkipped(s)}
                  actions={actions} onSelect={go} onPlay={play} onSuggest={setSuggestFor} sound={sound}
                />
              ))}
            </ol>
          ) : (
            <p className="p-6 text-center text-sm text-muted">
              {query ? 'No sentence contains that text.' : 'Nothing to check — every sentence is voiced and fits its time. 🎉'}
            </p>
          )}
          <p className="hidden border-t border-line px-3 py-1.5 text-[11px] text-faint lg:block">↑ ↓ move between sentences · Space play/pause · Ctrl+Z undo</p>
          </>)}
        </Panel>

        <Panel className="order-1 overflow-hidden lg:order-2" bodyClassName="flex flex-col">
          <Player project={project} sentences={sentences} tracks={tracks} control={control} time={time} playing={playing}
            subtitleStyle={subtitleDraft} showSubtitles={showSubtitles} setShowSubtitles={setShowSubtitles}
            numbers={numbers} onStep={go} cover={coverDraft} editingCover={editingCover} onCoverChange={setCoverDraft} title={titleDraft}
            onSubtitleMove={tab === 'subtitles' && !locked ? (pos) => setSubtitleDraft((cur) => ({ ...(cur || project.settings.subtitle_style), ...pos })) : null}
            selectedText={locked || tools.locked('text') ? null : selectedText} textDraft={textDraft}
            onTextMove={(cid, pos) => setTextDraft((d) => ({ id: cid, fields: { ...(d?.id === cid ? d.fields : {}), ...pos } }))}
            onTextCommit={(cid, pos) => { const c = findClip(tracks, cid)?.clip; if (c) editText(c, pos, true); }}
            onEditText={(cid) => { setSelection([cid]); setTab('clip'); setFocusText(`${cid}#${Date.now()}`); }}
            onSubtitleEdit={locked ? null : editSubtitle}
            selectedWatermark={locked || tools.locked('watermark') ? null : selectedWatermark} showSafeArea={tab === 'watermark' || !!selectedWatermark}
            onWatermarkMove={(w, patch) => editWatermark(w, patch)} onWatermarkCommit={(w, patch) => editWatermark(w, patch, true)} />
        </Panel>

        <Panel className="order-3" bodyClassName="flex flex-col">
          <div className="border-b border-line p-2">
            <Tabs value={tab} onChange={setTab} tabs={[
              { key: 'clip', label: 'Clip', dot: selection.length > 0 },
              { key: 'export', label: 'Export', dot: exporting },
              { key: 'subtitles', label: 'Subtitles', dot: !!subtitleDraft || !!coverDraft || !!titleDraft },
              { key: 'audio', label: 'Audio', dot: project.separation?.state === 'running' },
              { key: 'watermark', label: 'Watermark', dot: (trackOf(tracks, 'watermark')?.clips.length || 0) > 0 },
            ]} />
          </div>
          <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto p-4">
            {tab === 'clip' && (
              <ClipPanel project={project} tools={tools} sentences={shownSentences} numbers={numbers} actions={actions} voices={voices} provider={provider}
                textDraft={textDraft} editText={editText} focusText={focusText} sound={sound} tracks={tracks} playback={playback}
                onPlay={play} busy={locked} onEditText={(sid) => { setTab('clip'); const s = sentences.find((x) => x.id === sid); if (s) { focusNext.current = sid; go(s); } }} />
            )}
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
            {tab === 'audio' && <SettingsPanel project={project} tracks={tracks} health={health} locked={locked} actions={actions} sound={sound} />}
            {tab === 'watermark' && (
              <WatermarkPanel project={project} tracks={tracks} tools={tools} actions={actions} change={editWatermark} selection={selection}
                onSelect={setSelection} locked={locked} say={say} playback={playback}
                presets={<WatermarkPresets project={project} actions={actions} locked={locked} say={say} hasWatermarks={(trackOf(tracks, 'watermark')?.clips.length || 0) > 0} />} />
            )}
          </div>
        </Panel>
      </div>

      {/* desktop: the timeline along the bottom — resize it by its top edge, collapse, close (Shift+T) or maximise it */}
      <div className="hidden px-3 pb-3 pt-1 md:block">
        <TimelineDock view={panel.view} update={panel.update} playback={playback} fps={project.video.fps || 30}>
          {({ controls, onMeasure }) => (
            <Timeline
              project={project} tracks={tracks} sentences={sentences} media={project.media} playback={playback} selection={selection}
              onSelect={selectOnTimeline} onTiming={retime} onAdd={add} onTrack={actions.track} tools={editorTools} menuFor={menuFor} locked={locked} onSubtitleEdit={editSubtitle}
              onClipDouble={editClipText} onDropMedia={dropMedia} onDropFiles={dropFiles} waves={waves} sound={sound} onMixer={openMixer}
              filmstrip={media.filmstrip} waveform={voiceRemoved ? media.music : media.waveform} voiceRemoved={voiceRemoved}
              layout={panel.view} onLayout={panel.update} onTrackLayout={panel.setTrack} controls={controls} onMeasure={onMeasure}
            />
          )}
        </TimelineDock>
      </div>

      {/* phones: the timeline is a sheet along the bottom — swipe it up for more, down to close it */}
      <div className="md:hidden">
        <BottomSheet state={panel.view.sheet} onState={(sheet) => panel.update({ sheet })} title={<MiniProgress playback={playback} fps={project.video.fps || 30} line={false} />}>
          {(state) => state !== 'closed' && (
            <>
              <MobileTimeline project={project} tracks={tracks} sentences={sentences} playback={playback} filmstrip={media.filmstrip} size={state}
                selectedId={selectedId} onSelect={(cid) => { const s = sentences.find((x) => x.id === cid); if (s) go(s); else setSelectedId(cid); }}
                tools={(
                  <>
                    <Button size="sm" variant="secondary" disabled={locked} onClick={tools.split}>✂ Split</Button>
                    <Button size="sm" variant="secondary" disabled={locked || (!tools.picked.length && !tools.gap)} onClick={() => tools.remove()}>🗑 Delete</Button>
                    <Button size="sm" variant="secondary" disabled={locked || !tools.picked.length} onClick={tools.skip}>⤼ Skip</Button>
                    <Button size="sm" variant="secondary" disabled={locked || tools.locked('text')} onClick={addText}>T Text</Button>
                    <Button size="sm" variant="secondary" disabled={locked} onClick={() => openRegenerate()}>↻ Regenerate</Button>
                  </>
                )} />
              {tools.asking && <div className="mt-2"><DeleteChoice tools={tools} /></div>}
            </>
          )}
        </BottomSheet>
      </div>


      {regen && (
        <RegenerateDialog sentences={sentences} initialScope={regen.scope} initialWhat={regen.what}
          scopes={regenerateScopes({ sentences, tracks, selection, range: tools.full, at: regen.at })}
          voices={voices} provider={provider} defaultVoice={project.settings.voice} translator={!!health?.translate?.ok}
          onRun={runRegenerate} onClose={() => setRegen(null)} />
      )}
      {voiceLine && (
        <VoiceLineDialog at={voiceLine.at} room={voiceLine.room} voices={voices} provider={provider} defaultVoice={project.settings.voice}
          onGenerate={generateVoiceLine} onClose={() => setVoiceLine(null)} />
      )}
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
