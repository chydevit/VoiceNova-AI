// Display names for the voices of each voice engine (backend/services/tts).
const NAMES = {
  edge: { male: 'Piseth · ពិសិដ្ឋ', female: 'Sreymom · ស្រីមុំ' },
  azure: { male: 'Piseth · ពិសិដ្ឋ', female: 'Sreymom · ស្រីមុំ' },
};

const GENDER = { male: 'Male · ប្រុស', female: 'Female · ស្រី', default: 'Default voice' };

export const voiceTitle = (voice) => GENDER[voice] || voice;
export const voiceName = (provider, voice) => NAMES[provider]?.[voice] || '';
export const voiceLabel = (provider, voice) => [voiceTitle(voice), voiceName(provider, voice).split(' · ')[0]].filter(Boolean).join(' — ');
