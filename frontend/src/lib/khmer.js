// Khmer text helpers.

export const KHMER_CHARS_PER_SECOND = 11; // keep in sync with backend/sentences.py

// How many characters a Khmer voice comfortably says in `seconds`.
export const budget = (seconds) => Math.max(4, Math.round(seconds * KHMER_CHARS_PER_SECOND));

// Khmer is written without spaces between words, so find word boundaries with Intl.Segmenter
// (falls back to spaces). Returns every position where the text may be split.
export function wordBoundaries(text) {
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    return [...new Intl.Segmenter('km', { granularity: 'word' }).segment(text)].map((s) => s.index).filter((i) => i > 0);
  }
  const out = [];
  text.replace(/\s+/g, (m, i) => { out.push(i + m.length); return m; });
  return out;
}

// The word boundary nearest to `near` (default: the middle) — where "Split" cuts a sentence.
export function splitPoint(text, near) {
  const target = near ?? Math.floor(text.length / 2);
  const points = wordBoundaries(text).filter((i) => i < text.length);
  if (!points.length) return target;
  return points.reduce((best, i) => (Math.abs(i - target) < Math.abs(best - target) ? i : best), points[0]);
}
