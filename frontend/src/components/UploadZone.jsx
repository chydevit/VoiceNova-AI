import { useRef, useState } from 'react';
import { uploadVideo } from '../api.js';
import { Button, Card, ErrorBox } from './ui.jsx';
import { PresetSelect } from './editor/WatermarkPresets.jsx';

const LANGUAGES = [
  ['auto', 'Detect automatically'], ['en', 'English'], ['zh', 'Chinese'], ['th', 'Thai'], ['vi', 'Vietnamese'],
  ['ko', 'Korean'], ['ja', 'Japanese'], ['fr', 'French'], ['es', 'Spanish'], ['id', 'Indonesian'], ['hi', 'Hindi'],
];

export default function UploadZone({ health, onUploaded }) {
  const input = useRef(null);
  const [dragging, setDragging] = useState(false);
  const [sourceLang, setSourceLang] = useState('auto');
  const [preset, setPreset] = useState(''); // the watermark it gets: '' the default one, 'none', or a preset
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState(null);
  const maxMb = health?.max_upload_mb || 500;
  const formats = health?.formats || ['.mkv', '.mov', '.mp4', '.webm'];

  async function start(file) {
    if (!file) return;
    setError(null);
    const ext = `.${file.name.split('.').pop().toLowerCase()}`;
    if (!formats.includes(ext)) return setError({ message: `“${ext}” files aren’t supported.`, hint: 'Upload an MP4, MOV, MKV or WebM video.' });
    if (file.size > maxMb * 1024 * 1024) return setError({ message: `This video is larger than ${maxMb} MB.`, hint: 'Trim or compress it, then upload again.' });
    setProgress(0);
    try {
      const project = await uploadVideo(file, sourceLang, setProgress, preset);
      onUploaded(project);
    } catch (err) {
      setError(err);
      setProgress(null);
    }
  }

  const uploading = progress !== null;
  return (
    <Card>
      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); if (!uploading) start(e.dataTransfer.files[0]); }}
        className={`flex flex-col items-center justify-center rounded-2xl border-2 border-dashed px-6 py-12 text-center transition sm:py-16 ${dragging ? 'border-accent bg-accent-soft' : 'border-line-strong bg-raised'}`}
      >
        <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-accent-soft text-accent-ink">
          <svg viewBox="0 0 24 24" className="h-7 w-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 16V4m0 0-4 4m4-4 4 4M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
          </svg>
        </div>
        {uploading ? (
          <div className="w-full max-w-sm">
            <p className="font-semibold">Uploading… {Math.round(progress * 100)}%</p>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-sunken">
              <div className="h-full bg-accent transition-all" style={{ width: `${progress * 100}%` }} />
            </div>
          </div>
        ) : (
          <>
            <p className="text-lg font-semibold">Drop a video here</p>
            <p className="khmer mt-1 text-muted">ទម្លាក់វីដេអូនៅទីនេះ</p>
            <p className="mt-2 text-sm text-muted">MP4, MOV, MKV or WebM · up to {maxMb} MB · any language</p>
            <Button className="mt-5" onClick={() => input.current?.click()}>Choose video</Button>
          </>
        )}
        <input ref={input} type="file" accept={formats.join(',')} className="hidden" onChange={(e) => start(e.target.files[0])} />
      </div>

      <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <label className="flex items-center gap-2 text-sm text-muted">
          Spoken language
          <select value={sourceLang} onChange={(e) => setSourceLang(e.target.value)} disabled={uploading} className="rounded-lg border border-line-strong bg-panel px-2 py-1.5 text-sm">
            {LANGUAGES.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
          </select>
        </label>
        <PresetSelect value={preset} onChange={setPreset} disabled={uploading} />
        <p className="text-xs text-muted">Your video stays on this server, in <a href="#/projects" className="underline">My projects</a>, until you delete it.</p>
      </div>
      {error && <div className="mt-4"><ErrorBox error={error} /></div>}
    </Card>
  );
}
