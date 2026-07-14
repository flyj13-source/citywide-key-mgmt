import { useEffect, useState, useCallback, useMemo, memo } from 'react';
import { useNavigate } from 'react-router-dom';
import Layout from '../components/Layout';
import Modal from '../components/Modal';
import ImportModal from '../components/ImportModal';
import { getAccounts, getAccount, createAccount, updateAccount, revealCode, getAccountManagers, getCcms } from '../lib/api';

type TabType = 'ic' | 'customer' | 'am' | 'ccm' | 'all';

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
  office_keys: 0,
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

// ── Add / Edit modal ───────────────────────────────────────
// A stable top-level component with its OWN field state. Typing here re-renders
// only this modal — never the Registry page or the 576-row table behind it — and
// (being a fixed component type) it no longer remounts on every keystroke.
type FormState = typeof emptyForm & Record<string, any>;

function AccountFormModal({
  mode, recordType, initial, onClose, onSaved,
}: {
  mode: 'add' | 'edit';
  recordType: 'ic' | 'customer';
  initial?: any;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<FormState>(() => ({
    ...emptyForm,
    ...(initial || {}),
    keys_yn: !!initial?.keys_yn,
    security_app_yn: !!initial?.security_app_yn,
  }));
  const [saving, setSaving] = useState(false);
  const isCustomer = recordType === 'customer';

  const f = (key: string, val: any) => setForm((prev) => ({ ...prev, [key]: val }));
  const numF = (key: string) => (e: React.ChangeEvent<HTMLInputElement>) => f(key, Math.max(0, Number(e.target.value)));
  const textF = (key: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => f(key, e.target.value);

  const save = async () => {
    if (!form.ic_company_name.trim()) return;
    setSaving(true);
    try {
      const payload = { ...form, keys_yn: form.keys_yn ? 1 : 0, security_app_yn: form.security_app_yn ? 1 : 0 };
      if (mode === 'add') {
        await createAccount({ ...payload, record_type: recordType });
      } else {
        await updateAccount(initial.id, payload);
      }
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  const title = mode === 'add'
    ? (isCustomer ? 'Add Customer' : 'Add IC Vendor')
    : `Edit: ${form.ic_company_name}`;
  const saveLabel = mode === 'add' ? (isCustomer ? 'Add Customer' : 'Add IC Vendor') : 'Save Changes';

  return (
    <Modal title={title} onClose={onClose} width="max-w-lg">
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
              { label: 'Office Keys', key: 'office_keys' },
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

      <div className="flex gap-2 pt-4 border-t border-gray-200 mt-4">
        <button onClick={save} disabled={saving || !form.ic_company_name.trim()} className="px-4 py-2 bg-[#C0272D] text-white text-sm font-medium rounded hover:bg-[#a82227] disabled:opacity-50 transition-colors">
          {saving ? 'Saving…' : saveLabel}
        </button>
        <button onClick={onClose} className="px-4 py-2 border border-[#1a1a1a] text-[#1a1a1a] text-sm font-medium rounded hover:bg-gray-50 transition-colors">Cancel</button>
      </div>
    </Modal>
  );
}

// ── Registry table ─────────────────────────────────────────
// Memoized so typing in the search box (which re-renders the page shell to
// update the input) does NOT re-render the 50 visible rows every keystroke.
const RegistryTable = memo(function RegistryTable({
  tab, accounts, loading, colSpan, onRowClick, onEdit,
}: {
  tab: TabType;
  accounts: any[];
  loading: boolean;
  colSpan: number;
  onRowClick: (id: number) => void;
  onEdit: (e: React.MouseEvent, id: number) => void;
}) {
  return (
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
            <th className="text-center px-3 py-3 font-medium whitespace-nowrap">Office Keys</th>
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
                onClick={() => onRowClick(a.id)}
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
                <td className="px-3 py-3 text-center"><CountBadge value={a.office_keys} /></td>
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
                  <button onClick={(e) => onEdit(e, a.id)} className="text-xs text-[#C0272D] hover:underline whitespace-nowrap">Edit</button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
});

// ── People roster (Account Managers / CCMs) ────────────────
// Aggregates come pre-grouped from the backend (SQL GROUP BY + SUMs). Each key
// column is "Keys Across Clients" — the SUM of that CLIENT-level key type over
// the person's clients (the schema has no per-type-per-role split). Sorting is
// client-side over the small roster (one row per person, not per client).
const ROSTER_COLS: { key: string; label: string }[] = [
  { key: 'metal_keys', label: 'Metal Keys' },
  { key: 'key_cards', label: 'Key Cards' },
  { key: 'key_fobs', label: 'Key Fobs' },
  { key: 'dispenser_keys', label: 'Dispenser Keys' },
  { key: 'office_keys', label: 'Office Keys' },
];

function RosterTable({
  role, rows, loading, onSelect,
}: {
  role: 'am' | 'ccm';
  rows: any[];
  loading: boolean;
  onSelect: (person: string) => void;
}) {
  const [sortKey, setSortKey] = useState('total_keys');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const personLabel = role === 'am' ? 'Account Manager' : 'Contract Compliance Manager';

  const sorted = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => {
      const av = a[sortKey], bv = b[sortKey];
      const cmp = typeof av === 'string' ? String(av).localeCompare(String(bv)) : (av - bv);
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return copy;
  }, [rows, sortKey, sortDir]);

  const sort = (key: string) => {
    if (key === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir(key === 'person' ? 'asc' : 'desc'); }
  };
  const arrow = (key: string) => (key === sortKey ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '');

  return (
    <div className="card overflow-x-auto max-w-full">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="bg-[#1a1a1a] text-white text-xs">
            <th rowSpan={2} className="text-left px-4 py-3 font-medium whitespace-nowrap cursor-pointer select-none align-bottom" onClick={() => sort('person')}>{personLabel}{arrow('person')}</th>
            <th rowSpan={2} className="text-center px-3 py-3 font-medium whitespace-nowrap cursor-pointer select-none align-bottom" onClick={() => sort('clients_managed')}>Clients Managed{arrow('clients_managed')}</th>
            <th colSpan={5} className="text-center px-3 py-2 font-semibold whitespace-nowrap border-b border-white/20 text-[11px] uppercase tracking-wide">Keys Across Clients</th>
            <th rowSpan={2} className="text-center px-3 py-3 font-medium whitespace-nowrap cursor-pointer select-none align-bottom" onClick={() => sort('total_keys')}>Total Keys{arrow('total_keys')}</th>
          </tr>
          <tr className="bg-[#1a1a1a] text-white text-xs">
            {ROSTER_COLS.map((c) => (
              <th key={c.key} className="text-center px-3 py-2 font-medium whitespace-nowrap cursor-pointer select-none" onClick={() => sort(c.key)}>{c.label}{arrow(c.key)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr><td colSpan={8} className="px-4 py-8 text-center text-cw-muted">Loading…</td></tr>
          ) : sorted.length === 0 ? (
            <tr><td colSpan={8} className="px-4 py-8 text-center text-cw-muted">No {personLabel.toLowerCase()}s found</td></tr>
          ) : sorted.map((p, i) => {
            const rowBg = i % 2 === 0 ? 'bg-white' : 'bg-[#f4f4f2]';
            return (
              <tr
                key={p.person}
                className={`cursor-pointer border-b border-gray-100 hover:bg-[#f0f0ee] transition-colors ${rowBg}`}
                onClick={() => onSelect(p.person)}
                title="View this person's clients"
              >
                <td className="px-4 py-3 font-medium text-[#1a1a1a] whitespace-nowrap">{p.person}</td>
                <td className="px-3 py-3 text-center"><CountBadge value={p.clients_managed} /></td>
                {ROSTER_COLS.map((c) => (
                  <td key={c.key} className="px-3 py-3 text-center"><CountBadge value={p[c.key]} /></td>
                ))}
                <td className="px-3 py-3 text-center">
                  <span className="inline-flex items-center justify-center min-w-[1.75rem] h-6 px-2 rounded-full bg-[#C0272D] text-white text-xs font-bold">{p.total_keys}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────

type ModalState =
  | { kind: 'add'; recordType: 'ic' | 'customer' }
  | { kind: 'edit'; recordType: 'ic' | 'customer'; initial: any }
  | null;

export default function Registry() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<TabType>('customer');
  const [accounts, setAccounts] = useState<any[]>([]);
  const [counts, setCounts] = useState({ ic: 0, customer: 0, all: 0 });
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<ModalState>(null);
  const [showImport, setShowImport] = useState(false);
  const [roster, setRoster] = useState<any[]>([]);
  const [rosterLoading, setRosterLoading] = useState(false);
  // When a roster person is clicked, drill into their client list.
  const [drill, setDrill] = useState<{ role: 'am' | 'ccm'; name: string } | null>(null);
  const LIMIT = 50;

  const isRosterTab = (tab === 'am' || tab === 'ccm') && !drill;

  // Debounce the applied search: typing updates the input instantly, but the
  // list is only refetched 300ms after the user pauses (was 4 API calls PER
  // keystroke).
  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(id);
  }, [search]);

  // Row data — for the Customers/IC/All tabs and for the roster drill-down.
  // A pure roster tab (am/ccm, no drill) loads the roster instead (below).
  const loadRows = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, string> = { search: debouncedSearch, page: String(page), limit: String(LIMIT) };
      if (drill) {
        params.type = 'customer';
        params[drill.role === 'am' ? 'account_manager' : 'ccm_manager'] = drill.name;
      } else {
        params.type = tab;
      }
      const data = await getAccounts(params);
      setAccounts(data.accounts);
      setTotal(data.total);
    } finally {
      setLoading(false);
    }
  }, [debouncedSearch, page, tab, drill]);

  // People roster — aggregated server-side (GROUP BY), one row per person.
  const loadRoster = useCallback(async () => {
    setRosterLoading(true);
    try {
      const data = tab === 'am' ? await getAccountManagers() : await getCcms();
      setRoster(data.managers);
    } finally {
      setRosterLoading(false);
    }
  }, [tab]);

  useEffect(() => {
    if (isRosterTab) loadRoster();
    else loadRows();
  }, [isRosterTab, loadRoster, loadRows]);

  // Tab/type counts — independent of search, so they are NOT refetched while
  // typing. Refreshed on mount and after any mutation.
  const refreshCounts = useCallback(async () => {
    const [icData, custData, allData] = await Promise.all([
      getAccounts({ limit: '1', type: 'ic' }),
      getAccounts({ limit: '1', type: 'customer' }),
      getAccounts({ limit: '1', type: 'all' }),
    ]);
    setCounts({ ic: icData.total, customer: custData.total, all: allData.total });
  }, []);

  useEffect(() => { refreshCounts(); }, [refreshCounts]);

  const onRowClick = useCallback((id: number) => navigate(`/registry/${id}`), [navigate]);

  const openEdit = useCallback(async (e: React.MouseEvent, id: number) => {
    e.stopPropagation();
    const data = await getAccount(id);
    setModal({ kind: 'edit', recordType: data.record_type === 'customer' ? 'customer' : 'ic', initial: data });
  }, []);

  const openAdd = (type: 'ic' | 'customer') => setModal({ kind: 'add', recordType: type });

  const onSaved = useCallback(() => {
    setModal(null);
    loadRows();
    refreshCounts();
  }, [loadRows, refreshCounts]);

  const tabs: { key: TabType; label: string }[] = useMemo(() => [
    { key: 'customer', label: `Customers (${counts.customer})` },
    { key: 'ic', label: `IC Vendors (${counts.ic})` },
    { key: 'am', label: 'Account Managers' },
    { key: 'ccm', label: 'Contract Compliance Mgrs' },
    { key: 'all', label: `All (${counts.all})` },
  ], [counts]);

  const selectTab = (key: TabType) => { setTab(key); setPage(1); setDrill(null); };
  const openPerson = (name: string) => {
    setDrill({ role: tab === 'am' ? 'am' : 'ccm', name });
    setPage(1);
  };

  // When drilled in, the client list uses the Customer column layout.
  // col counts (incl. Office Keys): customer=21, all=16, ic=15
  const tableTab: TabType = drill ? 'customer' : tab;
  const colSpan = tableTab === 'customer' ? 21 : tableTab === 'all' ? 16 : 15;

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
              onClick={() => selectTab(t.key)}
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

        {/* Drill-down banner (roster person → their clients) */}
        {drill && (
          <div className="flex items-center gap-3">
            <button onClick={() => setDrill(null)} className="text-sm text-[#C0272D] hover:underline">
              ← Back to {drill.role === 'am' ? 'Account Managers' : 'Contract Compliance Mgrs'}
            </button>
            <span className="text-sm text-cw-muted">
              Clients managed by <span className="font-semibold text-[#1a1a1a]">{drill.name}</span>
            </span>
          </div>
        )}

        {/* Search — not shown on the pure roster tabs */}
        {!isRosterTab && (
          <input
            className="input max-w-xs focus:ring-[#C0272D] focus:border-[#C0272D]"
            placeholder="Search by name, number, or manager…"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          />
        )}

        {/* Roster (Account Managers / CCMs) OR the client table */}
        {isRosterTab ? (
          <RosterTable
            role={tab as 'am' | 'ccm'}
            rows={roster}
            loading={rosterLoading}
            onSelect={openPerson}
          />
        ) : (
          <RegistryTable
            tab={tableTab}
            accounts={accounts}
            loading={loading}
            colSpan={colSpan}
            onRowClick={onRowClick}
            onEdit={openEdit}
          />
        )}

        {/* Pagination */}
        {!isRosterTab && total > LIMIT && (
          <div className="flex items-center gap-3 justify-center">
            <button className="btn-secondary" disabled={page === 1} onClick={() => setPage(p => p - 1)}>← Prev</button>
            <span className="text-sm text-cw-muted">Page {page} of {Math.ceil(total / LIMIT)}</span>
            <button className="btn-secondary" disabled={page * LIMIT >= total} onClick={() => setPage(p => p + 1)}>Next →</button>
          </div>
        )}
      </div>

      {modal && (
        <AccountFormModal
          mode={modal.kind}
          recordType={modal.recordType}
          initial={modal.kind === 'edit' ? modal.initial : undefined}
          onClose={() => setModal(null)}
          onSaved={onSaved}
        />
      )}

      {showImport && (
        <ImportModal onClose={() => setShowImport(false)} onDone={() => { loadRows(); refreshCounts(); }} />
      )}
    </Layout>
  );
}
