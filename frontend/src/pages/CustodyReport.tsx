import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Layout from '../components/Layout';
import {
  getCustodyReport, exportCustodyReport,
  type CustodyReportFilters, type CustodyReportRow, type CustodyReportSummary,
} from '../lib/api';

// ── Custody Report ───────────────────────────────────────────────────────────
// One filterable view over the whole check-out / check-in history. The exports
// send the SAME filters to the server, so the spreadsheet is always the report
// that was on screen — never a silently different query.
//
// SECURITY: door and alarm codes appear nowhere here, and the export endpoint
// never reads them, so no export can leak one.

const hasZone = (s: string) => /[Tt]/.test(s) || /[Zz]$/.test(s) || /[+-]\d{2}:?\d{2}$/.test(s);
const parseStamp = (iso: string | null): Date | null => {
  if (!iso) return null;
  const d = new Date(hasZone(iso) ? iso : `${iso.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
};
const fmtDateTime = (iso: string | null): string => {
  const d = parseStamp(iso);
  return d ? d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';
};
const fmtDate = (iso: string | null): string => {
  if (!iso) return '—';
  const d = hasZone(iso) ? parseStamp(iso) : parseStamp(`${iso}T12:00:00Z`);
  return d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : iso;
};

const EMPTY: CustodyReportFilters = {
  date_from: '', date_to: '', holder: '', client: '',
  holder_type: 'all', status: 'all', signature: 'all',
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-[10px] font-bold uppercase tracking-widest text-[#6b6b68] mb-1">{label}</span>
      {children}
    </label>
  );
}

function SummaryStat({ value, label, tone }: { value: number; label: string; tone: 'neutral' | 'red' | 'amber' }) {
  const color = tone === 'red' ? 'text-[#C0272D]' : tone === 'amber' ? 'text-[#7a5a00]' : 'text-[#1a1a1a]';
  return (
    <div className="flex items-baseline gap-1.5">
      <span className={`text-lg font-bold ${color}`}>{value}</span>
      <span className="text-xs text-cw-muted">{label}</span>
    </div>
  );
}

function StatusPill({ row }: { row: CustodyReportRow }) {
  const style = row.overdue
    ? 'bg-[#fbeaea] text-[#C0272D] border-[#f0c9cb]'
    : row.status === 'returned'
      ? 'bg-[#f0f0ee] text-[#1a1a1a] border-cw-border'
      : 'bg-[#eaf5ec] text-[#2d7a3a] border-[#c9e4d0]';
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold whitespace-nowrap border ${style}`}>
      {row.status_label}
    </span>
  );
}

