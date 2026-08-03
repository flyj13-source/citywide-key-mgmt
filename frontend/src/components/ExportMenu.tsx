import { useEffect, useRef, useState } from 'react';

export interface ExportOption {
  label: string;
  onSelect: () => void | Promise<void>;
}

/**
 * A compact "Export ▾" button that opens a menu of format choices (e.g. Excel /
 * PDF). CW-outlined style. Shows a "…" busy state while the chosen export runs
 * and surfaces any error inline. Closes on outside-click / Escape.
 */
export default function ExportMenu({
  options,
  label = 'Export',
  size = 'md',
  variant = 'outline',
}: {
  options: ExportOption[];
  label?: string;
  size?: 'sm' | 'md';
  variant?: 'outline' | 'solid';
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

  const run = async (opt: ExportOption) => {
    setBusy(true); setError('');
    try {
      await opt.onSelect();
      setOpen(false);
    } catch (err: any) {
      setError(err?.message || 'Export failed');
    } finally {
      setBusy(false);
    }
  };

  const pad = size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-4 py-2 text-sm';
  const base = variant === 'solid'
    ? 'bg-[#C0272D] text-white hover:bg-[#a82227]'
    : 'border border-[#1a1a1a] text-[#1a1a1a] hover:border-[#C0272D] hover:text-[#C0272D]';

  return (
    <div className="relative inline-block" ref={ref}>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        disabled={busy}
        className={`${pad} ${base} font-medium rounded transition-colors disabled:opacity-50 whitespace-nowrap`}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {busy ? '…' : `${label} ▾`}
      </button>
      {open && (
        <div
          role="menu"
          onClick={(e) => e.stopPropagation()}
          className="absolute right-0 z-40 mt-1 min-w-[9rem] rounded border border-cw-border bg-white shadow-lg py-1"
        >
          {options.map((opt) => (
            <button
              key={opt.label}
              role="menuitem"
              onClick={() => run(opt)}
              className="block w-full text-left px-3 py-1.5 text-xs text-gray-700 hover:bg-[#f4f4f2]"
            >
              {opt.label}
            </button>
          ))}
          {error && <p className="px-3 py-1.5 text-[11px] text-[#C0272D]">{error}</p>}
        </div>
      )}
    </div>
  );
}
