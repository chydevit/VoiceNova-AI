// The edit list in the browser. The same rules as backend/timeline.py and backend/render.py, so the
// preview plays and the timeline draws exactly what the export will make.
//
// The server sends the voice track's clips once, as project.sentences; withVoice() puts them back on
// the voice track so every track can be handled the same way.

export const TRACKS = ['video', 'voice', 'text', 'watermark', 'background', 'audio'];
export const EPS = 0.001;
// keep these in sync with backend/render.py and backend/timeline.py
export const MIN_FADE = 0.01;
export const DUCK_HOLD = 0.25;
export const VOICE_CUT_FADE = 0.08;
export const VOLUME_MAX = 200;

export const TRACK_INFO = {
  video: { name: 'Video', km: 'វីដេអូ', toggle: 'hidden' },
  voice: { name: 'Khmer voice', km: 'សំឡេងខ្មែរ', toggle: 'muted' },
  text: { name: 'Text', km: 'អក្សរ', toggle: 'hidden' },
  watermark: { name: 'Watermark', km: 'ស្លាកសញ្ញា', toggle: 'hidden' },
  background: { name: 'Background', km: 'សំឡេងដើម', toggle: 'muted' },
  audio: { name: 'Music & sound', km: 'តន្ត្រី', toggle: 'muted' },
};

export function withVoice(timeline, sentences) {
  return timeline.tracks.map((t) => (t.id === 'voice' ? { ...t, clips: sentences } : t));
}

export const trackOf = (tracks, id) => tracks.find((t) => t.id === id);

// Volumes being changed, shown (and heard) before they're saved: {clip id | "track:<id>": fields}.
export function withDrafts(tracks, drafts) {
  if (!Object.keys(drafts).length) return tracks;
  return tracks.map((t) => {
    const own = drafts[`track:${t.id}`];
    const clips = t.clips.some((c) => drafts[c.id]) ? t.clips.map((c) => (drafts[c.id] ? { ...c, ...drafts[c.id] } : c)) : t.clips;
    return own || clips !== t.clips ? { ...t, ...own, clips } : t;
  });
}

export function findClip(tracks, id) {
  for (const t of tracks) {
    const c = t.clips.find((x) => x.id === id);
    if (c) return { track: t, clip: c };
  }
  return null;
}

// Where the timeline ends: the end of its last clip (a watermark never makes the video longer).
export function timelineEnd(tracks) {
  let end = 0;
  for (const t of tracks) if (t.id !== 'watermark') for (const c of t.clips) if (c.end > end) end = c.end;
  return end;
}

export function mergeRanges(ranges) {
  const out = [];
  for (const r of [...ranges].sort((a, b) => a.start - b.start)) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + 0.01) last.end = Math.max(last.end, r.end);
    else out.push({ start: r.start, end: r.end });
  }
  return out;
}

// The parts of the timeline left out of the export: where a skipped video clip is.
export const skippedRanges = (tracks) => mergeRanges(trackOf(tracks, 'video').clips.filter((c) => c.skipped));

export function keptRanges(skipped, length) {
  const out = [];
  let t = 0;
  for (const c of mergeRanges(skipped)) {
    if (c.start > t) out.push([t, Math.min(c.start, length)]);
    t = Math.max(t, c.end);
  }
  if (t < length) out.push([t, length]);
  return out.filter(([a, b]) => b - a > EPS);
}

// Where timeline time t lands in the export.
export function outputTime(t, skipped) {
  let removed = 0;
  for (const c of mergeRanges(skipped)) {
    if (t <= c.start) break;
    removed += Math.min(t, c.end) - c.start;
  }
  return t - removed;
}

export const inside = (start, end, ranges) => ranges.some((r) => r.start - 0.01 <= start && end <= r.end + 0.01);

// The clip of a (sorted) list at time t, or null.
export function clipAt(clips, t) {
  let lo = 0;
  let hi = clips.length - 1;
  while (lo <= hi) { // the last clip starting at or before t
    const mid = (lo + hi) >> 1;
    if (clips[mid].start - EPS <= t) lo = mid + 1; else hi = mid - 1;
  }
  for (let i = hi; i >= 0 && i >= hi - 3; i -= 1) { // overlapping clips (text, music) are rare: look back a little
    if (clips[i].start - EPS <= t && t < clips[i].end - EPS) return clips[i];
  }
  return null;
}

