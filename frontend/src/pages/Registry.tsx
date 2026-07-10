import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import Layout from '../components/Layout';
import Modal from '../components/Modal';
import ImportModal from '../components/ImportModal';
import { getAccounts, getAccount, createAccount, updateAccount, revealCode } from '../lib/api';

type TabType = 'ic' | 'customer' | 'all';

const emptyForm = {
  ic_company_name: '',
  bc_client_number: '',
  bc_vendor_number: '',
  ic_name: '',
  account_manager: '',
  ccm_manager: '',
  keys_yn: false,
  security_app_yn: false,
  metal_keys: 0,
  key_cards: 0,
  has_fob: 0,
  dispenser_keys: 0,
  am_keys: 0,
  ccm_keys: 0,
  contractor_keys: 0,
  lockbox_code: '',
  door_code: '',
  alarm_code: '',
  notes: '',
  status: 'active',
};

// ── Small helpers ──────────────────────────────────────────

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-[#C0272D] focus:ring-offset-1 ${checked ? 'bg-[#C0272D]' : 'bg-gray-300'}`}
    >
      <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-6' : 'translate-x-1'}`} />
    </button>
  );
}

function Check({ value }: { value: number | boolean }) {
  return value ? (
    <span className="text-[#2d7a3a] font-bold text-base">✓</span>
  ) : (
    <span className="text-gray-300">—</span>
  );
}

function CountBadge({ value }: { value: number }) {
  if (!value) return <span className="text-gray-300">—</span>;
  return (
    <span className="inline-flex items-center justify-center min-w-[1.5rem] h-6 px-1.5 rounded-full bg-[#1a1a1a] text-white text-xs font-semibold">
      {value}
    </span>
  );
}

function RevealCell({ accountId, type, hasCode }: { accountId: number; type: 'door' | 'alarm'; hasCode: boolean }) {
  const [code, setCode] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  if (!hasCode) return <span className="text-gray-300">—</span>;
  if (code) return (
    <span className="font-mono text-xs bg-gray-100 px-1.5 py-0.5 rounded select-all">
      {code}
      <button onClick={() => setCode(null)} className="ml-1 text-[10px] text-gray-400 hover:text-gray-700">×</button>
    </span>
  );
  return (
    <button
      onClick={async (e) => { e.stopPropagation(); setLoading(true); try { const r = await revealCode(accountId, type); setCode(r.code); } finally { setLoading(false); } }}
      className="text-xs border border-[#C0272D] text-[#C0272D] rounded px-2 py-0.5 hover:bg-[#C0272D] hover:text-white transition-colors"
    >
      {loading ? '…' : '••••'}
    </button>
  );
}

