import { useEffect, useState } from 'react';

// Light / dark theme. index.html applies the saved (or system) theme before the first paint.
const KEY = 'kva-theme';

export const currentTheme = () => (document.documentElement.classList.contains('dark') ? 'dark' : 'light');

export function setTheme(theme) {
  document.documentElement.classList.toggle('dark', theme === 'dark');
  try { localStorage.setItem(KEY, theme); } catch { /* private window: just not remembered */ }
  window.dispatchEvent(new Event('themechange'));
}

// The current theme, updated when it changes (for code that draws with colours, like the timeline).
export function useTheme() {
  const [theme, set] = useState(currentTheme);
  useEffect(() => {
    const on = () => set(currentTheme());
    window.addEventListener('themechange', on);
    return () => window.removeEventListener('themechange', on);
  }, []);
  return theme;
}

// A CSS colour token (e.g. "--muted") as a canvas can use it.
export const token = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
