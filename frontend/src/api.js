// Every API error comes back as {error: {message, hint?, detail?}}.
function toError(body, status) {
  const e = body?.error || { message: `Request failed (HTTP ${status}).` };
  return Object.assign(new Error(e.message), { hint: e.hint, detail: e.detail, status });
}

async function request(path, { method = 'GET', json } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: json ? { 'Content-Type': 'application/json' } : undefined,
      body: json ? JSON.stringify(json) : undefined,
    });
  } catch {
    throw Object.assign(new Error('Can’t reach the Khmer Voice AI server.'), { hint: 'Make sure the backend is running (python main.py).' });
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw toError(body, res.status);
  return body;
}

const project = (id) => `/api/projects/${id}`;
const sentence = (id, sid) => `${project(id)}/sentences/${sid}`;

export const api = {
  health: () => request('/api/health'),
  appSettings: () => request('/api/settings'),
  saveAppSettings: (values) => request('/api/settings', { method: 'PUT', json: { values } }),
  list: () => request('/api/projects').then((b) => b.projects),
  get: (id) => request(project(id)).then((b) => b.project),
  remove: (id) => request(project(id), { method: 'DELETE' }),
  retry: (id) => request(`${project(id)}/retry`, { method: 'POST' }).then((b) => b.project),
  generate: (id, body) => request(`${project(id)}/generate`, { method: 'POST', json: body }).then((b) => b.project),

  // Editor calls return {project, ...extra}; the editor keeps whichever project is newest.
  patchSentence: (id, sid, fields) => request(sentence(id, sid), { method: 'PATCH', json: fields }),
  applyAll: (id, fields) => request(`${project(id)}/sentences`, { method: 'PATCH', json: fields }),
  regenerate: (id, sid, force = false) => request(`${sentence(id, sid)}/regenerate`, { method: 'POST', json: { force } }),
  regenerateChanged: (id) => request(`${project(id)}/sentences/regenerate`, { method: 'POST', json: { ids: null } }),
  split: (id, sid, body) => request(`${sentence(id, sid)}/split`, { method: 'POST', json: body }),
  merge: (id, sid) => request(`${sentence(id, sid)}/merge`, { method: 'POST' }),
  add: (id, body) => request(`${project(id)}/sentences`, { method: 'POST', json: body }),
  deleteSentence: (id, sid, fill) => request(`${sentence(id, sid)}?fill=${fill}`, { method: 'DELETE' }),
  fix: (id, sid) => request(`${sentence(id, sid)}/fix`, { method: 'POST' }),
  checkVoices: (id) => request(`${project(id)}/sentences/check-voices`, { method: 'POST' }),
  suggest: (id, sid) => request(`${sentence(id, sid)}/suggest`, { method: 'POST' }),
  settings: (id, body) => request(`${project(id)}/settings`, { method: 'PATCH', json: body }),
  backgroundCuts: (id, cuts) => request(`${project(id)}/background/cuts`, { method: 'PUT', json: { cuts } }),
  videoCuts: (id, cuts) => request(`${project(id)}/video/cuts`, { method: 'PUT', json: { cuts } }),
  undo: (id) => request(`${project(id)}/undo`, { method: 'POST' }),
  redo: (id) => request(`${project(id)}/redo`, { method: 'POST' }),
  exportVideo: (id, body) => request(`${project(id)}/export`, { method: 'POST', json: body }),
  restoreVersion: (id, n) => request(`${project(id)}/versions/${n}/restore`, { method: 'POST' }),
  filmstrip: (id) => request(`${project(id)}/filmstrip`),
  waveform: (id, track = 'original') => request(`${project(id)}/waveform.json?track=${track}`),
  separate: (id) => request(`${project(id)}/separate`, { method: 'POST' }),
  detectCover: (id) => request(`${project(id)}/cover/detect`, { method: 'POST' }),
};

// Uploads use XHR because fetch can't report upload progress.
export function uploadVideo(file, sourceLang, onProgress) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('file', file);
    form.append('source_lang', sourceLang);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/projects');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let body = null;
      try { body = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body.project);
      else reject(toError(body, xhr.status));
    };
    xhr.onerror = () => reject(Object.assign(new Error('The upload was interrupted.'), { hint: 'Check that the server is running, then try again.' }));
    xhr.send(form);
  });
}

export function formatTime(t) {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

export function timeAgo(seconds) {
  const diff = Date.now() / 1000 - seconds;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  return new Date(seconds * 1000).toLocaleDateString();
}