// Seconds into a media clip's file at timeline time t.
export const sourceTime = (clip, t, speed = clip.speed ?? 1) => clip.source_in + (t - clip.start) * speed;

// A media clip's speed (a background piece plays at its video clip's speed).
export function speedOf(tracks, clip) {
  if (clip.link) return trackOf(tracks, 'video').clips.find((v) => v.id === clip.link)?.speed ?? 1;
  return clip.speed ?? 1;
}

// ---------- sound: the same runs and levels as backend render.py ----------
// A run's gain at a moment is its piece's level (the track's and the clip's volume, the background
// mode) x the clip's volume line, if it has one x its track's ducking while the Khmer voice speaks.
// Where two pieces meet, one changes into the other along a straight line (their fades, or 10 ms).

// A volume as stored: a whole percent, 0–VOLUME_MAX.
export const volume = (v) => Math.round(Math.min(VOLUME_MAX, Math.max(0, Number(v) || 0)));

// The parts of [start, finish] that are exported: [timeline start, timeline end, output start].
export function toOutput(start, finish, kept) {
  const out = [];
  let offset = 0;
  for (const [a, b] of kept) {
    const lo = Math.max(start, a);
    const hi = Math.min(finish, b);
    if (hi - lo > EPS) out.push([lo, hi, offset + lo - a]);
    offset += b - a;
  }
  return out;
}

// A clip's own share of its level: its volume (a volume line takes its place), nothing when muted.
export const clipFactor = (c) => (c.muted ? 0 : c.keys?.length ? 1 : (c.volume ?? 100) / 100);

// A volume line's value (percent) at `at` seconds of its clip's sound; level before the first point
// and after the last (numpy.interp, as the export).
export function keysAt(keys, at) {
  const n = keys.length;
  if (at <= keys[0].at) return keys[0].v;
  if (at >= keys[n - 1].at) return keys[n - 1].v;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (keys[mid].at <= at) lo = mid; else hi = mid; }
  const a = keys[lo];
  const b = keys[hi];
  return ((b.v - a.v) / (b.at - a.at)) * (at - a.at) + a.v;
}

// A voice clip that makes a sound: not muted, and not at 0 % all along.
export const audible = (s) => !s.muted && (s.keys?.length ? Math.max(...s.keys.map((k) => k.v)) > 0 : (s.volume ?? 100) > 0);

// Where the Khmer voice speaks, in output time: each voiced clip from its start until its sound
// ends (or its time slot does).
export function speech(tracks, skipped = skippedRanges(tracks)) {
  const voice = trackOf(tracks, 'voice');
  if (!voice || voice.muted || (voice.volume ?? 100) <= 0) return [];
  const kept = keptRanges(skipped, timelineEnd(tracks));
  const spans = [];
  for (const s of voice.clips) {
    if (s.skipped || inside(s.start, s.end, skipped) || !s.khmer_text || !s.audio_url || !audible(s)) continue;
    const finish = s.start + Math.min(s.audio_duration, s.end - s.start);
    for (const [lo, hi, at] of toOutput(s.start, finish, kept)) spans.push([at, at + hi - lo]);
  }
  spans.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return joinSpans(spans, EPS);
}

function joinSpans(spans, gap) {
  const out = [];
  for (const [a, b] of spans) {
    const last = out[out.length - 1];
    if (last && a - last[1] < gap) out[out.length - 1] = [last[0], Math.max(last[1], b)];
    else out.push([a, b]);
  }
  return out;
}

// How a track goes down while the voice speaks: to `ratio` of its level, over `fade` seconds before
// each sentence and after it; pauses too short for it to come back up are bridged.
function duckOf(track, voice, skipped) {
  const d = track.duck || {};
  const vol = track.volume ?? 100;
  if (!d.on || !voice.length || vol <= 0 || d.level >= vol) return null;
  const fade = d.fade ?? 0.3;
  return { ratio: d.level / vol, fade, spans: joinSpans(voice, 2 * fade + DUCK_HOLD), skipped };
}

