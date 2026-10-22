// Watermarks: where they sit, how they look and how they move — drawn here for the preview AND, at
// the exported size, for the export (backend services/merge.py lays the same pictures over the
// video), so the two are the same. Their settings are described in backend/watermarks.py.
import { inside, mergeRanges, outputTime, skippedRanges, timelineEnd, trackOf } from './timeline.js';

export const WATERMARK_FONTS = ['Kantumruy Pro', 'Noto Sans Khmer', 'Battambang', 'Moul'];
export const ANCHORS = [
  ['top-left', '↖', 'Top left'], ['top-center', '↑', 'Top centre'], ['top-right', '↗', 'Top right'],
  ['middle-left', '←', 'Middle left'], ['center', '•', 'Centre'], ['middle-right', '→', 'Middle right'],
  ['bottom-left', '↙', 'Bottom left'], ['bottom-center', '↓', 'Bottom centre'], ['bottom-right', '↘', 'Bottom right'],
];
// The parts of a 9:16 picture that TikTok, Reels and Shorts cover with their buttons and captions (%).
export const SAFE_AREA = { top: 10, bottom: 22, left: 6, right: 16 };
export const PULSE_DEPTH = 0.35; // a pulsing watermark goes down to (1 - this) of its opacity
export const PULSE_RATE = 10; // its opacity changes this many times a second (as the export's looped pulse)
export const CORNERS = ['top-left', 'top-right', 'bottom-right', 'bottom-left']; // the order it moves in

// A new watermark's settings (backend watermarks.defaults).
export function watermarkDefaults(kind = 'image') {
  return {
    kind, media: null, whole: true,
    anchor: kind === 'tiled' ? 'center' : 'bottom-right', x: 50, y: 50, margin: 4,
    width: kind === 'image' ? 12 : 8, height: null,
    text: '', font: 'Kantumruy Pro', size: 4, color: '#ffffff', bold: true,
    opacity: kind === 'tiled' ? 15 : 75, rotation: 0,
    effects: { shadow: false, glow: false, outline: false, color: 'original', radius: 0, soft: false },
    animation: { type: 'none', fade: 0.5, period: 3, every: 10 },
    tile: { spacing: 30, angle: -30 },
    hide_during: [], safe_area: true, remove_bg: false,
  };
}

export const isPortrait = (W, H) => H / W > 1.6; // 9:16 and the like

// Where a watermark may sit: the picture, or (9:16, safe area on) the part the apps don't cover.
export function placeArea(w, W, H) {
  if (!w.safe_area || !isPortrait(W, H)) return { left: 0, top: 0, right: W, bottom: H };
  return { left: (W * SAFE_AREA.left) / 100, top: (H * SAFE_AREA.top) / 100, right: W - (W * SAFE_AREA.right) / 100, bottom: H - (H * SAFE_AREA.bottom) / 100 };
}

// A logo's size on a W × H picture: `width` % of the picture's width, and `height` % of its height or
// the logo's own shape. A text watermark is as big as its letters.
export function logoSize(w, W, H, natural) {
  if (w.kind === 'text') return { width: natural.width, height: natural.height };
  const width = Math.max(2, (W * w.width) / 100);
  const height = w.height ? Math.max(2, (H * w.height) / 100) : Math.max(2, (width * natural.height) / Math.max(1, natural.width));
  return { width, height };
}

// The box (top-left, size; before rotation) of a watermark sized `size` at `anchor`.
export function placeBox(w, W, H, size, anchor = w.anchor) {
  const a = placeArea(w, W, H);
  const m = (Math.min(W, H) * w.margin) / 100;
  let x;
  let y;
  if (anchor === 'free') {
    x = (W * w.x) / 100 - size.width / 2;
    y = (H * w.y) / 100 - size.height / 2;
  } else {
    const [row, col] = anchor === 'center' ? ['middle', 'center'] : anchor.split('-');
    x = col === 'left' ? a.left + m : col === 'right' ? a.right - m - size.width : (a.left + a.right - size.width) / 2;
    y = row === 'top' ? a.top + m : row === 'bottom' ? a.bottom - m - size.height : (a.top + a.bottom - size.height) / 2;
  }
  return { x, y, width: size.width, height: size.height };
}

// ---------- when it shows, and how it moves ----------

