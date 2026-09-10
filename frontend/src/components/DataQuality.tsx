import { useState, useEffect, useCallback } from 'react';
import {
  getDuplicates, getMissingEmail, downloadDataQualityWorkbook,
  type DuplicatePair, type DuplicateSide, type NoEmailRecord, type DataQualitySummary,
} from '../lib/api';
import TestPill from './TestPill';

// ── Possible Duplicates — READ ONLY ──────────────────────────────────────────
// There is no merge button here, and there must not be one. Two records that
// look like a typo can turn out to be one live record and one empty shell, or
// two real people, or a shared mailbox — and which of those it is only becomes
// visible once you can see the clients, the keys and the open custody on each
// side. That is why this screen is a COMPARISON, not an action: the evidence is
// the deliverable, and the decision stays with the person who can verify it.
//
// Everything it shows is a CANDIDATE. A near-match is a suggestion.

type Tab = 'duplicates' | 'no_email';

const KIND_LABEL: Record<string, string> = {
  staff_name: 'Staff name',
  staff_email: 'Shared email',
  ic_vendor_number: 'Vendor number',
  ic_name: 'Company name',
  customer_number: 'Client number',
};

const dateOnly = (s: string | null) => (s ? String(s).slice(0, 10) : '—');

/** One label/value line — the shape every row in the comparison card takes. */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-[12px]">
      <span className="text-cw-muted">{label}</span>
      {children}
    </div>
  );
}

/** A number that means something is bold; a zero stays out of the way. */
function Stat({ label, value }: { label: string; value: number }) {
  return (
    <Field label={label}>
      <span className={value > 0 ? 'font-semibold text-[#1a1a1a]' : 'text-gray-300'}>{value}</span>
    </Field>
  );
}

function SideCard({ side, heavier }: { side: DuplicateSide; heavier: boolean }) {
  return (
    <div className={`rounded border px-3 py-2.5 ${
      heavier ? 'border-[#1a1a1a] bg-white' : 'border-cw-border bg-[#faf9f8]'
    }`}>
      <div className="flex items-start gap-2">
        {side.is_test === 1 && <TestPill className="mr-0 mt-0.5" />}
        <div className="min-w-0">
          <div className="font-semibold text-[#1a1a1a] text-sm break-words">{side.name}</div>
          <div className="text-[11px] text-cw-muted break-all">
            {side.email || <span className="text-[#C0272D]">no email on file</span>}
          </div>
        </div>
        {side.active === 0 && (
          <span className="ml-auto shrink-0 inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium bg-gray-200 text-gray-600">
            Inactive
          </span>
        )}
      </div>
      <div className="mt-2 space-y-0.5">
        <Field label="Role / type"><span className="font-medium text-[#1a1a1a]">{side.role}</span></Field>
        {side.number && (
          <Field label="Number"><span className="font-mono text-[11px] text-[#1a1a1a]">{side.number}</span></Field>
        )}
        <Stat label="Clients linked" value={side.clients_linked} />
        <Stat label="Keys held" value={side.keys_held} />
        <Stat label="Active custody" value={side.active_custody} />
        <Field label="Created"><span className="text-[11px] text-gray-500">{dateOnly(side.created_at)}</span></Field>
      </div>
    </div>
  );
}

/** How much real history hangs off a record — decides which card reads louder. */
const weight = (s: DuplicateSide) => s.clients_linked + s.keys_held + s.active_custody;

