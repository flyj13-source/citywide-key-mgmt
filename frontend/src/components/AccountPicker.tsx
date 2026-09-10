import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { getAccountOptions, type AccountOption } from '../lib/api';
import TestPill from './TestPill';

// ── Account picker ───────────────────────────────────────────────────────────
// The one picker for Check Out, Check In and Transfer. It lists EVERY
// non-archived record — customers and IC vendors both — because keys live at
// both and a picker that quietly showed only one of them made half the
// registry unreachable from the three screens that matter most.
//
// AT 578 RECORDS, NOTHING IS RENDERED IN BULK. The list is server-side
// searched and capped per group (40 customers + 40 IC vendors), so the DOM
// holds at most ~80 rows no matter how large the registry gets. That is why
// this does not use react-window or any virtualization library: the window is
// enforced at the query, which is cheaper than rendering 578 nodes and hiding
// 500 of them, and it means typing filters across the WHOLE registry rather
// than across whatever happened to be loaded.
//
// The two groups are counted and capped separately on purpose. A shared cap
// would let a search matching 40 customers push every IC vendor off the end —
// the exact "filtered subset" failure this replaces.

export interface PickedAccount {
  id: number;
  name: string;
  record_type?: 'customer' | 'ic';
}

const DEBOUNCE_MS = 200;

