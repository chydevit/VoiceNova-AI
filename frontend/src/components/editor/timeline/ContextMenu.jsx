import { useEffect, useLayoutEffect, useRef, useState } from 'react';

// The right-click menu of a clip (or a gap, or empty space): its common actions, with their keys.
// items: [{label, key?, onClick, danger?, disabled?} | '-'].
export default function ContextMenu({ x, y, title, items, onClose }) {
  const box = useRef(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => { // keep it on screen
    const r = box.current.getBoundingClientRect();
    setPos({ left: Math.min(x, window.innerWidth - r.width - 8), top: Math.min(y, window.innerHeight - r.height - 8) });
  }, [x, y]);

  useEffect(() => {
    const away = (e) => { if (!box.current?.contains(e.target)) onClose(); };
    const key = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('keydown', key, true);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('pointerdown', away, true);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);

  return (
    <div ref={box} role="menu" className="fixed z-50 min-w-52 rounded-xl border border-line bg-panel p-1 text-sm shadow-xl" style={pos}
      onContextMenu={(e) => e.preventDefault()}>
      {title && <p className="truncate px-2.5 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-faint">{title}</p>}
      {items.map((item, i) => (item === '-' ? <hr key={`-${i}`} className="my-1 border-line" /> : (
        <button key={item.label} type="button" role="menuitem" disabled={item.disabled}
          onClick={() => { onClose(); item.onClick(); }}
          className={`flex w-full items-center gap-3 rounded-lg px-2.5 py-1.5 text-left disabled:opacity-40 ${item.danger ? 'text-red-600 hover:bg-red-500/10 dark:text-red-400' : 'text-ink hover:bg-raised'}`}>
          <span className="flex-1">{item.label}</span>
          {item.key && <kbd className="font-mono text-[11px] text-faint">{item.key}</kbd>}
        </button>
      )))}
    </div>
  );
}