function PairRow({ pair }: { pair: DuplicatePair }) {
  const wa = weight(pair.a);
  const wb = weight(pair.b);
  return (
    <div className="border border-cw-border rounded bg-white overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2 bg-[#f4f4f2] border-b border-cw-border">
        <span className="text-[10px] font-bold uppercase tracking-wider text-[#1a1a1a]">
          {KIND_LABEL[pair.kind] ?? pair.kind}
        </span>
        <span className={`inline-flex items-center rounded-full px-2 py-[1px] text-[10px] font-semibold ${
          pair.confidence === 'exact'
            ? 'bg-[#fbeaea] text-[#C0272D] border border-[#f0c9cb]'
            : 'bg-[#fff8e6] text-[#7a5a00] border border-[#e8cf8a]'
        }`}>
          {pair.confidence === 'exact' ? 'exact match' : 'near match'}
        </span>
        <span className="text-[11px] text-cw-muted">{pair.reason}</span>
      </div>
      <div className="grid gap-3 p-3 sm:grid-cols-2">
        <SideCard side={pair.a} heavier={wa >= wb} />
        <SideCard side={pair.b} heavier={wb > wa} />
      </div>
      {/* The one thing worth saying about a pair, said once. */}
      {(wa === 0) !== (wb === 0) && (
        <div className="px-3 pb-3 -mt-1 text-[11px] text-cw-muted">
          {wa === 0 ? pair.a.name : pair.b.name} has no clients, keys or custody attached;{' '}
          {wa === 0 ? pair.b.name : pair.a.name} does.
        </div>
      )}
    </div>
  );
}

