// Plays the Khmer clips in time with the <video> (Web Audio), so edits can be heard before
// exporting. Each clip starts at its sentence's start and stops where its time slot ends, at the
// gain the export gives it (lib/timeline.js voiceGain: its volume or volume line, its fades, the
// short fade where it's cut), times the voice track's volume.
import { voiceGain } from './timeline.js';

const AHEAD = 0.1; // seconds of gain changes planned on each frame
const STEP = 0.01;
const MAX_GAIN = 4; // 200 % on a 200 % track

// Make a gain follow level(dt) — its value dt seconds from now — for the next AHEAD seconds. Called on
// every frame, so a change (a slider moved, the voice starting under the music) is heard at once,
// along the same lines the export uses.
export function follow(param, ctx, level) {
  const now = ctx.currentTime;
  const at = (dt) => Math.min(MAX_GAIN, Math.max(0, level(dt) || 0));
  param.cancelScheduledValues(now);
  param.setValueAtTime(at(0), now);
  for (let k = 1; k * STEP <= AHEAD + 1e-9; k += 1) param.linearRampToValueAtTime(at(k * STEP), now + k * STEP);
}

// Set a gain now (paused: nothing is playing towards a later value).
export function hold(param, value) {
  param.cancelScheduledValues(0);
  param.value = Math.min(MAX_GAIN, Math.max(0, value || 0));
}

export class VoicePreview {
  constructor() {
    this.ctx = null;
    this.loading = new Map(); // url -> Promise
    this.buffers = new Map(); // url -> AudioBuffer
    this.playing = new Map(); // sentence id -> {source, gain, key, when, offset, plays, cut}
  }

  context() {
    if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  load(url) {
    if (!this.loading.has(url)) {
      this.loading.set(url, fetch(url)
        .then((r) => r.arrayBuffer())
        .then((data) => this.context().decodeAudioData(data))
        .then((buffer) => { this.buffers.set(url, buffer); return buffer; })
        .catch(() => { this.loading.delete(url); return null; }));
    }
    return this.loading.get(url);
  }

  stop() {
    for (const { source } of this.playing.values()) {
      try { source.stop(); } catch { /* already stopped */ }
    }
    this.playing.clear();
  }

  // Call on every frame while the video plays: starts clips due now or within LEAD seconds, restarts
  // a clip whose timing or audio changed, and keeps every playing clip at its gain (a volume change
  // is heard without restarting it). `volume`: the voice track's, in percent.
  tick(time, sentences, volume = 100) {
    const LEAD = 0.5;
    const ctx = this.context();
    const live = new Set();
    for (const s of sentences) {
      if (!s.audio_url || s.end <= time || s.start > time + 10) continue;
      this.load(s.audio_url); // fetch upcoming clips early
      const buffer = this.buffers.get(s.audio_url);
      if (!buffer || s.start > time + LEAD) continue;
      const key = `${s.audio_url}|${s.start}|${s.end}`;
      live.add(s.id);
      let cur = this.playing.get(s.id);
      if (cur?.key !== key) {
        if (cur) { try { cur.source.stop(); } catch { /* ignore */ } }
        const slot = s.end - s.start;
        const plays = Math.min(buffer.duration, slot);
        const offset = Math.max(0, time - s.start);
        const length = plays - offset;
        if (length <= 0.03) { this.playing.set(s.id, { source: { stop() {} }, gain: null, key }); continue; }
        const when = ctx.currentTime + Math.max(0, s.start - time);
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        const gain = ctx.createGain();
        gain.gain.value = 0;
        source.connect(gain).connect(ctx.destination);
        source.start(when, offset, length);
        cur = { source, gain, key, when, offset, plays, cut: buffer.duration > slot };
        this.playing.set(s.id, cur);
      }
      if (cur.gain) {
        const { when, offset, plays, cut } = cur;
        const now = ctx.currentTime;
        follow(cur.gain.gain, ctx, (dt) => voiceGain(s, offset + Math.max(0, now + dt - when), plays, cut) * (volume / 100));
      }
    }
    for (const [sid, { source }] of this.playing) { // deleted or moved away
      if (!live.has(sid)) {
        try { source.stop(); } catch { /* ignore */ }
        this.playing.delete(sid);
      }
    }
  }
}
