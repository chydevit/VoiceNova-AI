import { DEFAULT_STYLE, FONTS } from '../../lib/subtitleImages.js';

const COLORS = [
  ['#ffffff', 'White'],
  ['#fde047', 'Yellow'],
  ['#67e8f9', 'Cyan'],
  ['#86efac', 'Green'],
];

function Toggle({ checked, onChange, children, disabled }) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {children}
    </label>
  );
}

function Range({ label, value, shown, min, max, step = 1, onChange }) {
  return (
    <label className="block text-sm">
      <span className="flex justify-between font-medium text-ink">{label} <span className="tabular-nums text-accent-ink">{shown ?? value}</span></span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="w-full" />
    </label>
  );
}

function Segmented({ value, options, onChange }) {
  return (
    <span className="inline-flex overflow-hidden rounded-lg border border-line-strong text-sm">
      {options.map(([key, label]) => (
        <button key={key} type="button" onClick={() => onChange(key)}
          className={`px-3 py-1 ${value === key ? 'bg-ink text-canvas' : 'hover:bg-raised'}`}>{label}</button>
      ))}
    </span>
  );
}

function ColorDot({ value, onChange, label }) {
  return (
    <label className="relative h-7 w-7 shrink-0 cursor-pointer overflow-hidden rounded-full border-2 border-line-strong" title={label} style={{ background: value }}>
      <input type="color" value={value} onChange={(e) => onChange(e.target.value)} className="absolute -inset-2 h-12 w-12 cursor-pointer opacity-0" aria-label={label} />
    </label>
  );
}

const Heading = ({ children }) => <h4 className="-mb-1 mt-2 text-xs font-semibold uppercase tracking-wide text-faint">{children}</h4>;

