import { useMemo, useState } from 'react';
import type { ManagerRosterRow, UnmatchedManager } from '../lib/api';

// ── Manager roster tables, inside the Key Registry ───────────────────────────
// These render staff_managers RECORDS (attributes + aggregates), not names
// grouped off the client rows. That distinction is the whole point of the
// consolidation: a roster hire with no clients still appears, and a name that
// exists only on a client row is shown separately as unreconciled rather than
// masquerading as a manager.

const TYPE_LABEL: Record<string, string> = {
  account_manager: 'AM', ccm: 'CCM', both: 'AM + CCM',
};

/** CW-red left border marks the "Personally Holds" group as primary. */
const RED_BORDER = 'border-l-2 border-[#C0272D]';

export const SHIFT_CHIPS = [
  { key: 'all', label: 'All' },
  { key: '1st', label: '1st' },
  { key: '2nd', label: '2nd' },
  { key: '3rd', label: '3rd' },
  { key: 'day', label: 'Day' },
  { key: 'night', label: 'Night' },
  { key: 'active', label: 'Active only' },
] as const;
export type RosterChip = typeof SHIFT_CHIPS[number]['key'];

export function matchesChip(m: ManagerRosterRow, chip: RosterChip): boolean {
  switch (chip) {
    case 'all': return true;
    case '1st': case '2nd': case '3rd': return m.shift === chip;
    case 'day': case 'night': return m.day_night === chip;
    case 'active': return m.active === 1;
    default: return true;
  }
}

function TypeBadge({ type }: { type: string }) {
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-[#1a1a1a] text-white whitespace-nowrap">
      {TYPE_LABEL[type] ?? type}
    </span>
  );
}

/* Shift only — day/night has its own column, so folding both in here would
   print the same fact twice on every row. */
function ShiftPill({ shift }: { shift: string | null }) {
  if (!shift) return <span className="text-gray-300">—</span>;
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border border-[#C0272D] text-[#C0272D] whitespace-nowrap">
      {shift} shift
    </span>
  );
}

function Count({ value }: { value: number }) {
  if (!value) return <span className="text-gray-300">—</span>;
  return (
    <span className="inline-flex items-center justify-center min-w-[1.5rem] h-6 px-1.5 rounded-full bg-[#1a1a1a] text-white text-xs font-semibold">
      {value}
    </span>
  );
}

/** Secondary zone — deliberately muted so it never competes with what they hold. */
function Muted({ value }: { value: number }) {
  if (!value) return <span className="text-gray-300">—</span>;
  return <span className="text-gray-500 text-xs font-medium">{value}</span>;
}

const PERSONAL_COLS = [
  { key: 'personal_metal', label: 'Metal' },
  { key: 'personal_cards', label: 'Card' },
  { key: 'personal_fobs', label: 'Fob' },
  { key: 'personal_dispenser', label: 'Dispenser' },
] as const;

