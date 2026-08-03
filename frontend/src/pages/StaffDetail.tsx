import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import Layout from '../components/Layout';
import Modal from '../components/Modal';
import ExportMenu from '../components/ExportMenu';
import { getStaffMember, updateStaffMember, exportEmployee, type StaffDetail as StaffDetailType } from '../lib/api';

function RoleBadges({ role_category, manager_type }: { role_category: string; manager_type: string | null }) {
  const badges: { k: string; crew?: boolean }[] = [];
  if (role_category === 'manager' || role_category === 'both') {
    if (manager_type === 'both') badges.push({ k: 'Account Manager' }, { k: 'Contract Compliance Manager' });
    else if (manager_type === 'account_manager') badges.push({ k: 'Account Manager' });
    else if (manager_type === 'ccm') badges.push({ k: 'Contract Compliance Manager' });
    else badges.push({ k: 'Manager' });
  }
  if (role_category === 'crew' || role_category === 'both') badges.push({ k: 'Field Crew', crew: true });
  return (
    <span className="inline-flex flex-wrap gap-2">
      {badges.map((b) => (
        <span key={b.k} className={`inline-flex items-center px-2.5 py-1 rounded text-xs font-medium ${b.crew ? 'border border-[#C0272D] text-[#C0272D]' : 'bg-[#1a1a1a] text-white'}`}>{b.k}</span>
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

const SHIFT_OPTIONS = ['1st', '2nd', '3rd'];
const DAY_NIGHT_OPTIONS = ['day', 'night'];
const TYPE_OPTIONS = [
  { value: 'account_manager', label: 'Account Manager' },
  { value: 'ccm', label: 'Contract Compliance Manager' },
  { value: 'both', label: 'Both' },
];

function EditModal({ staff, onClose, onSaved }: { staff: StaffDetailType; onClose: () => void; onSaved: (s: StaffDetailType) => void }) {
  const isManager = staff.role_category === 'manager' || staff.role_category === 'both';
  const [form, setForm] = useState({
    name: staff.name,
    manager_type: staff.manager_type ?? '',
    shift: staff.shift ?? '',
    day_night: staff.day_night ?? '',
    email: staff.email ?? '',
    phone: staff.phone ?? '',
    active: staff.active === 1,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const f = (k: string, v: any) => setForm((prev) => ({ ...prev, [k]: v }));

  const save = async () => {
    if (!form.name.trim()) return;
    setSaving(true); setError('');
    try {
      const payload: any = {
        name: form.name.trim(),
        shift: form.shift || null,
        day_night: form.day_night || null,
        email: form.email.trim() || null,
        phone: form.phone.trim() || null,
        active: form.active ? 1 : 0,
      };
      if (isManager && form.manager_type) payload.manager_type = form.manager_type;
      const res = await updateStaffMember(staff.id, payload);
      onSaved(res.staff);
    } catch (err: any) {
      setError(err?.message || 'Could not save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={`Edit: ${staff.name}`} onClose={onClose} width="max-w-md">
      <div className="space-y-4">
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Name *</label>
          <input className="input focus:ring-[#C0272D] focus:border-[#C0272D]" value={form.name} onChange={(e) => f('name', e.target.value)} autoFocus />
        </div>
        {isManager && (
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Manager Type</label>
            <div className="flex flex-col gap-1.5">
              {TYPE_OPTIONS.map((opt) => (
                <label key={opt.value} className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                  <input type="radio" name="manager_type" className="accent-[#C0272D]" checked={form.manager_type === opt.value} onChange={() => f('manager_type', opt.value)} />
                  {opt.label}
                </label>
              ))}
            </div>
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Shift</label>
            <select className="input focus:ring-[#C0272D] focus:border-[#C0272D]" value={form.shift} onChange={(e) => f('shift', e.target.value)}>
              <option value="">—</option>
              {SHIFT_OPTIONS.map((s) => <option key={s} value={s}>{s} shift</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Day or Night</label>
            <select className="input focus:ring-[#C0272D] focus:border-[#C0272D]" value={form.day_night} onChange={(e) => f('day_night', e.target.value)}>
              <option value="">—</option>
              {DAY_NIGHT_OPTIONS.map((d) => <option key={d} value={d}>{d[0].toUpperCase() + d.slice(1)}</option>)}
            </select>
          </div>
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Email</label>
          <input className="input focus:ring-[#C0272D] focus:border-[#C0272D]" value={form.email} onChange={(e) => f('email', e.target.value)} placeholder="name@citywideboston.com" />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">Phone</label>
          <input className="input focus:ring-[#C0272D] focus:border-[#C0272D]" value={form.phone} onChange={(e) => f('phone', e.target.value)} placeholder="(617) 555-0100" />
        </div>
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-gray-700">Active</span>
          <button
            type="button"
            onClick={() => f('active', !form.active)}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${form.active ? 'bg-[#C0272D]' : 'bg-gray-300'}`}
          >
            <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${form.active ? 'translate-x-6' : 'translate-x-1'}`} />
          </button>
        </div>
        {error && <p className="text-sm text-[#C0272D] bg-[#fbeaea] border border-[#f0c9cb] rounded px-3 py-2">{error}</p>}
      </div>
      <div className="flex gap-2 pt-4 border-t border-gray-200 mt-4">
        <button onClick={save} disabled={saving || !form.name.trim()} className="px-4 py-2 bg-[#C0272D] text-white text-sm font-medium rounded hover:bg-[#a82227] disabled:opacity-50 transition-colors">
          {saving ? 'Saving…' : 'Save Changes'}
        </button>
        <button onClick={onClose} className="px-4 py-2 border border-[#1a1a1a] text-[#1a1a1a] text-sm font-medium rounded hover:bg-gray-50 transition-colors">Cancel</button>
      </div>
    </Modal>
  );
}

function keysText(h: any): string {
  const parts = [
    h.metal ? `${h.metal} metal` : null,
    h.card ? `${h.card} card` : null,
    h.fob ? `${h.fob} fob` : null,
    h.dispenser ? `${h.dispenser} dispenser` : null,
    h.other ? `${h.other} other` : null,
  ].filter(Boolean);
  return parts.join(' · ') || '—';
}

export default function StaffDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [staff, setStaff] = useState<StaffDetailType | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [showEdit, setShowEdit] = useState(false);

  const load = () => {
    setLoading(true);
    getStaffMember(Number(id))
      .then((d) => setStaff(d.staff))
      .catch(() => setNotFound(true))
      .finally(() => setLoading(false));
  };
  useEffect(load, [id]);

  if (loading) {
    return <Layout><div className="flex items-center justify-center h-64 text-cw-muted">Loading…</div></Layout>;
  }
  if (notFound || !staff) {
    return (
      <Layout>
        <div className="p-6 max-w-3xl mx-auto space-y-4">
          <Link to="/registry?tab=cwemployees" className="text-sm text-[#C0272D] hover:underline">← Back to CW Employees</Link>
          <div className="card p-8 text-center text-cw-muted">Employee not found.</div>
        </div>
      </Layout>
    );
  }

  const shiftText = [staff.shift ? `${staff.shift} shift` : null, staff.day_night ? staff.day_night[0].toUpperCase() + staff.day_night.slice(1) : null].filter(Boolean).join(' · ');
  const managerHoldings = staff.holdings.filter((h: any) => h.source === 'manager');
  const crewHoldings = staff.holdings.filter((h: any) => h.source === 'crew');

  return (
    <Layout>
      <div className="p-6 max-w-full mx-auto space-y-4">
        <Link to="/registry?tab=cwemployees" className="text-sm text-[#C0272D] hover:underline">← Back to CW Employees</Link>

        {/* Header card */}
        <div className="card p-6">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div className="space-y-2">
              <div className="flex items-center gap-3 flex-wrap">
                <h1 className="text-xl font-bold text-[#1a1a1a]">{staff.name}</h1>
                {staff.active === 0 && (
                  <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium bg-gray-200 text-gray-600">Inactive</span>
                )}
              </div>
              <RoleBadges role_category={staff.role_category} manager_type={staff.manager_type} />
              <div className="flex items-center gap-3 flex-wrap text-sm text-gray-600">
                {shiftText && <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium border border-[#C0272D] text-[#C0272D]">{shiftText}</span>}
                {staff.email && <span>✉ {staff.email}</span>}
                {staff.phone && <span>☎ {staff.phone}</span>}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <ExportMenu
                options={[
                  { label: 'Excel (.xlsx)', onSelect: () => exportEmployee(staff.id, 'xlsx') },
                  { label: 'PDF (one-pager)', onSelect: () => exportEmployee(staff.id, 'pdf') },
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
            <Metric label="Total Keys Held" value={staff.total_keys_held} />
            <Metric label="Accounts Assigned" value={staff.accounts_assigned} />
            <Metric label="Key Holdings" value={staff.holdings.length} />
          </div>
          <p className="text-center text-xs text-cw-muted mt-3">
            Keys held: <span className="font-medium text-gray-700">{keysText({ metal: staff.keys_metal, card: staff.keys_card, fob: staff.keys_fob, dispenser: staff.keys_dispenser, other: staff.keys_other })}</span>
          </p>
        </div>

        {/* Manager key holdings (from their clients' holder grid) */}
        {managerHoldings.length > 0 && (
          <div>
            <h2 className="text-sm font-semibold text-[#1a1a1a] mb-2">Keys Held as Manager <span className="text-cw-muted font-normal">— from the holder grid on their clients</span></h2>
            <div className="card overflow-x-auto max-w-full">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="bg-[#1a1a1a] text-white text-xs">
                    <th className="text-left px-4 py-3 font-medium whitespace-nowrap">Client</th>
                    <th className="text-center px-3 py-3 font-medium whitespace-nowrap">Role</th>
                    <th className="text-left px-3 py-3 font-medium whitespace-nowrap">Breakdown</th>
                    <th className="text-center px-3 py-3 font-medium whitespace-nowrap">Keys Here</th>
                  </tr>
                </thead>
                <tbody>
                  {managerHoldings.map((h: any, i: number) => (
                    <tr key={`m${h.account_id}`} className={`cursor-pointer border-b border-gray-100 hover:bg-[#f0f0ee] ${i % 2 === 0 ? 'bg-white' : 'bg-[#f4f4f2]'}`} onClick={() => navigate(`/registry/${h.account_id}`)}>
                      <td className="px-4 py-3 font-medium text-[#1a1a1a] whitespace-nowrap max-w-[260px] truncate">{h.account_name}</td>
                      <td className="px-3 py-3 text-center text-xs text-gray-700">{h.role || '—'}</td>
                      <td className="px-3 py-3 text-xs text-gray-700">{keysText(h)}</td>
                      <td className="px-3 py-3 text-center font-semibold text-[#C0272D]">{h.total}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Crew key holdings (open check-outs) */}
        {crewHoldings.length > 0 && (
          <div>
            <h2 className="text-sm font-semibold text-[#1a1a1a] mb-2">Keys Held as Crew <span className="text-cw-muted font-normal">— currently checked out to this person</span></h2>
            <div className="card overflow-x-auto max-w-full">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="bg-[#1a1a1a] text-white text-xs">
                    <th className="text-left px-4 py-3 font-medium whitespace-nowrap">Account</th>
                    <th className="text-left px-3 py-3 font-medium whitespace-nowrap">Key Type</th>
                    <th className="text-left px-3 py-3 font-medium whitespace-nowrap">Keys</th>
                    <th className="text-left px-3 py-3 font-medium whitespace-nowrap">Checked Out</th>
                  </tr>
                </thead>
                <tbody>
                  {crewHoldings.map((h: any, i: number) => (
                    <tr key={`c${h.assignment_id}`} className={`border-b border-gray-100 ${i % 2 === 0 ? 'bg-white' : 'bg-[#f4f4f2]'} ${h.account_id ? 'cursor-pointer hover:bg-[#f0f0ee]' : ''}`} onClick={() => h.account_id && navigate(`/registry/${h.account_id}`)}>
                      <td className="px-4 py-3 font-medium text-[#1a1a1a] whitespace-nowrap max-w-[260px] truncate">{h.account_name || '—'}</td>
                      <td className="px-3 py-3 text-xs text-gray-700">{h.key_type || h.bucket || 'physical'}</td>
                      <td className="px-3 py-3 text-xs text-gray-700">{h.keys_held || '1'}</td>
                      <td className="px-3 py-3 text-xs text-gray-600 whitespace-nowrap">{h.checked_out_at ? new Date(h.checked_out_at + 'Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Accounts assigned */}
        <div>
          <h2 className="text-sm font-semibold text-[#1a1a1a] mb-2">Accounts / Clients Assigned</h2>
          <div className="card overflow-x-auto max-w-full">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="bg-[#1a1a1a] text-white text-xs">
                  <th className="text-left px-4 py-3 font-medium whitespace-nowrap">Account</th>
                  <th className="text-left px-3 py-3 font-medium whitespace-nowrap">BC #</th>
                  <th className="text-center px-3 py-3 font-medium whitespace-nowrap">Via</th>
                  <th className="text-center px-3 py-3 font-medium whitespace-nowrap">Keys Here</th>
                </tr>
              </thead>
              <tbody>
                {staff.accounts.length === 0 ? (
                  <tr><td colSpan={4} className="px-4 py-8 text-center text-cw-muted">No accounts assigned</td></tr>
                ) : staff.accounts.map((a: any, i: number) => (
                  <tr key={`${a.source}-${a.id ?? a.name}-${i}`} className={`border-b border-gray-100 ${i % 2 === 0 ? 'bg-white' : 'bg-[#f4f4f2]'} ${a.id ? 'cursor-pointer hover:bg-[#f0f0ee]' : ''}`} onClick={() => a.id && navigate(`/registry/${a.id}`)}>
                    <td className="px-4 py-3 font-medium text-[#1a1a1a] whitespace-nowrap max-w-[260px] truncate">{a.name}</td>
                    <td className="px-3 py-3 font-mono text-xs text-gray-600 whitespace-nowrap">{a.bc_client_number || '—'}</td>
                    <td className="px-3 py-3 text-center">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium ${a.source === 'crew' ? 'border border-[#C0272D] text-[#C0272D]' : 'bg-[#1a1a1a] text-white'}`}>{a.role}</span>
                    </td>
                    <td className="px-3 py-3 text-center text-xs font-semibold text-gray-700">{a.keys_here || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {showEdit && (
        <EditModal staff={staff} onClose={() => setShowEdit(false)} onSaved={(s) => { setShowEdit(false); setStaff(s); }} />
      )}
    </Layout>
  );
}
