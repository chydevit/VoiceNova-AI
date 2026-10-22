// Khmer subtitles and the title, drawn by the browser (it shapes Khmer script correctly and has
// the fonts). The editor's preview and the burned-in export use the same drawing code, so the
// preview shows exactly what the video will get.

// Khmer fonts the subtitles can use (loaded from Google Fonts in index.html).
export const FONTS = [
  ['Kantumruy Pro', 'Kantumruy Pro — clean'],
  ['Noto Sans Khmer', 'Noto Sans Khmer — plain'],
  ['Battambang', 'Battambang — classic'],
  ['Hanuman', 'Hanuman — book'],
  ['Koulen', 'Koulen — bold headline'],
  ['Moul', 'Moul — decorative'],
];

// keep in sync with backend store.default_subtitle_style()
export const DEFAULT_STYLE = {
  size: 5.5, color: '#ffffff', outline: true, box: false, position: 'bottom', margin: 7, bilingual: false,
  x: 50, align: 'center', width: 90, font: 'Kantumruy Pro', bold: true,
  outline_color: '#000000', outline_width: 20, box_color: '#000000', box_opacity: 0.6, shadow: false,
};

// keep in sync with backend store.default_title()
export const DEFAULT_TITLE = { text: '', size: 7, color: '#fde047', margin: 5, outline: true, box: false };

// Styles saved before a setting existed get its default.
const full = (style) => ({ ...DEFAULT_STYLE, ...style });

const family = (style) => `"${style.font}", "Kantumruy Pro", "Noto Sans Khmer", sans-serif`;

// Sizes in pixels for a picture of width × height.
function metrics(width, height, style) {
  const size = Math.max(14, Math.round((Math.min(width, height) * style.size) / 100));
  const small = Math.round(size * 0.62);
  return { size, small, line: size * 1.6, smallLine: small * 1.6, pad: Math.round(size * 0.35), maxWidth: (width * style.width) / 100 };
}

const font = (m, small, style) => (small ? `500 ${m.small}px ${family(style)}` : `${style.bold ? 600 : 400} ${m.size}px ${family(style)}`);