// The ducking's share of the level at output time t.
export function duckFactor(duck, t) {
  const { spans, fade, ratio } = duck;
  let lo = 0;
  let hi = spans.length - 1;
  let k = -1;
  while (lo <= hi) { // the last sentence whose ramp has begun
    const mid = (lo + hi) >> 1;
    if (spans[mid][0] - fade <= t) { k = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (k < 0) return 1;
  const [a, b] = spans[k];
  const w = t < a ? (t - a + fade) / fade : t <= b ? 1 : (b + fade - t) / fade;
  return 1 - (1 - ratio) * Math.min(1, Math.max(0, w));
}

// Runs of background and added sound in timeline time (the preview jumps over skipped parts, so
// nothing is cut out here): {media, track, stream, start, end, source_in, source_out, speed, pieces, duck}.
export function soundRuns(tracks, settings, stemReady) {
  const mode = settings.background;
  const skipped = skippedRanges(tracks);
  const voice = speech(tracks, skipped);
  const runs = [];
  for (const tid of ['background', 'audio']) {
    const track = trackOf(tracks, tid);
    if (!track || track.muted) continue;
    const level = (track.volume ?? 100) / 100;
    const duck = duckOf(track, voice, skipped);
    const pieces = track.clips.filter((c) => !c.skipped && c.end - c.start > EPS).map((c) => ({
      clip: c, media: c.media, speed: speedOf(tracks, c), start: c.start, end: c.end, source_in: c.source_in, source_out: c.source_out,
      fade_in: c.fade_in || 0, fade_out: c.fade_out || 0,
    }));
    for (const run of groupRuns(pieces)) {
      for (const [stream, gains] of streams(run, tid, mode, level, stemReady)) {
        if (gains.some((g) => g > 0)) runs.push(makeRun(run, tid, stream, gains, duck));
      }
    }
  }
  return runs;
}

function groupRuns(pieces) {
  const out = [];
  for (const p of [...pieces].sort((a, b) => a.start - b.start)) {
    const run = out[out.length - 1];
    const last = run?.[run.length - 1];
    if (last && last.media === p.media && last.speed === p.speed && Math.abs(last.end - p.start) < EPS && Math.abs(last.source_out - p.source_in) < EPS) run.push(p);
    else out.push([p]);
  }
  return out;
}

// Which streams of the file a run plays, with each piece's level in it: the music track at its
// volume; on the background track the upload's sound follows the mode and the track's volume, and
// another video's own sound plays at its clips' volume.
function streams(run, tid, mode, level, stemReady) {
  const cf = run.map((p) => clipFactor(p.clip));
  if (tid !== 'background' || run[0].media !== 'source') return [['original', cf.map((c) => c * (tid === 'audio' ? level : 1))]];
  const keep = run.map((p) => !!p.clip.keep_voice);
  if (mode === 'separate' && stemReady) {
    const out = [];
    if (!keep.every(Boolean)) out.push(['stem', cf.map((c, i) => (keep[i] ? 0 : c * level))]);
    if (keep.some(Boolean)) out.push(['original', cf.map((c, i) => (keep[i] ? c : 0))]);
    return out;
  }
  if (mode === 'duck' || mode === 'separate') {
    const base = mode === 'duck' ? level : level * 0.3; // separate, before the voice is removed: quietly
    return [['original', cf.map((c, i) => (keep[i] ? c : c * base))]];
  }
  return [['original', cf.map((c, i) => (keep[i] ? c : 0))]]; // replace: only where the original voice is kept
}

function makeRun(run, tid, stream, gains, duck) {
  const n = run.length;
  const start = run[0].start;
  const speed = run[0].speed;
  const pieces = run.map((p, i) => ({
    id: p.clip.id, start: p.start - start, end: p.end - start, level: gains[i], keys: gains[i] > 0 && p.clip.keys?.length ? p.clip.keys : null,
    source_in: p.source_in, fade_in: p.fade_in, fade_out: p.fade_out,
  }));
  if (pieces[0].fade_in <= 0) pieces[0].fade_in = MIN_FADE;
  if (pieces[n - 1].fade_out <= 0) pieces[n - 1].fade_out = MIN_FADE;
  for (let i = 0; i < n - 1; i += 1) {
    const a = pieces[i];
    const b = pieces[i + 1];
    if (Math.abs(valueAt(a, a.end, speed) - valueAt(b, b.start, speed)) > 1e-6 && a.fade_out <= 0 && b.fade_in <= 0) b.fade_in = MIN_FADE;
  }
  pieces.forEach((p, i) => {
    p.lead_in = i > 0 ? pieces[i - 1].fade_out : 0;
    p.lead_out = i + 1 < n ? pieces[i + 1].fade_in : 0;
  });
  return {
    media: run[0].media, track: tid, stream, speed, start, end: run[n - 1].end,
    source_in: run[0].source_in, source_out: run[n - 1].source_out, pieces, duck,
  };
}

// A piece's level at t seconds into its run, with its clip's volume line (it carries on past the
// piece's ends, so a neighbour can change into it).
function valueAt(p, t, speed) {
  return p.keys ? p.level * keysAt(p.keys, p.source_in + (t - p.start) * speed) / 100 : p.level;
}

// How loud a run plays at t seconds into it (backend render.gain_at).
export function runGain(run, t) {
  const { pieces, speed } = run;
  const i = pieces.findIndex((p) => t >= p.start && t < p.end);
  if (i < 0) return 0;
  const p = pieces[i];
  const a = p.fade_in > 0 ? Math.min(1, Math.max(0, (t - p.start + p.lead_in) / (p.lead_in + p.fade_in))) : 1;
  const b = p.fade_out > 0 ? Math.min(1, Math.max(0, (p.end + p.lead_out - t) / (p.lead_out + p.fade_out))) : 1;
  const cur = valueAt(p, t, speed);
  let g;
  if (a < b) {
    const prev = i > 0 ? valueAt(pieces[i - 1], t, speed) : 0;
    g = prev + (cur - prev) * a;
  } else {
    const next = i + 1 < pieces.length ? valueAt(pieces[i + 1], t, speed) : 0;
    g = next + (cur - next) * b;
  }
  return run.duck ? g * duckFactor(run.duck, outputTime(run.start + t, run.duck.skipped)) : g;
}

// How loud one clip plays at timeline time t (its own piece of its run).
export function clipLevel(runs, clip, t) {
  let level = 0;
  for (const run of runs) {
    if (run.media !== clip.media || t < run.start || t >= run.end) continue;
    const local = t - run.start;
    if (run.pieces.some((p) => p.id === clip.id && local >= p.start && local < p.end)) level += runGain(run, local);
  }
  return level;
}

// How loud one stream of one file plays at timeline time t (0 when nothing plays it).
export function levelOf(runs, stream, media, t) {
  let level = 0;
  for (const run of runs) {
    if (run.stream !== stream || run.media !== media || t < run.start || t >= run.end) continue;
    level += runGain(run, t - run.start);
  }
  return level;
}

// How loud one file plays at timeline time t, all its streams together (for the waveform's height).
export function mediaLevel(runs, media, t) {
  let level = 0;
  for (const run of runs) if (run.media === media && t >= run.start && t < run.end) level += runGain(run, t - run.start);
  return level;
}

// A voice clip's gain `local` seconds after it starts (its track's volume aside): its volume or its
// volume line, its fades, and the short fade where a clip too long for its slot is cut (backend
// render.voice_gains). `audible`: how long it plays.
export function voiceGain(s, local, playsFor, cut) {
  if (s.muted) return 0;
  let g = s.keys?.length ? keysAt(s.keys, local) / 100 : (s.volume ?? 100) / 100;
  if ((s.fade_in || 0) > 0) g *= Math.min(1, Math.max(0, local / s.fade_in));
  if ((s.fade_out || 0) > 0) g *= Math.min(1, Math.max(0, (playsFor - local) / s.fade_out));
  if (cut) g *= Math.min(1, Math.max(0, (playsFor - local) / VOICE_CUT_FADE));
  return g;
}

// A sound clip's volume line in timeline time ([{t, v}]), or its volume as a flat line.
export function clipLine(clip, tid, speed = clip.speed ?? 1) {
  if (!clip.keys?.length) return null;
  const toTime = tid === 'voice' ? (at) => clip.start + at : (at) => clip.start + (at - clip.source_in) / speed;
  return clip.keys.map((k) => ({ t: toTime(k.at), v: k.v, at: k.at }));
}

// Where in a clip's own sound timeline time t is (what volume line points are in).
export const soundAt = (clip, tid, t, speed = clip.speed ?? 1) => (tid === 'voice' ? t - clip.start : clip.source_in + (t - clip.start) * speed);

// ---------- the picture ----------

// The exported picture's size (backend render.canvas).
export function canvasSize(project) {
  const { width: w, height: h } = project.video;
  const e = project.settings.export || {};
  const aspect = e.aspect || 'original';
  const resolution = e.resolution || 'original';
  if (aspect === 'original' && resolution === 'original') return { width: w, height: h };
  const ratio = { '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1 }[aspect] || w / h;
  const short = { '720p': 720, '1080p': 1080 }[resolution] || Math.min(w, h);
  const even = (v) => Math.max(2, Math.round(v / 2) * 2);
  return ratio >= 1 ? { width: even(short * ratio), height: even(short) } : { width: even(short), height: even(short / ratio) };
}

// Where a picture of width × height sits on the canvas: whole (fit) or covering it (fill).
export function pictureRect(canvas, width, height, fit = 'fit') {
  const scale = (fit === 'fill' ? Math.max : Math.min)(canvas.width / width, canvas.height / height);
  const w = width * scale;
  const h = height * scale;
  return { left: (canvas.width - w) / 2, top: (canvas.height - h) / 2, width: w, height: h };
}

// ---------- time ----------

export const onFrame = (t, fps) => Math.round(t * fps) / fps;

// 1:02.15 = 1 minute, 2 seconds, frame 15.
export function timecode(t, fps = 30) {
  const frames = Math.max(0, Math.round(t * fps));
  const whole = Math.floor(frames / fps);
  const f = frames - whole * fps;
  const m = Math.floor(whole / 60);
  const s = whole - m * 60;
  return `${m}:${String(s).padStart(2, '0')}.${String(Math.round(f)).padStart(2, '0')}`;
}

// The nearest edge (or other moment) within `px` pixels of t, else t itself.
export function snapTo(t, points, scale, px = 8) {
  let best = t;
  let dist = px / scale;
  for (const p of points) {
    const d = Math.abs(p - t);
    if (d < dist) { dist = d; best = p; }
  }
  return best;
}

// Every clip edge on the timeline (and the playhead), for snapping.
export function edges(tracks, extra = []) {
  const out = [...extra];
  for (const t of tracks) for (const c of t.clips) out.push(c.start, c.end);
  return out;
}

// ---------- subtitles: the same rules as backend render.subtitle_spans ----------

export const subtitleText = (s) => (s.subtitle_text ?? s.khmer_text ?? '').trim();

// Every subtitle shown, in timeline time: {id, text, original, start, end}. A subtitle stays at least
// half a second and never runs into the next one; skipped sentences and the hidden text track show none.
export function subtitleLines(tracks) {
  if (trackOf(tracks, 'text').hidden) return [];
  const end = timelineEnd(tracks);
  const lines = trackOf(tracks, 'voice').clips
    .filter((s) => !s.skipped && subtitleText(s))
    .map((s) => {
      const timing = s.subtitle_timing;
      return {
        id: s.id, text: subtitleText(s), original: s.original_text, timed: !!timing,
        start: timing ? s.start + timing.from : s.start,
        end: timing ? s.start + timing.to : Math.max(s.end, s.start + 0.5),
      };
    })
    .sort((a, b) => a.start - b.start);
  return lines.map((l, i) => ({ ...l, end: Math.min(l.end, lines[i + 1]?.start ?? end, end) })).filter((l) => l.end - l.start > EPS);
}

export const lineAt = (lines, t) => clipAt(lines, t);