export default function DataQuality({ embedded = false }: { embedded?: boolean }) {
  const [tab, setTab] = useState<Tab>('duplicates');
  const [population, setPopulation] = useState<'' | 'staff' | 'ic' | 'customer'>('');
  const [pairs, setPairs] = useState<DuplicatePair[]>([]);
  const [missing, setMissing] = useState<NoEmailRecord[]>([]);
  const [ofTotal, setOfTotal] = useState(0);
  const [summary, setSummary] = useState<DataQualitySummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const [d, m] = await Promise.all([
        getDuplicates(population || undefined),
        getMissingEmail(),
      ]);
      setPairs(d.pairs); setSummary(d.summary);
      setMissing(m.records); setOfTotal(m.of_total);
    } catch (e: any) {
      setError(e?.message || 'Could not load the report');
    } finally {
      setLoading(false);
    }
  }, [population]);

  useEffect(() => { load(); }, [load]);

  const exportIt = async () => {
    setBusy(true);
    try { await downloadDataQualityWorkbook(); }
    catch (e: any) { setError(e?.message || 'Export failed'); }
    finally { setBusy(false); }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {([
          ['duplicates', `Possible duplicates${summary ? ` (${summary.pairs})` : ''}`],
          ['no_email', `No email on file${summary ? ` (${summary.no_email})` : ''}`],
        ] as const).map(([k, label]) => (
          <button
            key={k}
            type="button"
            onClick={() => setTab(k)}
            className={`px-3 py-1.5 rounded-full border text-xs font-medium transition-colors ${
              tab === k
                ? 'bg-[#1a1a1a] border-[#1a1a1a] text-white'
                : 'bg-white border-cw-border text-[#1a1a1a] hover:border-[#1a1a1a]'
            }`}
          >
            {label}
          </button>
        ))}
        <button
          type="button"
          onClick={exportIt}
          disabled={busy}
          className="ml-auto px-3 py-1.5 border border-[#1a1a1a] text-[#1a1a1a] text-xs font-medium rounded hover:border-[#C0272D] hover:text-[#C0272D] disabled:opacity-50 transition-colors"
        >
          {busy ? 'Building…' : 'Export to Excel'}
        </button>
      </div>

      {/* Said plainly, at the top, every time. */}
      <div className="rounded border border-cw-border bg-[#f4f4f2] px-3 py-2 text-[12px] text-cw-text">
        <span className="font-semibold text-[#1a1a1a]">This view never changes anything.</span>{' '}
        There is no merge, archive or edit here — every record stays exactly as entered. A near match is a
        suggestion, not a finding: two people can legitimately have names one character apart, and one mailbox
        can legitimately be shared. The <strong>Clients</strong>, <strong>Keys</strong> and{' '}
        <strong>Active custody</strong> columns show which side has real history attached.
      </div>

      {error && (
        <p className="text-sm text-[#C0272D] bg-[#fbeaea] border border-[#f0c9cb] rounded px-3 py-2">{error}</p>
      )}

      {tab === 'duplicates' ? (
        <>
          <div className="flex flex-wrap items-center gap-1.5">
            {([
              ['', 'All'],
              ['staff', `Staff${summary ? ` (${summary.by_population.staff})` : ''}`],
              ['ic', `IC vendors${summary ? ` (${summary.by_population.ic})` : ''}`],
              ['customer', `Customers${summary ? ` (${summary.by_population.customer})` : ''}`],
            ] as const).map(([k, label]) => (
              <button
                key={k || 'all'}
                type="button"
                onClick={() => setPopulation(k)}
                className={`px-2.5 py-1 rounded-full border text-[11px] transition-colors ${
                  population === k
                    ? 'bg-[#C0272D] border-[#C0272D] text-white'
                    : 'bg-white border-cw-border text-cw-muted hover:border-[#1a1a1a] hover:text-[#1a1a1a]'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {loading ? (
            <p className="text-sm text-cw-muted">Scanning for candidates…</p>
          ) : pairs.length === 0 ? (
            <p className="text-sm text-cw-muted">
              No candidate pairs{population ? ' in this population' : ''}. Nothing to review.
            </p>
          ) : (
            <div className="space-y-3">
              {pairs.map((p) => <PairRow key={`${p.kind}-${p.a.id}-${p.b.id}`} pair={p} />)}
            </div>
          )}
        </>
      ) : (
        <>
          {loading ? (
            <p className="text-sm text-cw-muted">Loading…</p>
          ) : (
            <>
              <p className="text-[12px] text-cw-muted">
                <span className="font-semibold text-[#1a1a1a]">{missing.length}</span> of {ofTotal} staff and IC
                records have no email on file — a custody event they can never be sent a signature link for.
              </p>
              <div className="card overflow-x-auto">
                <table className="w-full text-sm border-collapse">
                  <thead>
                    <tr className="bg-[#1a1a1a] text-white text-[11px]">
                      <th className="text-left px-4 py-2 font-medium">Name</th>
                      <th className="text-left px-3 py-2 font-medium">Role / Type</th>
                      <th className="text-center px-3 py-2 font-medium">Clients linked</th>
                      <th className="text-center px-3 py-2 font-medium">Keys held</th>
                      <th className="text-center px-3 py-2 font-medium">Active custody</th>
                      <th className="text-center px-3 py-2 font-medium">Active</th>
                      <th className="text-left px-3 py-2 font-medium">Created</th>
                    </tr>
                  </thead>
                  <tbody>
                    {missing.length === 0 ? (
                      <tr><td colSpan={7} className="px-4 py-8 text-center text-cw-muted">Every record has an address.</td></tr>
                    ) : missing.map((r, i) => (
                      <tr
                        key={`${r.population}-${r.id}`}
                        className={`border-b border-gray-100 ${
                          r.is_test === 1 ? 'bg-[#fefaed]' : i % 2 === 0 ? 'bg-white' : 'bg-[#f4f4f2]'
                        }`}
                      >
                        <td className="px-4 py-2.5 font-medium text-[#1a1a1a]">
                          {r.is_test === 1 && <TestPill />}
                          {r.name}
                        </td>
                        <td className="px-3 py-2.5 text-cw-muted">{r.role}</td>
                        <td className="px-3 py-2.5 text-center">{r.clients_linked || <span className="text-gray-300">—</span>}</td>
                        <td className="px-3 py-2.5 text-center">{r.keys_held || <span className="text-gray-300">—</span>}</td>
                        <td className="px-3 py-2.5 text-center">
                          {r.active_custody
                            ? <span className="font-semibold text-[#C0272D]">{r.active_custody}</span>
                            : <span className="text-gray-300">—</span>}
                        </td>
                        <td className="px-3 py-2.5 text-center">
                          {r.active === 1 ? <span className="text-[#2d7a3a] font-bold">✓</span> : <span className="text-gray-400">—</span>}
                        </td>
                        <td className="px-3 py-2.5 text-[11px] text-gray-500">{dateOnly(r.created_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}

      {!embedded && (
        <p className="text-[11px] text-gray-400">
          Export the workbook to work through this offline — it has a note column for what you want done with
          each pair.
        </p>
      )}
    </div>
  );
}
