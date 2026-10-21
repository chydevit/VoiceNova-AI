import { Button } from '../ui.jsx';

const COLORS = [
  ['#fde047', 'Yellow'],
  ['#ffffff', 'White'],
  ['#67e8f9', 'Cyan'],
  ['#f87171', 'Red'],
];

function Toggle({ checked, onChange, children }) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {children}
    </label>
  );
}

// A title at the top of the video for its whole length (the sentence subtitles stay where they are).
// Changes show at once in the preview; "Apply" saves them, and every video export burns the title in.
export default function TitlePanel({ saved, draft, setDraft, locked, onApply, onApplyExport }) {
  const title = draft || saved;
  const dirty = JSON.stringify(title) !== JSON.stringify(saved);
  const set = (patch) => setDraft((current) => ({ ...(current || saved), ...patch }));
  const on = !!title.text.trim();

  return (
    <section className="mt-6 border-t border-line pt-5">
      <span className="block text-sm font-semibold">Title at the top</span>
      <span className="block text-xs text-muted">Shown for the whole video, above the picture. Leave it empty for no title.</span>

      <fieldset disabled={locked} className="mt-3 grid gap-y-4">
        <textarea value={title.text} onChange={(e) => set({ text: e.target.value })} rows={2} maxLength={300}
          placeholder="ឧ. រឿង ព្រលឹងប្រពន្ធ · ភាគ ១"
          className="khmer w-full resize-y rounded-lg border border-line-strong bg-panel px-3 py-2 text-base leading-relaxed text-ink placeholder:text-faint focus:border-accent focus:outline-none" />

        {on && (
          <>
            <label className="block text-sm">
              <span className="flex justify-between font-medium text-ink">Text size <span className="tabular-nums text-accent-ink">{title.size.toFixed(1)}</span></span>
              <input type="range" min="3" max="14" step="0.5" value={title.size} onChange={(e) => set({ size: Number(e.target.value) })} className="w-full" />
            </label>
            <label className="block text-sm">
              <span className="flex justify-between font-medium text-ink">Distance from the top <span className="tabular-nums text-accent-ink">{title.margin}%</span></span>
              <input type="range" min="0" max="60" step="1" value={title.margin} onChange={(e) => set({ margin: Number(e.target.value) })} className="w-full" />
            </label>
            <div className="text-sm">
              <span className="mb-1 block font-medium text-ink">Colour</span>
              <div className="flex items-center gap-1.5">
                {COLORS.map(([color, name]) => (
                  <button key={color} type="button" title={name} aria-label={name} onClick={() => set({ color })}
                    className={`h-7 w-7 rounded-full border-2 ${title.color === color ? 'border-accent ring-2 ring-accent/30' : 'border-line-strong'}`}
                    style={{ background: color }} />
                ))}
                <label className="relative h-7 w-7 cursor-pointer overflow-hidden rounded-full border-2 border-line-strong" title="Any colour">
                  <input type="color" value={title.color} onChange={(e) => set({ color: e.target.value })} className="absolute -inset-2 h-12 w-12 cursor-pointer" aria-label="Any colour" />
                </label>
              </div>
            </div>
            <Toggle checked={title.outline} onChange={(outline) => set({ outline })}>Black outline</Toggle>
            <Toggle checked={title.box} onChange={(box) => set({ box })}>Dark box behind the text</Toggle>
          </>
        )}
      </fieldset>

      <div className="mt-4 flex flex-col gap-2">
        <Button disabled={locked || !dirty} onClick={() => onApply(title)}>Apply</Button>
        {dirty && (
          <button type="button" disabled={locked} onClick={() => onApplyExport(title)}
            className="rounded-xl border border-accent/40 bg-accent-soft px-4 py-2 text-sm font-semibold text-accent-ink hover:brightness-95 disabled:opacity-50 dark:hover:brightness-125">
            Apply &amp; export video
          </button>
        )}
        {dirty && <button type="button" className="py-1 text-sm text-muted underline" onClick={() => setDraft(null)}>Cancel changes</button>}
      </div>
      <p className="mt-2 text-xs text-muted">
        {on ? 'Burned into both exported videos (with and without subtitles). Press Enter for a second line.' : 'No title — nothing is added at the top.'}
      </p>
    </section>
  );
}
