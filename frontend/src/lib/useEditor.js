import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';

const TEXT_DELAY = 700; // save typed text this long after the last key press

// Editor state: the project from the server, plus Khmer/subtitle text typed but not saved yet.
//
// Every server reply carries the project's `rev`; a reply older than what is shown is ignored, so
// a slow request can never put back text the user has since changed. Typed text stays a "draft"
// until the server has saved exactly that text.
export function useEditor(id, initial) {
  const [project, setProject] = useState(initial);
  const [drafts, setDrafts] = useState({}); // sid -> {khmer_text?, subtitle_text?}
  const [busy, setBusy] = useState({}); // sid -> what is running on it ("regenerate", "fix", …)
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const [inFlight, setInFlight] = useState(0); // requests not answered yet (for "Saving…")
  const rev = useRef(initial.rev);
  const draftsRef = useRef(drafts);
  const timers = useRef({});
  draftsRef.current = drafts;

  const accept = useCallback((p) => {
    if (p && p.rev >= rev.current) {
      rev.current = p.rev;
      setProject(p);
    }
  }, []);

  const say = useCallback((text) => setToast({ text, at: Date.now() }), []);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  // Follow an export, or the removal of the original voice, while it runs.
  const following = project.status === 'exporting' || project.separation?.state === 'running';
  useEffect(() => {
    if (!following) return undefined;
    const t = setInterval(() => { api.get(id).then(accept).catch(() => {}); }, 1000);
    return () => clearInterval(t);
  }, [following, id, accept]);

  // Run a request; keep the newest project it returns; show its error.
  const run = useCallback(async (fn, mark) => {
    setError(null);
    if (mark) setBusy((b) => ({ ...b, [mark.sid]: mark.kind }));
    setInFlight((n) => n + 1);
    try {
      const body = await fn();
      if (body?.project) accept(body.project);
      return body;
    } catch (err) {
      setError(err);
      if (err.status === 409 || err.status === 404) api.get(id).then(accept).catch(() => {});
      return null;
    } finally {
      setInFlight((n) => n - 1);
      if (mark) setBusy((b) => { const next = { ...b }; delete next[mark.sid]; return next; });
    }
  }, [accept, id]);

  // ---------- text: drafts saved after a pause ----------

  const saveText = useCallback(async (sid, field) => {
    clearTimeout(timers.current[`${sid}:${field}`]);
    delete timers.current[`${sid}:${field}`];
    const value = draftsRef.current[sid]?.[field];
    if (value === undefined) return;
    const body = await run(() => api.patchSentence(id, sid, { [field]: value }));
    if (!body) return;
    setDrafts((d) => {
      if (d[sid]?.[field] !== value) return d; // typed more meanwhile: keep the newer draft
      const rest = { ...d[sid] };
      delete rest[field];
      const next = { ...d };
      if (Object.keys(rest).length) next[sid] = rest; else delete next[sid];
      return next;
    });
  }, [id, run]);

  const setText = useCallback((sid, field, value) => {
    setDrafts((d) => ({ ...d, [sid]: { ...d[sid], [field]: value } }));
    const key = `${sid}:${field}`;
    clearTimeout(timers.current[key]);
    timers.current[key] = setTimeout(() => saveText(sid, field), TEXT_DELAY);
  }, [saveText]);

  // Save every pending draft now (before undo, regenerate, export…).
  const flush = useCallback(async () => {
    const pending = Object.entries(draftsRef.current).flatMap(([sid, fields]) => Object.keys(fields).map((f) => [sid, f]));
    await Promise.all(pending.map(([sid, f]) => saveText(sid, f)));
  }, [saveText]);

  // ---------- other edits: shown at once, then saved ----------

  const patch = useCallback(async (sid, fields) => {
    await flush();
    setProject((p) => ({ ...p, sentences: p.sentences.map((s) => (s.id === sid ? { ...s, ...fields } : s)) }));
    const body = await run(() => api.patchSentence(id, sid, fields));
    if (!body) api.get(id).then(accept).catch(() => {}); // refused: show the saved state again
    return body;
  }, [accept, flush, id, run]);

  const action = useCallback(async (fn, mark, done) => {
    await flush();
    const body = await run(fn, mark);
    if (body && done) done(body);
    return body;
  }, [flush, run]);

  const actions = useMemo(() => ({
    setText,
    patch,
    regenerate: (sid, force) => action(() => api.regenerate(id, sid, force), { sid, kind: 'regenerate' }),
    regenerateChanged: () => action(() => api.regenerateChanged(id), { sid: '*', kind: 'regenerate' },
      (b) => say(b.voiced ? `Voiced ${b.voiced} sentence${b.voiced === 1 ? '' : 's'}${b.failed ? ` · ${b.failed} failed` : ''}.` : 'Every sentence already has its voice.')),
    fix: (sid) => action(() => api.fix(id, sid), { sid, kind: 'fix' }, (b) => say(b.note)),
    split: (sid, body) => action(() => api.split(id, sid, body), { sid, kind: 'split' }),
    merge: (sid) => action(() => api.merge(id, sid), { sid, kind: 'merge' }),
    add: (body) => action(() => api.add(id, body)),
    remove: (sid, fill) => action(() => api.deleteSentence(id, sid, fill), { sid, kind: 'delete' },
      () => say(fill === 'original' ? 'Deleted — the original audio plays there.' : 'Deleted — silence there.')),
    applyAll: (fields) => action(() => api.applyAll(id, fields), null, (b) => say(`Applied to ${b.changed} sentences.`)),
    settings: (body) => action(() => api.settings(id, body)),
    backgroundCuts: (cuts, note) => action(() => api.backgroundCuts(id, cuts), null, () => note && say(note)),
    videoCuts: (cuts, note) => action(() => api.videoCuts(id, cuts), null, () => note && say(note)),
    undo: () => action(() => api.undo(id), null, (b) => say(b.label ? `Undid: ${b.label}` : 'Nothing to undo.')),
    redo: () => action(() => api.redo(id), null, (b) => say(b.label ? `Redid: ${b.label}` : 'Nothing to redo.')),
    restore: (n) => action(() => api.restoreVersion(id, n), null, () => say(`Restored the edits of export ${n}. Undo brings your later edits back.`)),
    exportVideo: (body) => action(() => api.exportVideo(id, body)),
    separate: () => action(() => api.separate(id)),
    retry: () => action(async () => ({ project: await api.retry(id) })),
    dismissError: () => setError(null),
  }), [action, id, patch, say, setText]);

  // The sentences as shown: saved values with unsaved drafts on top.
  const sentences = useMemo(
    () => project.sentences.map((s) => (drafts[s.id] ? { ...s, ...drafts[s.id] } : s)),
    [project.sentences, drafts],
  );

  const saving = inFlight > 0 || Object.keys(drafts).length > 0;
  return { project, sentences, drafts, busy, error, toast, actions, flush, saving };
}
