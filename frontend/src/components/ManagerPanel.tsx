import { useEffect, useState } from 'react';
import ExportMenu from './ExportMenu';
import { getStaffManager, exportEmployee, type StaffManager } from '../lib/api';

// ── Manager detail, IN CONTEXT ───────────────────────────────────────────────
// A slide-over on top of the registry rather than a route away from it: the
// registry stays the hub, and closing the panel puts you back exactly where you
// were — same tab, same filter, same scroll position.

function Metric({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <div className="text-center">
      <div className={`text-2xl font-bold ${accent ? 'text-[#C0272D]' : 'text-[#1a1a1a]'}`}>{value}</div>
      <div className="text-[11px] uppercase tracking-wide text-cw-muted mt-0.5">{label}</div>
    </div>
  );
}

const TYPE_LABEL: Record<string, string> = {
  account_manager: 'Account Manager', ccm: 'Contract Compliance Manager', both: 'AM + CCM',
};

export default function ManagerPanel({
  staffId, onClose, onEdit, onReassign, canReassign,
}: {
  staffId: number;
  onClose: () => void;
  onEdit: (m: StaffManager) => void;
  onReassign: (m: StaffManager) => void;
  canReassign: boolean;
}) {
  const [manager, setManager] = useState<StaffManager | null>(null);
  const [clients, setClients] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    setLoading(true);
    getStaffManager(staffId)
      .then((d) => { setManager(d.manager); setClients(d.clients); })
      .catch((e) => setError(e?.message || 'Could not load this manager'))
      .finally(() => setLoading(false));
  }, [staffId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const shiftText = manager
    ? [manager.shift ? `${manager.shift} shift` : null,
       manager.day_night ? manager.day_night[0].toUpperCase() + manager.day_night.slice(1) : null]
      .filter(Boolean).join(' · ')
    : '';

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <aside className="relative bg-white w-full max-w-3xl h-full shadow-xl flex flex-col">
        <div className="px-6 py-4 border-b border-cw-border flex items-start justify-between gap-4">
          <div className="min-w-0">
            {loading ? (
              <div className="text-cw-muted text-sm">Loading…</div>
            ) : manager ? (
              <>
                <div className="flex items-center gap-2 flex-wrap">
                  <h2 className="text-lg font-bold text-[#1a1a1a]">{manager.name}</h2>
                  <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-[#1a1a1a] text-white whitespace-nowrap">
                    {TYPE_LABEL[manager.manager_type] ?? manager.manager_type}
                  </span>
                  {shiftText && (
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border border-[#C0272D] text-[#C0272D] whitespace-nowrap">
                      {shiftText}
                    </span>
                  )}
                  {manager.active === 0 && (
                    <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium bg-gray-200 text-gray-600">Inactive</span>
                  )}
                </div>
                <div className="text-xs text-cw-muted mt-1 flex items-center gap-3 flex-wrap">
                  {manager.email
                    ? <span>✉ {manager.email}</span>
                    : <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-[#fbeaea] text-[#C0272D] border border-[#C0272D]">
                        No email on file — required for signature forms and notifications
                      </span>}
                  {manager.phone && <span>☎ {manager.phone}</span>}
                </div>
              </>
            ) : (
              <div className="text-sm text-[#C0272D]">{error}</div>
            )}
          </div>
          <button onClick={onClose} className="text-cw-muted hover:text-cw-text text-xl leading-none shrink-0" aria-label="Close">&times;</button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          {manager && (
            <>
              <div className="card p-5">
                <div className="grid grid-cols-3 gap-4">
                  <Metric label="Clients Managed" value={manager.clients_managed} />
                  <Metric label="Keys Personally Held" value={manager.keys_personally_held} accent />
                  <Metric label="Total Managed Inventory" value={manager.total_managed_inventory} />
                </div>
              </div>

              <div className="card overflow-x-auto">
                <div className="px-4 py-3 border-b border-cw-border">
                  <h3 className="font-semibold text-sm text-[#1a1a1a]">
                    Client book <span className="font-normal text-cw-muted">({clients.length})</span>
                  </h3>
                </div>
                <table className="w-full text-sm border-collapse">
                  <thead>
                    <tr className="bg-[#f4f4f2] text-xs uppercase tracking-wide text-cw-muted">
                      <th className="text-left px-4 py-2 font-semibold">Client Name</th>
                      <th className="text-left px-3 py-2 font-semibold whitespace-nowrap">BC #</th>
                      <th className="text-left px-3 py-2 font-semibold">IC</th>
                      <th className="text-left px-3 py-2 font-semibold whitespace-nowrap">Role here</th>
                      <th className="text-left px-3 py-2 font-semibold">Keys held there</th>
                    </tr>
                  </thead>
                  <tbody>
                    {clients.length === 0 ? (
                      <tr><td colSpan={5} className="px-4 py-8 text-center text-cw-muted">No clients under this manager yet</td></tr>
                    ) : clients.map((c, i) => (
                      <tr key={c.id} className={`border-b border-gray-100 ${i % 2 === 0 ? 'bg-white' : 'bg-[#f4f4f2]'}`}>
                        <td className="px-4 py-2.5 font-medium text-[#1a1a1a]">{c.ic_company_name}</td>
                        <td className="px-3 py-2.5 font-mono text-xs text-gray-600 whitespace-nowrap">{c.bc_client_number || '—'}</td>
                        <td className="px-3 py-2.5 text-xs text-gray-700 max-w-[180px] truncate">{c.ic_name || '—'}</td>
                        <td className="px-3 py-2.5 whitespace-nowrap">
                          {/* The API sends `role` as one string — 'AM', 'CCM',
                              or 'AM + CCM' when this person is both here. */}
                          {c.role && c.role !== '—'
                            ? c.role.split(' + ').map((r: string) => (
                                <span key={r} className="inline-flex items-center px-2 py-0.5 mr-1 rounded text-[10px] font-medium bg-[#1a1a1a] text-white">{r}</span>
                              ))
                            : <span className="text-gray-300">—</span>}
                        </td>
                        <td className="px-3 py-2.5">
                          {(c.keys_by_type ?? []).length === 0
                            ? <span className="text-gray-300">—</span>
                            : (
                              <span className="inline-flex flex-wrap gap-1">
                                {c.keys_by_type.map((k: any) => (
                                  <span key={k.type} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[#f0f0ee] border border-cw-border text-[11px] whitespace-nowrap">
                                    {k.label}<span className="font-bold text-[#C0272D]">×{k.qty}</span>
                                  </span>
                                ))}
                              </span>
                            )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>

        {manager && (
          <div className="px-6 py-4 border-t border-cw-border flex flex-wrap gap-2 items-center">
            <button
              onClick={() => onEdit(manager)}
              className="px-4 py-2 bg-[#C0272D] text-white text-sm font-medium rounded hover:bg-[#a82227] transition-colors"
            >
              Edit
            </button>
            {canReassign && (
              <button
                onClick={() => onReassign(manager)}
                className="px-4 py-2 border border-[#1a1a1a] text-[#1a1a1a] text-sm font-medium rounded hover:border-[#C0272D] hover:text-[#C0272D] transition-colors"
              >
                Reassign clients
              </button>
            )}
            <ExportMenu
              options={[
                { label: 'Excel (.xlsx)', onSelect: () => exportEmployee(manager.id, 'xlsx') },
                { label: 'PDF (one-pager)', onSelect: () => exportEmployee(manager.id, 'pdf') },
              ]}
            />
            <button onClick={onClose} className="ml-auto text-sm text-cw-muted hover:text-cw-text">Close</button>
          </div>
        )}
      </aside>
    </div>
  );
}
