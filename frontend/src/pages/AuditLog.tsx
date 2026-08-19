import { useEffect, useState, useCallback } from 'react';
import Layout from '../components/Layout';
import Badge from '../components/Badge';
import TestPill from '../components/TestPill';
import { getAudit, downloadExcel, undoReassignment } from '../lib/api';
import { getManager } from '../lib/auth';

const ACTION_LABELS: Record<string, { label: string; variant: 'red' | 'green' | 'gray' | 'yellow' | 'blue' }> = {
  key_checked_out: { label: 'Check Out', variant: 'yellow' },
  key_checked_in: { label: 'Check In', variant: 'green' },
  vault_revealed: { label: 'Vault Reveal', variant: 'red' },
  account_created: { label: 'Account Created', variant: 'blue' },
  account_updated: { label: 'Account Updated', variant: 'gray' },
  excel_exported: { label: 'Excel Export', variant: 'gray' },
  email_sent: { label: 'Email Sent', variant: 'blue' },
  teams_alert_sent: { label: 'Teams Alert', variant: 'blue' },
  contractor_invited: { label: 'Contractor Invite', variant: 'yellow' },
  contractor_signed: { label: 'Contractor Signed', variant: 'green' },
  ai_query: { label: 'AI Query', variant: 'gray' },
  system_seed: { label: 'System Init', variant: 'gray' },
  bulk_manager_reassignment: { label: 'Bulk Reassignment', variant: 'red' },
  manager_reassigned: { label: 'Manager Reassigned', variant: 'yellow' },
  reassignment_undone: { label: 'Reassignment Undone', variant: 'blue' },
  handover_confirmed: { label: 'Handover Confirmed', variant: 'green' },
  vault_updated: { label: 'Vault Updated', variant: 'yellow' },
};

// ── Undo a bulk reassignment ────────────────────────────────────────────────
// Available to admins / can_delete holders for 30 days, straight off the audit
// entry that recorded the change — the before/after it carries IS the undo data.
function UndoReassignment({
  log, meta, canUndo, onDone,
}: {
  log: any; meta: any; canUndo: boolean; onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  if (meta.undone_by) {
    return (
      <div className="mt-1 text-[11px] text-cw-muted">
        Undone by {meta.undone_by}
      </div>
    );
  }
  if (!canUndo) return null;

  const ageDays = (Date.now() - new Date(String(log.created_at).replace(' ', 'T') + 'Z').getTime()) / 86_400_000;
  if (Number.isFinite(ageDays) && ageDays > 30) {
    return <div className="mt-1 text-[11px] text-gray-400">Undo window expired (30 days)</div>;
  }

  return (
    <div className="mt-1">
      {msg ? (
        <span className="text-[11px] text-[#1a1a1a]">{msg}</span>
      ) : (
        <button
          disabled={busy}
          onClick={async () => {
            if (!window.confirm(
              `Undo this reassignment? ${meta.total_clients} client(s) will be restored to ${meta.from}.`
            )) return;
            setBusy(true);
            try {
              const r = await undoReassignment(log.id);
              setMsg(r.message);
              onDone();
            } catch (e: any) {
              setMsg(e?.message || 'Undo failed');
            } finally { setBusy(false); }
          }}
          className="text-[11px] border border-[#C0272D] text-[#C0272D] rounded px-2 py-0.5 hover:bg-[#C0272D] hover:text-white transition-colors disabled:opacity-50"
        >
          {busy ? 'Undoing…' : '↺ Undo reassignment'}
        </button>
      )}
    </div>
  );
}

export default function AuditLog() {
  const canUndo = !!getManager()?.can_delete || getManager()?.role === 'admin';
  const [logs, setLogs] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [action, setAction] = useState('');
  const [manager, setManager] = useState('');
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const LIMIT = 100;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getAudit({ page: String(page), limit: String(LIMIT), ...(action ? { action } : {}), ...(manager ? { manager } : {}) });
      setLogs(data.logs);
      setTotal(data.total);
    } finally {
      setLoading(false);
    }
  }, [page, action, manager]);

  useEffect(() => { load(); }, [load]);

  const handleExport = async () => {
    setExporting(true);
    try { await downloadExcel(); } finally { setExporting(false); }
  };

  return (
    <Layout>
      <div className="p-6 max-w-6xl mx-auto space-y-5">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold">Audit Log</h1>
            <p className="text-sm text-cw-muted">{total} total entries · Immutable record</p>
          </div>
          <button onClick={handleExport} disabled={exporting} className="btn-secondary">
            {exporting ? 'Exporting…' : '↓ Export Excel'}
          </button>
        </div>

        <div className="flex gap-3 flex-wrap">
          <select className="input max-w-[180px]" value={action} onChange={(e) => { setAction(e.target.value); setPage(1); }}>
            <option value="">All actions</option>
            {Object.entries(ACTION_LABELS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
          <input
            className="input max-w-[200px]"
            placeholder="Filter by manager…"
            value={manager}
            onChange={(e) => { setManager(e.target.value); setPage(1); }}
          />
        </div>

        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-cw-black text-white text-xs">
                <th className="text-left px-4 py-3 font-medium">Timestamp</th>
                <th className="text-left px-4 py-3 font-medium">Action</th>
                <th className="text-left px-4 py-3 font-medium">Account</th>
                <th className="text-left px-4 py-3 font-medium">Manager</th>
                <th className="text-left px-4 py-3 font-medium">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-cw-border">
              {loading ? (
                <tr><td colSpan={5} className="px-4 py-8 text-center text-cw-muted">Loading…</td></tr>
              ) : logs.map((log) => {
                const meta = log.metadata ? JSON.parse(log.metadata) : {};
                const actionInfo = ACTION_LABELS[log.action] || { label: log.action, variant: 'gray' as const };
                return (
                  <tr key={log.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 text-cw-muted whitespace-nowrap text-xs">
                      {new Date(log.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={actionInfo.variant}>{actionInfo.label}</Badge>
                    </td>
                    <td className="px-4 py-3 max-w-[200px] truncate text-cw-muted">
                      {log.account_name || '—'}
                    </td>
                    <td className="px-4 py-3 font-medium">
                      <span className="inline-flex items-center gap-1.5">
                        {log.manager}
                        {meta.test_action && <TestPill />}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-cw-muted">
                      {Object.entries(meta)
                        .filter(([k]) => k !== 'test_action' && k !== 'clients' && k !== 'client_ids')
                        .map(([k, v]) => (
                          <span key={k} className="mr-2">
                            <span className="font-medium">{k}:</span>{' '}
                            {typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v)}
                          </span>
                        ))}
                      {log.action === 'bulk_manager_reassignment' && (
                        <UndoReassignment log={log} meta={meta} canUndo={canUndo} onDone={load} />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!loading && logs.length === 0 && (
            <div className="px-4 py-8 text-center text-cw-muted">No log entries found</div>
          )}
        </div>

        {total > LIMIT && (
          <div className="flex items-center gap-3 justify-center">
            <button className="btn-secondary" disabled={page === 1} onClick={() => setPage(p => p - 1)}>← Prev</button>
            <span className="text-sm text-cw-muted">Page {page} of {Math.ceil(total / LIMIT)}</span>
            <button className="btn-secondary" disabled={page * LIMIT >= total} onClick={() => setPage(p => p + 1)}>Next →</button>
          </div>
        )}
      </div>
    </Layout>
  );
}
