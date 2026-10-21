// Small shared building blocks (they use the theme's semantic colours, see index.css).

export function Card({ className = '', children }) {
  return <section className={`rounded-2xl border border-line bg-panel p-4 shadow-sm sm:p-6 ${className}`}>{children}</section>;
}

// A studio panel: fills its grid cell, with an optional title row.
export function Panel({ title, actions, className = '', bodyClassName = '', children }) {
  return (
    <section className={`flex min-h-0 flex-col rounded-xl border border-line bg-panel ${className}`}>
      {(title || actions) && (
        <div className="flex min-h-11 flex-wrap items-center gap-2 border-b border-line px-3 py-1.5">
          {title && <h2 className="text-sm font-semibold">{title}</h2>}
          {actions && <div className="ml-auto flex items-center gap-1.5">{actions}</div>}
        </div>
      )}
      <div className={`min-h-0 flex-1 ${bodyClassName}`}>{children}</div>
    </section>
  );
}

export function Button({ variant = 'primary', size = 'md', className = '', ...props }) {
  const styles = {
    primary: 'bg-accent text-white shadow-sm hover:bg-accent-hover disabled:opacity-45',
    secondary: 'border border-line-strong bg-panel text-ink hover:bg-raised disabled:text-faint',
    soft: 'bg-accent-soft text-accent-ink hover:brightness-95 dark:hover:brightness-125 disabled:opacity-45',
    ghost: 'text-muted hover:bg-raised hover:text-ink disabled:text-faint disabled:hover:bg-transparent',
    danger: 'text-red-600 hover:bg-red-500/10 dark:text-red-400 disabled:opacity-40',
  };
  const sizes = { sm: 'rounded-lg px-2.5 py-1.5 text-xs', md: 'rounded-xl px-4 py-2.5 text-sm', lg: 'rounded-xl px-5 py-3 text-base' };
  return (
    <button
      type="button"
      className={`inline-flex items-center justify-center gap-1.5 font-semibold transition disabled:cursor-not-allowed ${sizes[size]} ${styles[variant]} ${className}`}
      {...props}
    />
  );
}

// A square icon button with a tooltip (and the label for screen readers).
export function IconButton({ label, children, className = '', active = false, ...props }) {
  return (
    <button type="button" title={label} aria-label={label}
      className={`inline-flex h-8 min-w-8 items-center justify-center rounded-lg px-1.5 text-sm transition disabled:cursor-not-allowed disabled:opacity-35 ${active ? 'bg-accent-soft text-accent-ink' : 'text-muted hover:bg-raised hover:text-ink'} ${className}`}
      {...props}>
      {children}
    </button>
  );
}

export function Tabs({ tabs, value, onChange }) {
  return (
    <div role="tablist" className="flex gap-1 rounded-lg bg-raised p-1">
      {tabs.map((t) => (
        <button key={t.key} type="button" role="tab" aria-selected={value === t.key} onClick={() => onChange(t.key)}
          className={`flex flex-1 items-center justify-center gap-1 rounded-md px-2 py-1.5 text-xs font-semibold transition ${value === t.key ? 'bg-panel text-ink shadow-sm' : 'text-muted hover:text-ink'}`}>
          {t.label}
          {t.dot && <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden="true" />}
        </button>
      ))}
    </div>
  );
}

const CHIP = {
  slate: 'bg-raised text-muted',
  green: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  amber: 'bg-amber-500/15 text-amber-800 dark:text-amber-300',
  red: 'bg-red-500/15 text-red-700 dark:text-red-300',
  accent: 'bg-accent-soft text-accent-ink',
  sky: 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
};

export function Chip({ tone = 'slate', className = '', children, ...props }) {
  return <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-md px-2 py-0.5 text-xs font-medium ${CHIP[tone]} ${className}`} {...props}>{children}</span>;
}

export function ErrorBox({ error, children, compact = false }) {
  if (!error) return null;
  return (
    <div role="alert" className={`rounded-xl border border-red-500/30 bg-red-500/10 text-sm text-red-800 dark:text-red-200 ${compact ? 'p-3' : 'p-4'}`}>
      <p className="font-semibold">{error.message}</p>
      {error.hint && <p className="mt-1">{error.hint}</p>}
      {error.detail && (
        <details className="mt-2 text-xs opacity-80">
          <summary className="cursor-pointer">Technical details</summary>
          <pre className="mt-1 whitespace-pre-wrap break-words">{error.detail}</pre>
        </details>
      )}
      {children && <div className="mt-3">{children}</div>}
    </div>
  );
}

export function Notice({ tone = 'amber', children, className = '' }) {
  const tones = {
    amber: 'border-amber-500/30 bg-amber-500/10 text-amber-900 dark:text-amber-200',
    sky: 'border-sky-500/30 bg-sky-500/10 text-sky-900 dark:text-sky-200',
    green: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-900 dark:text-emerald-200',
  };
  return <div className={`rounded-xl border p-3 text-sm ${tones[tone]} ${className}`}>{children}</div>;
}

export function Progress({ value, failed = false, className = '' }) {
  return (
    <div className={`h-1.5 overflow-hidden rounded-full bg-raised ${className}`} role="progressbar" aria-valuenow={Math.round(value * 100)} aria-valuemin={0} aria-valuemax={100}>
      <div className={`h-full rounded-full transition-all duration-500 ${failed ? 'bg-red-500' : 'bg-accent'}`} style={{ width: `${Math.max(2, value * 100)}%` }} />
    </div>
  );
}

// Inputs share one look.
export const inputCss = 'rounded-lg border border-line-strong bg-panel px-2 py-1.5 text-sm text-ink focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25 disabled:opacity-50';
export const textareaCss = 'khmer w-full resize-y rounded-xl border border-line-strong bg-panel px-3 py-2 text-base text-ink placeholder:text-faint focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25 disabled:bg-raised disabled:text-muted';
