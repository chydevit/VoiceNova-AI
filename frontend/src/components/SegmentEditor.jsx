import { formatTime } from '../api.js';
import { budget as charBudget } from '../lib/khmer.js';

// The review step: check the Khmer lines before the first voice is generated.
export default function SegmentEditor({ sentences, texts, onChange, onSeek, duration, disabled }) {
  return (
    <ol className="divide-y divide-line">
      {sentences.map((seg, i) => {
        const text = texts[seg.id] ?? seg.khmer_text;
        const room = (sentences[i + 1]?.start ?? duration) - seg.start;
        const budget = charBudget(room);
        const long = text.length > budget * 1.25;
        return (
          <li key={seg.id} className="py-3 first:pt-0 last:pb-0">
            <div className="mb-1 flex flex-wrap items-center gap-2 text-xs">
              <button
                type="button"
                onClick={() => onSeek(seg.start)}
                className="rounded-md bg-raised px-2 py-0.5 font-mono text-muted hover:bg-accent-soft hover:text-accent-ink"
                title="Play from here"
              >
                ▶ {formatTime(seg.start)} – {formatTime(seg.end)}
              </button>
              {seg.shortened && <span className="rounded-md bg-sky-100 px-2 py-0.5 text-sky-800">shortened to fit</span>}
              {!text.trim() && <span className="rounded-md bg-amber-100 px-2 py-0.5 text-amber-800 dark:text-amber-300">not translated</span>}
              <span className={`ml-auto tabular-nums ${long ? 'font-semibold text-amber-700 dark:text-amber-300' : 'text-faint'}`} title="Characters / what fits comfortably in this time">
                {text.length}/{budget}{long ? ' · will be sped up or shortened' : ''}
              </span>
            </div>
            <p className="mb-1.5 text-sm text-muted">{seg.original_text}</p>
            <textarea
              lang="km"
              rows={Math.max(1, Math.ceil(text.length / 60))}
              value={text}
              disabled={disabled}
              onChange={(e) => onChange(seg.id, e.target.value)}
              placeholder="Type the Khmer line…"
              className="khmer w-full resize-y rounded-xl border border-line-strong bg-panel px-3 py-2 text-base focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25 disabled:bg-raised disabled:text-muted"
            />
          </li>
        );
      })}
    </ol>
  );
}