function SignaturePill({ row }: { row: CustodyReportRow }) {
  const style = row.signature_status === 'signed'
    ? 'bg-[#eaf5ec] text-[#2d7a3a] border-[#c9e4d0]'
    : 'bg-[#fff8e6] text-[#7a5a00] border-[#e8cf8a]';
  const title = [
    row.signed_out_at ? `Check-out signed ${fmtDateTime(row.signed_out_at)}` : 'Check-out not signed',
    row.status === 'returned'
      ? (row.signed_in_at ? `Return signed ${fmtDateTime(row.signed_in_at)}` : 'Return not signed')
      : null,
  ].filter(Boolean).join(' · ');
  return (
    <span title={title} className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold whitespace-nowrap border ${style}`}>
      {row.signature_label}
    </span>
  );
}

export default function CustodyReport() {
  const navigate = useNavigate();
  // `filters` is what the inputs hold; `applied` is what produced the rows on
  // screen — and therefore exactly what an export must be given.
  const [filters, setFilters] = useState<CustodyReportFilters>(EMPTY);
  const [applied, setApplied] = useState<CustodyReportFilters>(EMPTY);
  const [rows, setRows] = useState<CustodyReportRow[]>([]);
  const [summary, setSummary] = useState<CustodyReportSummary | null>(null);
  const [description, setDescription] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [exporting, setExporting] = useState<'xlsx' | 'pdf' | null>(null);

  const load = useCallback(async (f: CustodyReportFilters) => {
    setLoading(true); setError('');
    try {
      const d = await getCustodyReport(f);
      setRows(d.rows);
      setSummary(d.summary);
      setDescription(d.description);
      setApplied(f);
    } catch (e: any) {
      setError(e?.message || 'Could not load the custody report');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(EMPTY); }, [load]);

  const set = <K extends keyof CustodyReportFilters>(k: K, v: CustodyReportFilters[K]) =>
    setFilters((f) => ({ ...f, [k]: v }));

  const doExport = async (format: 'xlsx' | 'pdf') => {
    setExporting(format); setError('');
    try {
      await exportCustodyReport(applied, format);
    } catch (e: any) {
      setError(e?.message || 'Export failed');
    } finally {
      setExporting(null);
    }
  };

  return (
    <Layout>
      <div className="p-6 max-w-full mx-auto space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <button onClick={() => navigate('/registry')} className="text-sm text-[#C0272D] hover:underline">
              ← Back to Key Registry
            </button>
            <h1 className="text-xl font-bold text-[#1a1a1a] mt-1">Custody Report</h1>
            <p className="text-sm text-cw-muted">{description || 'All custody records'}</p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => doExport('xlsx')}
              disabled={!!exporting || loading}
              className="px-4 py-2 border border-[#1a1a1a] text-[#1a1a1a] text-sm font-medium rounded hover:border-[#C0272D] hover:text-[#C0272D] disabled:opacity-50 transition-colors"
            >
              {exporting === 'xlsx' ? 'Exporting…' : '↓ Excel'}
            </button>
            <button
              onClick={() => doExport('pdf')}
              disabled={!!exporting || loading}
              className="px-4 py-2 bg-[#C0272D] text-white text-sm font-medium rounded hover:bg-[#a82227] disabled:opacity-50 transition-colors"
            >
              {exporting === 'pdf' ? 'Exporting…' : '↓ PDF'}
            </button>
          </div>
        </div>

        {/* Filters */}
        <div className="card p-4">
          <div className="grid gap-3 md:grid-cols-4 lg:grid-cols-7">
            <Field label="From">
              <input type="date" className="input focus:ring-[#C0272D] focus:border-[#C0272D]" value={filters.date_from ?? ''} onChange={(e) => set('date_from', e.target.value)} />
            </Field>
            <Field label="To">
              <input type="date" className="input focus:ring-[#C0272D] focus:border-[#C0272D]" value={filters.date_to ?? ''} onChange={(e) => set('date_to', e.target.value)} />
            </Field>
            <Field label="Holder">
              <input className="input focus:ring-[#C0272D] focus:border-[#C0272D]" placeholder="Name…" value={filters.holder ?? ''} onChange={(e) => set('holder', e.target.value)} />
            </Field>
            <Field label="Client">
              <input className="input focus:ring-[#C0272D] focus:border-[#C0272D]" placeholder="Name or BC #…" value={filters.client ?? ''} onChange={(e) => set('client', e.target.value)} />
            </Field>
            <Field label="Holder type">
              <select className="input focus:ring-[#C0272D] focus:border-[#C0272D]" value={filters.holder_type} onChange={(e) => set('holder_type', e.target.value as any)}>
                <option value="all">All</option>
                <option value="employee">Employee</option>
                <option value="ic">IC</option>
              </select>
            </Field>
            <Field label="Status">
              <select className="input focus:ring-[#C0272D] focus:border-[#C0272D]" value={filters.status} onChange={(e) => set('status', e.target.value as any)}>
                <option value="all">All</option>
                <option value="active">Active</option>
                <option value="returned">Returned</option>
                <option value="overdue">Overdue</option>
              </select>
            </Field>
            <Field label="Signature">
              <select className="input focus:ring-[#C0272D] focus:border-[#C0272D]" value={filters.signature} onChange={(e) => set('signature', e.target.value as any)}>
                <option value="all">All</option>
                <option value="signed">Signed</option>
                <option value="awaiting">Awaiting</option>
                <option value="missing">Missing signatures</option>
                <option value="unresolvable">Missing — needs follow-up</option>
              </select>
            </Field>
          </div>
          <div className="flex gap-2 mt-3">
            <button onClick={() => load(filters)} disabled={loading} className="px-4 py-2 bg-[#C0272D] text-white text-sm font-medium rounded hover:bg-[#a82227] disabled:opacity-50 transition-colors">
              {loading ? 'Running…' : 'Apply filters'}
            </button>
            <button onClick={() => { setFilters(EMPTY); load(EMPTY); }} className="px-4 py-2 border border-[#1a1a1a] text-[#1a1a1a] text-sm font-medium rounded hover:bg-gray-50 transition-colors">
              Reset
            </button>
          </div>
        </div>

        {/* Summary bar */}
        {summary && (
          <div className="card px-4 py-3 flex flex-wrap items-center gap-x-6 gap-y-2">
            <SummaryStat value={summary.currently_out} label="currently out" tone="neutral" />
            <span className="text-cw-border">·</span>
            <SummaryStat value={summary.overdue} label="overdue" tone="red" />
            <span className="text-cw-border">·</span>
            <SummaryStat value={summary.awaiting_signature} label="missing signature" tone="amber" />
            {summary.needs_follow_up > 0 && (
              <>
                <span className="text-cw-border">·</span>
                {/* Split out because these will not resolve on their own. */}
                <SummaryStat value={summary.needs_follow_up} label="need follow-up" tone="red" />
                <span className="text-xs text-cw-muted">
                  ({summary.no_email} no email · {summary.send_failed} send failed)
                </span>
              </>
            )}
            <span className="ml-auto text-xs text-cw-muted">
              {summary.total} record{summary.total === 1 ? '' : 's'} · {summary.total_keys_out} key{summary.total_keys_out === 1 ? '' : 's'} currently out
            </span>
          </div>
        )}

        {error && (
          <p className="text-sm text-[#C0272D] bg-[#fbeaea] border border-[#f0c9cb] rounded px-3 py-2">{error}</p>
        )}

        <div className="card overflow-x-auto max-w-full">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="bg-[#1a1a1a] text-white text-xs">
                <th className="text-left px-3 py-3 font-medium whitespace-nowrap">Holder</th>
                <th className="text-left px-3 py-3 font-medium whitespace-nowrap">Type</th>
                <th className="text-left px-3 py-3 font-medium whitespace-nowrap">Client</th>
                <th className="text-left px-3 py-3 font-medium whitespace-nowrap">BC #</th>
                <th className="text-left px-3 py-3 font-medium whitespace-nowrap">Keys</th>
                <th className="text-left px-3 py-3 font-medium whitespace-nowrap">Checked Out</th>
                <th className="text-left px-3 py-3 font-medium whitespace-nowrap">Due</th>
                <th className="text-left px-3 py-3 font-medium whitespace-nowrap">Returned</th>
                <th className="text-center px-3 py-3 font-medium whitespace-nowrap">Status</th>
                <th className="text-left px-3 py-3 font-medium whitespace-nowrap">Signed</th>
                <th className="text-left px-3 py-3 font-medium whitespace-nowrap">Recorded By</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={11} className="px-4 py-8 text-center text-cw-muted">Loading…</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan={11} className="px-4 py-8 text-center text-cw-muted">No custody records match these filters</td></tr>
              ) : rows.map((r, i) => (
                <tr key={r.id} className={`border-b border-gray-100 ${i % 2 === 0 ? 'bg-white' : 'bg-[#f4f4f2]'}`}>
                  <td className="px-3 py-3 font-medium text-[#1a1a1a] whitespace-nowrap">{r.holder}</td>
                  <td className="px-3 py-3 text-xs text-gray-700 whitespace-nowrap">{r.holder_type_label}</td>
                  <td className="px-3 py-3 text-[#1a1a1a] max-w-[220px] truncate" title={r.client}>{r.client}</td>
                  <td className="px-3 py-3 text-xs font-mono text-gray-600 whitespace-nowrap">{r.bc_number || <span className="text-gray-300">—</span>}</td>
                  <td className="px-3 py-3 max-w-[300px]">
                    {r.keys.length ? (
                      <span className="inline-flex flex-wrap gap-1">
                        {r.keys.map((k) => (
                          <span key={k.type} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[#f0f0ee] border border-cw-border text-[11px] whitespace-nowrap">
                            {k.label}<span className="font-bold text-[#C0272D]">×{k.qty}</span>
                          </span>
                        ))}
                      </span>
                    ) : <span className="text-xs text-gray-500 italic">{r.keys_summary || '—'}</span>}
                  </td>
                  <td className="px-3 py-3 text-xs text-gray-600 whitespace-nowrap">{fmtDateTime(r.checked_out_at)}</td>
                  <td className="px-3 py-3 text-xs text-gray-600 whitespace-nowrap">{fmtDate(r.due_at)}</td>
                  <td className="px-3 py-3 text-xs text-gray-600 whitespace-nowrap">{fmtDateTime(r.returned_at)}</td>
                  <td className="px-3 py-3 text-center"><StatusPill row={r} /></td>
                  <td className="px-3 py-3"><SignaturePill row={r} /></td>
                  <td className="px-3 py-3 text-xs text-gray-700 whitespace-nowrap">{r.recorded_by || <span className="text-gray-300">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="text-[11px] text-gray-400">
          Exports contain no door or alarm access codes.
        </p>
      </div>
    </Layout>
  );
}
