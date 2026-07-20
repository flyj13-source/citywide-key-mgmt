import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Layout from '../components/Layout';
import ManagerModal from '../components/ManagerModal';
import { getStaffManagers, type StaffManager } from '../lib/api';

function TypeBadges({ type }: { type: StaffManager['manager_type'] }) {
  const badges = type === 'both' ? ['AM', 'CCM'] : type === 'account_manager' ? ['AM'] : ['CCM'];
  return (
    <span className="inline-flex gap-1">
      {badges.map((b) => (
        <span key={b} className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-[#1a1a1a] text-white">{b}</span>
      ))}
    </span>
  );
}

function ShiftPill({ shift, dayNight }: { shift: string | null; dayNight: string | null }) {
  if (!shift && !dayNight) return <span className="text-gray-300">—</span>;
  const parts = [shift ? `${shift} shift` : null, dayNight ? dayNight[0].toUpperCase() + dayNight.slice(1) : null].filter(Boolean);
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border border-[#C0272D] text-[#C0272D]">
      {parts.join(' · ')}
    </span>
  );
}

function Num({ value, bold }: { value: number; bold?: boolean }) {
  if (!value) return <span className="text-gray-300">—</span>;
  return <span className={bold ? 'font-bold text-[#1a1a1a]' : 'text-gray-700'}>{value}</span>;
}

const TYPE_FILTERS: { key: string; label: string; match: (t: string) => boolean }[] = [
  { key: 'all', label: 'All', match: () => true },
  { key: 'am', label: 'Account Managers', match: (t) => t === 'account_manager' || t === 'both' },
  { key: 'ccm', label: 'CCMs', match: (t) => t === 'ccm' || t === 'both' },
];

export default function ManagerRoster() {
  const navigate = useNavigate();
  const [managers, setManagers] = useState<StaffManager[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [showInactive, setShowInactive] = useState(false);

  const load = () => {
    setLoading(true);
    getStaffManagers(true)
      .then((d) => setManagers(d.managers))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const filtered = useMemo(() => {
    const tf = TYPE_FILTERS.find((f) => f.key === typeFilter)!;
    const q = search.trim().toLowerCase();
    return managers.filter((m) =>
      (showInactive || m.active === 1) &&
      tf.match(m.manager_type) &&
      (!q || m.name.toLowerCase().includes(q) || (m.email || '').toLowerCase().includes(q))
    );
  }, [managers, typeFilter, search, showInactive]);

  return (
    <Layout>
      <div className="p-6 max-w-full mx-auto space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-[#1a1a1a]">Manager Roster</h1>
            <p className="text-sm text-cw-muted">{filtered.length} manager{filtered.length !== 1 ? 's' : ''}</p>
          </div>
          <button
            onClick={() => setShowAdd(true)}
            className="px-4 py-2 bg-[#C0272D] text-white text-sm font-medium rounded hover:bg-[#a82227] transition-colors"
          >
            + Add Manager
          </button>
        </div>

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex border-b border-cw-border gap-6">
            {TYPE_FILTERS.map((t) => (
              <button
                key={t.key}
                onClick={() => setTypeFilter(t.key)}
                className={`pb-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
                  typeFilter === t.key ? 'border-[#C0272D] text-[#C0272D]' : 'border-transparent text-[#6b6b68] hover:text-[#1a1a1a]'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="flex-1" />
          <label className="flex items-center gap-1.5 text-xs text-gray-600 cursor-pointer">
            <input type="checkbox" className="accent-[#C0272D]" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
            Show inactive
          </label>
          <input
            className="input max-w-xs focus:ring-[#C0272D] focus:border-[#C0272D]"
            placeholder="Search by name or email…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        {/* Table */}
        <div className="card overflow-x-auto max-w-full">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="bg-[#1a1a1a] text-white text-xs">
                <th className="text-left px-4 py-3 font-medium whitespace-nowrap">Name</th>
                <th className="text-left px-3 py-3 font-medium whitespace-nowrap">Type</th>
                <th className="text-left px-3 py-3 font-medium whitespace-nowrap">Shift</th>
                <th className="text-center px-3 py-3 font-medium whitespace-nowrap">Day/Night</th>
                <th className="text-center px-3 py-3 font-medium whitespace-nowrap">Clients Managed</th>
                <th className="text-center px-3 py-3 font-medium whitespace-nowrap">Keys Personally Held</th>
                <th className="text-center px-3 py-3 font-medium whitespace-nowrap">Total Managed Inventory</th>
                <th className="text-center px-3 py-3 font-medium whitespace-nowrap">Active</th>
                <th className="px-3 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={9} className="px-4 py-8 text-center text-cw-muted">Loading…</td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={9} className="px-4 py-8 text-center text-cw-muted">No managers found</td></tr>
              ) : filtered.map((m, i) => {
                const rowBg = i % 2 === 0 ? 'bg-white' : 'bg-[#f4f4f2]';
                return (
                  <tr
                    key={m.id}
                    className={`cursor-pointer border-b border-gray-100 hover:bg-[#f0f0ee] transition-colors ${rowBg} ${m.active === 0 ? 'opacity-60' : ''}`}
                    onClick={() => navigate(`/managers/${m.id}`)}
                    title="View this manager's client book"
                  >
                    <td className="px-4 py-3 font-medium text-[#1a1a1a] whitespace-nowrap">{m.name}</td>
                    <td className="px-3 py-3"><TypeBadges type={m.manager_type} /></td>
                    <td className="px-3 py-3"><ShiftPill shift={m.shift} dayNight={m.day_night} /></td>
                    <td className="px-3 py-3 text-center text-xs text-gray-600">{m.day_night ? m.day_night[0].toUpperCase() + m.day_night.slice(1) : '—'}</td>
                    <td className="px-3 py-3 text-center"><Num value={m.clients_managed} bold /></td>
                    <td className="px-3 py-3 text-center"><Num value={m.keys_personally_held} /></td>
                    <td className="px-3 py-3 text-center"><Num value={m.total_managed_inventory} /></td>
                    <td className="px-3 py-3 text-center">
                      {m.active === 1
                        ? <span className="text-[#2d7a3a] font-bold">✓</span>
                        : <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium bg-gray-200 text-gray-600">Inactive</span>}
                    </td>
                    <td className="px-3 py-3 text-right" onClick={(e) => e.stopPropagation()}>
                      <button onClick={() => navigate(`/managers/${m.id}`)} className="text-xs text-[#C0272D] hover:underline whitespace-nowrap">View</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {showAdd && (
        <ManagerModal
          mode="add"
          onClose={() => setShowAdd(false)}
          onSaved={() => { setShowAdd(false); load(); }}
        />
      )}
    </Layout>
  );
}
