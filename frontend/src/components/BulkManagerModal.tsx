// ── Change Account Manager / Change CCM — directly, on a selection ───────────
// Sets the name on every selected client in one transaction. Unlike Reassign
// Manager it does not care who the clients are with now: it is the tool for
// correcting or setting the field, keys or no keys. Two steps — pick, then
// confirm — so a bulk change is never one mis-click away.

import { useEffect, useMemo, useState } from 'react';
import Modal from './Modal';
import { getStaffManagers, bulkSetManager, type StaffManager } from '../lib/api';

const LABEL = { am: 'Account Manager', ccm: 'CCM' } as const;

export default function BulkManagerModal({
  role, clients, onClose, onDone,
}: {
  role: 'am' | 'ccm';
  clients: { id: number; name: string; current: string | null }[];
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [roster, setRoster] = useState<StaffManager[]>([]);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<StaffManager | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { getStaffManagers().then((d) => setRoster(d.managers)).catch(() => setRoster([])); }, []);

  // Only people the roster says can hold this role — the server enforces the same rule.
  const eligible = useMemo(() => roster.filter((m) => m.active && (
    m.manager_type === 'both' || (role === 'am' ? m.manager_type === 'account_manager' : m.manager_type === 'ccm')
  )), [roster, role]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return eligible.filter((m) => !q || m.name.toLowerCase().includes(q) || (m.email ?? '').toLowerCase().includes(q));
  }, [eligible, query]);

  const n = clients.length;
  const already = picked ? clients.filter((c) => (c.current ?? '').trim().toLowerCase() === picked.name.trim().toLowerCase()).length : 0;

  const run = async () => {
    if (!picked) return;
    setBusy(true); setError('');
    try {
      const r = await bulkSetManager(role, picked.id, clients.map((c) => c.id));
      onDone(`${LABEL[role]} set to ${r.to} on ${r.changed} client${r.changed === 1 ? '' : 's'}`
        + (r.unchanged ? ` (${r.unchanged} already had them)` : '') + '.');
      onClose();
    } catch (e: any) {
      setError(e?.message || 'Nothing was changed');
      setConfirming(false);
    } finally { setBusy(false); }
  };

  return (
    <Modal title={`Change ${LABEL[role]}`} onClose={onClose} width="max-w-md">
      {!confirming ? (
        <div className="space-y-3">
          <p className="text-sm text-cw-muted">
            New {LABEL[role]} for {n} selected client{n === 1 ? '' : 's'}.
          </p>
          <input
            autoFocus
            className="input focus:ring-[#C0272D] focus:border-[#C0272D]"
            placeholder="Search the staff roster…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="border border-cw-border rounded max-h-64 overflow-y-auto divide-y divide-gray-100">
            {shown.length === 0 && <div className="px-3 py-3 text-sm text-cw-muted">No one on the roster matches.</div>}
            {shown.map((m) => (
              <label key={m.id} className="flex items-center gap-3 px-3 py-2 text-sm cursor-pointer hover:bg-[#faf9f8]">
                <input type="radio" name="bulk-manager" className="accent-[#C0272D]"
                  checked={picked?.id === m.id} onChange={() => setPicked(m)} />
                <span className="font-medium text-[#1a1a1a]">{m.name}</span>
                <span className="text-xs text-cw-muted">{m.clients_managed} client{m.clients_managed === 1 ? '' : 's'}</span>
              </label>
            ))}
          </div>
          <p className="text-[11px] text-cw-muted">
            Not listed? Add them to the roster first (Key Registry → CW Employees).
          </p>
          {error && <p className="text-sm text-[#C0272D]">{error}</p>}
          <div className="flex justify-end gap-2">
            <button onClick={onClose} className="btn-secondary">Cancel</button>
            <button onClick={() => setConfirming(true)} disabled={!picked} className="btn-primary">Continue</button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-[#1a1a1a]">
            Set the {LABEL[role]} to <strong>{picked!.name}</strong> on <strong>{n} client{n === 1 ? '' : 's'}</strong>?
          </p>
          <ul className="text-xs border border-cw-border rounded divide-y divide-gray-100">
            {clients.slice(0, 5).map((c) => (
              <li key={c.id} className="px-3 py-1.5 flex justify-between gap-3">
                <span className="font-medium text-[#1a1a1a] truncate">{c.name}</span>
                <span className="text-cw-muted whitespace-nowrap">{c.current || '—'} → {picked!.name}</span>
              </li>
            ))}
            {n > 5 && <li className="px-3 py-1.5 text-cw-muted">+ {n - 5} more</li>}
          </ul>
          {already > 0 && (
            <p className="text-[11px] text-cw-muted">{already} already have {picked!.name} and will be left as they are.</p>
          )}
          <p className="text-[11px] text-cw-muted">
            Changes the name only — no handover is flagged and no keys move. Each client is recorded in the Audit Log.
          </p>
          <div className="flex justify-end gap-2">
            <button onClick={() => setConfirming(false)} className="btn-secondary">Back</button>
            <button onClick={run} disabled={busy} className="btn-primary">
              {busy ? 'Updating…' : `Update ${n} client${n === 1 ? '' : 's'}`}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
