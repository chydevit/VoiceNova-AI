// Background volume parts ({start, end, gain, fade}): 0 = silent, 0.5 = half, 1.5 = louder.
// Same maths as backend/services/merge.py, so the preview and the waveform match the export.
export const DEFAULT_FADE = 0.05;

// How loud the background is at time t (1 = normal), ramped over each part's fade.
export function gainAt(parts, t) {
  let factor = 1;
  for (const p of parts) {
    const fade = Math.max(p.fade ?? DEFAULT_FADE, 0.01);
    const ramp = Math.min(1, Math.max(0, Math.min(t - p.start, p.end - t) / fade));
    factor += ((p.gain ?? 0) - 1) * ramp;
  }
  return Math.max(0, factor);
}

export function partLabel(p) {
  const gain = p.gain ?? 0;
  if (gain === 0) return '🔇 silent';
  return `${gain < 1 ? '🔉' : '🔊'} ${Math.round(gain * 100)}%`;
}
