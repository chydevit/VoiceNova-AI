// The server calls for watermarks (backend api_watermarks.py). Adding and changing a project's
// watermarks are timeline edits: actions.edit({op: 'add_watermark' | 'set_watermark', …}).
import { request, toError } from '../api.js';
import { svgToPng } from './watermark.js';

const project = (id) => `/api/projects/${id}`;

export const MAX_LOGO_MB = 10; // keep in sync with backend watermarks.MAX_LOGO_MB
export const LOGO_ACCEPT = '.png,.jpg,.jpeg,.webp,.svg,image/png,image/jpeg,image/webp,image/svg+xml';

// Add a logo to the project (and to the Brand Kit unless saveToKit is false). An SVG becomes a PNG first.
export async function uploadLogo(id, file, { saveToKit = true, name = '' } = {}) {
  if (file.size > MAX_LOGO_MB * 1024 * 1024) throw Object.assign(new Error(`A logo can be at most ${MAX_LOGO_MB} MB.`), { hint: 'Save it smaller (a logo needs about 1000 pixels at most).' });
  const upload = /\.svg$/i.test(file.name) || file.type === 'image/svg+xml' ? await svgToPng(file) : file;
  const form = new FormData();
  form.append('file', upload);
  form.append('save_to_kit', saveToKit ? 'yes' : 'no');
  form.append('name', name || file.name.replace(/\.[^.]+$/, ''));
  const res = await fetch(`${project(id)}/watermark-logo`, { method: 'POST', body: form });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw toError(body, res.status);
  return body;
}

export const watermarkApi = {
  fromKit: (id, asset) => request(`${project(id)}/watermark-logo/from-kit`, { method: 'POST', json: { asset } }),
  removeBackground: (id, mid, tolerance = 40) => request(`${project(id)}/media/${mid}/remove-background`, { method: 'POST', json: { tolerance } }),
  kitLogos: () => request('/api/library').then((b) => b.assets.filter((a) => a.kind === 'logo' && a.media === 'image')),
  // presets: {presets: [{id, name, watermarks}], default, auto}
  presets: () => request('/api/watermarks'),
  savePreset: (name, projectId) => request('/api/watermarks/presets', { method: 'POST', json: { name, project: projectId } }),
  renamePreset: (wid, name) => request(`/api/watermarks/presets/${wid}`, { method: 'PATCH', json: { name } }),
  deletePreset: (wid) => request(`/api/watermarks/presets/${wid}`, { method: 'DELETE' }),
  setDefault: (fields) => request('/api/watermarks/default', { method: 'POST', json: fields }), // {preset?, auto?}
  applyPreset: (id, preset) => request(`${project(id)}/watermarks/preset`, { method: 'POST', json: { preset } }),
  applyToAll: (preset) => request(`/api/watermarks/presets/${preset}/apply-all`, { method: 'POST' }),
};
