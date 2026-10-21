// Plays the Khmer clips in time with the <video> (Web Audio), so edits can be heard before
// exporting. Each clip starts at its sentence's start, at its volume, and stops where its time
// slot ends — the same rules the export uses.
export class VoicePreview {
  constructor() {
    this.ctx = null;
    this.loading = new Map(); // url -> Promise
    this.buffers = new Map(); // url -> AudioBuffer
    this.playing = new Map(); // sentence id -> {source, key}
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

  // Call often while the video plays: starts clips due now or within LEAD seconds,
  // and restarts a clip whose timing, volume or audio changed.
  tick(time, sentences) {
    const LEAD = 0.5;
    const ctx = this.context();
    const live = new Set();
    for (const s of sentences) {
      if (!s.audio_url || s.end <= time || s.start > time + 10) continue;
      this.load(s.audio_url); // fetch upcoming clips early
      const buffer = this.buffers.get(s.audio_url);
      if (!buffer || s.start > time + LEAD) continue;
      const key = `${s.audio_url}|${s.start}|${s.end}|${s.volume}`;
      live.add(s.id);
      const current = this.playing.get(s.id);
      if (current?.key === key) continue;
      if (current) { try { current.source.stop(); } catch { /* ignore */ } }
      const offset = Math.max(0, time - s.start);
      const length = Math.min(buffer.duration, s.end - s.start) - offset;
      if (length <= 0.03) { this.playing.set(s.id, { source: { stop() {} }, key }); continue; }
      const when = ctx.currentTime + Math.max(0, s.start - time);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(s.volume, when);
      gain.gain.setValueAtTime(s.volume, Math.max(when, when + length - 0.08));
      gain.gain.linearRampToValueAtTime(0, when + length);
      source.connect(gain).connect(ctx.destination);
      source.start(when, offset, length);
      this.playing.set(s.id, { source, key });
    }
    for (const [sid, { source }] of this.playing) { // deleted or moved away
      if (!live.has(sid)) {
        try { source.stop(); } catch { /* ignore */ }
        this.playing.delete(sid);
      }
    }
  }
}