function TypeBadge({ type }: { type: 'customer' | 'ic' }) {
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-[1px] text-[10px] font-semibold uppercase tracking-wide leading-none shrink-0 ${
        type === 'customer'
          ? 'bg-[#eef2f7] text-[#3a5169] border border-[#c9d6e3]'
          : 'bg-[#f4efe6] text-[#7a5a00] border border-[#e0cfa8]'
      }`}
    >
      {type === 'customer' ? 'Customer' : 'IC'}
    </span>
  );
}

export default function AccountPicker({
  value, onSelect, placeholder = 'Search all clients and IC vendors…', autoFocus = false,
}: {
  value: PickedAccount | null;
  onSelect: (v: PickedAccount | null) => void;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const [search, setSearch] = useState('');
  // Customers outnumber IC vendors ~100:1, so an unfiltered list buries the
  // vendors under 40 customers. The filter is what makes "every record" mean
  // reachable rather than merely present.
  const [group, setGroup] = useState<'all' | 'customer' | 'ic'>('all');
  const [data, setData] = useState<{
    customers: AccountOption[]; ics: AccountOption[];
    totals: { customers: number; ics: number }; truncated: boolean;
  } | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [cursor, setCursor] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Guards against a slow early request landing after a faster later one and
  // repainting the list with results for a query the user has moved past.
  const seq = useRef(0);

  // Fetch on open and on every (debounced) keystroke — including the EMPTY
  // query, which is what makes the dropdown a browsable list of everything
  // rather than something that only appears once you guess a name.
  useEffect(() => {
    if (!open) return;
    const mine = ++seq.current;
    setLoading(true);
    const t = setTimeout(() => {
      getAccountOptions(search.trim(), group)
        .then((d) => { if (mine === seq.current) { setData(d); setCursor(0); } })
        .catch(() => { if (mine === seq.current) setData(null); })
        .finally(() => { if (mine === seq.current) setLoading(false); });
    }, search.trim() ? DEBOUNCE_MS : 0);
    return () => clearTimeout(t);
  }, [search, group, open]);

  // Click-away closes without clearing what is already chosen.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // One flat list for keyboard navigation, with the group headers marked so
  // arrowing never lands on a heading.
  const rows = useMemo(() => {
    if (!data) return [] as ({ kind: 'header'; label: string; note?: string } | { kind: 'option'; opt: AccountOption })[];
    const out: ({ kind: 'header'; label: string; note?: string } | { kind: 'option'; opt: AccountOption })[] = [];
    const add = (label: string, list: AccountOption[], total: number) => {
      if (!list.length) return;
      out.push({
        kind: 'header',
        label,
        note: list.length < total ? `showing ${list.length} of ${total} — keep typing to narrow` : `${total}`,
      });
      for (const opt of list) out.push({ kind: 'option', opt });
    };
    add('Customers', data.customers, data.totals.customers);
    add('IC Vendors', data.ics, data.totals.ics);
    return out;
  }, [data]);

  const options = useMemo(
    () => rows.flatMap((r, i) => (r.kind === 'option' ? [i] : [])),
    [rows],
  );

  const choose = useCallback((opt: AccountOption) => {
    onSelect({ id: opt.id, name: opt.name, record_type: opt.record_type });
    setSearch('');
    setOpen(false);
  }, [onSelect]);

  const move = (delta: number) => {
    if (!options.length) return;
    const at = options.indexOf(cursor);
    const next = options[Math.max(0, Math.min(options.length - 1, (at < 0 ? 0 : at) + delta))];
    setCursor(next);
    // Keep the highlighted row on screen without scrolling the modal itself.
    listRef.current?.querySelector(`[data-row="${next}"]`)?.scrollIntoView({ block: 'nearest' });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (!open) setOpen(true); else move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Enter') {
      const r = rows[cursor];
      if (open && r && r.kind === 'option') { e.preventDefault(); choose(r.opt); }
    } else if (e.key === 'Escape') { setOpen(false); }
  };

  // Once something is chosen the input becomes a chip, so the selection is not
  // a piece of text somebody can half-edit into a value that means nothing.
  if (value) {
    return (
      <div className="flex items-center gap-2 border border-cw-border rounded px-3 py-2 bg-[#faf9f8]">
        {value.record_type && <TypeBadge type={value.record_type} />}
        <span className="font-medium text-[#1a1a1a] truncate">{value.name}</span>
        <button
          type="button"
          onClick={() => { onSelect(null); setSearch(''); setOpen(true); }}
          className="ml-auto text-xs text-[#C0272D] hover:underline shrink-0"
        >
          Change
        </button>
      </div>
    );
  }

  return (
    <div className="relative" ref={boxRef}>
      <input
        className="input focus:ring-[#C0272D] focus:border-[#C0272D]"
        placeholder={placeholder}
        value={search}
        autoFocus={autoFocus}
        onChange={(e) => { setSearch(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
      />
      {open && (
        <div
          ref={listRef}
          className="absolute z-30 w-full bg-white border border-cw-border rounded shadow-lg mt-1"
        >
          <div className="flex items-stretch border-b border-cw-border bg-[#faf9f8] text-[11px]">
            {([
              ['all', 'All', (data?.totals.customers ?? 0) + (data?.totals.ics ?? 0)],
              ['customer', 'Customers', data?.totals.customers ?? 0],
              ['ic', 'IC Vendors', data?.totals.ics ?? 0],
            ] as const).map(([k, label, n]) => (
              <button
                key={k}
                type="button"
                // Mouse DOWN, not click: the input's blur would close the list
                // before a click ever landed.
                onMouseDown={(e) => { e.preventDefault(); setGroup(k); }}
                className={`px-3 py-1.5 font-semibold transition-colors ${
                  group === k
                    ? 'bg-white text-[#C0272D] border-b-2 border-[#C0272D] -mb-px'
                    : 'text-cw-muted hover:text-[#1a1a1a]'
                }`}
              >
                {label} <span className="font-normal text-gray-400">{n}</span>
              </button>
            ))}
          </div>
          <div className="max-h-72 overflow-y-auto">
          {rows.length === 0 ? (
            <div className="px-3 py-3 text-sm text-cw-muted">
              {loading ? 'Loading…' : search.trim() ? `No record matches “${search.trim()}”` : 'No records'}
            </div>
          ) : rows.map((r, i) => r.kind === 'header' ? (
            <div
              key={`h-${r.label}`}
              className="sticky top-0 z-10 flex items-baseline gap-2 px-3 py-1.5 bg-[#1a1a1a] text-white text-[10px] font-bold uppercase tracking-wider"
            >
              <span>{r.label}</span>
              <span className="font-normal normal-case tracking-normal text-white/55">{r.note}</span>
            </div>
          ) : (
            <button
              key={`${r.opt.record_type}-${r.opt.id}`}
              type="button"
              data-row={i}
              onMouseEnter={() => setCursor(i)}
              onClick={() => choose(r.opt)}
              className={`w-full text-left px-3 py-2 text-sm flex items-center gap-2 ${
                cursor === i ? 'bg-[#fbeaea]' : r.opt.is_test === 1 ? 'bg-[#fefaed]' : 'hover:bg-gray-50'
              }`}
            >
              <TypeBadge type={r.opt.record_type} />
              {r.opt.is_test === 1 && <TestPill className="mr-0" />}
              <span className="truncate text-[#1a1a1a]">{r.opt.name}</span>
              {r.opt.number && (
                <span className="ml-auto shrink-0 font-mono text-[11px] text-cw-muted">{r.opt.number}</span>
              )}
            </button>
          ))}
          </div>
        </div>
      )}
    </div>
  );
}
