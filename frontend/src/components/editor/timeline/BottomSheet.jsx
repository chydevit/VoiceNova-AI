import { useEffect, useRef, useState } from 'react';
import { PanelIcon } from './TimelineDock.jsx';

const ORDER = ['closed', 'open', 'expanded'];
const SWIPE = 36; // px of swipe that moves to the next size
const HANDLE = 44; // what's left of a closed sheet: its handle and title

// Phones: the timeline is a sheet along the bottom of the screen. Swipe its handle up to make it
// bigger (open → expanded), down to make it smaller or close it; tap the handle to open or close it.
// state / onState: 'closed' | 'open' | 'expanded'. children(state) draws what's in it. A spacer as
// tall as the sheet keeps the page's last part from hiding under it.
export default function BottomSheet({ state, onState, title, children }) {
  const sheet = useRef(null);
  const [drag, setDrag] = useState(null); // {y0, dy}
  const [size, setSize] = useState(HANDLE);

  useEffect(() => {
    const el = sheet.current;
    const ro = new ResizeObserver(() => setSize(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const step = (by) => onState(ORDER[Math.min(ORDER.length - 1, Math.max(0, ORDER.indexOf(state) + by))]);
  function end() {
    if (!drag) return;
    const { dy } = drag;
    setDrag(null);
    if (Math.abs(dy) < 8) onState(state === 'closed' ? 'open' : 'closed'); // a tap
    else if (dy <= -SWIPE) step(1);
    else if (dy >= SWIPE) step(-1);
  }
  const closed = state === 'closed';
  // while swiped: follows the finger (down freely, up a little, as a hint)
  const offset = drag ? (drag.dy > 0 ? drag.dy : Math.max(drag.dy, -40) / 2) : 0;
  const hidden = closed ? Math.max(0, size - HANDLE) : 0;

  return (
    <>
      <div aria-hidden="true" style={{ height: closed ? HANDLE : size }} />
      <section ref={sheet} aria-label="Timeline"
        className={`fixed inset-x-0 bottom-0 z-40 rounded-t-2xl border border-b-0 border-line bg-panel pb-[env(safe-area-inset-bottom)] shadow-[0_-8px_24px_rgb(0_0_0/0.25)] ${drag ? '' : 'transition-transform duration-200 ease-out'}`}
        style={{ transform: `translateY(${hidden + offset}px)` }}>
        <div role="button" tabIndex={0} aria-expanded={!closed}
          aria-label={closed ? 'Open the timeline (swipe up)' : 'Timeline: swipe up for more, down to close; tap to close'}
          className="flex cursor-grab touch-none select-none flex-col items-center gap-1 px-3 pb-1.5 pt-2"
          style={{ minHeight: HANDLE }}
          onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); setDrag({ y0: e.clientY, dy: 0 }); }}
          onPointerMove={(e) => { if (drag) setDrag({ ...drag, dy: e.clientY - drag.y0 }); }}
          onPointerUp={end} onPointerCancel={() => setDrag(null)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onState(closed ? 'open' : 'closed'); }
            if (e.key === 'ArrowUp') { e.preventDefault(); step(1); }
            if (e.key === 'ArrowDown') { e.preventDefault(); step(-1); }
          }}>
          <span className="h-1 w-10 rounded-full bg-line-strong" />
          <span className="flex w-full items-center gap-2 text-sm">
            <span className="font-semibold">Timeline</span>
            {title}
            <span className="ml-auto flex text-faint">
              {state !== 'expanded' && <PanelIcon name="up" />}
              {!closed && <PanelIcon name="down" />}
            </span>
          </span>
        </div>
        <div className="px-2.5 pb-2.5">{children(state)}</div>
      </section>
    </>
  );
}
