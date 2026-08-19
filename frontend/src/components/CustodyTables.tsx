import { downloadReceipt, resendSignoff, type Assignment } from '../lib/api';
import { useState } from 'react';

// ── Custody tables (Checked Out / Checked In registry tabs) ─────────────────
// Sorting is server-side (the API exposes the same sortable columns) so it
// spans the whole result set, not just the page on screen.

export type SortState = { key: string; dir: 'asc' | 'desc' };

// Timestamps arrive as ISO strings from new rows and as SQLite 'YYYY-MM-DD
// HH:MM:SS' (UTC, no zone) from older ones. Normalize both; a bare date
// (due_at) is read at midday UTC so it never slips a day in local time.
const hasZone = (s: string) => /[Tt]/.test(s) || /[Zz]$/.test(s) || /[+-]\d{2}:?\d{2}$/.test(s);
const parseStamp = (iso: string | null): Date | null => {
  if (!iso) return null;
  const d = new Date(hasZone(iso) ? iso : `${iso.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
};
const fmtDateTime = (iso: string | null): string => {
  const d = parseStamp(iso);
  if (!d) return iso || '—';
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
};
const fmtDate = (iso: string | null): string => {
  if (!iso) return '—';
  const d = hasZone(iso) ? parseStamp(iso) : parseStamp(`${iso}T12:00:00Z`);
  if (!d) return iso;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

const CONDITION_LABEL: Record<string, string> = {
  good: 'Good', damaged: 'Damaged', missing_copy: 'Missing copy',
};

function HolderTypeBadge({ type }: { type: 'employee' | 'ic' | null }) {
  if (type === 'ic') {
    return <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border border-[#C0272D] text-[#C0272D]">IC</span>;
  }
  if (type === 'employee') {
    return <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-[#1a1a1a] text-white">Employee</span>;
  }
  return <span className="text-gray-300">—</span>;
}

/** Key type + qty chips — the visible proof a transaction carried several types. */
function KeyChips({ a }: { a: Assignment }) {
  if (!a.keys.length) {
    return <span className="text-xs text-gray-500 italic">{a.keys_summary || '—'}</span>;
  }
  return (
    <span className="inline-flex flex-wrap gap-1">
      {a.keys.map((k) => (
        <span key={k.type} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[#f0f0ee] border border-cw-border text-[11px] text-[#1a1a1a] whitespace-nowrap">
          {k.label}
          <span className="font-bold text-[#C0272D]">×{k.qty}</span>
        </span>
      ))}
    </span>
  );
}

function StatusPill({ overdue }: { overdue: boolean }) {
  return overdue
    ? <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold whitespace-nowrap bg-[#fbeaea] text-[#C0272D] border border-[#f0c9cb]">Overdue</span>
    : <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap bg-[#eaf5ec] text-[#2d7a3a] border border-[#c9e4d0]">On time</span>;
}

/** Signed / Awaiting signature (amber) — plus the receipt download once signed. */
function SignaturePill({ a, onResent }: { a: Assignment; onResent: (msg: string) => void }) {
  const [busy, setBusy] = useState(false);
  if (a.signed_at) {
    return (
      <span className="inline-flex items-center gap-2">
        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-[#eaf5ec] text-[#2d7a3a] border border-[#c9e4d0]" title={`Signed ${fmtDateTime(a.signed_at)}`}>
          Signed
        </span>
        {a.has_pdf && (
          <button onClick={() => downloadReceipt(a.id)} className="text-[11px] text-[#C0272D] hover:underline whitespace-nowrap">PDF</button>
        )}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-2">
      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold whitespace-nowrap bg-[#fff8e6] text-[#7a5a00] border border-[#e8cf8a]">
        Awaiting signature
      </span>
      <button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            const r = await resendSignoff(a.id);
            onResent(r.email.ok
              ? `Sign-off link re-sent to ${r.email.recipients.join(', ')}`
              : `Could not re-send the sign-off email${r.email.error ? `: ${r.email.error}` : ''}`);
          } catch (e: any) {
            onResent(e?.message || 'Could not re-send the sign-off email');
          } finally { setBusy(false); }
        }}
        className="text-[11px] text-[#C0272D] hover:underline whitespace-nowrap disabled:opacity-50"
        title="Mint a fresh 48-hour link and email it again"
      >
        {busy ? '…' : 'Resend'}
      </button>
    </span>
  );
}

function SortHeader({
  label, sortKey, sort, onSort, align = 'left',
}: {
  label: string; sortKey: string; sort: SortState; onSort: (k: string) => void; align?: 'left' | 'center';
}) {
  const arrow = sort.key === sortKey ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '';
  return (
    <th
      className={`text-${align} px-3 py-3 font-medium whitespace-nowrap cursor-pointer select-none`}
      onClick={() => onSort(sortKey)}
    >
      {label}{arrow}
    </th>
  );
}

export function CheckedOutTable({
  rows, loading, sort, onSort, onCheckIn, onNotice,
}: {
  rows: Assignment[];
  loading: boolean;
  sort: SortState;
  onSort: (k: string) => void;
  onCheckIn: (a: Assignment) => void;
  onNotice: (msg: string) => void;
}) {
  return (
    <div className="card overflow-x-auto max-w-full">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="bg-[#1a1a1a] text-white text-xs">
            <SortHeader label="Holder" sortKey="holder" sort={sort} onSort={onSort} />
            <th className="text-left px-3 py-3 font-medium whitespace-nowrap">Type</th>
            <SortHeader label="Client" sortKey="account_name" sort={sort} onSort={onSort} />
            <th className="text-left px-3 py-3 font-medium whitespace-nowrap">Keys</th>
            <SortHeader label="Checked Out" sortKey="checked_out_at" sort={sort} onSort={onSort} />
            <SortHeader label="Due" sortKey="due_at" sort={sort} onSort={onSort} />
            <th className="text-center px-3 py-3 font-medium whitespace-nowrap">Status</th>
            <th className="text-left px-3 py-3 font-medium whitespace-nowrap">Signature</th>
            <th className="px-3 py-3"></th>
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr><td colSpan={9} className="px-4 py-8 text-center text-cw-muted">Loading…</td></tr>
          ) : rows.length === 0 ? (
            <tr><td colSpan={9} className="px-4 py-8 text-center text-cw-muted">Nothing is currently checked out</td></tr>
          ) : rows.map((a, i) => (
            <tr key={a.id} className={`border-b border-gray-100 ${i % 2 === 0 ? 'bg-white' : 'bg-[#f4f4f2]'}`}>
              <td className="px-3 py-3 font-medium text-[#1a1a1a] whitespace-nowrap">
                {a.holder}
                {a.recorded_by && a.recorded_by !== a.holder && (
                  <div className="text-[10px] text-gray-400 font-normal">recorded by {a.recorded_by}</div>
                )}
              </td>
              <td className="px-3 py-3"><HolderTypeBadge type={a.holder_type} /></td>
              <td className="px-3 py-3 text-[#1a1a1a] whitespace-nowrap max-w-[220px] truncate">{a.account_name}</td>
              <td className="px-3 py-3 max-w-[320px]"><KeyChips a={a} /></td>
              <td className="px-3 py-3 text-xs text-gray-600 whitespace-nowrap">{fmtDateTime(a.checked_out_at)}</td>
              <td className="px-3 py-3 text-xs text-gray-600 whitespace-nowrap">{a.due_at ? fmtDate(a.due_at) : '—'}</td>
              <td className="px-3 py-3 text-center"><StatusPill overdue={a.overdue} /></td>
              <td className="px-3 py-3"><SignaturePill a={a} onResent={onNotice} /></td>
              <td className="px-3 py-3 text-right whitespace-nowrap">
                <button
                  onClick={() => onCheckIn(a)}
                  className="text-xs border border-[#1a1a1a] text-[#1a1a1a] rounded px-2.5 py-1 hover:border-[#C0272D] hover:text-[#C0272D] transition-colors"
                >
                  Check In
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function CheckedInTable({
  rows, loading, sort, onSort,
}: {
  rows: Assignment[];
  loading: boolean;
  sort: SortState;
  onSort: (k: string) => void;
}) {
  return (
    <div className="card overflow-x-auto max-w-full">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="bg-[#1a1a1a] text-white text-xs">
            <SortHeader label="Holder" sortKey="holder" sort={sort} onSort={onSort} />
            <SortHeader label="Client" sortKey="account_name" sort={sort} onSort={onSort} />
            <th className="text-left px-3 py-3 font-medium whitespace-nowrap">Keys</th>
            <SortHeader label="Checked Out" sortKey="checked_out_at" sort={sort} onSort={onSort} />
            <SortHeader label="Returned" sortKey="returned_at" sort={sort} onSort={onSort} />
            <SortHeader label="Condition" sortKey="condition" sort={sort} onSort={onSort} />
            <SortHeader label="Recorded By" sortKey="recorded_by" sort={sort} onSort={onSort} />
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr><td colSpan={7} className="px-4 py-8 text-center text-cw-muted">Loading…</td></tr>
          ) : rows.length === 0 ? (
            <tr><td colSpan={7} className="px-4 py-8 text-center text-cw-muted">No returned keys yet</td></tr>
          ) : rows.map((a, i) => (
            <tr key={a.id} className={`border-b border-gray-100 ${i % 2 === 0 ? 'bg-white' : 'bg-[#f4f4f2]'}`}>
              <td className="px-3 py-3 font-medium text-[#1a1a1a] whitespace-nowrap">
                {a.holder}
                <div className="mt-0.5"><HolderTypeBadge type={a.holder_type} /></div>
              </td>
              <td className="px-3 py-3 text-[#1a1a1a] whitespace-nowrap max-w-[220px] truncate">{a.account_name}</td>
              <td className="px-3 py-3 max-w-[320px]"><KeyChips a={a} /></td>
              <td className="px-3 py-3 text-xs text-gray-600 whitespace-nowrap">{fmtDateTime(a.checked_out_at)}</td>
              <td className="px-3 py-3 text-xs text-gray-600 whitespace-nowrap">{fmtDateTime(a.returned_at)}</td>
              <td className="px-3 py-3 text-xs text-gray-700 whitespace-nowrap">
                {a.condition_on_return
                  ? CONDITION_LABEL[a.condition_on_return] || a.condition_on_return
                  : <span className="text-gray-300">—</span>}
              </td>
              <td className="px-3 py-3 text-xs text-gray-700 whitespace-nowrap">
                {a.checkin_recorded_by || a.recorded_by || <span className="text-gray-300">—</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