// The parts of the timeline a watermark hides during (backend watermarks.hidden_ranges).
export function hiddenRanges(tracks, media, hide = []) {
  if (!hide.length) return [];
  const video = trackOf(tracks, 'video').clips;
  const out = [];
  if (hide.includes('ads')) out.push(...video.filter((c) => c.type === 'ad_video' || media?.[c.media]?.role === 'ad').map((c) => ({ start: c.start, end: c.end })));
  const own = video.filter((c) => c.media === 'source');
  if (own.length) {
    const first = Math.min(...own.map((c) => c.start));
    const last = Math.max(...own.map((c) => c.end));
    const added = video.filter((c) => c.media !== 'source');
    if (hide.includes('intro') && added.some((c) => c.end <= first + 0.001)) out.push({ start: 0, end: first });
    if (hide.includes('outro') && added.some((c) => c.start >= last - 0.001)) out.push({ start: last, end: timelineEnd(tracks) });
  }
  return mergeRanges(out);
}

// How a watermark's animation is `since` seconds after it appeared and `until` seconds before it goes
// (output time): {alpha: its opacity's share, 0–1, anchor: where it sits}. The same as the export
// (backend watermarks.animation_at): a fade ramps in a straight line; a pulse steps PULSE_RATE times a
// second; a corner switch jumps to the next corner (clockwise) every `every` seconds.
export function animationAt(w, since, until = Infinity) {
  const a = w.animation || {};
  let alpha = 1;
  let anchor = w.anchor;
  if (a.type === 'fade') { // at most half its time each way, so the two never meet
    const d = Math.min(a.fade, (since + until) / 2);
    alpha = Math.min(1, Math.max(0, since / d), Math.max(0, until / d));
  }
  if (a.type === 'pulse') {
    const step = Math.floor(since * PULSE_RATE + 1e-9) / PULSE_RATE;
    alpha = 1 - (PULSE_DEPTH * (1 - Math.cos((2 * Math.PI * step) / a.period))) / 2;
  }
  if (a.type === 'corners' && w.kind !== 'tiled') {
    const first = Math.max(0, CORNERS.indexOf(nearestCorner(w.anchor)));
    anchor = CORNERS[(first + Math.floor(since / a.every + 1e-9)) % 4];
  }
  return { alpha, anchor };
}

export function nearestCorner(anchor) {
  if (CORNERS.includes(anchor)) return anchor;
  const [row, col] = anchor === 'center' || anchor === 'free' ? ['bottom', 'right'] : anchor.split('-');
  return `${row === 'top' ? 'top' : 'bottom'}-${col === 'left' ? 'left' : 'right'}`;
}

// The watermarks on screen at timeline time t, with how far into them it is (in output time, as
// the export animates them): [{clip, since, until}].
export function watermarksAt(tracks, media, t) {
  const track = trackOf(tracks, 'watermark');
  if (!track || track.hidden) return [];
  const skipped = skippedRanges(tracks);
  if (inside(t, t, skipped)) return [];
  const out = [];
  for (const c of track.clips) {
    if (c.skipped || t < c.start || t >= c.end) continue;
    if (hiddenRanges(tracks, media, c.hide_during).some((r) => t >= r.start && t < r.end)) continue;
    const now = outputTime(t, skipped);
    out.push({ clip: c, since: now - outputTime(c.start, skipped), until: outputTime(c.end, skipped) - now });
  }
  return out;
}

// ---------- drawing ----------

const images = new Map(); // url -> Promise<HTMLImageElement> / the image
export function loadImage(url) {
  if (!images.has(url)) {
    images.set(url, new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => { images.set(url, img); resolve(img); };
      img.onerror = () => { images.delete(url); reject(new Error(`can't load ${url}`)); };
      img.src = url;
    }));
  }
  const hit = images.get(url);
  return hit instanceof Promise ? hit : Promise.resolve(hit);
}
export const loadedImage = (url) => { const hit = images.get(url); return hit && !(hit instanceof Promise) ? hit : null; };

// The picture a watermark uses: the logo (without its background when that's on).
export function logoUrl(w, media) {
  const m = media?.[w.media];
  if (!m) return null;
  return w.remove_bg && m.nobg_url ? m.nobg_url : m.url;
}

const canvasOf = (w, h) => {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
};

function fontOf(w, W, H) {
  const px = Math.max(8, (Math.min(W, H) * w.size) / 100);
  return { px, css: `${w.bold ? 700 : 400} ${px}px "${w.font}", "Kantumruy Pro", sans-serif` };
}

