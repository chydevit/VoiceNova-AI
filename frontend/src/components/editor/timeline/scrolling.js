import { useEffect, useRef } from 'react';
import { edgeSpeed, wheelIntent } from './layout.js';

// Gestures on the timeline's scroll area (`ref`):
//  - mouse wheel / two-finger swipe up-down scrolls the tracks; Shift + wheel or a sideways swipe
//    moves through time; Ctrl/⌘ + wheel or a trackpad pinch zooms around the pointer (layout.wheelIntent)
//  - Safari (and the Mac app, which is WebKit) reports a trackpad pinch as gesture events
//  - on a touch screen, two fingers pinch to zoom; one finger scrolls as usual
// onZoom(factor, clientX): zoom by `factor` around that point.
export function useTrackGestures(ref, onZoom) {
  const zoom = useRef(onZoom);
  zoom.current = onZoom;

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const onWheel = (e) => {
      const intent = wheelIntent(e, { canScrollY: el.scrollHeight > el.clientHeight + 1 });
      if (intent.kind === 'native') return;
      e.preventDefault();
      if (intent.kind === 'zoom') zoom.current(intent.amount, e.clientX);
      else el.scrollLeft += intent.amount;
    };
    let gesture = null; // Safari pinch: the scale it started at
    const onGestureStart = (e) => { e.preventDefault(); gesture = { scale: 1, x: e.clientX }; };
    const onGestureChange = (e) => {
      if (!gesture) return;
      e.preventDefault();
      zoom.current(e.scale / gesture.scale, gesture.x);
      gesture.scale = e.scale;
    };
    const onGestureEnd = (e) => { e.preventDefault(); gesture = null; };
    let pinch = null; // touch: the distance between the two fingers last time
    const spread = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const onTouchMove = (e) => {
      if (e.touches.length !== 2) { pinch = null; return; }
      e.preventDefault(); // two fingers: ours, not the page's zoom
      const d = spread(e.touches);
      if (pinch && d > 0) zoom.current(d / pinch, (e.touches[0].clientX + e.touches[1].clientX) / 2);
      pinch = d;
    };
    const onTouchEnd = () => { pinch = null; };
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('gesturestart', onGestureStart);
    el.addEventListener('gesturechange', onGestureChange);
    el.addEventListener('gestureend', onGestureEnd);
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd);
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('gesturestart', onGestureStart);
      el.removeEventListener('gesturechange', onGestureChange);
      el.removeEventListener('gestureend', onGestureEnd);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
    };
  }, [ref]);
}

// While something is dragged (axes: 'x', 'xy' or null), holding the pointer near an edge of the
// tracks scrolls that way. `inset` = {left, top}: the sticky track names and ruler, which aren't
// part of the tracks' area. After each step onScrolled(the last pointer event) runs, so whatever
// is dragged follows the pointer's new place on the timeline.
export function useEdgeScroll(ref, axes, inset, onScrolled) {
  const last = useRef(null);
  const after = useRef(onScrolled);
  after.current = onScrolled;

  useEffect(() => {
    if (!axes) return undefined;
    const el = ref.current;
    const onMove = (e) => { last.current = e; };
    let frame;
    const tick = () => {
      const e = last.current;
      if (e && el) {
        const r = el.getBoundingClientRect();
        const dx = edgeSpeed(e.clientX, r.left + inset.left, r.right);
        const dy = axes === 'xy' ? edgeSpeed(e.clientY, r.top + inset.top, r.bottom) : 0;
        const before = [el.scrollLeft, el.scrollTop];
        if (dx) el.scrollLeft += dx;
        if (dy) el.scrollTop += dy;
        if (el.scrollLeft !== before[0] || el.scrollTop !== before[1]) after.current?.(e);
      }
      frame = requestAnimationFrame(tick);
    };
    window.addEventListener('pointermove', onMove);
    frame = requestAnimationFrame(tick);
    return () => {
      window.removeEventListener('pointermove', onMove);
      cancelAnimationFrame(frame);
      last.current = null;
    };
  }, [ref, axes, inset.left, inset.top]);
}
