import { useEffect, useRef, useState } from 'react';

export interface ActionItem {
  label: string;
  onSelect: () => void | Promise<void>;
  /** Greyed out and unclickable; `hint` explains why. */
  disabled?: boolean;
  hint?: string;
  /** Renders in CW red — for destructive entries. */
  danger?: boolean;
  /** Draws a divider above this item. */
  separated?: boolean;
}

/**
 * A "⋯ More" overflow menu for lower-frequency header actions, so the primary
 * action row stays scannable. Closes on outside-click and Escape, surfaces the
 * reason an item is unavailable rather than just greying it out, and reports
 * errors inline instead of failing silently.
 */
export default function ActionMenu({
  items,
  label = '⋯ More',
}: {
  items: ActionItem[];
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const run = async (item: ActionItem) => {
    if (item.disabled) return;
    setBusy(true); setError('');
    try {
      await item.onSelect();
      setOpen(false);
    } catch (err: any) {
      setError(err?.message || 'Action failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative inline-block" ref={ref}>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        disabled={busy}
        aria-haspopup="menu"
        aria-expanded={open}
        className="px-4 py-2 border border-[#1a1a1a] text-[#1a1a1a] text-sm font-medium rounded hover:border-[#C0272D] hover:text-[#C0272D] transition-colors disabled:opacity-50 whitespace-nowrap"
      >
        {busy ? '…' : label}
      </button>
      {open && (
        <div
          role="menu"
          onClick={(e) => e.stopPropagation()}
          className="absolute right-0 z-40 mt-1 min-w-[15rem] rounded border border-cw-border bg-white shadow-lg py-1"
        >
          {items.map((item) => (
            <div key={item.label} className={item.separated ? 'border-t border-gray-100 mt-1 pt-1' : ''}>
              <button
                role="menuitem"
                onClick={() => run(item)}
                disabled={item.disabled}
                title={item.disabled ? item.hint : undefined}
                className={`block w-full text-left px-3 py-2 text-sm transition-colors ${
                  item.disabled
                    ? 'text-gray-400 cursor-not-allowed'
                    : item.danger
                      ? 'text-[#C0272D] hover:bg-[#fbeaea]'
                      : 'text-gray-700 hover:bg-[#f4f4f2]'
                }`}
              >
                {item.label}
              </button>
              {item.disabled && item.hint && (
                <p className="px-3 pb-1.5 -mt-1 text-[11px] text-gray-400">{item.hint}</p>
              )}
            </div>
          ))}
          {error && <p className="px-3 py-1.5 text-[11px] text-[#C0272D]">{error}</p>}
        </div>
      )}
    </div>
  );
}
