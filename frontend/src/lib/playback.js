// Plays the edit list in the preview, the way the export will render it:
//  - the video clips one after another, on two <video> elements, so the next clip is ready (seeked,
//    paused) before its cut; clips that simply carry on (a split) keep playing on the same element;
//  - pictures and black gaps, timed by the clock;
//  - skipped parts jumped over;
//  - the background (each clip's own sound and the voice-free music) and the music track at the
//    export's levels (lib/timeline.js: volumes, volume lines, fades, ducking under the voice), and the
//    Khmer voice clips (VoicePreview). Gains are planned a moment ahead on the audio clock (follow),
//    so they change smoothly, and a change to a volume is heard on the next frame.
// It works on timeline time `t`. React reads it through subscribe(); the timeline's playhead reads
// `playback.t` itself every frame.
import { VoicePreview, follow, hold } from './previewAudio.js';
import { EPS, clipAt, clipLevel, levelOf, onFrame, skippedRanges, soundRuns, sourceTime, timelineEnd, trackOf } from './timeline.js';

const DRIFT = 0.3; // seconds a video may be off before it's put back in place
const LEAD = 0.5; // seconds ahead that sound clips are started (scheduled on the audio clock)

// The Music & sound track: each clip's file decoded once, started at its time with Web Audio, at its
// level (the same as the export, moment by moment), stopped where it ends.
class SoundClips {
  constructor(voice) {
    this.voice = voice; // shares its audio context and decoded files
    this.playing = new Map(); // clip id -> {source, gain, key}
  }

  tick(t, clips, urlOf, runs) {
    const ctx = this.voice.context();
    const live = new Set();
    for (const c of clips) {
      if (c.end <= t || c.start > t + 10) continue;
      const url = urlOf(c.media);
      if (!url) continue;
      this.voice.load(url); // fetch upcoming files early
      const buffer = this.voice.buffers.get(url);
      if (!buffer || c.start > t + LEAD) continue;
      const key = `${url}|${c.start}|${c.end}|${c.source_in}`;
      live.add(c.id);
      let cur = this.playing.get(c.id);
      if (!cur || cur.key !== key) {
        if (cur) { try { cur.source.stop(); } catch { /* ended */ } }
        const from = Math.max(t, c.start);
        const length = c.end - from;
        if (length <= 0.03) { this.playing.set(c.id, { source: { stop() {} }, gain: null, key }); continue; }
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        const gain = ctx.createGain();
        gain.gain.value = 0;
        source.connect(gain).connect(ctx.destination);
        source.start(ctx.currentTime + Math.max(0, c.start - t), c.source_in + (from - c.start), length);
        cur = { source, gain, key };
        this.playing.set(c.id, cur);
      }
      if (cur.gain) follow(cur.gain.gain, ctx, (dt) => clipLevel(runs, c, t + dt));
    }
    for (const [cid, { source }] of this.playing) {
      if (!live.has(cid)) {
        try { source.stop(); } catch { /* ended */ }
        this.playing.delete(cid);
      }
    }
  }

  stop() {
    for (const { source } of this.playing.values()) { try { source.stop(); } catch { /* ended */ } }
    this.playing.clear();
  }
}
const PRELOAD = 1.5; // seconds before a cut that the next clip is made ready
const EMIT_EVERY = 100; // ms between updates to React while playing

export class Playback {
  constructor() {
    this.t = 0;
    this.playing = false;
    this.stopAt = null; // pause here (▶ on one sentence)
    this.voice = new VoicePreview();
    this.sounds = new SoundClips(this.voice);
    this.listeners = new Set();
    this.frames = new Set(); // called on every frame (for drawing what animates)
    this.els = null;
    this.front = 'a';
    this.data = null;
    this.raf = 0;
    this.last = 0;
    this.emitted = 0;
    this.gains = new Map(); // element -> GainNode (so the background can be louder than 100 %)
  }

  // ---------- setup ----------

  attach(els) { // {a, b: <video>, image: <img>, stem: <audio>}
    this.els = els;
    for (const key of ['a', 'b']) {
      els[key].addEventListener('ended', () => { if (this.playing && this.els?.[this.front] === els[key]) this.onEnded(); });
    }
    this.show();
  }

  detach() {
    this.pause();
    this.els = null;
  }

