import { useCallback, useMemo, useState } from 'react';
import { formatTime } from '../../../api.js';
import { splitPoint } from '../../../lib/khmer.js';
import { EPS, findClip, onFrame, trackOf } from '../../../lib/timeline.js';

const CLIPBOARD = 'kva-clipboard'; // copied clips: {project, items: [{track, clip}]} (kept in this browser)

// A gap on the video track is selected as "gap:<start>:<end>".
export const gapId = (start, end) => `gap:${start}:${end}`;
export const parseGap = (id) => (id?.startsWith('gap:') ? { start: Number(id.split(':')[1]), end: Number(id.split(':')[2]) } : null);

// The timeline's tools, shared by the toolbar, the keys, the right-click menu, the clip properties
// and the phone's buttons: split, delete (closing the gap or leaving it), skip, In/Out range, trim.
export function useTimelineTools({ projectId, tracks, playback, actions, selection, setSelection, fps, say }) {
  const [range, setRange] = useState(null); // {start, end}: the In (I) and Out (O) points
  const [asking, setAsking] = useState(null); // {ids, kind}: the user chooses how to delete

  const picked = useMemo(() => selection.map((id) => findClip(tracks, id)).filter(Boolean), [selection, tracks]);
  const gap = parseGap(selection[selection.length - 1]);
  const at = () => onFrame(playback.t, fps);
  const clock = (t) => formatTime(t);

  // ✂ Split (S): the selected clips under the playhead, or else the video clip there (with its sound).
  const split = useCallback(async () => {
    const t = at();
    const targets = picked.filter(({ track, clip }) => !track.locked && clip.start + EPS < t && t < clip.end - EPS);
    const indexes = {};
    for (const { track, clip } of targets) {
      if (track.id === 'voice' && clip.khmer_text) {
        indexes[clip.id] = splitPoint(clip.khmer_text, Math.round(clip.khmer_text.length * ((t - clip.start) / (clip.end - clip.start))));
      }
    }
    const body = await actions.edit({ op: 'split', at: t, clips: targets.length ? targets.map(({ clip }) => clip.id) : null, indexes },
      `Split at ${clock(t)}.`);
    if (body?.ids) setSelection(body.ids);
  }, [picked, actions, setSelection]); // eslint-disable-line react-hooks/exhaustive-deps

  // Delete: a video clip asks whether to close the gap (what follows moves up) or leave it;
  // a sentence asks whether its time becomes silence or the original audio. `how` skips the question.
  const remove = useCallback(async (how) => {
    if (gap) {
      const body = await actions.edit({ op: 'close_gap', at: (gap.start + gap.end) / 2 }, `Closed the gap — everything after it moved up ${(gap.end - gap.start).toFixed(1)}s.`);
      if (body) setSelection([]);
      return;
    }
    if (!picked.length) return;
    const ids = picked.map(({ clip }) => clip.id);
    const kinds = new Set(picked.map(({ track }) => track.id));
    if (!how) {
      if (kinds.has('video')) return setAsking({ ids, kind: 'video' });
      how = 'gap';
    }
    setAsking(null);
    const op = { op: 'delete', clips: ids, ripple: how === 'ripple', fill: how === 'original' ? 'original' : 'silence' };
    const body = await actions.edit(op, how === 'ripple' ? 'Deleted, and the gap closed. Ctrl+Z brings it back.' : 'Deleted. Ctrl+Z brings it back.');
    if (body) setSelection([]);
  }, [gap, picked, actions, setSelection]);

  // ⤼ Skip: leave the selected clips out of the export (or bring them back); they stay on the timeline.
  const skip = useCallback(() => {
    const live = picked.filter(({ track }) => !track.locked);
    if (!live.length) return null;
    const value = !live.every(({ clip }) => clip.skipped);
    const what = live.some(({ track }) => track.id === 'video') ? 'part of the video' : live.length === 1 ? 'clip' : 'clips';
    return actions.edit({ op: 'skip', clips: live.map(({ clip }) => clip.id), skipped: value },
      value ? `Skipped the ${what} — it's left out of the export. Press Skip again to bring it back.` : 'Brought back into the export.');
  }, [picked, actions]);

  // In / Out (I / O): a part of the timeline, for the range tools.
  const markIn = useCallback(() => {
    const t = at();
    setRange((r) => ({ start: t, end: r && r.end > t + EPS ? r.end : null }));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const markOut = useCallback(() => {
    const t = at();
    setRange((r) => ({ start: r && r.start !== null && r.start < t - EPS ? r.start : null, end: t }));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const full = range && range.start !== null && range.end !== null && range.end - range.start > EPS ? range : null;

  // `arg`: for 'volume', {track, volume (percent)}.
  const rangeAction = useCallback(async (kind, arg) => {
    if (!full) return;
    const when = `${clock(full.start)}–${clock(full.end)}`;
    const name = { background: 'The background', voice: 'The Khmer voice', audio: 'The music' }[arg?.track];
    const ops = {
      remove: [{ op: 'remove_range', start: full.start, end: full.end }, `Removed ${when} from every track; what follows moved up.`],
      skip: [{ op: 'skip_range', start: full.start, end: full.end }, `Skipped ${when} — it's left out of the export but stays on the timeline.`],
      unskip: [{ op: 'unskip_range', start: full.start, end: full.end }, `${when} is back in the export.`],
      volume: [{ op: 'volume', track: arg?.track, start: full.start, end: full.end, volume: arg?.volume },
        arg?.volume === 0 ? `${name} is silent ${when}.` : `${name} plays at ${arg?.volume}% ${when}${arg?.track === 'voice' ? ' (the sentences there)' : ''}.`],
    };
    const [op, note] = ops[kind];
    const body = await actions.edit(op, note);
    if (body && kind === 'remove') { setRange(null); playback.seek(full.start); }
  }, [full, actions, playback]); // eslint-disable-line react-hooks/exhaustive-deps

  const trim = useCallback((clip, side, to) => actions.edit({ op: 'trim', clip: clip.id, side, to }), [actions]);
  // A watermark for the whole video (range null), or just for [range.start, range.end].
  const watermarkTimes = useCallback((w, range) => actions.edit({ op: 'set_watermark', clip: w.id, fields: range ? { start: range.start, end: range.end } : { whole: true } },
    range ? `The watermark shows ${clock(range.start)}–${clock(range.end)}.` : 'The watermark shows for the whole video.'), [actions]); // eslint-disable-line react-hooks/exhaustive-deps
  const removeIds = useCallback((ids) => actions.edit({ op: 'delete', clips: ids }, 'Deleted. Ctrl+Z brings it back.'), [actions]);
  const setProps = useCallback((clip, fields) => actions.edit({ op: 'set', clip: clip.id, fields }), [actions]);
  const move = useCallback((ids, by) => actions.edit({ op: 'move', clips: ids, by }), [actions]);
  const subtitleTiming = useCallback((sid, start, end) => actions.edit({ op: 'subtitle_timing', clip: sid, start, end },
    start === null ? 'The subtitle shows with its sentence again.' : null), [actions]);

  // Media: a video or picture inserted at t (what follows moves later), or sound on its track.
  const insert = useCallback(async (mid, t = at(), seconds = undefined) => {
    const body = await actions.edit({ op: 'insert', media: mid, at: t, ...(seconds ? { seconds } : {}) });
    if (body?.id) setSelection([body.id]);
    return body;
  }, [actions, setSelection]); // eslint-disable-line react-hooks/exhaustive-deps

  // Ctrl+D: a copy right after each selected clip (a video clip with its sound, sentences and text).
  const duplicate = useCallback(async () => {
    const ids = picked.filter(({ track }) => track.id !== 'background').map(({ clip }) => clip.id);
    if (!ids.length) return null;
    const body = await actions.edit({ op: 'duplicate', clips: ids }, `Duplicated ${ids.length === 1 ? 'the clip' : `${ids.length} clips`}.`);
    if (body?.ids?.length) setSelection(body.ids.filter((x) => !x.startsWith('b')));
    return body;
  }, [picked, actions, setSelection]);

  // Ctrl+C / Ctrl+V: copy the selected clips (a video clip with what's on it), paste them at the playhead.
  const copy = useCallback(() => {
    const items = [];
    const seen = new Set();
    const add = (track, clip) => { if (!seen.has(clip.id)) { seen.add(clip.id); items.push({ track, clip }); } };
    for (const { track, clip } of picked) {
      if (track.id === 'background') continue;
      add(track.id, clip);
      if (track.id === 'video') {
        for (const t of tracks) {
          for (const c of t.clips) {
            if (t.id === 'background' && c.link === clip.id) add('background', c);
            if ((t.id === 'voice' || t.id === 'text') && !t.locked && c.start >= clip.start - EPS && c.start < clip.end - EPS) add(t.id, c);
          }
        }
      }
    }
    if (!items.length) return 0;
    try { localStorage.setItem(CLIPBOARD, JSON.stringify({ project: projectId, items })); } catch { /* storage blocked */ }
    return items.length;
  }, [picked, tracks, projectId]);
  const paste = useCallback(async () => {
    let board = null;
    try { board = JSON.parse(localStorage.getItem(CLIPBOARD) || 'null'); } catch { /* nothing copied */ }
    if (!board?.items?.length) return null;
    if (board.project !== projectId) { say?.('Those clips were copied in another project — copy and paste within one project.'); return null; }
    const body = await actions.edit({ op: 'paste', items: board.items, at: at() },
      (b) => (b.left_out ? `Pasted. ${b.left_out} sentence${b.left_out === 1 ? '' : 's'} left out: they'd overlap sentences already there.` : 'Pasted at the playhead.'));
    if (body?.ids?.length) setSelection(body.ids.filter((x) => !x.startsWith('b')));
    return body;
  }, [actions, setSelection, projectId, say]); // eslint-disable-line react-hooks/exhaustive-deps

  // Rearrange: a video clip moved into empty space, or put in between other clips at `to`.
  const moveVideo = useCallback((cid, to, insertHere) => actions.edit({ op: 'move_video', clip: cid, to, insert: insertHere },
    insertHere ? 'Moved — what was there moved later.' : null), [actions]);
  const speed = useCallback((clip, value) => actions.edit({ op: 'speed', clip: clip.id, speed: value }), [actions]);

  // + Text: new text at the playhead, selected, ready to type.
  const addText = useCallback(async () => {
    const body = await actions.edit({ op: 'add_text', at: at(), text: '' }, 'Added text — type it in the Clip tab, drag it on the picture to place it.');
    if (body?.id) setSelection([body.id]);
    return body;
  }, [actions, setSelection]); // eslint-disable-line react-hooks/exhaustive-deps

  return useMemo(() => ({
    range, setRange, full, asking, setAsking, picked, gap,
    split, remove, skip, markIn, markOut, clearRange: () => setRange(null), rangeAction, trim, setProps, move, subtitleTiming, addText,
    insert, duplicate, copy, paste, moveVideo, speed, watermarkTimes, removeIds,
    locked: (tid) => !!trackOf(tracks, tid)?.locked,
  }), [range, full, asking, picked, gap, split, remove, skip, markIn, markOut, rangeAction, trim, setProps, move, subtitleTiming, addText,
    insert, duplicate, copy, paste, moveVideo, speed, watermarkTimes, removeIds, tracks]);
}
