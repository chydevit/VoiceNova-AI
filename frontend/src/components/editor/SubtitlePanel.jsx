import { DEFAULT_STYLE } from '../../lib/subtitleImages.js';

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

// How the burned-in subtitles look. Changes show at once in the preview above;
// "Apply" saves them to the project (undoable), "Apply & export" also burns them into a new MP4.
export default function SubtitlePanel({ saved, draft, setDraft, show, setShow, locked, onApply, onApplyExport }) {
  const style = draft || saved;
  const dirty = JSON.stringify(style) !== JSON.stringify(saved);
  const set = (patch) => setDraft((current) => ({ ...(current || saved), ...patch })); // never lose a quick earlier change

  return (
    <section>
      <div className="mb-4 flex items-center justify-between gap-2 rounded-lg bg-raised px-3 py-2">
        <span className="khmer text-sm text-muted">អក្សររត់ · how they look</span>
        <Toggle checked={show} onChange={setShow}>Show in preview</Toggle>
      </div>

      <fieldset disabled={locked} className="grid gap-y-4">
        <label className="block text-sm">
          <span className="flex justify-between font-medium text-ink">Text size <span className="tabular-nums text-accent-ink">{style.size.toFixed(1)}</span></span>
          <input type="range" min="3" max="10" step="0.5" value={style.size} onChange={(e) => set({ size: Number(e.target.value) })} className="w-full" />
        </label>
        <label className="block text-sm">
          <span className="flex justify-between font-medium text-ink">Distance from the {style.position} <span className="tabular-nums text-accent-ink">{style.margin}%</span></span>
          <input type="range" min="2" max="30" step="1" value={style.margin} onChange={(e) => set({ margin: Number(e.target.value) })} className="w-full" />
        </label>

        <div className="text-sm">
          <span className="mb-1 block font-medium text-ink">Colour</span>
          <div className="flex items-center gap-1.5">
            {COLORS.map(([color, name]) => (
              <button key={color} type="button" title={name} aria-label={name} onClick={() => set({ color })}
                className={`h-7 w-7 rounded-full border-2 ${style.color === color ? 'border-accent ring-2 ring-accent/30' : 'border-line-strong'}`}
                style={{ background: color }} />
            ))}
            <label className="relative h-7 w-7 cursor-pointer overflow-hidden rounded-full border-2 border-line-strong" title="Any colour">
              <input type="color" value={style.color} onChange={(e) => set({ color: e.target.value })} className="absolute -inset-2 h-12 w-12 cursor-pointer" aria-label="Any colour" />
            </label>
          </div>
        </div>
        <div className="text-sm">
          <span className="mb-1 block font-medium text-ink">Position</span>
          <span className="inline-flex overflow-hidden rounded-lg border border-line-strong">
            {['bottom', 'top'].map((pos) => (
              <button key={pos} type="button" onClick={() => set({ position: pos })}
                className={`px-3 py-1 capitalize ${style.position === pos ? 'bg-ink text-canvas' : 'hover:bg-raised'}`}>{pos}</button>
            ))}
          </span>
        </div>

        <Toggle checked={style.outline} onChange={(outline) => set({ outline })}>Black outline</Toggle>
        <Toggle checked={style.box} onChange={(box) => set({ box })}>Dark box behind the text</Toggle>
        <div>
          <Toggle checked={style.bilingual} onChange={(bilingual) => set({ bilingual })}>Also show the original text, smaller, under the Khmer</Toggle>
        </div>
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
        {!dirty && JSON.stringify(saved) !== JSON.stringify(DEFAULT_STYLE) && (
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
