import { useCallback, useEffect, useRef, useState } from 'react';
import { normalizeView } from './layout.js';

// How the timeline panel looks (layout.js DEFAULT_VIEW), kept with the project: saved a moment after
// each change (PUT /view: no undo step, see backend panelview.py). The last layout used is also kept
// in this browser, as the start for projects that have none of their own yet.
const LAST = 'kva-timeline-view';

function readLast() {
  try { return JSON.parse(localStorage.getItem(LAST)); } catch { return null; }
}

export function usePanelView(projectId, saved) {
  const [view, setView] = useState(() => normalizeView(saved ?? readLast()));
  const pending = useRef(null); // a change not sent yet
  const first = useRef(true);

  const send = useCallback((v) => {
    pending.current = null;
    // keepalive: still sent when the page is closed or left right after a change
    fetch(`/api/projects/${projectId}/view`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(v), keepalive: true })
      .catch(() => {}); // only the layout: never worth an error message
  }, [projectId]);

  useEffect(() => {
    if (first.current) { first.current = false; return undefined; }
    try { localStorage.setItem(LAST, JSON.stringify(view)); } catch { /* not remembered here */ }
    pending.current = view;
    const timer = setTimeout(() => send(view), 500);
    return () => clearTimeout(timer);
  }, [view, send]);
  useEffect(() => () => { if (pending.current) send(pending.current); }, [send]); // leaving the editor

  const update = useCallback((patch) => setView((v) => normalizeView(typeof patch === 'function' ? patch(v) : { ...v, ...patch })), []);
  const setTrack = useCallback((id, patch) => update((v) => ({ ...v, tracks: { ...v.tracks, [id]: { ...(v.tracks[id] || {}), ...patch } } })), [update]);
  return { view, update, setTrack };
}