// The logo or the text at its size, in its colour, with its rounded corners and soft look.
function baseImage(w, W, H, img) {
  if (w.kind === 'text') {
    const { px, css } = fontOf(w, W, H);
    const probe = canvasOf(1, 1).getContext('2d');
    probe.font = css;
    const m = probe.measureText(w.text || ' ');
    const width = Math.ceil(m.width + px * 0.2);
    const height = Math.ceil(px * 1.6); // room for Khmer marks above and below
    const c = canvasOf(width, height);
    const g = c.getContext('2d');
    g.font = css;
    g.textBaseline = 'middle';
    g.fillStyle = w.color;
    g.fillText(w.text || '', px * 0.1, height / 2);
    return c;
  }
  const natural = { width: img.naturalWidth || img.width, height: img.naturalHeight || img.height };
  const size = logoSize(w, W, H, natural);
  const c = canvasOf(size.width, size.height);
  const g = c.getContext('2d');
  const r = ((w.effects?.radius || 0) / 100) * Math.min(c.width, c.height);
  if (r > 0) {
    g.beginPath();
    g.roundRect(0, 0, c.width, c.height, r);
    g.clip();
  }
  g.imageSmoothingQuality = 'high';
  g.drawImage(img, 0, 0, c.width, c.height);
  return c;
}

function recolor(c, w) {
  const e = w.effects || {};
  if (e.color === 'original' && !e.soft) return c;
  const g = c.getContext('2d');
  g.save();
  if (e.color !== 'original') {
    g.globalCompositeOperation = 'source-in';
    g.fillStyle = e.color === 'white' ? '#ffffff' : '#000000';
    g.fillRect(0, 0, c.width, c.height);
  }
  if (e.soft) { // a lighter, washed-out look
    g.globalCompositeOperation = 'source-atop';
    g.fillStyle = 'rgb(255 255 255 / 0.45)';
    g.fillRect(0, 0, c.width, c.height);
  }
  g.restore();
  return c;
}

// Shadow, glow and outline around the base picture (it grows by a padding all round).
function withEffects(base, w) {
  const e = w.effects || {};
  if (!e.shadow && !e.glow && !e.outline) return base;
  const s = Math.min(base.width, base.height);
  const pad = Math.ceil(Math.max(4, s * 0.14));
  const c = canvasOf(base.width + 2 * pad, base.height + 2 * pad);
  const g = c.getContext('2d');
  if (e.outline) { // the shape, in a contrasting colour, all round it
    const sil = canvasOf(base.width, base.height);
    const sg = sil.getContext('2d');
    sg.drawImage(base, 0, 0);
    sg.globalCompositeOperation = 'source-in';
    sg.fillStyle = e.color === 'white' ? '#000000' : '#ffffff';
    sg.fillRect(0, 0, sil.width, sil.height);
    const r = Math.max(1, s * 0.035);
    for (let k = 0; k < 16; k += 1) g.drawImage(sil, pad + r * Math.cos((k * Math.PI) / 8), pad + r * Math.sin((k * Math.PI) / 8));
  }
  g.save();
  if (e.glow) {
    g.shadowColor = e.color === 'white' ? 'rgb(255 255 255 / 0.95)' : 'rgb(255 255 255 / 0.85)';
    g.shadowBlur = s * 0.12;
    g.drawImage(base, pad, pad);
  }
  if (e.shadow) {
    g.shadowColor = 'rgb(0 0 0 / 0.6)';
    g.shadowBlur = s * 0.08;
    g.shadowOffsetX = g.shadowOffsetY = s * 0.04;
    g.drawImage(base, pad, pad);
  }
  g.restore();
  g.drawImage(base, pad, pad);
  return c;
}

// Its opacity and rotation: the final picture, as big as the rotated picture needs.
function finish(pic, w) {
  const angle = ((w.rotation || 0) * Math.PI) / 180;
  const cos = Math.abs(Math.cos(angle));
  const sin = Math.abs(Math.sin(angle));
  const c = canvasOf(pic.width * cos + pic.height * sin, pic.width * sin + pic.height * cos);
  const g = c.getContext('2d');
  g.globalAlpha = Math.max(0, Math.min(1, w.opacity / 100));
  g.translate(c.width / 2, c.height / 2);
  g.rotate(angle);
  g.drawImage(pic, -pic.width / 2, -pic.height / 2);
  return c;
}