// How the burned-in subtitles look and where they sit. Changes show at once in the preview above,
// where the subtitle can also be dragged; "Apply" saves them to the project (undoable),
// "Apply & export" also burns them into a new MP4.
export default function SubtitlePanel({ saved, draft, setDraft, show, setShow, locked, onApply, onApplyExport }) {
  const base = { ...DEFAULT_STYLE, ...saved }; // styles saved before a setting existed get its default
  const style = { ...base, ...draft };
  const dirty = JSON.stringify(style) !== JSON.stringify(base);
  const set = (patch) => setDraft((current) => ({ ...base, ...current, ...patch })); // never lose a quick earlier change

  return (
    <section>
      <div className="mb-4 flex items-center justify-between gap-2 rounded-lg bg-raised px-3 py-2">
        <span className="khmer text-sm text-muted">អក្សររត់ · how they look</span>
        <Toggle checked={show} onChange={setShow}>Show in preview</Toggle>
      </div>
      <p className="mb-3 rounded-lg bg-accent-soft px-3 py-2 text-xs text-accent-ink">
        ✥ Drag the subtitle on the video to place it anywhere. When no sentence is on screen, a sample line is shown.
      </p>

      <fieldset disabled={locked} className="grid gap-y-4">
        <Heading>Text</Heading>
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-ink">Font</span>
          <select value={style.font} onChange={(e) => set({ font: e.target.value })}
            className="w-full rounded-lg border border-line-strong bg-panel px-2 py-1.5 text-ink" style={{ fontFamily: `"${style.font}", sans-serif` }}>
            {FONTS.map(([name, label]) => <option key={name} value={name} style={{ fontFamily: `"${name}", sans-serif` }}>{label}</option>)}
          </select>
        </label>
        <Range label="Text size" value={style.size} shown={style.size.toFixed(1)} min={3} max={10} step={0.5} onChange={(size) => set({ size })} />
        <div className="text-sm">
          <span className="mb-1 block font-medium text-ink">Colour</span>
          <div className="flex items-center gap-1.5">
            {COLORS.map(([color, name]) => (
              <button key={color} type="button" title={name} aria-label={name} onClick={() => set({ color })}
                className={`h-7 w-7 rounded-full border-2 ${style.color === color ? 'border-accent ring-2 ring-accent/30' : 'border-line-strong'}`}
                style={{ background: color }} />
            ))}
            <ColorDot value={style.color} onChange={(color) => set({ color })} label="Any colour" />
          </div>
        </div>
        <Toggle checked={style.bold} onChange={(bold) => set({ bold })}>Bold</Toggle>
        <Toggle checked={style.bilingual} onChange={(bilingual) => set({ bilingual })}>Also show the original text, smaller, under the Khmer</Toggle>

        <Heading>Position</Heading>
        <div className="flex flex-wrap items-center gap-2">
          <Segmented value={style.position} options={[['bottom', 'Bottom'], ['top', 'Top']]} onChange={(position) => set({ position })} />
          <button type="button" onClick={() => set({ position: 'bottom', margin: DEFAULT_STYLE.margin, x: 50, align: 'center' })}
            className="text-xs text-muted underline hover:text-ink">Reset position</button>
        </div>
        <Range label={`Distance from the ${style.position}`} value={style.margin} shown={`${style.margin}%`} min={0} max={90} step={0.5} onChange={(margin) => set({ margin })} />
        <Range label="Left ↔ right" value={style.x} shown={style.x === 50 ? 'centre' : `${style.x}%`} min={0} max={100} step={0.5} onChange={(x) => set({ x })} />
        <div className="text-sm">
          <span className="mb-1 block font-medium text-ink">Align text</span>
          <Segmented value={style.align} options={[['left', '⇤ Left'], ['center', 'Centre'], ['right', 'Right ⇥']]}
            onChange={(align) => set({ align, x: align === 'left' ? 5 : align === 'right' ? 95 : 50 })} />
        </div>
        <Range label="Line width before wrapping" value={style.width} shown={`${style.width}%`} min={20} max={100} onChange={(width) => set({ width })} />

        <Heading>Outline &amp; background</Heading>
        <div className="flex items-center gap-3">
          <Toggle checked={style.outline} onChange={(outline) => set({ outline })}>Outline</Toggle>
          {style.outline && <ColorDot value={style.outline_color} onChange={(c) => set({ outline_color: c })} label="Outline colour" />}
        </div>
        {style.outline && (
          <Range label="Outline thickness" value={style.outline_width} min={2} max={60} onChange={(outline_width) => set({ outline_width })} />
        )}
        <div className="flex items-center gap-3">
          <Toggle checked={style.box} onChange={(box) => set({ box })}>Box behind the text</Toggle>
          {style.box && <ColorDot value={style.box_color} onChange={(c) => set({ box_color: c })} label="Box colour" />}
        </div>
        {style.box && (
          <Range label="Box opacity" value={style.box_opacity} shown={`${Math.round(style.box_opacity * 100)}%`} min={0.1} max={1} step={0.05} onChange={(box_opacity) => set({ box_opacity })} />
        )}
        <Toggle checked={style.shadow} onChange={(shadow) => set({ shadow })}>Soft shadow</Toggle>
      </fieldset>

      <div className="mt-5 flex flex-col gap-2">
        <button type="button" disabled={locked || !dirty} onClick={() => onApply(style)}
          className="rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-accent-hover disabled:opacity-45">
          Apply
        </button>
        <button type="button" disabled={locked} onClick={() => onApplyExport(style)}
          className="rounded-xl border border-accent/40 bg-accent-soft px-4 py-2 text-sm font-semibold text-accent-ink hover:brightness-95 disabled:opacity-50 dark:hover:brightness-125">
          Apply &amp; export video with subtitles
        </button>
        {dirty && <button type="button" className="py-1 text-sm text-muted underline" onClick={() => setDraft(null)}>Cancel changes</button>}
        {!dirty && JSON.stringify(base) !== JSON.stringify(DEFAULT_STYLE) && (
          <button type="button" className="py-1 text-sm text-muted underline" onClick={() => setDraft({ ...DEFAULT_STYLE })}>Reset to default</button>
        )}
      </div>
      <p className="mt-2 text-xs text-muted">
        The preview shows exactly what gets burned into the video. Subtitle text follows each sentence — edit it in the sentence list.
        The .srt file {style.bilingual ? 'also includes the original line.' : 'has the Khmer text only.'}
      </p>
    </section>
  );
}
