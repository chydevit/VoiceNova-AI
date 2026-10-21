// Khmer subtitles, drawn by the browser (it shapes Khmer script correctly and has the font).
// The editor's preview and the burned-in export use the same drawing code, so the preview
// shows exactly what the video will get.
const FONT_FAMILY = '"Kantumruy Pro", "Noto Sans Khmer", sans-serif';

// keep in sync with backend store.default_subtitle_style()
export const DEFAULT_STYLE = { size: 5.5, color: '#ffffff', outline: true, box: false, position: 'bottom', margin: 7, bilingual: false };

// Sizes in pixels for a picture of width × height.
function metrics(width, height, style) {
  const size = Math.max(14, Math.round((Math.min(width, height) * style.size) / 100));
  const small = Math.round(size * 0.62);
  return { size, small, line: size * 1.6, smallLine: small * 1.6, pad: Math.round(size * 0.35), maxWidth: width * 0.9 };
}

const font = (m, small) => (small ? `500 ${m.small}px ${FONT_FAMILY}` : `600 ${m.size}px ${FONT_FAMILY}`);

// The lines one subtitle needs: the Khmer text, then (bilingual) the original, smaller.
function lines(ctx, item, m, style) {
  ctx.font = font(m, false);
  const out = wrap(ctx, item.text.trim(), m.maxWidth).map((t) => ({ t, small: false }));
  if (style.bilingual && item.original?.trim()) {
    ctx.font = font(m, true);
    out.push(...wrap(ctx, item.original.trim(), m.maxWidth).map((t) => ({ t, small: true })));
  }
  return out;
}

const blockHeight = (ls, m) => ls.reduce((h, l) => h + (l.small ? m.smallLine : m.line), 0);

// Draw the lines with the top of the text block at `top`, centred at `cx`.
function drawBlock(ctx, ls, m, style, cx, top) {
  if (style.box) {
    let widest = 0;
    for (const l of ls) { ctx.font = font(m, l.small); widest = Math.max(widest, ctx.measureText(l.t).width); }
    const w = widest + m.pad * 2;
    const h = blockHeight(ls, m) + m.pad;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.beginPath();
    ctx.roundRect(cx - w / 2, top - m.pad / 2, w, h, m.pad);
    ctx.fill();
  }
  let y = top;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  for (const l of ls) {
    const lineHeight = l.small ? m.smallLine : m.line;
    ctx.font = font(m, l.small);
    if (style.outline) {
      ctx.lineWidth = (l.small ? m.small : m.size) * 0.2;
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
      ctx.strokeText(l.t, cx, y + lineHeight / 2);
    }
    ctx.fillStyle = l.small ? '#e2e8f0' : style.color;
    ctx.fillText(l.t, cx, y + lineHeight / 2);
    y += lineHeight;
  }
}

// Where the text block's top goes in the full picture.
function blockTop(height, blockH, style) {
  return style.position === 'top' ? (height * style.margin) / 100 : height * (1 - style.margin / 100) - blockH;
}

export function loadSubtitleFont(style = DEFAULT_STYLE) {
  return document.fonts.load(`600 40px ${FONT_FAMILY}`, 'កខគ').then(() => style);
}

// Draw one subtitle over a full-picture canvas (the editor preview). `item`: {text, original?}.
export function drawSubtitle(ctx, item, width, height, style) {
  ctx.clearRect(0, 0, width, height);
  if (!item?.text?.trim()) return;
  const m = metrics(width, height, style);
  const ls = lines(ctx, item, m, style);
  drawBlock(ctx, ls, m, style, width / 2, blockTop(height, blockHeight(ls, m), style));
}

// One transparent PNG per subtitle for burning in. They all cover the same strip of the picture,
// just tall enough for the longest subtitle, so far less data is sent than full frames.
// `items`: [{id, text, original?}]. Returns {images: {id: dataURL}, layout: {y, width, height}}.
export async function renderSubtitleImages(items, width, height, style = DEFAULT_STYLE) {
  await loadSubtitleFont(style); // canvas draws with a fallback font if this hasn't loaded
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const m = metrics(width, height, style);
  const laid = items.filter((item) => item.text.trim()).map((item) => ({ item, ls: lines(ctx, item, m, style) }));
  const tallest = Math.max(m.line, ...laid.map(({ ls }) => blockHeight(ls, m)));
  const strip = Math.min(height, Math.ceil(tallest + m.pad * 2));
  // bottom: the block's bottom edge sits at (1 - margin) of the height; top: its top edge at margin
  const anchor = style.position === 'top' ? (height * style.margin) / 100 - m.pad : height * (1 - style.margin / 100) + m.pad - strip;
  const y = Math.max(0, Math.min(height - strip, Math.round(anchor)));
  canvas.width = width;
  canvas.height = strip;
  const images = {};
  for (const { item, ls } of laid) {
    ctx.clearRect(0, 0, width, strip);
    const top = blockTop(height, blockHeight(ls, m), style) - y; // same place as the preview, inside the strip
    drawBlock(ctx, ls, m, style, width / 2, top);
    images[item.id] = canvas.toDataURL('image/png');
  }
  return { images, layout: { y, width, height: strip } };
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