// A tiled watermark: the logo again and again across the whole picture, on a turned grid.
function tile(pic, w, W, H) {
  const c = canvasOf(W, H);
  const g = c.getContext('2d');
  const step = Math.max(pic.width, pic.height) + (W * (w.tile?.spacing ?? 30)) / 100;
  const angle = ((w.tile?.angle ?? -30) * Math.PI) / 180;
  const reach = Math.hypot(W, H);
  g.translate(W / 2, H / 2);
  g.rotate(angle);
  for (let y = -reach; y <= reach; y += step) {
    const shift = (Math.round(y / step) % 2) * (step / 2); // every other row half a step along
    for (let x = -reach - shift; x <= reach; x += step) g.drawImage(pic, x - pic.width / 2, y - pic.height / 2);
  }
  return c;
}

// Each font is loaded (for the letters used) before a text watermark is drawn with it, so neither the
// preview nor the export is ever drawn with a stand-in. document.fonts.check() isn't asked: it says
// yes too early for a weight the font doesn't have (Moul has no bold), and the stand-in would be kept.
const fonts = new Map(); // css font + letters -> 'loading' | 'done' (loaded, or it can't be: a stand-in then)
function fontReady(css, text) {
  if (typeof document === 'undefined' || !document.fonts) return true;
  const key = `${css}|${text}`;
  if (fonts.get(key) === 'done') return true;
  if (!fonts.has(key)) {
    fonts.set(key, 'loading');
    document.fonts.load(css, text || 'ក').catch(() => {}).finally(() => fonts.set(key, 'done'));
  }
  return false;
}
export const waitForFont = async (w, W, H) => { while (!fontReady(fontOf(w, W, H).css, w.text)) await new Promise((r) => setTimeout(r, 25)); };

const rendered = new Map(); // appearance key -> {canvas, size}
const appearance = (w, W, H, url) => JSON.stringify([w.kind, url, w.width, w.height, w.text, w.font, w.size, w.color, w.bold, w.opacity, w.rotation, w.effects, w.kind === 'tiled' ? w.tile : null, W, H]);

// The watermark drawn at its final look for a W × H picture: {canvas, size (the logo's box before
// rotation and effects)} — or null while its logo is loading (it's then loaded; call again).
export function renderWatermark(w, W, H, media) {
  const url = w.kind === 'text' ? null : logoUrl(w, media);
  const key = appearance(w, W, H, url);
  if (rendered.has(key)) return rendered.get(key);
  let img = null;
  if (url) {
    img = loadedImage(url);
    if (!img) { loadImage(url).catch(() => {}); return null; }
  }
  if (w.kind !== 'text' && !img) return null;
  if (w.kind === 'text' && !fontReady(fontOf(w, W, H).css, w.text)) return null; // drawn once its font is here, not with a stand-in
  const base = recolor(baseImage(w, W, H, img), w);
  const size = { width: base.width, height: base.height };
  let canvas = finish(withEffects(base, w), w);
  if (w.kind === 'tiled') canvas = tile(canvas, w, W, H);
  const out = { canvas, size };
  if (rendered.size > 60) rendered.delete(rendered.keys().next().value);
  rendered.set(key, out);
  return out;
}

// Where the finished picture goes (its top-left on the W × H picture) at `anchor`.
export function placeRendered(w, r, W, H, anchor = w.anchor) {
  if (w.kind === 'tiled') return { x: 0, y: 0 };
  const box = placeBox(w, W, H, r.size, anchor);
  return { x: box.x + box.width / 2 - r.canvas.width / 2, y: box.y + box.height / 2 - r.canvas.height / 2 };
}

// Draw every watermark on screen at timeline time t. Returns false while a logo is still loading.
export function drawWatermarks(ctx, tracks, media, t, W, H) {
  let complete = true;
  for (const { clip, since, until } of watermarksAt(tracks, media, t)) {
    const r = renderWatermark(clip, W, H, media);
    if (!r) { complete = false; continue; }
    const { alpha, anchor } = animationAt(clip, since, until);
    if (alpha <= 0) continue;
    const at = placeRendered(clip, r, W, H, anchor);
    ctx.globalAlpha = alpha;
    ctx.drawImage(r.canvas, Math.round(at.x), Math.round(at.y)); // on whole pixels, as the export lays it
    ctx.globalAlpha = 1;
  }
  return complete;
}

