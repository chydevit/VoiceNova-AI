// The ad wizard's drafts (backend api_adverts.py).
import { request } from '../api.js';

const base = '/api/adverts';

export const advertsApi = {
  list: () => request(base),
  create: () => request(base, { method: 'POST' }).then((b) => b.draft),
  get: (id) => request(`${base}/${id}`),
  patch: (id, fields) => request(`${base}/${id}`, { method: 'PATCH', json: fields }).then((b) => b.draft),
  applyBrand: (id) => request(`${base}/${id}/brand`, { method: 'POST' }).then((b) => b.draft),
  remove: (id) => request(`${base}/${id}`, { method: 'DELETE' }),
  writeScripts: (id) => request(`${base}/${id}/scripts`, { method: 'POST' }).then((b) => b.draft),
  scriptUrl: (id, index) => `${base}/${id}/script.txt${index != null ? `?index=${index}` : ''}`,
};

export const STEPS = [
  ['product', 'Product', 'ផលិតផល'],
  ['media', 'Pictures', 'រូបភាព'],
  ['style', 'Style', 'ប្រភេទ'],
  ['format', 'Format', 'ទំហំ'],
  ['script', 'Script', 'អត្ថបទ'],
  ['build', 'Build', 'បង្កើត'],
];

export const STYLE_LOOK = {
  product: { icon: '🛍️', km: 'បង្ហាញផលិតផល' },
  sale: { icon: '🏷️', km: 'ប្រូម៉ូសិន / បញ្ចុះតម្លៃ' },
  food: { icon: '🍜', km: 'ភោជនីយដ្ឋាន / អាហារ' },
  shop: { icon: '🏪', km: 'ណែនាំហាង / ម៉ាក' },
  service: { icon: '💇', km: 'សេវាកម្ម (សាឡន គ្លីនិក សាលា…)' },
  real_estate: { icon: '🏠', km: 'អចលនទ្រព្យ' },
};

export const MOOD_LOOK = {
  upbeat: ['Upbeat', 'រីករាយ', '⚡'],
  calm: ['Calm', 'ស្ងប់ស្ងាត់', '🌿'],
  luxury: ['Luxury', 'ប្រណីត', '✨'],
  fun: ['Fun', 'សប្បាយ', '🎈'],
};

// short ones for the script cards
export const ROLE_SHORT = { hook: 'Hook', problem: 'Problem', benefit: 'Benefit', feature: 'Feature', proof: 'Proof', price: 'Price', promo: 'Promo', cta: 'CTA' };

export const ROLE_LABELS = {
  hook: 'Hook', problem: 'Problem', benefit: 'Benefit', feature: 'Feature', proof: 'Proof', price: 'Price', promo: 'Promotion', cta: 'Call to action',
};