function rgba(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

// The lines one subtitle needs: the Khmer text, then (bilingual) the original, smaller.
function lines(ctx, item, m, style) {
  ctx.font = font(m, false, style);
  const out = wrap(ctx, item.text.trim(), m.maxWidth).map((t) => ({ t, small: false }));
  if (style.bilingual && item.original?.trim()) {
    ctx.font = font(m, true, style);
    out.push(...wrap(ctx, item.original.trim(), m.maxWidth).map((t) => ({ t, small: true })));
  }
  return out;
}

const blockHeight = (ls, m) => ls.reduce((h, l) => h + (l.small ? m.smallLine : m.line), 0);

// Draw the lines with the top of the text block at `top`. style.x (% of the picture width) is where
// the block's left edge, centre or right edge goes (style.align); it never leaves the picture.
// Returns the block's box in picture pixels.
function drawBlock(ctx, ls, m, style, pictureWidth, top) {
  let widest = 0;
  for (const l of ls) { ctx.font = font(m, l.small, style); widest = Math.max(widest, ctx.measureText(l.t).width); }
  const padX = style.box ? m.pad : Math.round(m.size * 0.12);
  const w = widest + padX * 2;
  const h = blockHeight(ls, m) + m.pad;
  const anchor = (pictureWidth * style.x) / 100;
  const want = style.align === 'left' ? anchor : style.align === 'right' ? anchor - w : anchor - w / 2;
  const left = w >= pictureWidth ? (pictureWidth - w) / 2 : Math.min(pictureWidth - w, Math.max(0, want));
  if (style.box) {
    ctx.fillStyle = rgba(style.box_color, style.box_opacity);
    ctx.beginPath();
    ctx.roundRect(left, top - m.pad / 2, w, h, m.pad);
    ctx.fill();
  }
  const tx = style.align === 'left' ? left + padX : style.align === 'right' ? left + w - padX : left + w / 2;
  let y = top;
  ctx.textAlign = style.align;
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  for (const l of ls) {
    const lineHeight = l.small ? m.smallLine : m.line;
    const px = l.small ? m.small : m.size;
    ctx.font = font(m, l.small, style);
    if (style.shadow) {
      ctx.shadowColor = 'rgba(0, 0, 0, 0.75)';
      ctx.shadowBlur = px * 0.25;
      ctx.shadowOffsetY = px * 0.06;
    }
    if (style.outline && style.outline_width > 0) {
      ctx.lineWidth = (px * style.outline_width) / 100;
      ctx.strokeStyle = style.outline_color;
      ctx.strokeText(l.t, tx, y + lineHeight / 2);
      ctx.shadowColor = 'transparent'; // one shadow, under the outline
    }
    ctx.fillStyle = l.small ? '#e2e8f0' : style.color;
    ctx.fillText(l.t, tx, y + lineHeight / 2);
    ctx.shadowColor = 'transparent';
    y += lineHeight;
  }
  return { left, top: top - m.pad / 2, width: w, height: h };
}

// Where the text block's top goes in the full picture.
function blockTop(height, blockH, style) {
  return style.position === 'top' ? (height * style.margin) / 100 : height * (1 - style.margin / 100) - blockH;
}

export function loadSubtitleFont(style = DEFAULT_STYLE) {
  const st = full(style);
  return Promise.all([
    document.fonts.load(`600 40px ${family(st)}`, 'កខគ'),
    document.fonts.load(`400 40px ${family(st)}`, 'កខគ'),
  ]).then(() => style, () => style);
}

// Draw one subtitle over a full-picture canvas (the editor preview). `item`: {text, original?}.
// Returns where it was drawn (picture pixels), or null.
export function drawSubtitle(ctx, item, width, height, style) {
  ctx.clearRect(0, 0, width, height);
  if (!item?.text?.trim()) return null;
  const st = full(style);
  const m = metrics(width, height, st);
  const ls = lines(ctx, item, m, st);
  return drawBlock(ctx, ls, m, st, width, blockTop(height, blockHeight(ls, m), st));
}

// One transparent PNG per subtitle for burning in. They all cover the same strip of the picture,
// just tall enough for the longest subtitle, so far less data is sent than full frames.
// `items`: [{id, text, original?}]. Returns {images: {id: dataURL}, layout: {y, width, height}}.
export async function renderSubtitleImages(items, width, height, style = DEFAULT_STYLE) {
  const st = full(style);
  await loadSubtitleFont(st); // canvas draws with a fallback font if this hasn't loaded
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const m = metrics(width, height, st);
  const laid = items.filter((item) => item.text.trim()).map((item) => ({ item, ls: lines(ctx, item, m, st) }));
  const tallest = Math.max(m.line, ...laid.map(({ ls }) => blockHeight(ls, m)));
  const strip = Math.min(height, Math.ceil(tallest + m.pad * 2));
  // bottom: the block's bottom edge sits at (1 - margin) of the height; top: its top edge at margin
  const anchor = st.position === 'top' ? (height * st.margin) / 100 - m.pad : height * (1 - st.margin / 100) + m.pad - strip;
  const y = Math.max(0, Math.min(height - strip, Math.round(anchor)));
  canvas.width = width;
  canvas.height = strip;
  const images = {};
  for (const { item, ls } of laid) {
    ctx.clearRect(0, 0, width, strip);
    const top = blockTop(height, blockHeight(ls, m), st) - y; // same place as the preview, inside the strip
    drawBlock(ctx, ls, m, st, width, top);
    images[item.id] = canvas.toDataURL('image/png');
  }
  return { images, layout: { y, width, height: strip } };
}

// ---------- title: one text at the top for the whole video ----------

const titleStyle = (title) => full({ ...title, position: 'top', x: 50, align: 'center', width: 90, font: DEFAULT_STYLE.font, bold: true, shadow: false });

// The title's lines: each line typed (Enter = new line), wrapped to the picture's width.
function titleLines(ctx, title, m, style) {
  ctx.font = font(m, false, style);
  return title.text.split('\n').flatMap((part) => wrap(ctx, part.trim(), m.maxWidth)).map((t) => ({ t, small: false }));
}

// Draw the title over a full-picture canvas (the editor preview).
export function drawTitle(ctx, title, width, height) {
  ctx.clearRect(0, 0, width, height);
  if (!title?.text?.trim()) return;
  const style = titleStyle(title);
  const m = metrics(width, height, style);
  const ls = titleLines(ctx, title, m, style);
  drawBlock(ctx, ls, m, style, width, blockTop(height, blockHeight(ls, m), style));
}

// The title as one transparent PNG strip for burning in: {data, y, width, height}, or null.
export async function renderTitleImage(title, width, height) {
  if (!title?.text?.trim()) return null;
  await loadSubtitleFont();
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const style = titleStyle(title);
  const m = metrics(width, height, style);
  const ls = titleLines(ctx, title, m, style);
  const top = blockTop(height, blockHeight(ls, m), style);
  const strip = Math.min(height, Math.ceil(blockHeight(ls, m) + m.pad * 2));
  const y = Math.max(0, Math.min(height - strip, Math.round(top - m.pad)));
  canvas.width = width;
  canvas.height = strip;
  drawBlock(ctx, ls, m, style, width, top - y); // same place as the preview, inside the strip
  return { data: canvas.toDataURL('image/png'), y, width, height: strip };
}

// ---------- text clips: text anywhere on the picture, for a time, with an animation ----------

export const TEXT_ANIMATION = 0.35; // seconds to come in or go out; keep in sync with backend services/merge.py
export const ANIMATIONS = [['none', 'None'], ['fade', 'Fade'], ['pop', 'Pop'], ['slide', 'Slide']];

// keep in sync with backend timeline.default_text_style()
export const DEFAULT_TEXT_STYLE = {
  font: 'Kantumruy Pro', size: 8, color: '#ffffff', bold: true, outline: true, outline_color: '#000000', outline_width: 18,
  box: false, box_color: '#000000', box_opacity: 0.6, shadow: true,
};

// A text clip's style in the terms the drawing code uses (its middle at x, y % of the picture).
const textStyle = (clip) => full({ ...DEFAULT_TEXT_STYLE, ...clip.style, x: clip.x ?? 50, align: clip.align || 'center', width: clip.width ?? 90, position: 'top', margin: 0, bilingual: false });

function textLayout(ctx, clip, width, height) {
  const style = textStyle(clip);
  const m = metrics(width, height, style);
  ctx.font = font(m, false, style);
  const ls = String(clip.text || '').split('\n').flatMap((part) => wrap(ctx, part.trim(), m.maxWidth)).map((t) => ({ t, small: false }));
  const top = (height * (clip.y ?? 50)) / 100 - blockHeight(ls, m) / 2;
  return { style, m, ls, top };
}

// How far a text clip has come in / gone out at timeline time t: {alpha, scale, dy (px)}.
// The same curves as the export's FFmpeg expressions (backend services/merge._text).
export function textMotion(clip, t, height) {
  const d = Math.min(TEXT_ANIMATION, (clip.end - clip.start) / 2);
  const come = clip.animation?.in || 'none';
  const go = clip.animation?.out || 'none';
  const p = Math.min(1, Math.max(0, (t - clip.start) / d));
  const q = Math.min(1, Math.max(0, (t - (clip.end - d)) / d));
  let alpha = 1;
  let scale = 1;
  let dy = 0;
  if (come === 'fade' || come === 'slide') alpha *= p;
  if (come === 'pop') { alpha *= Math.min(1, p * 2); scale *= 0.5 + 0.5 * (1 + 2.70158 * (p - 1) ** 3 + 1.70158 * (p - 1) ** 2); }
  if (come === 'slide') dy += height * 0.06 * (1 - p) ** 2;
  if (go !== 'none') alpha *= 1 - q;
  if (go === 'pop') scale *= 1 - 0.4 * q * q;
  if (go === 'slide') dy -= height * 0.05 * q * q;
  return { alpha, scale, dy };
}

// Draw a text clip onto a full-picture canvas (not cleared first), as it looks at time t
// (t null: fully in). Returns its box in picture pixels, without the animation.
export function drawTextClip(ctx, clip, width, height, t = null) {
  if (!String(clip.text || '').trim()) return null;
  const { style, m, ls, top } = textLayout(ctx, clip, width, height);
  if (t === null) return drawBlock(ctx, ls, m, style, width, top);
  const { alpha, scale, dy } = textMotion(clip, t, height);
  if (alpha <= 0.001) return measureBlock(ctx, ls, m, style, width, top);
  ctx.save();
  ctx.globalAlpha = alpha;
  const box = measureBlock(ctx, ls, m, style, width, top);
  const cx = box.left + box.width / 2;
  const cy = box.top + box.height / 2;
  ctx.translate(cx, cy + dy);
  ctx.scale(scale, scale);
  ctx.translate(-cx, -cy);
  drawBlock(ctx, ls, m, style, width, top);
  ctx.restore();
  return box;
}

// Where a text clip sits on the picture (picture pixels), fully in.
export function measureTextClip(clip, width, height) {
  if (!String(clip.text || '').trim()) return null;
  const scratch = document.createElement('canvas').getContext('2d');
  const { style, m, ls, top } = textLayout(scratch, clip, width, height);
  return drawBlock(scratch, ls, m, style, width, top);
}

// Where a block would go, without drawing it.
function measureBlock(ctx, ls, m, style, width, top) {
  const scratch = document.createElement('canvas').getContext('2d');
  return drawBlock(scratch, ls, m, style, width, top);
}

// A text clip as one PNG of just the text (for burning in), and where it goes: {data, x, y, width, height}.
export async function renderTextImage(clip, width, height) {
  await loadSubtitleFont(textStyle(clip));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const box = drawTextClip(ctx, clip, width, height);
  if (!box) return null;
  const pad = Math.ceil(metrics(width, height, textStyle(clip)).size * 0.35); // room for the outline and shadow
  const x = Math.max(0, Math.floor(box.left - pad));
  const y = Math.max(0, Math.floor(box.top - pad));
  const w = Math.min(width, Math.ceil(box.left + box.width + pad)) - x;
  const h = Math.min(height, Math.ceil(box.top + box.height + pad)) - y;
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  out.getContext('2d').drawImage(canvas, x, y, w, h, 0, 0, w, h);
  return { data: out.toDataURL('image/png'), x, y, width: w, height: h };
}

// Khmer is written without spaces between words, so break at word boundaries
// found by Intl.Segmenter (falls back to spaces in old browsers).
function wrap(ctx, text, maxWidth) {
  const words = typeof Intl !== 'undefined' && Intl.Segmenter
    ? [...new Intl.Segmenter('km', { granularity: 'word' }).segment(text)].map((s) => s.segment)
    : text.split(/(\s+)/);
  const out = [];
  let line = '';
  for (const word of words) {
    const candidate = line + word;
    if (line.trim() && ctx.measureText(candidate).width > maxWidth) {
      out.push(line.trim());
      line = word.trimStart();
    } else {
      line = candidate;
    }
  }
  if (line.trim()) out.push(line.trim());
  return out;
}