// For the export: each watermark as a PNG at the exported size, where it goes, and (corner switch)
// where it goes at each corner.
export async function renderWatermarkImages(tracks, media, W, H) {
  const out = {};
  const track = trackOf(tracks, 'watermark');
  for (const w of track?.clips || []) {
    if (w.skipped) continue;
    let r = renderWatermark(w, W, H, media);
    if (!r && w.kind !== 'text') { await loadImage(logoUrl(w, media)).catch(() => null); r = renderWatermark(w, W, H, media); }
    if (!r && w.kind === 'text') { await waitForFont(w, W, H); r = renderWatermark(w, W, H, media); }
    if (!r) continue;
    const at = placeRendered(w, r, W, H);
    const item = { data: r.canvas.toDataURL('image/png'), x: Math.round(at.x), y: Math.round(at.y), width: r.canvas.width, height: r.canvas.height };
    if (w.animation?.type === 'corners') item.corners = CORNERS.map((a) => { const p = placeRendered(w, r, W, H, a); return { x: Math.round(p.x), y: Math.round(p.y) }; });
    out[w.id] = item;
  }
  return out;
}

// ---------- helpers for the editor ----------

// Does the watermark cover the subtitles? `band` is where they are ({top, bottom} px).
export function overlapsBand(w, W, H, size, band) {
  if (!band || w.kind === 'tiled') return false;
  const b = placeBox(w, W, H, size);
  return b.y < band.bottom && b.y + b.height > band.top;
}

// Where the burned-in subtitles usually are (two lines, three when bilingual), from their style.
export function subtitleBand(style, W, H) {
  if (!style) return null;
  const line = (Math.min(W, H) * (style.size || 5.5)) / 100 * 1.6;
  const lines = style.bilingual ? 3 : 2;
  const margin = (H * (style.margin ?? 7)) / 100;
  if (style.position === 'top') return { top: margin, bottom: margin + line * lines };
  if (style.position === 'middle') return { top: H / 2 - (line * lines) / 2, bottom: H / 2 + (line * lines) / 2 };
  return { top: H - margin - line * lines, bottom: H - margin };
}

// The same column, at the other end (away from the subtitles).
export function awayFrom(anchor, position = 'bottom') {
  const [row, col] = anchor === 'center' || anchor === 'free' ? ['middle', 'right'] : anchor.split('-');
  const to = position === 'top' ? 'bottom' : 'top';
  return row === to ? `${to}-${col === 'center' ? 'right' : col}` : `${to}-${col}`;
}

// Snap a dragged box to the picture's edges (at the margin) and middle: {x, y, guides}.
export function snapBox(box, w, W, H, px = 8) {
  const a = placeArea(w, W, H);
  const m = (Math.min(W, H) * w.margin) / 100;
  const xs = [[a.left + m, 'left'], [(a.left + a.right - box.width) / 2, 'center'], [a.right - m - box.width, 'right']];
  const ys = [[a.top + m, 'top'], [(a.top + a.bottom - box.height) / 2, 'middle'], [a.bottom - m - box.height, 'bottom']];
  let { x, y } = box;
  const guides = [];
  let col = null;
  let row = null;
  for (const [v, name] of xs) if (Math.abs(x - v) <= px) { x = v; col = name; guides.push({ x: name === 'left' ? v : name === 'right' ? v + box.width : v + box.width / 2 }); break; }
  for (const [v, name] of ys) if (Math.abs(y - v) <= px) { y = v; row = name; guides.push({ y: name === 'top' ? v : name === 'bottom' ? v + box.height : v + box.height / 2 }); break; }
  const anchor = col && row ? (row === 'middle' && col === 'center' ? 'center' : `${row}-${col}`) : null;
  return { x, y, guides, anchor };
}

// An SVG logo as a PNG file (the server can't read SVG), about `long` pixels on its longer side.
export async function svgToPng(file, long = 1200) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = reject; i.src = url; });
    const k = long / Math.max(img.naturalWidth || 300, img.naturalHeight || 150);
    const c = canvasOf((img.naturalWidth || 300) * k, (img.naturalHeight || 150) * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const blob = await new Promise((resolve) => c.toBlob(resolve, 'image/png'));
    return new File([blob], file.name.replace(/\.svg$/i, '.png'), { type: 'image/png' });
  } finally {
    URL.revokeObjectURL(url);
  }
}