  // The latest project data: tracks (with the voice clips), settings, media URLs, fps.
  update({ tracks, settings, media, fps, stemUrl }) {
    const video = trackOf(tracks, 'video');
    this.data = {
      tracks, settings, media, fps: fps || 30, stemUrl,
      video: video.clips, hidden: video.hidden,
      skipped: skippedRanges(tracks),
      end: timelineEnd(tracks),
      runs: soundRuns(tracks, settings, !!stemUrl),
      voice: trackOf(tracks, 'voice').muted ? [] : trackOf(tracks, 'voice').clips.filter((s) => !s.skipped),
      voiceVolume: trackOf(tracks, 'voice').volume ?? 100,
      sounds: trackOf(tracks, 'audio').muted ? [] : trackOf(tracks, 'audio').clips.filter((c) => !c.skipped),
    };
    if (this.els?.stem && stemUrl && this.els.stem.dataset.src !== stemUrl) {
      this.els.stem.src = stemUrl;
      this.els.stem.dataset.src = stemUrl;
    }
    if (!this.playing) this.show();
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // fn(t) on every frame while playing, and after every seek.
  onFrame(fn) {
    this.frames.add(fn);
    return () => this.frames.delete(fn);
  }

  drawn() {
    for (const fn of this.frames) fn(this.t);
  }

  emit(force = false) {
    const now = performance.now();
    if (!force && now - this.emitted < EMIT_EVERY) return;
    this.emitted = now;
    for (const fn of this.listeners) fn({ t: this.t, playing: this.playing });
  }

  get duration() { return this.data?.end || 0; }

  // ---------- controls ----------

  toggle() { if (this.playing) this.pause(); else this.play(); }

  play() {
    if (!this.data || !this.els || this.playing) return;
    if (this.t >= this.data.end - 0.05) this.t = 0;
    this.voice.context(); // a click started this: the audio may start now
    this.playing = true;
    this.last = performance.now();
    this.show();
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame((now) => this.tick(now));
    this.emit(true);
  }

  pause() {
    this.playing = false;
    this.stopAt = null;
    cancelAnimationFrame(this.raf);
    this.voice.stop();
    this.sounds.stop();
    if (this.els) for (const el of [this.els.a, this.els.b, this.els.stem]) if (el && !el.paused) el.pause();
    this.emit(true);
  }

  seek(t) {
    this.t = Math.max(0, Math.min(this.data?.end ?? t, t));
    this.voice.stop();
    this.sounds.stop();
    this.show();
    this.emit(true);
  }

  // One frame forward or back (paused, on the frame grid).
  step(frames) {
    if (this.playing) this.pause();
    const fps = this.data?.fps || 30;
    this.seek(onFrame(this.t, fps) + frames / fps);
  }

  // Play [start, end] once (▶ on a sentence).
  playRange(start, end) {
    this.pause();
    this.seek(start);
    this.play();
    this.stopAt = end;
  }

  // ---------- what is on screen ----------

  videoClipAt(t) {
    const c = clipAt(this.data.video, t);
    return c && !c.skipped ? c : c ? { ...c, isSkipped: true } : null;
  }

  url(mediaId) {
    const m = this.data.media[mediaId];
    return m ? (m.proxy_url || m.url) : '';
  }

  // Load a file into an element (keeps its place if it's already that file).
  load(el, mediaId) {
    const url = this.url(mediaId);
    if (el.dataset.src !== url) {
      const keep = el.dataset.media === mediaId ? el.currentTime : null; // the proxy arrived: same file, smaller copy
      el.src = url;
      el.dataset.src = url;
      el.dataset.media = mediaId;
      if (keep !== null) el.currentTime = keep;
    }
  }

  // Show the picture for this.t (and put the elements in place while paused).
  show() {
    if (!this.els || !this.data) return;
    const { a, b, image } = this.els;
    const clip = this.videoClipAt(this.t);
    const front = this.els[this.front];
    let visible = null;
    if (clip?.type === 'video') {
      this.load(front, clip.media);
      const target = sourceTime(clip, this.t);
      if (!this.playing && Math.abs(front.currentTime - target) > 0.5 / this.data.fps) front.currentTime = target;
      front.playbackRate = clip.speed || 1;
      visible = front;
    } else if (clip?.type === 'image') {
      const url = this.data.media[clip.media]?.url;
      if (image.dataset.src !== url) { image.src = url; image.dataset.src = url; }
      visible = image;
    }
    const hidden = this.data.hidden;
    for (const el of [a, b, image]) el.style.visibility = el === visible && !hidden ? 'visible' : 'hidden';
    this.setLevels(clip);
    this.drawn();
  }

  setLevels(clip) {
    const { runs } = this.data;
    const front = this.els[this.front];
    const back = this.els[this.front === 'a' ? 'b' : 'a'];
    const media = clip?.type === 'video' ? clip.media : null;
    const t = this.t;
    this.volume(front, media ? (dt) => levelOf(runs, 'original', media, t + dt) : () => 0);
    this.volume(back, () => 0);
    if (this.els.stem) this.volume(this.els.stem, media === 'source' ? (dt) => levelOf(runs, 'stem', 'source', t + dt) : () => 0);
  }

  // An element's gain: level(dt) is its level dt seconds from now.
  volume(el, level) {
    let gain = this.gains.get(el);
    if (!gain && this.voice.ctx) { // route through Web Audio once a click has unlocked it
      try {
        const ctx = this.voice.ctx;
        gain = ctx.createGain();
        ctx.createMediaElementSource(el).connect(gain).connect(ctx.destination);
        this.gains.set(el, gain);
      } catch { /* not allowed here: fall back to the element's own volume */ }
    }
    if (gain) {
      el.volume = 1;
      if (this.playing) follow(gain.gain, this.voice.ctx, level);
      else hold(gain.gain, level(0));
    } else {
      el.volume = Math.max(0, Math.min(1, level(0)));
    }
  }

  // ---------- playing ----------

  tick(now) {
    if (!this.playing || !this.data || !this.els) return;
    const dt = Math.min(0.25, (now - this.last) / 1000);
    this.last = now;
    const d = this.data;

    if (this.stopAt !== null && this.t >= this.stopAt) { this.t = this.stopAt; this.pause(); return; }
    if (this.t >= d.end - EPS) { this.t = d.end; this.pause(); return; }

    // jump over skipped parts, as the export leaves them out
    const skip = d.skipped.find((r) => this.t >= r.start - EPS && this.t < r.end - EPS);
    if (skip) { this.jump(skip.end); this.raf = requestAnimationFrame((n) => this.tick(n)); return; }

    const clip = this.videoClipAt(this.t);
    if (clip?.type === 'video') {
      this.playVideo(clip);
    } else {
      for (const el of [this.els.a, this.els.b]) if (!el.paused) el.pause();
      this.t += dt; // a picture or a gap: the clock moves on
      const next = clipAt(d.video, this.t);
      if (next && next !== clip && next.type === 'video') this.show();
    }
    this.prepareNext();
    this.show();
    this.syncStem(clip);
    this.voice.tick(this.t, d.voice, d.voiceVolume);
    this.sounds.tick(this.t, d.sounds, (mid) => d.media[mid]?.url, d.runs);
    this.emit();
    this.raf = requestAnimationFrame((n) => this.tick(n));
  }

  playVideo(clip) {
    const target = sourceTime(clip, this.t);
    let el = this.els[this.front];
    if (el.dataset.media !== clip.media || Math.abs(el.currentTime - target) > DRIFT) {
      const other = this.els[this.front === 'a' ? 'b' : 'a'];
      if (other.dataset.media === clip.media && Math.abs(other.currentTime - target) <= DRIFT) { // ready at the cut
        el.pause();
        this.front = this.front === 'a' ? 'b' : 'a';
        el = other;
      } else {
        this.load(el, clip.media);
        if (!el.seeking) el.currentTime = target;
        this.voice.stop();
        this.sounds.stop();
      }
    }
    el.playbackRate = clip.speed || 1;
    if (el.paused) el.play().catch(() => {});
    if (el.seeking || el.readyState < 3) return; // still loading: time waits for the picture
    const t = clip.start + (el.currentTime - clip.source_in) / (clip.speed || 1);
    this.t = Math.min(clip.end, Math.max(this.t, t)); // the picture's clock (never backwards)
    if (clip.end - this.t < 0.5 / this.data.fps) this.t = clip.end; // on to the next clip
  }

  onEnded() { // the file itself ended (its last clip ran to the end of the file)
    const clip = this.videoClipAt(this.t);
    if (clip) this.t = clip.end;
  }

  jump(t) {
    this.t = t;
    this.voice.stop();
    this.sounds.stop();
    this.show();
  }

  // Before a cut, put the next video clip in the other element, seeked and paused.
  prepareNext() {
    const d = this.data;
    const clip = clipAt(d.video, this.t);
    if (!clip || clip.end - this.t > PRELOAD) return;
    let t = clip.end;
    for (const r of d.skipped) if (t >= r.start - EPS && t < r.end - EPS) t = r.end;
    const next = clipAt(d.video, t + EPS);
    if (!next || next.type !== 'video' || next.skipped) return;
    const front = this.els[this.front];
    const target = sourceTime(next, t);
    const carriesOn = front.dataset.media === next.media && Math.abs(sourceTime(clip, clip.end) - target) < 0.05 && Math.abs(t - clip.end) < EPS;
    if (carriesOn) return;
    const back = this.els[this.front === 'a' ? 'b' : 'a'];
    this.load(back, next.media);
    if (Math.abs(back.currentTime - target) > 0.05 && !back.seeking) back.currentTime = target;
    if (!back.paused) back.pause();
  }

  // The voice-free music plays in step with the upload's clips.
  syncStem(clip) {
    const stem = this.els.stem;
    if (!stem?.src) return;
    const on = clip?.type === 'video' && clip.media === 'source' && levelOf(this.data.runs, 'stem', 'source', this.t) > 0;
    if (!on) { if (!stem.paused) stem.pause(); return; }
    const target = sourceTime(clip, this.t);
    if (Math.abs(stem.currentTime - target) > 0.15) stem.currentTime = target;
    stem.playbackRate = clip.speed || 1;
    if (stem.paused) stem.play().catch(() => {});
  }
}
