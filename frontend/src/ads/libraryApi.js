// The Ad Library and Brand Kits (backend api_library.py). Calls that change something return the
// whole library again, so the page just shows what comes back.
import { request, toError } from '../api.js';

const base = '/api/library';

export const libraryApi = {
  get: () => request(base),
  patchAsset: (aid, fields) => request(`${base}/assets/${aid}`, { method: 'PATCH', json: fields }),
  deleteAsset: (aid) => request(`${base}/assets/${aid}`, { method: 'DELETE' }),
  setColors: (colors) => request(`${base}/colors`, { method: 'PUT', json: { colors } }),
  createBrand: (fields) => request(`${base}/brands`, { method: 'POST', json: fields }),
  patchBrand: (bid, fields) => request(`${base}/brands/${bid}`, { method: 'PATCH', json: fields }),
  makeDefault: (bid) => request(`${base}/brands/${bid}/default`, { method: 'POST' }),
  deleteBrand: (bid) => request(`${base}/brands/${bid}`, { method: 'DELETE' }),
};

// Uploads use XHR because fetch can't report upload progress. Resolves to {asset, library}.
export function uploadAsset(file, kind, onProgress) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('file', file);
    form.append('kind', kind);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${base}/assets`);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      let body = null;
      try { body = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body);
      else reject(toError(body, xhr.status));
    };
    xhr.onerror = () => reject(Object.assign(new Error('The upload was interrupted.'), { hint: 'Check that the server is running, then try again.' }));
    xhr.send(form);
  });
}

export const KIND_LABELS = {
  logo: { one: 'Logo', many: 'Logos', km: 'ឡូហ្គោ' },
  product: { one: 'Product', many: 'Products', km: 'ផលិតផល' },
  ad_clip: { one: 'Ad clip', many: 'Ad clips', km: 'វីដេអូពាណិជ្ជកម្ម' },
  image: { one: 'Image', many: 'Images', km: 'រូបភាព' },
  music: { one: 'Music', many: 'Music', km: 'តន្ត្រី' },
};

const IMAGE = /\.(png|jpe?g|webp)$/i;
const VIDEO = /\.(mp4|mov|mkv|webm)$/i;
const AUDIO = /\.(mp3|m4a|aac|wav|ogg|flac)$/i;

export const ACCEPT = '.png,.jpg,.jpeg,.webp,.mp4,.mov,.mkv,.webm,.mp3,.m4a,.aac,.wav,.ogg,.flac';

export function mediaOf(name) {
  if (IMAGE.test(name)) return 'image';
  if (VIDEO.test(name)) return 'video';
  if (AUDIO.test(name)) return 'audio';
  return null;
}

// The kind a dropped file most likely is, given the kind the user is looking at.
export function guessKind(name, wanted, kinds) {
  const media = mediaOf(name);
  if (!media) return null;
  if (wanted && kinds[wanted]?.includes(media)) return wanted;
  return { image: 'product', video: 'ad_clip', audio: 'music' }[media];
}

export function formatBytes(n) {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

export function formatSeconds(t) {
  const m = Math.floor(t / 60);
  const s = Math.round(t - m * 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
