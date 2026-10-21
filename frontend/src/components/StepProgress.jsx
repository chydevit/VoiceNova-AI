const STEPS = [
  { key: 'extract', label: 'Extracting', km: 'ទាញយកសំឡេង' },
  { key: 'transcribe', label: 'Transcribing', km: 'បំលែងជាអក្សរ' },
  { key: 'translate', label: 'Translating', km: 'បកប្រែ' },
  { key: 'voice', label: 'Generating voice', km: 'បង្កើតសំឡេង' },
  { key: 'merge', label: 'Merging', km: 'បញ្ចូលគ្នា' },
  { key: 'done', label: 'Done', km: 'រួចរាល់' },
];

// Where the project is in the six steps: index of the active step, and whether it is running.
function position(project) {
  const { status, step } = project;
  if (status === 'done') return { index: 5, running: false };
  if (status === 'review' || (status === 'error' && project.phase === 'generate')) return { index: 3, running: false };
  const i = STEPS.findIndex((s) => s.key === step);
  return { index: Math.max(0, i), running: status === 'processing' || status === 'generating' };
}

export default function StepProgress({ project }) {
  const { index, running } = position(project);
  const failed = project.status === 'error';
  const overall = project.status === 'done' ? 1 : (index + (running ? project.progress || 0 : 0)) / 5;

  return (
    <div>
      <ol className="grid grid-cols-3 gap-2 sm:grid-cols-6">
        {STEPS.map((s, i) => {
          const state = i < index || project.status === 'done' ? 'done' : i === index ? (failed ? 'failed' : running ? 'active' : 'waiting') : 'pending';
          const dot = {
            done: 'bg-emerald-500 text-white',
            active: 'bg-accent text-white animate-pulse',
            failed: 'bg-red-500 text-white',
            waiting: 'bg-amber-400 text-white',
            pending: 'bg-sunken text-muted',
          }[state];
          return (
            <li key={s.key} className="flex items-center gap-2">
              <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold ${dot}`}>
                {state === 'done' ? '✓' : state === 'failed' ? '!' : i + 1}
              </span>
              <span className="min-w-0 leading-tight">
                <span className={`block truncate text-sm font-medium ${state === 'pending' ? 'text-faint' : ''}`}>{s.label}</span>
                <span className="khmer block truncate text-xs text-faint">{s.km}</span>
              </span>
            </li>
          );
        })}
      </ol>
      <div className="mt-4 h-2 overflow-hidden rounded-full bg-sunken" role="progressbar" aria-valuenow={Math.round(overall * 100)} aria-valuemin={0} aria-valuemax={100}>
        <div className={`h-full transition-all duration-500 ${failed ? 'bg-red-500' : 'bg-accent'}`} style={{ width: `${Math.max(2, overall * 100)}%` }} />
      </div>
      {running && project.message && <p className="mt-2 text-sm text-muted">{project.message}</p>}
      {project.status === 'review' && (
        <p className="mt-2 text-sm text-amber-700 dark:text-amber-300">Waiting for you: check the Khmer lines below, then press <b>Generate Voice</b>.</p>
      )}
    </div>
  );
}