export function ManagerRosterTable({
  role, rows, unmatched, loading, chip, onChip, search, onSearch,
  onEdit, onReassign, onView, canReassign,
}: {
  role: 'am' | 'ccm';
  rows: ManagerRosterRow[];
  unmatched: UnmatchedManager[];
  loading: boolean;
  chip: RosterChip;
  onChip: (c: RosterChip) => void;
  search: string;
  onSearch: (v: string) => void;
  onEdit: (m: ManagerRosterRow) => void;
  onReassign: (m: ManagerRosterRow) => void;
  onView: (m: ManagerRosterRow) => void;
  canReassign: boolean;
}) {
  const [sortKey, setSortKey] = useState<string>('name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((m) =>
      matchesChip(m, chip) &&
      (!q || m.name.toLowerCase().includes(q) || (m.email || '').toLowerCase().includes(q)));
  }, [rows, chip, search]);

  const sorted = useMemo(() => {
    const copy = [...filtered];
    copy.sort((a, b) => {
      const av = (a as any)[sortKey], bv = (b as any)[sortKey];
      const cmp = typeof av === 'string' || typeof bv === 'string'
        ? String(av ?? '').localeCompare(String(bv ?? ''))
        : ((av || 0) - (bv || 0));
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return copy;
  }, [filtered, sortKey, sortDir]);

  const sort = (key: string) => {
    if (key === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir(key === 'name' ? 'asc' : 'desc'); }
  };
  const arrow = (key: string) => (key === sortKey ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '');
  const label = role === 'am' ? 'Account Manager' : 'Contract Compliance Manager';

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex border-b border-cw-border gap-5">
          {SHIFT_CHIPS.map((c) => (
            <button
              key={c.key}
              onClick={() => onChip(c.key)}
              className={`pb-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
                chip === c.key ? 'border-[#C0272D] text-[#C0272D]' : 'border-transparent text-[#6b6b68] hover:text-[#1a1a1a]'
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        <input
          className="input max-w-xs focus:ring-[#C0272D] focus:border-[#C0272D]"
          placeholder="Search by name or email…"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
        />
      </div>

      <div className="card overflow-x-auto max-w-full">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="bg-[#1a1a1a] text-white text-[11px]">
              <th rowSpan={2} className="text-left px-4 py-3 font-medium whitespace-nowrap cursor-pointer select-none align-bottom" onClick={() => sort('name')}>Name{arrow('name')}</th>
              <th rowSpan={2} className="text-left px-3 py-3 font-medium whitespace-nowrap align-bottom">Type</th>
              <th rowSpan={2} className="text-left px-3 py-3 font-medium whitespace-nowrap align-bottom">Shift</th>
              <th rowSpan={2} className="text-center px-3 py-3 font-medium whitespace-nowrap align-bottom">Day/Night</th>
              <th rowSpan={2} className="text-center px-3 py-3 font-medium whitespace-nowrap cursor-pointer select-none align-bottom" onClick={() => sort('clients_managed')}>Clients Managed{arrow('clients_managed')}</th>
              <th colSpan={5} className={`text-center px-3 py-2 font-bold uppercase tracking-wide whitespace-nowrap ${RED_BORDER}`}>Personally Holds</th>
              <th rowSpan={2} className="text-center px-3 py-3 font-medium uppercase tracking-wide whitespace-nowrap text-white/50 border-l border-white/20 align-bottom cursor-pointer select-none" onClick={() => sort('total_client_keys')}>Total Managed Inventory{arrow('total_client_keys')}</th>
              <th rowSpan={2} className="text-center px-3 py-3 font-medium whitespace-nowrap align-bottom">Active</th>
              <th rowSpan={2} className="px-3 py-3 align-bottom sticky right-0 bg-[#1a1a1a] z-10"></th>
            </tr>
            <tr className="bg-[#1a1a1a] text-white text-xs">
              {PERSONAL_COLS.map((c, i) => (
                <th key={c.key} className={`text-center px-3 py-2 font-semibold whitespace-nowrap cursor-pointer select-none ${i === 0 ? RED_BORDER : ''}`} onClick={() => sort(c.key)}>
                  {c.label}{arrow(c.key)}
                </th>
              ))}
              <th className="text-center px-3 py-2 font-bold whitespace-nowrap cursor-pointer select-none" onClick={() => sort('total_held')}>Total{arrow('total_held')}</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={13} className="px-4 py-8 text-center text-cw-muted">Loading…</td></tr>
            ) : sorted.length === 0 ? (
              <tr><td colSpan={13} className="px-4 py-8 text-center text-cw-muted">No {label.toLowerCase()}s match this filter</td></tr>
            ) : sorted.map((m, i) => (
              <tr
                key={m.id}
                className={`cursor-pointer border-b border-gray-100 hover:bg-[#f0f0ee] transition-colors ${i % 2 === 0 ? 'bg-white' : 'bg-[#f4f4f2]'} ${m.active === 0 ? 'opacity-60' : ''}`}
                onClick={() => onView(m)}
                title="Open this manager's detail"
              >
                <td className="px-4 py-3 font-medium text-[#1a1a1a] whitespace-nowrap">
                  {m.name}
                  {/* Email drives signature forms and notifications — flag it here
                      so the gap is visible before it blocks a handover. */}
                  {!m.email && (
                    <div className="mt-0.5">
                      <span
                        title="No email on file — signature forms and notifications cannot reach this person"
                        className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold whitespace-nowrap bg-[#fbeaea] text-[#C0272D] border border-[#C0272D]"
                      >
                        No email on file
                      </span>
                    </div>
                  )}
                </td>
                <td className="px-3 py-3"><TypeBadge type={m.manager_type} /></td>
                <td className="px-3 py-3"><ShiftPill shift={m.shift} /></td>
                <td className="px-3 py-3 text-center text-xs text-gray-600">
                  {m.day_night ? m.day_night[0].toUpperCase() + m.day_night.slice(1) : '—'}
                </td>
                <td className="px-3 py-3 text-center"><Count value={m.clients_managed} /></td>
                {PERSONAL_COLS.map((c, idx) => (
                  <td key={c.key} className={`px-3 py-3 text-center ${idx === 0 ? RED_BORDER : ''}`}>
                    <Count value={(m as any)[c.key]} />
                  </td>
                ))}
                <td className="px-3 py-3 text-center">
                  {m.total_held
                    ? <span className="inline-flex items-center justify-center min-w-[1.75rem] h-6 px-2 rounded-full bg-[#C0272D] text-white text-xs font-bold">{m.total_held}</span>
                    : <span className="text-gray-300">—</span>}
                </td>
                <td className="px-3 py-3 text-center border-l border-gray-200"><Muted value={m.total_client_keys} /></td>
                <td className="px-3 py-3 text-center">
                  {m.active === 1
                    ? <span className="text-[#2d7a3a] font-bold">✓</span>
                    : <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium bg-gray-200 text-gray-600">Inactive</span>}
                </td>
                <td
                  className={`px-3 py-3 text-right whitespace-nowrap sticky right-0 shadow-[-6px_0_6px_-6px_rgba(0,0,0,0.18)] ${i % 2 === 0 ? 'bg-white' : 'bg-[#f4f4f2]'}`}
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="inline-flex items-center gap-2">
                    <button onClick={() => onEdit(m)} className="text-xs border border-[#1a1a1a] text-[#1a1a1a] rounded px-2.5 py-1 hover:border-[#C0272D] hover:text-[#C0272D] transition-colors">Edit</button>
                    {canReassign && (
                      <button onClick={() => onReassign(m)} className="text-xs border border-[#1a1a1a] text-[#1a1a1a] rounded px-2.5 py-1 hover:border-[#C0272D] hover:text-[#C0272D] transition-colors">Reassign</button>
                    )}
                    <button onClick={() => onView(m)} className="text-xs text-[#C0272D] hover:underline">View</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Names on client rows with no roster record. Shown, not swallowed —
          they hold real keys, and the fix is to add or correct the record. */}
      {unmatched.length > 0 && (
        <div className="rounded border border-[#e8cf8a] bg-[#fff8e6] px-4 py-3">
          <div className="text-sm font-semibold text-[#7a5a00]">
            {unmatched.length} name{unmatched.length === 1 ? '' : 's'} on client rows with no roster record
          </div>
          <p className="text-xs text-[#7a5a00] mt-0.5">
            These appear as {label.toLowerCase()} on client rows but are not staff records — usually a spelling
            variant or someone who left. Add them with “+ Add Manager”, or correct the client rows.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {unmatched.map((u) => (
              <span key={u.person} className="inline-flex items-center gap-2 px-2 py-1 rounded bg-white border border-[#e8cf8a] text-xs">
                <span className="font-medium text-[#1a1a1a]">{u.person}</span>
                <span className="text-[#7a5a00]">
                  {u.clients_managed} client{u.clients_managed === 1 ? '' : 's'} · {u.total_held} key{u.total_held === 1 ? '' : 's'}
                </span>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
