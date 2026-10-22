// The loudness of sound files the server doesn't draw for us (the Khmer voice clips): decoded once
// in the browser, as peaks (0–1, `per_second` a second), kept for the session.
const PER_SECOND = 50;
const cache = new Map(); // url -> {peaks, per_second} once decoded, or the Promise while decoding
const listeners = new Set();
let decoder = null;

export function peaksOf(url) {
  const hit = cache.get(url);
  if (hit && !(hit instanceof Promise)) return hit;
  if (!hit && typeof OfflineAudioContext !== 'undefined') {
    decoder = decoder || new OfflineAudioContext(1, 1, 24000);
    const job = fetch(url)
      .then((r) => r.arrayBuffer())
      .then((data) => decoder.decodeAudioData(data))
      .then((buffer) => {
        const samples = buffer.getChannelData(0);
        const size = Math.max(1, Math.floor(buffer.sampleRate / PER_SECOND));
        const peaks = new Float32Array(Math.ceil(samples.length / size));
        for (let i = 0; i < peaks.length; i += 1) {
          let top = 0;
          for (let k = i * size, end = Math.min(samples.length, k + size); k < end; k += 1) top = Math.max(top, Math.abs(samples[k]));
          peaks[i] = top;
        }
        cache.set(url, { peaks, per_second: PER_SECOND });
        for (const fn of listeners) fn(url);
      })
      .catch(() => cache.delete(url));
    cache.set(url, job);
  }
  return null;
}

// fn(url) when a file's peaks are ready.
export function onPeaks(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