function TypeBadge({ type }: { type: string }) {
  if (type === 'customer') {
    return <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-[#1a1a1a] text-white">Customer</span>;
  }
  return <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border border-[#C0272D] text-[#C0272D]">IC</span>;
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="text-[10px] font-bold uppercase tracking-widest text-[#1a1a1a] border-b border-gray-200 pb-1 mb-3">{children}</div>;
}

function FormField({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-600 mb-1">
        {label}{hint && <span className="ml-1 text-gray-400 font-normal">— {hint}</span>}
      </label>
      {children}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────

export default function Registry() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<TabType>('customer');
  const [accounts, setAccounts] = useState<any[]>([]);
  const [counts, setCounts] = useState({ ic: 0, customer: 0, all: 0 });
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [addType, setAddType] = useState<'ic' | 'customer'>('ic');
  const [showImport, setShowImport] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [form, setForm] = useState({ ...emptyForm });
  const [saving, setSaving] = useState(false);
  const LIMIT = 50;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [tabData, icData, custData, allData] = await Promise.all([
        getAccounts({ search, page: String(page), limit: String(LIMIT), type: tab }),
        getAccounts({ limit: '1', type: 'ic' }),
        getAccounts({ limit: '1', type: 'customer' }),
        getAccounts({ limit: '1', type: 'all' }),
      ]);
      setAccounts(tabData.accounts);
      setTotal(tabData.total);
      setCounts({ ic: icData.total, customer: custData.total, all: allData.total });
    } finally {
      setLoading(false);
    }
  }, [search, page, tab]);

  useEffect(() => { load(); }, [load]);

  const openEdit = async (e: React.MouseEvent, id: number) => {
    e.stopPropagation();
    const data = await getAccount(id);
    setForm({
      ...emptyForm,
      ...data,
      keys_yn: !!data.keys_yn,
      security_app_yn: !!data.security_app_yn,
    });
    setEditId(id);
    setShowEdit(true);
  };

  const f = (key: string, val: any) => setForm(prev => ({ ...prev, [key]: val }));
  const numF = (key: string) => (e: React.ChangeEvent<HTMLInputElement>) => f(key, Math.max(0, Number(e.target.value)));
  const textF = (key: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => f(key, e.target.value);

  const openAdd = (type: 'ic' | 'customer') => {
    setAddType(type);
    setForm({ ...emptyForm });
    setShowAdd(true);
  };

  const saveNew = async () => {
    if (!form.ic_company_name.trim()) return;
    setSaving(true);
    try {
      await createAccount({ ...form, keys_yn: form.keys_yn ? 1 : 0, security_app_yn: form.security_app_yn ? 1 : 0, record_type: addType });
      setShowAdd(false);
      setForm({ ...emptyForm });
      load();
    } finally { setSaving(false); }
  };

  const saveEdit = async () => {
    if (!editId) return;
    setSaving(true);
    try {
      await updateAccount(editId, { ...form, keys_yn: form.keys_yn ? 1 : 0, security_app_yn: form.security_app_yn ? 1 : 0 });
      setShowEdit(false);
      load();
    } finally { setSaving(false); }
  };

  // Form body — customer form includes client/IC/manager sections; IC form is simpler
  const FormBody = ({ isCustomer }: { isCustomer: boolean }) => (
    <div className="space-y-5 max-h-[70vh] overflow-y-auto pr-1">
      {isCustomer ? (
        <>
          <div>
            <SectionLabel>Client Info</SectionLabel>
            <div className="space-y-3">
              <FormField label="Client Name *">
                <input className="input focus:ring-[#C0272D] focus:border-[#C0272D]" value={form.ic_company_name} onChange={textF('ic_company_name')} placeholder="CLIENT NAME" />
              </FormField>
              <FormField label="BC Client Number *" hint="01014XXXXXX">
                <input className="input focus:ring-[#C0272D] focus:border-[#C0272D]" value={form.bc_client_number} onChange={textF('bc_client_number')} placeholder="01014XXXXXX" />
              </FormField>
            </div>
          </div>
          <div>
            <SectionLabel>Independent Contractor</SectionLabel>
            <div className="space-y-3">
              <FormField label="IC Name">
                <input className="input focus:ring-[#C0272D] focus:border-[#C0272D]" value={form.ic_name} onChange={textF('ic_name')} placeholder="CONTRACTOR NAME INC" />
              </FormField>
              <FormField label="BC Vendor Number" hint="02014XXXXXX">
                <input className="input focus:ring-[#C0272D] focus:border-[#C0272D]" value={form.bc_vendor_number} onChange={textF('bc_vendor_number')} placeholder="02014XXXXXX" />
              </FormField>
            </div>
          </div>
          <div>
            <SectionLabel>Account Management</SectionLabel>
            <div className="space-y-3">
              <FormField label="Account Manager">
                <input className="input focus:ring-[#C0272D] focus:border-[#C0272D]" value={form.account_manager} onChange={textF('account_manager')} placeholder="Full name" />
              </FormField>
              <FormField label="Contract Compliance Manager">
                <input className="input focus:ring-[#C0272D] focus:border-[#C0272D]" value={form.ccm_manager} onChange={textF('ccm_manager')} placeholder="Full name" />
              </FormField>
            </div>
          </div>
        </>
      ) : (
        <div>
          <SectionLabel>Contractor Info</SectionLabel>
          <div className="space-y-3">
            <FormField label="Independent Contractor *">
              <input className="input focus:ring-[#C0272D] focus:border-[#C0272D]" value={form.ic_company_name} onChange={textF('ic_company_name')} placeholder="COMPANY NAME INC" />
            </FormField>
            <FormField label="BC Vendor Number *" hint="02014XXXXXX">
              <input className="input focus:ring-[#C0272D] focus:border-[#C0272D]" value={form.bc_vendor_number} onChange={textF('bc_vendor_number')} placeholder="02014XXXXXX" />
            </FormField>
          </div>
        </div>
      )}

      <div>
        <SectionLabel>Access Toggles</SectionLabel>
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-gray-700">Keys Y/N</span>
            <Toggle checked={!!form.keys_yn} onChange={(v) => f('keys_yn', v)} />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-gray-700">Security App Y/N</span>
            <Toggle checked={!!form.security_app_yn} onChange={(v) => f('security_app_yn', v)} />
          </div>
        </div>
      </div>

      <div>
        <SectionLabel>Key Inventory</SectionLabel>
        <div className="grid grid-cols-2 gap-3">
          {[
            { label: 'Metal Keys', key: 'metal_keys' },
            { label: 'Key Cards', key: 'key_cards' },
            { label: 'Key Fobs', key: 'has_fob' },
            { label: 'Dispenser Key', key: 'dispenser_keys' },
          ].map(({ label, key }) => (
            <FormField key={key} label={label}>
              <input type="number" min={0} className="input focus:ring-[#C0272D] focus:border-[#C0272D]" value={(form as any)[key] ?? 0} onChange={numF(key)} />
            </FormField>
          ))}
        </div>
      </div>

      {isCustomer && (
        <div>
          <SectionLabel>Role Key Counts</SectionLabel>
          <div className="grid grid-cols-3 gap-3">
            {[
              { label: 'AM Keys', key: 'am_keys' },
              { label: 'CCM Keys', key: 'ccm_keys' },
              { label: 'Contractor Keys', key: 'contractor_keys' },
            ].map(({ label, key }) => (
              <FormField key={key} label={label}>
                <input type="number" min={0} className="input focus:ring-[#C0272D] focus:border-[#C0272D]" value={(form as any)[key] ?? 0} onChange={numF(key)} />
              </FormField>
            ))}
          </div>
        </div>
      )}

      <div>
        <SectionLabel>Access Codes</SectionLabel>
        <div className="space-y-3">
          <FormField label="Lockbox Code">
            <input className="input focus:ring-[#C0272D] focus:border-[#C0272D]" value={form.lockbox_code} onChange={textF('lockbox_code')} placeholder="Plain text" />
          </FormField>
          <FormField label="Door Code" hint="stored encrypted">
            <input className="input focus:ring-[#C0272D] focus:border-[#C0272D]" value={form.door_code} onChange={textF('door_code')} placeholder="Leave blank to keep existing" />
          </FormField>
          <FormField label="Alarm Code" hint="stored encrypted">
            <input className="input focus:ring-[#C0272D] focus:border-[#C0272D]" value={form.alarm_code} onChange={textF('alarm_code')} placeholder="Leave blank to keep existing" />
          </FormField>
        </div>
      </div>

      <div>
        <SectionLabel>Notes</SectionLabel>
        <textarea className="input h-20 resize-none focus:ring-[#C0272D] focus:border-[#C0272D]" value={form.notes} onChange={textF('notes')} />
      </div>
    </div>
  );

  const tabs: { key: TabType; label: string }[] = [
    { key: 'customer', label: `Customers (${counts.customer})` },
    { key: 'ic', label: `IC Vendors (${counts.ic})` },
    { key: 'all', label: `All (${counts.all})` },
  ];

  // col counts: customer=20 (19 data + edit), ic=14, all=15
  const colSpan = tab === 'customer' ? 20 : tab === 'all' ? 15 : 14;

  return (
    <Layout>
      <div className="p-6 max-w-full mx-auto space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-[#1a1a1a]">Key Registry</h1>
            <p className="text-sm text-cw-muted">{total} record{total !== 1 ? 's' : ''}</p>
          </div>
          <div className="flex gap-2">
            <button onClick={() => setShowImport(true)} className="px-4 py-2 bg-[#C0272D] text-white text-sm font-medium rounded hover:bg-[#a82227] transition-colors">
              ↑ Import from Excel
            </button>
            <button onClick={() => openAdd('customer')} className="px-4 py-2 bg-[#C0272D] text-white text-sm font-medium rounded hover:bg-[#a82227] transition-colors">
              + Add Customer
            </button>
            <button onClick={() => openAdd('ic')} className="px-4 py-2 border border-cw-border text-cw-text text-sm font-medium rounded hover:bg-gray-50 transition-colors">
              + Add IC
            </button>
          </div>
        </div>

        {/* Tab bar */}
        <div className="flex border-b border-cw-border gap-6">
          {tabs.map((t) => (
            <button
              key={t.key}
              onClick={() => { setTab(t.key); setPage(1); }}
              className={`pb-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
                tab === t.key
                  ? 'border-[#C0272D] text-[#C0272D]'
                  : 'border-transparent text-[#6b6b68] hover:text-[#1a1a1a]'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Search */}
        <input
          className="input max-w-xs focus:ring-[#C0272D] focus:border-[#C0272D]"
          placeholder="Search by name, number, or manager…"
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
        />

        {/* Table */}
        <div className="card overflow-x-auto max-w-full">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="bg-[#1a1a1a] text-white text-xs">
                {tab === 'customer' ? (
                  <>
                    <th className="text-left px-4 py-3 font-medium whitespace-nowrap sticky left-0 z-20 bg-[#1a1a1a] min-w-[200px]">Client Name</th>
                    <th className="text-left px-3 py-3 font-medium whitespace-nowrap sticky left-[200px] z-20 bg-[#1a1a1a] min-w-[150px]">BC Client #</th>
                    <th className="text-left px-3 py-3 font-medium whitespace-nowrap">Independent Contractor</th>
                    <th className="text-left px-3 py-3 font-medium whitespace-nowrap">BC Vendor #</th>
                    <th className="text-left px-3 py-3 font-medium whitespace-nowrap">Account Manager</th>
                    <th className="text-left px-3 py-3 font-medium whitespace-nowrap">Contract Compliance Manager</th>
                  </>
                ) : (
                  <>
                    <th className="text-left px-4 py-3 font-medium whitespace-nowrap">
                      {tab === 'all' ? 'Name' : 'Independent Contractor'}
                    </th>
                    <th className="text-left px-3 py-3 font-medium whitespace-nowrap">BC Vendor Number</th>
                  </>
                )}
                <th className="text-center px-3 py-3 font-medium whitespace-nowrap">Keys Y/N</th>
                <th className="text-center px-3 py-3 font-medium whitespace-nowrap">Security App Y/N</th>
                <th className="text-center px-3 py-3 font-medium whitespace-nowrap">Metal Keys</th>
                <th className="text-center px-3 py-3 font-medium whitespace-nowrap">Key Cards</th>
                <th className="text-center px-3 py-3 font-medium whitespace-nowrap">Key Fobs</th>
                <th className="text-center px-3 py-3 font-medium whitespace-nowrap">Dispenser Key</th>
                {tab === 'customer' && <>
                  <th className="text-center px-3 py-3 font-medium whitespace-nowrap">IC Keys</th>
                  <th className="text-center px-3 py-3 font-medium whitespace-nowrap">AM Keys</th>
                  <th className="text-center px-3 py-3 font-medium whitespace-nowrap">CCM Keys</th>
                </>}
                <th className="text-center px-3 py-3 font-medium whitespace-nowrap">Lockbox Code</th>
                <th className="text-center px-3 py-3 font-medium whitespace-nowrap">Door Code</th>
                <th className="text-center px-3 py-3 font-medium whitespace-nowrap">Alarm Code</th>
                <th className="text-left px-3 py-3 font-medium">Notes</th>
                {tab === 'all' && <th className="text-center px-3 py-3 font-medium whitespace-nowrap">Type</th>}
                <th className="px-3 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={colSpan} className="px-4 py-8 text-center text-cw-muted">Loading…</td></tr>
              ) : accounts.length === 0 ? (
                <tr><td colSpan={colSpan} className="px-4 py-8 text-center text-cw-muted">No records found</td></tr>
              ) : accounts.map((a, i) => {
                const rowBg = i % 2 === 0 ? 'bg-white' : 'bg-[#f4f4f2]';
                return (
                  <tr
                    key={a.id}
                    className={`cursor-pointer border-b border-gray-100 hover:bg-[#f0f0ee] transition-colors ${rowBg}`}
                    onClick={() => navigate(`/registry/${a.id}`)}
                  >
                    {tab === 'customer' ? (
                      <>
                        <td className={`px-4 py-3 font-medium text-[#1a1a1a] whitespace-nowrap max-w-[200px] truncate sticky left-0 z-10 ${rowBg}`}>
                          {a.ic_company_name}
                        </td>
                        <td className={`px-3 py-3 font-mono text-xs text-gray-600 whitespace-nowrap sticky left-[200px] z-10 ${rowBg}`}>
                          {a.bc_client_number || '—'}
                        </td>
                        <td className="px-3 py-3 text-xs text-gray-700 whitespace-nowrap max-w-[180px] truncate">{a.ic_name || '—'}</td>
                        <td className="px-3 py-3 font-mono text-xs text-gray-600 whitespace-nowrap">{a.bc_vendor_number || '—'}</td>
                        <td className="px-3 py-3 text-xs text-gray-700 whitespace-nowrap max-w-[140px] truncate">{a.account_manager || '—'}</td>
                        <td className="px-3 py-3 text-xs text-gray-700 whitespace-nowrap max-w-[140px] truncate">{a.ccm_manager || '—'}</td>
                      </>
                    ) : (
                      <>
                        <td className="px-4 py-3 font-medium text-[#1a1a1a] whitespace-nowrap max-w-[220px] truncate">{a.ic_company_name}</td>
                        <td className="px-3 py-3 font-mono text-xs text-gray-600 whitespace-nowrap">{a.bc_vendor_number || '—'}</td>
                      </>
                    )}
                    <td className="px-3 py-3 text-center"><Check value={a.keys_yn} /></td>
                    <td className="px-3 py-3 text-center"><Check value={a.security_app_yn} /></td>
                    <td className="px-3 py-3 text-center"><CountBadge value={a.metal_keys} /></td>
                    <td className="px-3 py-3 text-center"><CountBadge value={a.key_cards} /></td>
                    <td className="px-3 py-3 text-center"><CountBadge value={a.has_fob} /></td>
                    <td className="px-3 py-3 text-center"><CountBadge value={a.dispenser_keys} /></td>
                    {tab === 'customer' && <>
                      <td className="px-3 py-3 text-center"><CountBadge value={a.contractor_keys} /></td>
                      <td className="px-3 py-3 text-center"><CountBadge value={a.am_keys} /></td>
                      <td className="px-3 py-3 text-center"><CountBadge value={a.ccm_keys} /></td>
                    </>}
                    <td className="px-3 py-3 text-center text-xs font-mono text-gray-600">{a.lockbox_code || '—'}</td>
                    <td className="px-3 py-3 text-center" onClick={(e) => e.stopPropagation()}>
                      <RevealCell accountId={a.id} type="door" hasCode={!!a.door_code_encrypted} />
                    </td>
                    <td className="px-3 py-3 text-center" onClick={(e) => e.stopPropagation()}>
                      <RevealCell accountId={a.id} type="alarm" hasCode={!!a.alarm_code_encrypted} />
                    </td>
                    <td className="px-3 py-3 text-xs text-gray-500 max-w-[160px] truncate">{a.notes ? a.notes.slice(0, 40) + (a.notes.length > 40 ? '…' : '') : '—'}</td>
                    {tab === 'all' && <td className="px-3 py-3 text-center" onClick={(e) => e.stopPropagation()}><TypeBadge type={a.record_type || 'ic'} /></td>}
                    <td className="px-3 py-3 text-right" onClick={(e) => e.stopPropagation()}>
                      <button onClick={(e) => openEdit(e, a.id)} className="text-xs text-[#C0272D] hover:underline whitespace-nowrap">Edit</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {total > LIMIT && (
          <div className="flex items-center gap-3 justify-center">
            <button className="btn-secondary" disabled={page === 1} onClick={() => setPage(p => p - 1)}>← Prev</button>
            <span className="text-sm text-cw-muted">Page {page} of {Math.ceil(total / LIMIT)}</span>
            <button className="btn-secondary" disabled={page * LIMIT >= total} onClick={() => setPage(p => p + 1)}>Next →</button>
          </div>
        )}
      </div>

      {/* Add Modal */}
      {showAdd && (
        <Modal title={addType === 'customer' ? 'Add Customer' : 'Add IC Vendor'} onClose={() => setShowAdd(false)} width="max-w-lg">
          <FormBody isCustomer={addType === 'customer'} />
          <div className="flex gap-2 pt-4 border-t border-gray-200 mt-4">
            <button onClick={saveNew} disabled={saving || !form.ic_company_name.trim()} className="px-4 py-2 bg-[#C0272D] text-white text-sm font-medium rounded hover:bg-[#a82227] disabled:opacity-50 transition-colors">
              {saving ? 'Saving…' : addType === 'customer' ? 'Add Customer' : 'Add IC Vendor'}
            </button>
            <button onClick={() => setShowAdd(false)} className="px-4 py-2 border border-[#1a1a1a] text-[#1a1a1a] text-sm font-medium rounded hover:bg-gray-50 transition-colors">Cancel</button>
          </div>
        </Modal>
      )}

      {/* Edit Modal */}
      {showEdit && (
        <Modal title={`Edit: ${form.ic_company_name}`} onClose={() => setShowEdit(false)} width="max-w-lg">
          <FormBody isCustomer={(form as any).record_type === 'customer'} />
          <div className="flex gap-2 pt-4 border-t border-gray-200 mt-4">
            <button onClick={saveEdit} disabled={saving} className="px-4 py-2 bg-[#C0272D] text-white text-sm font-medium rounded hover:bg-[#a82227] disabled:opacity-50 transition-colors">
              {saving ? 'Saving…' : 'Save Changes'}
            </button>
            <button onClick={() => setShowEdit(false)} className="px-4 py-2 border border-[#1a1a1a] text-[#1a1a1a] text-sm font-medium rounded hover:bg-gray-50 transition-colors">Cancel</button>
          </div>
        </Modal>
      )}

      {showImport && (
        <ImportModal onClose={() => setShowImport(false)} onDone={() => load()} />
      )}
    </Layout>
  );
}
