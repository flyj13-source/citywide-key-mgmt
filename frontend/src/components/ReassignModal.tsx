import { useEffect, useMemo, useState } from 'react';
import Modal from './Modal';
import {
  getReassignable, reassignManager, getStaff,
  type ReassignablePayload, type ReassignClient, type MailOutcome,
} from '../lib/api';

// ── Bulk manager reassignment ────────────────────────────────────────────────
// One modal serving both entry points: the manager detail page (which knows the
// staff id) and the AM/CCM roster rows (which only know a name — resolved here).

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] font-bold uppercase tracking-widest text-[#1a1a1a] border-b border-gray-200 pb-1 mb-3">
      {children}
    </div>
  );
}

function KeyPills({ keys }: { keys: ReassignClient['keys'] }) {
  if (!keys.length) return <span className="text-gray-300 text-xs">—</span>;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {keys.map((k) => (
        <span
          key={k.type}
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[#f0f0ee] border border-cw-border text-[11px] text-[#1a1a1a] whitespace-nowrap"
        >
          {k.label}<span className="font-bold text-[#C0272D]">×{k.qty}</span>
        </span>
      ))}
    </span>
  );
}

export default function ReassignModal({
  staffId, sourceName, role, onClose, onDone,
}: {
  /** Known on the manager detail page; resolved from sourceName otherwise. */
  staffId?: number | null;
  sourceName?: string;
  role: 'am' | 'ccm';
  onClose: () => void;
  onDone: () => void;
}) {
  const [resolvedId, setResolvedId] = useState<number | null>(staffId ?? null);
  const [data, setData] = useState<ReassignablePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [toId, setToId] = useState<string>('');
  const [checked, setChecked] = useState<Record<number, boolean>>({});
  const [sendHandover, setSendHandover] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<{
    to: string; clients: number; keys: number; email: MailOutcome | null; pending: boolean;
  } | null>(null);

  // Roster rows carry a NAME only — map it to the staff_managers id.
  useEffect(() => {
    if (resolvedId != null || !sourceName) return;
    getStaff({ includeInactive: true })
      .then((list) => {
        const hit = list.find((s) => s.name === sourceName);
        if (hit) setResolvedId(hit.id);
        else {
          setLoadError(`"${sourceName}" is named on client rows but is not on the staff roster, so there is no record to transfer from. Add them to the roster first (Key Registry → CW Employees).`);
          setLoading(false);
        }
      })
      .catch(() => { setLoadError('Could not load the staff roster.'); setLoading(false); });
  }, [resolvedId, sourceName]);

  useEffect(() => {
    if (resolvedId == null) return;
    setLoading(true);
    getReassignable(resolvedId, role)
      .then((d) => {
        setData(d);
        // ALL checked by default — the common case is a full handover.
        setChecked(Object.fromEntries(d.clients.map((c) => [c.id, true])));
      })
      .catch((e) => setLoadError(e?.message || 'Could not load this manager’s clients'))
      .finally(() => setLoading(false));
  }, [resolvedId, role]);

  const selected = useMemo(
    () => (data?.clients ?? []).filter((c) => checked[c.id]),
    [data, checked],
  );
  const summary = useMemo(() => ({
    clients: selected.length,
    keys: selected.reduce((n, c) => n + c.total_keys, 0),
    types: new Set(selected.flatMap((c) => c.keys.map((k) => k.label))).size,
  }), [selected]);

  const target = data?.targets.find((t) => String(t.id) === toId) ?? null;
  const canSubmit = !!data && !!target && selected.length > 0 && !saving;

  const submit = async () => {
    if (!canSubmit || !data || !target) return;
    setSaving(true); setError('');
    try {
      const r = await reassignManager({
        fromId: data.source.id,
        toId: target.id,
        clientIds: selected.map((c) => c.id),
        role: data.role,
        sendHandover,
      });
      setDone({
        to: r.to, clients: r.totalClients, keys: r.totalKeys,
        email: r.email, pending: r.pending_handover,
      });
      onDone();
    } catch (e: any) {
      setError(e?.message || 'Transfer failed');
    } finally {
      setSaving(false);
    }
  };

  if (done) {
    return (
      <Modal title="Clients reassigned" onClose={onClose} width="max-w-lg">
        <div className="space-y-4">
          <p className="text-sm text-cw-text">
            <span className="font-semibold">{done.clients}</span> client{done.clients === 1 ? '' : 's'} and{' '}
            <span className="font-semibold">{done.keys}</span> key{done.keys === 1 ? '' : 's'} of responsibility
            moved to <span className="font-semibold">{done.to}</span>.
          </p>
          {done.pending && (
            <div className="text-sm bg-[#fff8e6] border border-[#e8cf8a] text-[#7a5a00] rounded px-3 py-2">
              These clients now show <strong>Handover pending</strong> in the registry until the physical keys
              change hands and someone confirms it.
            </div>
          )}
          {done.email && (
            done.email.ok ? (
              <div className="text-sm bg-green-50 border border-green-200 text-green-800 rounded px-3 py-2">
                ✓ Handover notice sent to {done.email.recipients.join(', ')}
              </div>
            ) : (
              <div className="text-sm bg-[#fff8e6] border border-[#e8cf8a] text-[#7a5a00] rounded px-3 py-2">
                ⚠ The transfer saved, but the handover email did not send
                {done.email.error ? `: ${done.email.error}` : '.'} It is logged in the Audit Log.
              </div>
            )
          )}
          <p className="text-xs text-cw-muted">
            Undo is available from the Audit Log for 30 days.
          </p>
        </div>
        <div className="flex gap-2 pt-4 border-t border-gray-200 mt-4">
          <button onClick={onClose} className="px-4 py-2 bg-[#C0272D] text-white text-sm font-medium rounded hover:bg-[#a82227] transition-colors">Done</button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Reassign clients" onClose={onClose} width="max-w-2xl">
      {loading ? (
        <p className="text-sm text-cw-muted">Loading…</p>
      ) : loadError ? (
        <p className="text-sm text-[#C0272D] bg-[#fbeaea] border border-[#f0c9cb] rounded px-3 py-2">{loadError}</p>
      ) : !data ? null : (
        <div className="space-y-5 max-h-[70vh] overflow-y-auto pr-1">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <SectionLabel>From</SectionLabel>
              <div className="input bg-gray-50 flex items-center text-[#1a1a1a] font-medium">
                {data.source.name}
              </div>
              <p className="text-[11px] text-gray-400 mt-1">{data.role_label}</p>
            </div>
            <div>
              <SectionLabel>To</SectionLabel>
              <select
                className="input focus:ring-[#C0272D] focus:border-[#C0272D]"
                value={toId}
                onChange={(e) => setToId(e.target.value)}
              >
                <option value="">— Select {data.role === 'am' ? 'an' : 'a'} {data.role_label} —</option>
                {data.targets.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} ({t.clients_managed} client{t.clients_managed === 1 ? '' : 's'})
                  </option>
                ))}
              </select>
              <p className="text-[11px] text-gray-400 mt-1">
                {data.targets.length} compatible {data.role_label.toLowerCase()}
                {data.targets.length === 1 ? '' : 's'} · cross-type transfers are blocked
              </p>
            </div>
          </div>

          {target && (
            <div className="rounded border border-cw-border bg-[#f4f4f2] px-4 py-3 text-sm text-[#1a1a1a]">
              Transferring <span className="font-bold">{summary.clients}</span> client{summary.clients === 1 ? '' : 's'}
              {' · '}<span className="font-bold">{summary.keys}</span> key{summary.keys === 1 ? '' : 's'} held
              {' · '}<span className="font-bold">{summary.types}</span> key type{summary.types === 1 ? '' : 's'} affected
              <div className="text-xs text-cw-muted mt-0.5">
                {data.source.name} → {target.name}
              </div>
            </div>
          )}

          <div className="rounded border border-[#e8cf8a] bg-[#fff8e6] px-4 py-3 text-sm text-[#7a5a00]">
            Reassigning updates registry responsibility. It does <strong>not</strong> move physical keys.
            Each client gets an audit entry.
          </div>

          <div>
            <SectionLabel>
              Clients{' '}
              <span className="normal-case font-normal text-gray-400 tracking-normal">
                — all selected by default; uncheck to exclude
              </span>
            </SectionLabel>
            {data.clients.length === 0 ? (
              <p className="text-sm text-cw-muted">
                {data.source.name} has no clients as {data.role_label} — nothing to transfer.
              </p>
            ) : (
              <>
                <div className="flex items-center gap-3 mb-2">
                  <button
                    type="button"
                    onClick={() => setChecked(Object.fromEntries(data.clients.map((c) => [c.id, true])))}
                    className="text-xs text-[#C0272D] hover:underline"
                  >Select all</button>
                  <button
                    type="button"
                    onClick={() => setChecked({})}
                    className="text-xs text-[#C0272D] hover:underline"
                  >Clear all</button>
                </div>
                <div className="border border-cw-border rounded overflow-hidden">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-[#1a1a1a] text-white text-xs">
                        <th className="w-10 px-2 py-2"></th>
                        <th className="text-left px-3 py-2 font-medium">Client Name</th>
                        <th className="text-left px-3 py-2 font-medium whitespace-nowrap">BC Client #</th>
                        <th className="text-left px-3 py-2 font-medium">Keys held here</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.clients.map((c, i) => (
                        <tr key={c.id} className={`border-b border-gray-100 ${i % 2 === 0 ? 'bg-white' : 'bg-[#f4f4f2]'}`}>
                          <td className="px-2 py-2 text-center">
                            <input
                              type="checkbox"
                              className="h-4 w-4 accent-[#C0272D] cursor-pointer"
                              checked={!!checked[c.id]}
                              onChange={(e) => setChecked((p) => ({ ...p, [c.id]: e.target.checked }))}
                              aria-label={`Include ${c.name}`}
                            />
                          </td>
                          <td className="px-3 py-2 font-medium text-[#1a1a1a]">{c.name}</td>
                          <td className="px-3 py-2 font-mono text-xs text-gray-600 whitespace-nowrap">
                            {c.bc_client_number || '—'}
                          </td>
                          <td className="px-3 py-2"><KeyPills keys={c.keys} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>

          <label className="flex items-start gap-2 text-sm text-gray-700 cursor-pointer">
            <input
              type="checkbox"
              className="h-4 w-4 mt-0.5 accent-[#C0272D]"
              checked={sendHandover}
              onChange={(e) => setSendHandover(e.target.checked)}
            />
            <span>
              Send a key handover notice
              <span className="text-gray-400"> — emails both managers and Cara, and flags these clients
              “Handover pending” in the registry until the metal changes hands</span>
            </span>
          </label>

          {error && (
            <p className="text-sm text-[#C0272D] bg-[#fbeaea] border border-[#f0c9cb] rounded px-3 py-2">{error}</p>
          )}
        </div>
      )}

      <div className="flex gap-2 pt-4 border-t border-gray-200 mt-4">
        <button
          onClick={submit}
          disabled={!canSubmit}
          className="px-4 py-2 bg-[#C0272D] text-white text-sm font-medium rounded hover:bg-[#a82227] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {saving ? 'Transferring…' : `Transfer ${summary.clients} client${summary.clients === 1 ? '' : 's'}`}
        </button>
        <button onClick={onClose} className="px-4 py-2 border border-[#1a1a1a] text-[#1a1a1a] text-sm font-medium rounded hover:bg-gray-50 transition-colors">Cancel</button>
      </div>
    </Modal>
  );
}
