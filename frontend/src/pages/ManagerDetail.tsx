import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import Layout from '../components/Layout';
import ManagerModal from '../components/ManagerModal';
import ExportMenu from '../components/ExportMenu';
import { getStaffManager, exportEmployee, type StaffManager } from '../lib/api';

function TypeBadges({ type }: { type: StaffManager['manager_type'] }) {
  const badges = type === 'both'
    ? [{ k: 'AM', label: 'Account Manager' }, { k: 'CCM', label: 'Contract Compliance Manager' }]
    : type === 'account_manager'
      ? [{ k: 'AM', label: 'Account Manager' }]
      : [{ k: 'CCM', label: 'Contract Compliance Manager' }];
  return (
    <span className="inline-flex flex-wrap gap-2">
      {badges.map((b) => (
        <span key={b.k} className="inline-flex items-center px-2.5 py-1 rounded text-xs font-medium bg-[#1a1a1a] text-white" title={b.label}>{b.label}</span>
      ))}
    </span>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="text-center">
      <div className="text-2xl font-bold text-[#1a1a1a]">{value}</div>
      <div className="text-xs text-cw-muted mt-1">{label}</div>
    </div>
  );
}

function RoleBadge({ role }: { role: string }) {
  return (
    <span className="inline-flex gap-1">
      {role.split(' + ').map((r) => (
        <span key={r} className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold border border-[#C0272D] text-[#C0272D]">{r}</span>
      ))}
    </span>
  );
}

export default function ManagerDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [manager, setManager] = useState<StaffManager | null>(null);
  const [clients, setClients] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [showEdit, setShowEdit] = useState(false);

  const load = () => {
    setLoading(true);
    getStaffManager(Number(id))
      .then((d) => { setManager(d.manager); setClients(d.clients); })
      .catch(() => setNotFound(true))
      .finally(() => setLoading(false));
  };
  useEffect(load, [id]);

  if (loading) {
    return <Layout><div className="flex items-center justify-center h-64 text-cw-muted">Loading…</div></Layout>;
  }
  if (notFound || !manager) {
    return (
      <Layout>
        <div className="p-6 max-w-3xl mx-auto space-y-4">
          <Link to="/managers" className="text-sm text-[#C0272D] hover:underline">← Back to Manager Roster</Link>
          <div className="card p-8 text-center text-cw-muted">Manager not found.</div>
        </div>
      </Layout>
    );
  }

  const shiftText = [manager.shift ? `${manager.shift} shift` : null, manager.day_night ? manager.day_night[0].toUpperCase() + manager.day_night.slice(1) : null].filter(Boolean).join(' · ');

  return (
    <Layout>
      <div className="p-6 max-w-full mx-auto space-y-4">
        <Link to="/managers" className="text-sm text-[#C0272D] hover:underline">← Back to Manager Roster</Link>

        {/* Header card */}
        <div className="card p-6">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div className="space-y-2">
              <div className="flex items-center gap-3 flex-wrap">
                <h1 className="text-xl font-bold text-[#1a1a1a]">{manager.name}</h1>
                {manager.active === 0 && (
                  <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium bg-gray-200 text-gray-600">Inactive</span>
                )}
              </div>
              <TypeBadges type={manager.manager_type} />
              <div className="flex items-center gap-3 flex-wrap text-sm text-gray-600">
                {shiftText && (
                  <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium border border-[#C0272D] text-[#C0272D]">{shiftText}</span>
                )}
                {manager.email && <span>✉ {manager.email}</span>}
                {manager.phone && <span>☎ {manager.phone}</span>}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <ExportMenu
                options={[
                  { label: 'Excel (.xlsx)', onSelect: () => exportEmployee(manager.id, 'xlsx') },
                  { label: 'PDF (one-pager)', onSelect: () => exportEmployee(manager.id, 'pdf') },
                ]}
              />
              <button
                onClick={() => setShowEdit(true)}
                className="px-4 py-2 border border-[#1a1a1a] text-[#1a1a1a] text-sm font-medium rounded hover:border-[#C0272D] hover:text-[#C0272D] transition-colors"
              >
                Edit
              </button>
            </div>
          </div>
        </div>

        {/* Metrics */}
        <div className="card p-5">
          <div className="grid grid-cols-3 gap-4">
            <Metric label="Clients Managed" value={manager.clients_managed} />
            <Metric label="Keys Personally Held" value={manager.keys_personally_held} />
            <Metric label="Total Managed Inventory" value={manager.total_managed_inventory} />
          </div>
        </div>

        {/* Client book */}
        <div>
          <h2 className="text-sm font-semibold text-[#1a1a1a] mb-2">Client Book <span className="text-cw-muted font-normal">— every client under this manager</span></h2>
          <div className="card overflow-x-auto max-w-full">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="bg-[#1a1a1a] text-white text-xs">
                  <th className="text-left px-4 py-3 font-medium whitespace-nowrap">Client Name</th>
                  <th className="text-left px-3 py-3 font-medium whitespace-nowrap">BC Client #</th>
                  <th className="text-left px-3 py-3 font-medium whitespace-nowrap">Independent Contractor</th>
                  <th className="text-center px-3 py-3 font-medium whitespace-nowrap">Role</th>
                  <th className="text-center px-3 py-3 font-medium whitespace-nowrap">Keys at This Client</th>
                </tr>
              </thead>
              <tbody>
                {clients.length === 0 ? (
                  <tr><td colSpan={5} className="px-4 py-8 text-center text-cw-muted">No clients under this manager</td></tr>
                ) : clients.map((c, i) => {
                  const rowBg = i % 2 === 0 ? 'bg-white' : 'bg-[#f4f4f2]';
                  const breakdown = [
                    c.am_keys ? `${c.am_keys} AM` : null,
                    c.ccm_keys ? `${c.ccm_keys} CCM` : null,
                    c.contractor_keys ? `${c.contractor_keys} IC` : null,
                    c.office_keys_held ? `${c.office_keys_held} Office` : null,
                  ].filter(Boolean).join(' · ');
                  return (
                    <tr
                      key={c.id}
                      className={`cursor-pointer border-b border-gray-100 hover:bg-[#f0f0ee] transition-colors ${rowBg}`}
                      onClick={() => navigate(`/registry/${c.id}`)}
                      title="Open this client record"
                    >
                      <td className="px-4 py-3 font-medium text-[#1a1a1a] whitespace-nowrap max-w-[240px] truncate">{c.ic_company_name}</td>
                      <td className="px-3 py-3 font-mono text-xs text-gray-600 whitespace-nowrap">{c.bc_client_number || '—'}</td>
                      <td className="px-3 py-3 text-xs text-gray-700 whitespace-nowrap max-w-[200px] truncate">{c.ic_name || '—'}</td>
                      <td className="px-3 py-3 text-center"><RoleBadge role={c.role} /></td>
                      <td className="px-3 py-3 text-center">
                        {breakdown
                          ? <span className="text-xs text-gray-700" title="Keys by holder at this client">{breakdown}</span>
                          : <span className="text-gray-300">—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {showEdit && (
        <ManagerModal
          mode="edit"
          initial={manager}
          onClose={() => setShowEdit(false)}
          onSaved={(m) => { setShowEdit(false); setManager(m); load(); }}
        />
      )}
    </Layout>
  );
}
