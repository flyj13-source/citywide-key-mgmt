import { useEffect, useState, useCallback, useMemo, memo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import Layout from '../components/Layout';
import Modal from '../components/Modal';
import ImportModal from '../components/ImportModal';
import { getManager } from '../lib/auth';
import YesNo from '../components/YesNo';
import ExportMenu from '../components/ExportMenu';
import { CheckOutModal, CheckInModal } from '../components/CustodyModals';
import ReassignModal from '../components/ReassignModal';
import ActionMenu, { type ActionItem } from '../components/ActionMenu';
import { CheckedOutTable, CheckedInTable, type SortState } from '../components/CustodyTables';
import { getAccounts, getAccount, createAccount, updateAccount, revealCode, getAccountManagers, getCcms, archiveAccount, restoreAccount, purgeAccount, getStaff, exportEmployee, exportRegistry, getAssignments, confirmHandover, type Assignment } from '../lib/api';

type TabType = 'ic' | 'customer' | 'am' | 'ccm' | 'office' | 'cwemployees' | 'checkedout' | 'checkedin' | 'all' | 'archived';

const emptyForm = {
  ic_company_name: '',
  bc_client_number: '',
  bc_vendor_number: '',
  ic_name: '',
  account_manager: '',
  ccm_manager: '',
  keys_yn: false,
  security_app_yn: false,
  // Client-site Key Inventory row totals — auto-computed from the holder grid
  // below (see GRID_TYPES/GRID_HOLDERS), sent through as a legacy-preserve
  // fallback for rows that predate the grid.
  metal_keys: 0,
  key_cards: 0,
  has_fob: 0,
  dispenser_keys: 0,
  // Holder × type grid — 16 cells. Office is a HOLDER, not a type.
  am_metal: 0, am_card: 0, am_fob: 0, am_dispenser: 0,
  ccm_metal: 0, ccm_card: 0, ccm_fob: 0, ccm_dispenser: 0,
  contractor_metal: 0, contractor_card: 0, contractor_fob: 0, contractor_dispenser: 0,
  office_metal: 0, office_card: 0, office_fob: 0, office_dispenser: 0,
  // Column totals (computed server-side from the grid; sent as fallback)
  am_keys: 0,
  ccm_keys: 0,
  contractor_keys: 0,
  office_keys_held: 0,
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

function CountBadge({ value }: { value: number }) {
  if (!value) return <span className="text-gray-300">—</span>;
  return (
    <span className="inline-flex items-center justify-center min-w-[1.5rem] h-6 px-1.5 rounded-full bg-[#1a1a1a] text-white text-xs font-semibold">
      {value}
    </span>
  );
}

export function roleBreakdownText(metal: number, card: number, fob: number, dispenser: number): string {
  const parts: string[] = [];
  if (metal) parts.push(`${metal} metal`);
  if (card) parts.push(`${card} card`);
  if (fob) parts.push(`${fob} fob`);
  if (dispenser) parts.push(`${dispenser} dispenser`);
  return parts.length ? parts.join(' · ') : 'No type breakdown recorded';
}

// A holder-column-total pill. Click to expand the metal/card/fob/dispenser
// breakdown in an inline popover (hover title kept as a fallback). Own state
// so only this pill re-renders — the memoized table is untouched.
function RolePill({ value, metal, card, fob, dispenser }: {
  value: number; metal: number; card: number; fob: number; dispenser: number;
}) {
  const [open, setOpen] = useState(false);
  const text = roleBreakdownText(metal || 0, card || 0, fob || 0, dispenser || 0);
  if (!value) return <span className="text-gray-300">—</span>;
  return (
    <span className="relative inline-block">
      <button
        type="button"
        title={text}
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        onBlur={() => setOpen(false)}
        className="inline-flex items-center justify-center min-w-[1.5rem] h-6 px-1.5 rounded-full bg-[#1a1a1a] text-white text-xs font-semibold cursor-pointer hover:ring-2 hover:ring-[#C0272D]/50 focus:outline-none focus:ring-2 focus:ring-[#C0272D]"
      >
        {value}
      </button>
      {open && (
        <div
          onClick={(e) => e.stopPropagation()}
          className="absolute z-30 left-1/2 -translate-x-1/2 mt-1 whitespace-nowrap rounded border border-cw-border bg-white px-2 py-1 text-[11px] text-gray-700 shadow-lg"
        >
          {text}
        </div>
      )}
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

// Amber until the physical keys have actually changed hands. Registry
// responsibility already moved; this is the honest gap between the two truths.
function HandoverPill({ from, to }: { from?: string | null; to?: string | null }) {
  return (
    <span
      title={from && to ? `Keys still with ${from} — to be handed to ${to}` : 'Physical handover pending'}
      className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold whitespace-nowrap bg-[#fff8e6] text-[#7a5a00] border border-[#e8cf8a]"
    >
      Handover pending
    </span>
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

// Holder × type key grid — TRANSPOSED model. Rows are key TYPES, columns are
// HOLDERS (Office is a holder, like AM/CCM/Contractor — not a type). A cell's
// field name is `${holder.key}_${type.key}` (e.g. am_metal, office_dispenser),
// matching the backend's 16-column schema exactly.
const GRID_HOLDERS: { key: string; label: string }[] = [
  { key: 'am', label: 'AM' },
  { key: 'ccm', label: 'CCM' },
  { key: 'contractor', label: 'Contractor/IC' },
  { key: 'office', label: 'Office' },
];
const GRID_TYPES: { key: string; label: string }[] = [
  { key: 'metal', label: 'Metal' },
  { key: 'card', label: 'Key Card' },
  { key: 'fob', label: 'Key Fob' },
  { key: 'dispenser', label: 'Dispenser' },
];

function GridTypeRow({
  type, form, numF, rowTotal,
}: {
  type: { key: string; label: string };
  form: Record<string, any>;
  numF: (key: string) => (e: React.ChangeEvent<HTMLInputElement>) => void;
  rowTotal: number;
}) {
  return (
    <>
      <div className="text-xs font-semibold text-[#1a1a1a] whitespace-nowrap pr-2">{type.label}</div>
      {GRID_HOLDERS.map((h) => {
        const k = `${h.key}_${type.key}`;
        return (
          <input
            key={k}
            type="number"
            min={0}
            className="input text-center px-1 focus:ring-[#C0272D] focus:border-[#C0272D]"
            value={form[k] ?? 0}
            onChange={numF(k)}
            aria-label={`${h.label} ${type.label}`}
          />
        );
      })}
      <div className="text-sm font-bold text-[#C0272D] text-center pl-2 tabular-nums min-w-[2rem]">{rowTotal}</div>
    </>
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
  const [form, setForm] = useState<FormState>(() => {
    const merged: FormState = {
      ...emptyForm,
      ...(initial || {}),
      keys_yn: !!initial?.keys_yn,
      security_app_yn: !!initial?.security_app_yn,
    };
    // The DB stores NULL for empty optional fields (ic_name, account_manager,
    // notes, …). Spreading those over emptyForm's '' defaults would feed a
    // controlled <input> a null value (React warns). Coerce every string-typed
    // form field back to '' so the inputs stay controlled.
    for (const key of Object.keys(emptyForm) as (keyof typeof emptyForm)[]) {
      if (typeof emptyForm[key] === 'string' && (merged as any)[key] == null) (merged as any)[key] = '';
    }
    return merged;
  });
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
    : (isCustomer ? 'Edit Customer' : 'Edit IC Vendor');
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
          <SectionLabel>Role Key Counts</SectionLabel>
          {/* Holder × type grid. Rows = key types, columns = holders (Office is
              a holder). Row totals (right) and the bottom TOTAL row (column
              sums) are computed live, read-only. */}
          <div className="grid grid-cols-[auto_repeat(4,1fr)_auto] gap-x-2 gap-y-2 items-center">
            <div />
            {GRID_HOLDERS.map((h) => (
              <div key={h.key} className="text-[10px] font-semibold uppercase tracking-wide text-gray-500 text-center">{h.label}</div>
            ))}
            <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-500 text-center pl-1">Total</div>
            {GRID_TYPES.map((type) => {
              const rowTotal = GRID_HOLDERS.reduce((s, h) => s + (Number((form as any)[`${h.key}_${type.key}`]) || 0), 0);
              return (
                <GridTypeRow key={type.key} type={type} form={form} numF={numF} rowTotal={rowTotal} />
              );
            })}
            <div className="text-xs font-bold text-[#1a1a1a] whitespace-nowrap pr-2 border-t border-gray-200 pt-2 mt-1">TOTAL</div>
            {GRID_HOLDERS.map((h) => {
              const colTotal = GRID_TYPES.reduce((s, type) => s + (Number((form as any)[`${h.key}_${type.key}`]) || 0), 0);
              return (
                <div key={h.key} className="text-sm font-bold text-[#1a1a1a] text-center tabular-nums border-t border-gray-200 pt-2 mt-1">{colTotal}</div>
              );
            })}
            <div className="text-sm font-extrabold text-[#C0272D] text-center pl-2 tabular-nums border-t border-gray-200 pt-2 mt-1">
              {GRID_HOLDERS.reduce((s, h) => s + GRID_TYPES.reduce((s2, type) => s2 + (Number((form as any)[`${h.key}_${type.key}`]) || 0), 0), 0)}
            </div>
          </div>
          <p className="text-[11px] text-gray-400 mt-2">
            Row totals = keys of that type across all holders. Column totals (AM / CCM / Contractor-IC / Office Keys) = total keys that holder has, all types.
          </p>
        </div>

        <div>
          <SectionLabel>Key Inventory <span className="normal-case font-normal text-gray-400 tracking-normal">— client-site totals, auto-computed from Role Key Counts above</span></SectionLabel>
          <div className="grid grid-cols-4 gap-3">
            {GRID_TYPES.map((type) => {
              const rowTotal = GRID_HOLDERS.reduce((s, h) => s + (Number((form as any)[`${h.key}_${type.key}`]) || 0), 0);
              return (
                <div key={type.key}>
                  <label className="block text-xs font-medium text-gray-600 mb-1">{type.label}</label>
                  <div className="input flex items-center justify-center bg-gray-50 text-gray-700 font-semibold tabular-nums">{rowTotal}</div>
                </div>
              );
            })}
          </div>
        </div>

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
  tab, accounts, loading, colSpan, selectable, selectedId, onToggleSelect, onRowClick, onEdit,
}: {
  tab: TabType;
  accounts: any[];
  loading: boolean;
  colSpan: number;
  selectable: boolean;
  selectedId: number | null;
  onToggleSelect: (id: number) => void;
  onRowClick: (id: number) => void;
  onEdit: (e: React.MouseEvent, id: number) => void;
}) {
  return (
    <div className="card overflow-x-auto max-w-full">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="bg-[#1a1a1a] text-white text-xs">
            {selectable && <th className="w-11 px-2 py-3 sticky left-0 z-20 bg-[#1a1a1a]"></th>}
            {tab === 'customer' ? (
              <>
                <th className={`text-left px-4 py-3 font-medium whitespace-nowrap sticky ${selectable ? 'left-11' : 'left-0'} z-20 bg-[#1a1a1a] min-w-[200px]`}>Client Name</th>
                <th className={`text-left px-3 py-3 font-medium whitespace-nowrap sticky ${selectable ? 'left-[244px]' : 'left-[200px]'} z-20 bg-[#1a1a1a] min-w-[150px]`}>BC Client #</th>
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
              <th className="text-center px-3 py-3 font-medium whitespace-nowrap">Office Keys</th>
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
            const selected = selectedId === a.id;
            const rowBg = selected ? 'bg-[#fbeaea]' : (i % 2 === 0 ? 'bg-white' : 'bg-[#f4f4f2]');
            return (
              <tr
                key={a.id}
                className={`cursor-pointer border-b border-gray-100 hover:bg-[#f0f0ee] transition-colors ${rowBg}`}
                onClick={() => onRowClick(a.id)}
              >
                {selectable && (
                  <td className={`w-11 px-2 py-3 text-center sticky left-0 z-10 ${rowBg}`} onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-[#C0272D] cursor-pointer align-middle"
                      checked={selected}
                      onChange={() => onToggleSelect(a.id)}
                      aria-label={`Select ${a.ic_company_name}`}
                    />
                  </td>
                )}
                {tab === 'customer' ? (
                  <>
                    <td className={`px-4 py-3 font-medium text-[#1a1a1a] whitespace-nowrap max-w-[240px] truncate sticky ${selectable ? 'left-11' : 'left-0'} z-10 ${rowBg}`}>
                      {a.ic_company_name}
                      {!!a.pending_handover && (
                        <div className="mt-0.5">
                          <HandoverPill from={a.pending_handover_from} to={a.pending_handover_to} />
                        </div>
                      )}
                    </td>
                    <td className={`px-3 py-3 font-mono text-xs text-gray-600 whitespace-nowrap sticky ${selectable ? 'left-[244px]' : 'left-[200px]'} z-10 ${rowBg}`}>
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
                <td className="px-3 py-3 text-center"><YesNo value={a.keys_yn} label="Keys" /></td>
                <td className="px-3 py-3 text-center"><YesNo value={a.security_app_yn} label="Security app" /></td>
                <td className="px-3 py-3 text-center"><CountBadge value={a.metal_keys} /></td>
                <td className="px-3 py-3 text-center"><CountBadge value={a.key_cards} /></td>
                <td className="px-3 py-3 text-center"><CountBadge value={a.has_fob} /></td>
                <td className="px-3 py-3 text-center"><CountBadge value={a.dispenser_keys} /></td>
                {tab === 'customer' && <>
                  <td className="px-3 py-3 text-center"><RolePill value={a.contractor_keys} metal={a.contractor_metal} card={a.contractor_card} fob={a.contractor_fob} dispenser={a.contractor_dispenser} /></td>
                  <td className="px-3 py-3 text-center"><RolePill value={a.am_keys} metal={a.am_metal} card={a.am_card} fob={a.am_fob} dispenser={a.am_dispenser} /></td>
                  <td className="px-3 py-3 text-center"><RolePill value={a.ccm_keys} metal={a.ccm_metal} card={a.ccm_card} fob={a.ccm_fob} dispenser={a.ccm_dispenser} /></td>
                  <td className="px-3 py-3 text-center"><RolePill value={a.office_keys_held} metal={a.office_metal} card={a.office_card} fob={a.office_fob} dispenser={a.office_dispenser} /></td>
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

// ── Archived records table ─────────────────────────────────
function ArchivedTable({
  rows, loading, canDelete, isAdmin, onRestore, onPurge,
}: {
  rows: any[];
  loading: boolean;
  canDelete: boolean;
  isAdmin: boolean;
  onRestore: (id: number) => void;
  onPurge: (a: any) => void;
}) {
  return (
    <div className="card overflow-x-auto max-w-full">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="bg-[#1a1a1a] text-white text-xs">
            <th className="text-left px-4 py-3 font-medium whitespace-nowrap">Name</th>
            <th className="text-left px-3 py-3 font-medium whitespace-nowrap">BC #</th>
            <th className="text-center px-3 py-3 font-medium whitespace-nowrap">Type</th>
            <th className="text-left px-3 py-3 font-medium whitespace-nowrap">Archived by</th>
            <th className="text-left px-3 py-3 font-medium whitespace-nowrap">Archived on</th>
            <th className="text-right px-4 py-3 font-medium whitespace-nowrap">Actions</th>
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr><td colSpan={6} className="px-4 py-8 text-center text-cw-muted">Loading…</td></tr>
          ) : rows.length === 0 ? (
            <tr><td colSpan={6} className="px-4 py-8 text-center text-cw-muted">No archived records</td></tr>
          ) : rows.map((a, i) => {
            const rowBg = i % 2 === 0 ? 'bg-white' : 'bg-[#f4f4f2]';
            const bc = a.record_type === 'customer' ? a.bc_client_number : a.bc_vendor_number;
            return (
              <tr key={a.id} className={`border-b border-gray-100 ${rowBg}`}>
                <td className="px-4 py-3 font-medium text-[#1a1a1a] whitespace-nowrap max-w-[240px] truncate">{a.ic_company_name}</td>
                <td className="px-3 py-3 font-mono text-xs text-gray-600 whitespace-nowrap">{bc || '—'}</td>
                <td className="px-3 py-3 text-center"><TypeBadge type={a.record_type || 'ic'} /></td>
                <td className="px-3 py-3 text-xs text-gray-700 whitespace-nowrap">{a.archived_by || '—'}</td>
                <td className="px-3 py-3 text-xs text-gray-600 whitespace-nowrap">{a.archived_at ? new Date(a.archived_at + 'Z').toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'}</td>
                <td className="px-4 py-3 text-right whitespace-nowrap">
                  {canDelete ? (
                    <>
                      <button onClick={() => onRestore(a.id)} className="text-xs border border-[#1a1a1a] text-[#1a1a1a] rounded px-2.5 py-1 hover:bg-gray-50 transition-colors mr-2">Restore</button>
                      {isAdmin && (
                        <button onClick={() => onPurge(a)} className="text-xs border border-gray-300 text-gray-600 rounded px-2.5 py-1 hover:border-[#C0272D] hover:text-[#C0272D] transition-colors">Delete Permanently</button>
                      )}
                    </>
                  ) : (
                    <span className="text-xs text-gray-400">—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── People roster (Account Managers / CCMs) ────────────────
// Aggregates come pre-grouped from the backend (SQL GROUP BY + SUMs). Two zones:
//   PERSONALLY HOLDS   — keys in that person's own pocket (role-count fields)
//   ACROSS THEIR CLIENTS — every key that exists at the clients they manage
// Sorting is client-side over the small roster (one row per person).
const PERSONAL_COLS: { key: string; label: string }[] = [
  { key: 'personal_metal', label: 'Metal' },
  { key: 'personal_cards', label: 'Cards' },
  { key: 'personal_fobs', label: 'Fobs' },
  { key: 'personal_dispenser', label: 'Dispenser' },
];
const CLIENT_COLS: { key: string; label: string }[] = [
  { key: 'metal_keys', label: 'Metal' },
  { key: 'key_cards', label: 'Cards' },
  { key: 'key_fobs', label: 'Fobs' },
  { key: 'dispenser_keys', label: 'Dispenser' },
];
const RED_BORDER = 'border-l-2 border-[#C0272D]';

function MutedCount({ value }: { value: number }) {
  if (!value) return <span className="text-gray-300">—</span>;
  return <span className="text-gray-500 text-xs font-medium">{value}</span>;
}

function RosterTable({
  role, rows, loading, onSelect, onReassign, canReassign,
}: {
  role: 'am' | 'ccm';
  rows: any[];
  loading: boolean;
  onSelect: (person: string) => void;
  onReassign: (person: string) => void;
  canReassign: boolean;
}) {
  const [sortKey, setSortKey] = useState('total_held');
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
          {/* Zone header row */}
          <tr className="bg-[#1a1a1a] text-white text-[11px]">
            <th rowSpan={2} className="text-left px-4 py-3 font-medium whitespace-nowrap cursor-pointer select-none align-bottom" onClick={() => sort('person')}>{personLabel}{arrow('person')}</th>
            <th rowSpan={2} className="text-center px-3 py-3 font-medium whitespace-nowrap cursor-pointer select-none align-bottom" onClick={() => sort('clients_managed')}>Clients Managed{arrow('clients_managed')}</th>
            <th colSpan={5} className={`text-center px-3 py-2 font-bold uppercase tracking-wide whitespace-nowrap ${RED_BORDER}`}>Personally Holds</th>
            <th colSpan={5} className="text-center px-3 py-2 font-medium uppercase tracking-wide whitespace-nowrap text-white/50 border-l border-white/20">Across Their Clients</th>
            <th rowSpan={2} className="px-3 py-3 align-bottom"></th>
          </tr>
          {/* Column header row */}
          <tr className="bg-[#1a1a1a] text-white text-xs">
            {PERSONAL_COLS.map((c, idx) => (
              <th key={c.key} className={`text-center px-3 py-2 font-semibold whitespace-nowrap cursor-pointer select-none ${idx === 0 ? RED_BORDER : ''}`} onClick={() => sort(c.key)}>{c.label}{arrow(c.key)}</th>
            ))}
            <th className="text-center px-3 py-2 font-bold whitespace-nowrap cursor-pointer select-none" onClick={() => sort('total_held')}>Total Held{arrow('total_held')}</th>
            {CLIENT_COLS.map((c, idx) => (
              <th key={c.key} className={`text-center px-3 py-2 font-medium whitespace-nowrap cursor-pointer select-none text-white/60 ${idx === 0 ? 'border-l border-white/20' : ''}`} onClick={() => sort(c.key)}>{c.label}{arrow(c.key)}</th>
            ))}
            <th className="text-center px-3 py-2 font-medium whitespace-nowrap cursor-pointer select-none text-white/60" onClick={() => sort('total_client_keys')}>Total Client Keys{arrow('total_client_keys')}</th>
            <th className="px-3 py-2"></th>
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr><td colSpan={13} className="px-4 py-8 text-center text-cw-muted">Loading…</td></tr>
          ) : sorted.length === 0 ? (
            <tr><td colSpan={13} className="px-4 py-8 text-center text-cw-muted">No {personLabel.toLowerCase()}s found</td></tr>
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
                {/* Personally Holds — primary, red-bordered, per type */}
                {PERSONAL_COLS.map((c, idx) => (
                  <td key={c.key} className={`px-3 py-3 text-center ${idx === 0 ? RED_BORDER : ''}`}><CountBadge value={p[c.key]} /></td>
                ))}
                <td className="px-3 py-3 text-center">
                  <span className="inline-flex items-center justify-center min-w-[1.75rem] h-6 px-2 rounded-full bg-[#C0272D] text-white text-xs font-bold">{p.total_held}</span>
                </td>
                {/* Across Their Clients — secondary, muted */}
                {CLIENT_COLS.map((c, idx) => (
                  <td key={c.key} className={`px-3 py-3 text-center ${idx === 0 ? 'border-l border-gray-200' : ''}`}><MutedCount value={p[c.key]} /></td>
                ))}
                <td className="px-3 py-3 text-center text-gray-600 text-xs font-semibold">{p.total_client_keys || '—'}</td>
                <td className="px-3 py-3 text-right whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                  {canReassign && (
                    <button
                      onClick={() => onReassign(p.person)}
                      title={`Transfer ${p.person}'s clients to another manager`}
                      className="text-xs border border-[#1a1a1a] text-[#1a1a1a] rounded px-2.5 py-1 hover:border-[#C0272D] hover:text-[#C0272D] transition-colors"
                    >
                      Reassign
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── CW Boston Employees roster (managers + field crew) ─────
// One row per staff member. Keys Held (metal/card/fob/dispenser/other) come
// pre-aggregated from the backend, resolved against the live source data.
// Managers hold via their clients' holder grid; crew hold via open check-outs.
function StaffRoleBadges({ role_category, manager_type }: { role_category: string; manager_type: string | null }) {
  const badges: string[] = [];
  if (role_category === 'manager' || role_category === 'both') {
    if (manager_type === 'both') badges.push('AM', 'CCM');
    else if (manager_type === 'account_manager') badges.push('AM');
    else if (manager_type === 'ccm') badges.push('CCM');
    else badges.push('Mgr');
  }
  if (role_category === 'crew' || role_category === 'both') badges.push('Crew');
  return (
    <span className="inline-flex gap-1 flex-wrap">
      {badges.map((b) => (
        <span key={b} className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${b === 'Crew' ? 'border border-[#C0272D] text-[#C0272D]' : 'bg-[#1a1a1a] text-white'}`}>{b}</span>
      ))}
    </span>
  );
}

function KeysHeldCell({ s }: { s: any }) {
  const [open, setOpen] = useState(false);
  const total = s.total_keys_held;
  if (!total) return <span className="text-gray-300">—</span>;
  const parts = [
    s.keys_metal ? `${s.keys_metal} metal` : null,
    s.keys_card ? `${s.keys_card} card` : null,
    s.keys_fob ? `${s.keys_fob} fob` : null,
    s.keys_dispenser ? `${s.keys_dispenser} dispenser` : null,
    s.keys_other ? `${s.keys_other} other` : null,
  ].filter(Boolean);
  const text = parts.length ? parts.join(' · ') : 'No type breakdown recorded';
  return (
    <span className="relative inline-block">
      <button
        type="button"
        title={text}
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        onBlur={() => setOpen(false)}
        className="inline-flex items-center justify-center min-w-[1.5rem] h-6 px-1.5 rounded-full bg-[#1a1a1a] text-white text-xs font-semibold cursor-pointer hover:ring-2 hover:ring-[#C0272D]/50 focus:outline-none focus:ring-2 focus:ring-[#C0272D]"
      >
        {total}
      </button>
      {open && (
        <div onClick={(e) => e.stopPropagation()} className="absolute z-30 left-1/2 -translate-x-1/2 mt-1 whitespace-nowrap rounded border border-cw-border bg-white px-2 py-1 text-[11px] text-gray-700 shadow-lg">
          {text}
        </div>
      )}
    </span>
  );
}

const STAFF_CHIPS: { key: string; label: string; match: (rc: string) => boolean }[] = [
  { key: 'all', label: 'All', match: () => true },
  { key: 'managers', label: 'Managers', match: (rc) => rc === 'manager' || rc === 'both' },
  { key: 'crew', label: 'Crew', match: (rc) => rc === 'crew' || rc === 'both' },
];

function CWEmployeesTable({
  rows, loading, onSelect,
}: {
  rows: any[];
  loading: boolean;
  onSelect: (id: number) => void;
}) {
  const [sortKey, setSortKey] = useState('total_keys_held');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const sorted = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => {
      const av = a[sortKey], bv = b[sortKey];
      const cmp = typeof av === 'string' ? String(av).localeCompare(String(bv)) : ((av || 0) - (bv || 0));
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return copy;
  }, [rows, sortKey, sortDir]);

  const sort = (key: string) => {
    if (key === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir(key === 'name' ? 'asc' : 'desc'); }
  };
  const arrow = (key: string) => (key === sortKey ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '');

  return (
    <div className="card overflow-x-auto max-w-full">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="bg-[#1a1a1a] text-white text-xs">
            <th className="text-left px-4 py-3 font-medium whitespace-nowrap cursor-pointer select-none" onClick={() => sort('name')}>Name{arrow('name')}</th>
            <th className="text-left px-3 py-3 font-medium whitespace-nowrap">Role</th>
            <th className="text-left px-3 py-3 font-medium whitespace-nowrap">Shift</th>
            <th className="text-center px-3 py-3 font-medium whitespace-nowrap">Day/Night</th>
            <th className="text-center px-3 py-3 font-medium whitespace-nowrap">Keys Held</th>
            <th className="text-center px-3 py-3 font-medium whitespace-nowrap cursor-pointer select-none" onClick={() => sort('total_keys_held')}>Total Keys Held{arrow('total_keys_held')}</th>
            <th className="text-center px-3 py-3 font-medium whitespace-nowrap cursor-pointer select-none" onClick={() => sort('accounts_assigned')}>Accounts Assigned{arrow('accounts_assigned')}</th>
            <th className="text-center px-3 py-3 font-medium whitespace-nowrap">Active</th>
            <th className="px-3 py-3"></th>
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr><td colSpan={9} className="px-4 py-8 text-center text-cw-muted">Loading…</td></tr>
          ) : sorted.length === 0 ? (
            <tr><td colSpan={9} className="px-4 py-8 text-center text-cw-muted">No employees found</td></tr>
          ) : sorted.map((s, i) => {
            const rowBg = i % 2 === 0 ? 'bg-white' : 'bg-[#f4f4f2]';
            const shiftText = [s.shift ? `${s.shift} shift` : null, s.day_night ? s.day_night[0].toUpperCase() + s.day_night.slice(1) : null].filter(Boolean).join(' · ');
            return (
              <tr
                key={s.id}
                className={`cursor-pointer border-b border-gray-100 hover:bg-[#f0f0ee] transition-colors ${rowBg} ${s.active === 0 ? 'opacity-60' : ''}`}
                onClick={() => onSelect(s.id)}
                title="View this employee's keys + accounts"
              >
                <td className="px-4 py-3 font-medium text-[#1a1a1a] whitespace-nowrap">{s.name}</td>
                <td className="px-3 py-3"><StaffRoleBadges role_category={s.role_category} manager_type={s.manager_type} /></td>
                <td className="px-3 py-3 whitespace-nowrap">
                  {shiftText
                    ? <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border border-[#C0272D] text-[#C0272D]">{shiftText}</span>
                    : <span className="text-gray-300">—</span>}
                </td>
                <td className="px-3 py-3 text-center text-xs text-gray-600">{s.day_night ? s.day_night[0].toUpperCase() + s.day_night.slice(1) : '—'}</td>
                <td className="px-3 py-3 text-center"><KeysHeldCell s={s} /></td>
                <td className="px-3 py-3 text-center">
                  {s.total_keys_held
                    ? <span className="inline-flex items-center justify-center min-w-[1.75rem] h-6 px-2 rounded-full bg-[#C0272D] text-white text-xs font-bold">{s.total_keys_held}</span>
                    : <span className="text-gray-300">—</span>}
                </td>
                <td className="px-3 py-3 text-center"><CountBadge value={s.accounts_assigned} /></td>
                <td className="px-3 py-3 text-center">
                  {s.active === 1
                    ? <span className="text-[#2d7a3a] font-bold">✓</span>
                    : <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium bg-gray-200 text-gray-600">Inactive</span>}
                </td>
                <td className="px-3 py-3 text-right whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                  <div className="inline-flex items-center gap-2">
                    <ExportMenu
                      size="sm"
                      options={[
                        { label: 'Excel (.xlsx)', onSelect: () => exportEmployee(s.id, 'xlsx') },
                        { label: 'PDF (one-pager)', onSelect: () => exportEmployee(s.id, 'pdf') },
                      ]}
                    />
                    <button onClick={() => onSelect(s.id)} className="text-xs text-[#C0272D] hover:underline">View</button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Registry export modal ──────────────────────────────────
// Scope (current tab / entire registry), format (xlsx / csv), and an archived
// opt-in. Respects the active search so "what I see is what I get".
const EXPORT_TAB_LABEL: Record<string, string> = {
  customer: 'Customers', ic: 'IC Vendors', am: 'Account Managers', ccm: 'Contract Compliance Mgrs',
  office: 'Office', cwemployees: 'CW Employees', checkedout: 'Checked Out', checkedin: 'Checked In',
  all: 'All', archived: 'Archived',
};

function RegistryExportModal({
  tab, search, onClose,
}: {
  tab: TabType;
  search: string;
  onClose: () => void;
}) {
  const [scope, setScope] = useState<'current' | 'all'>('current');
  const [format, setFormat] = useState<'xlsx' | 'csv'>('xlsx');
  const [includeArchived, setIncludeArchived] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const run = async () => {
    setBusy(true); setError('');
    try {
      await exportRegistry({ scope, tab, format, search, includeArchived });
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Export failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Export Registry" onClose={onClose} width="max-w-md">
      <div className="space-y-5">
        <div>
          <SectionLabel>Scope</SectionLabel>
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
              <input type="radio" name="exp-scope" className="accent-[#C0272D]" checked={scope === 'current'} onChange={() => setScope('current')} />
              Current tab only <span className="text-gray-400">— {EXPORT_TAB_LABEL[tab] || tab}</span>
            </label>
            <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
              <input type="radio" name="exp-scope" className="accent-[#C0272D]" checked={scope === 'all'} onChange={() => setScope('all')} />
              Entire registry <span className="text-gray-400">— all tabs, one sheet each</span>
            </label>
          </div>
        </div>

        <div>
          <SectionLabel>Format</SectionLabel>
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
              <input type="radio" name="exp-format" className="accent-[#C0272D]" checked={format === 'xlsx'} onChange={() => setFormat('xlsx')} />
              Excel (.xlsx) <span className="text-gray-400">— recommended</span>
            </label>
            <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
              <input type="radio" name="exp-format" className="accent-[#C0272D]" checked={format === 'csv'} onChange={() => setFormat('csv')} />
              CSV (.csv)
            </label>
          </div>
        </div>

        <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
          <input type="checkbox" className="accent-[#C0272D] h-4 w-4" checked={includeArchived} onChange={(e) => setIncludeArchived(e.target.checked)} />
          Include archived records
        </label>

        <p className="text-[11px] text-gray-400">
          Access codes are never exported — a “Has Door Code” / “Has Alarm Code” column shows Yes/No instead. Respects your current search.
        </p>

        {error && <p className="text-sm text-[#C0272D] bg-[#fbeaea] border border-[#f0c9cb] rounded px-3 py-2">{error}</p>}
      </div>

      <div className="flex gap-2 pt-4 border-t border-gray-200 mt-4">
        <button onClick={run} disabled={busy} className="px-4 py-2 bg-[#C0272D] text-white text-sm font-medium rounded hover:bg-[#a82227] disabled:opacity-50 transition-colors">
          {busy ? 'Exporting…' : 'Export'}
        </button>
        <button onClick={onClose} className="px-4 py-2 border border-[#1a1a1a] text-[#1a1a1a] text-sm font-medium rounded hover:bg-gray-50 transition-colors">Cancel</button>
      </div>
    </Modal>
  );
}

// ── Main component ─────────────────────────────────────────

type ModalState =
  | { kind: 'add'; recordType: 'ic' | 'customer' }
  | { kind: 'edit'; recordType: 'ic' | 'customer'; initial: any }
  | null;

export default function Registry() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const isAdmin = getManager()?.role === 'admin';
  const canDelete = !!getManager()?.can_delete;
  const initialTab = searchParams.get('tab');
  const [tab, setTab] = useState<TabType>(
    (['archived', 'cwemployees', 'checkedout', 'checkedin'] as string[]).includes(initialTab || '')
      ? (initialTab as TabType)
      : 'customer'
  );
  const [accounts, setAccounts] = useState<any[]>([]);
  const [counts, setCounts] = useState({
    ic: 0, customer: 0, office: 0, staff: 0, all: 0, archived: 0, checkedOut: 0, checkedIn: 0,
  });
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<ModalState>(null);
  const [showImport, setShowImport] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [roster, setRoster] = useState<any[]>([]);
  const [rosterLoading, setRosterLoading] = useState(false);
  // CW Boston Employees (unified staff roster) — its own state + view filters.
  const [staff, setStaff] = useState<any[]>([]);
  const [staffLoading, setStaffLoading] = useState(false);
  const [staffChip, setStaffChip] = useState('all');
  const [staffSearch, setStaffSearch] = useState('');
  // When a roster person is clicked, drill into their client list.
  const [drill, setDrill] = useState<{ role: 'am' | 'ccm'; name: string } | null>(null);
  // Row selection + delete flows. The selected row is kept as a {id, name}
  // snapshot too, so it still pre-fills the custody modals after switching to a
  // tab whose row list no longer contains it.
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [selectedSnapshot, setSelectedSnapshot] = useState<{ id: number; name: string } | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<any | null>(null);
  const [archiveError, setArchiveError] = useState('');
  const [purgeTarget, setPurgeTarget] = useState<any | null>(null);
  const [purgeConfirm, setPurgeConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  // Key custody — the Check Out / In workflow, now inside the registry.
  const [custody, setCustody] = useState<Assignment[]>([]);
  const [custodyLoading, setCustodyLoading] = useState(false);
  const [custodyTotal, setCustodyTotal] = useState(0);
  const [custodySort, setCustodySort] = useState<SortState>({ key: 'checked_out_at', dir: 'desc' });
  const [checkOutOpen, setCheckOutOpen] = useState(false);
  const [checkInFor, setCheckInFor] = useState<
    { assignmentId: number | null; account: { id: number; name: string } | null } | null
  >(null);
  const [notice, setNotice] = useState('');
  const [reassign, setReassign] = useState<{ name: string | null; role: 'am' | 'ccm' } | null>(null);
  const LIMIT = 50;

  const isRosterTab = (tab === 'am' || tab === 'ccm') && !drill;
  const isStaffTab = tab === 'cwemployees' && !drill;
  const isArchivedTab = tab === 'archived' && !drill;
  const isCustodyTab = (tab === 'checkedout' || tab === 'checkedin') && !drill;
  // Tabs that render their OWN roster (no account list / account search box).
  const isPeopleTab = isRosterTab || isStaffTab;

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
      } else if (tab === 'archived') {
        params.type = 'all';
        params.archived = '1';
      } else if (tab === 'office') {
        // Office tab — customers where the Office holder physically holds keys.
        params.type = 'customer';
        params.office_keys = '1';
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

  // CW Employees — the full roster (incl. inactive so the Active column is
  // meaningful); category + search are applied client-side over the small list.
  const loadStaff = useCallback(async () => {
    setStaffLoading(true);
    try {
      const data = await getStaff({ includeInactive: true });
      setStaff(data);
    } finally {
      setStaffLoading(false);
    }
  }, []);

  // Key custody rows — Checked Out (active) or Checked In (returned history).
  // Sorting and search are applied server-side so they span the whole set.
  const loadCustody = useCallback(async () => {
    setCustodyLoading(true);
    try {
      const data = await getAssignments({
        status: tab === 'checkedin' ? 'returned' : 'checked_out',
        search: debouncedSearch,
        sort: custodySort.key,
        dir: custodySort.dir,
        page: String(page),
        limit: String(LIMIT),
      });
      setCustody(data.assignments);
      setCustodyTotal(data.total);
    } finally {
      setCustodyLoading(false);
    }
  }, [tab, debouncedSearch, custodySort, page]);

  useEffect(() => {
    if (isCustodyTab) loadCustody();
    else if (isStaffTab) loadStaff();
    else if (isRosterTab) loadRoster();
    else loadRows();
  }, [isCustodyTab, isStaffTab, isRosterTab, loadCustody, loadStaff, loadRoster, loadRows]);

  // Tab/type counts — independent of search, so they are NOT refetched while
  // typing. Refreshed on mount and after any mutation.
  const refreshCounts = useCallback(async () => {
    const [icData, custData, officeData, allData, archData, staffData, outData, inData] = await Promise.all([
      getAccounts({ limit: '1', type: 'ic' }),
      getAccounts({ limit: '1', type: 'customer' }),
      getAccounts({ limit: '1', type: 'customer', office_keys: '1' }),
      getAccounts({ limit: '1', type: 'all' }),
      getAccounts({ limit: '1', type: 'all', archived: '1' }),
      getStaff({ includeInactive: false }).catch(() => [] as any[]),
      getAssignments({ limit: '1', status: 'checked_out' }).catch(() => ({ total: 0, assignments: [] })),
      getAssignments({ limit: '1', status: 'returned' }).catch(() => ({ total: 0, assignments: [] })),
    ]);
    setCounts({
      ic: icData.total, customer: custData.total, office: officeData.total,
      staff: staffData.length, all: allData.total, archived: archData.total,
      checkedOut: outData.total, checkedIn: inData.total,
    });
  }, []);

  useEffect(() => { refreshCounts(); }, [refreshCounts]);

  const onRowClick = useCallback((id: number) => navigate(`/registry/${id}`), [navigate]);

  const openEditId = useCallback(async (id: number) => {
    const data = await getAccount(id);
    setModal({ kind: 'edit', recordType: data.record_type === 'customer' ? 'customer' : 'ic', initial: data });
  }, []);
  const openEdit = useCallback(async (e: React.MouseEvent, id: number) => {
    e.stopPropagation();
    await openEditId(id);
  }, [openEditId]);

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
    { key: 'office', label: `Office (${counts.office})` },
    { key: 'cwemployees', label: `CW Employees (${counts.staff})` },
    { key: 'checkedout', label: `Checked Out (${counts.checkedOut})` },
    { key: 'checkedin', label: `Checked In (${counts.checkedIn})` },
    { key: 'all', label: `All (${counts.all})` },
    { key: 'archived', label: `Archived (${counts.archived})` },
  ], [counts]);

  const DEEP_LINK_TABS: TabType[] = ['archived', 'cwemployees', 'checkedout', 'checkedin'];

  const selectTab = (key: TabType) => {
    setTab(key);
    setPage(1);
    setDrill(null);
    setStaffChip('all');
    setStaffSearch('');
    setNotice('');
    setCustodySort({ key: key === 'checkedin' ? 'returned_at' : 'checked_out_at', dir: 'desc' });
    setSearchParams(DEEP_LINK_TABS.includes(key) ? { tab: key } : {}, { replace: true });
  };
  const openPerson = (name: string) => {
    setDrill({ role: tab === 'am' ? 'am' : 'ccm', name });
    setPage(1);
  };
  const openStaff = useCallback((id: number) => navigate(`/staff/${id}`), [navigate]);

  const sortCustody = useCallback((key: string) => {
    setCustodySort((cur) => (cur.key === key
      ? { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' }
      : { key, dir: key === 'holder' || key === 'account_name' ? 'asc' : 'desc' }));
    setPage(1);
  }, []);

  // A custody change moves rows between the two tabs and shifts availability —
  // refresh both the visible list and the tab counts.
  const onCustodyChanged = useCallback(() => {
    refreshCounts();
    if (isCustodyTab) loadCustody();
  }, [refreshCounts, isCustodyTab, loadCustody]);

  // CW Employees — filter chip (role category) + search applied client-side.
  const filteredStaff = useMemo(() => {
    const chip = STAFF_CHIPS.find((c) => c.key === staffChip)!;
    const q = staffSearch.trim().toLowerCase();
    return staff.filter((s) =>
      chip.match(s.role_category) &&
      (!q || s.name.toLowerCase().includes(q) || (s.email || '').toLowerCase().includes(q))
    );
  }, [staff, staffChip, staffSearch]);

  const selectedAccount = accounts.find((a) => a.id === selectedId) || null;

  const toggleSelect = useCallback((id: number) => {
    setSelectedId((cur) => (cur === id ? null : id));
    setSelectedSnapshot((cur) => {
      if (cur?.id === id) return null;
      const row = accounts.find((a) => a.id === id);
      return row ? { id: row.id, name: row.ic_company_name } : null;
    });
  }, [accounts]);

  const doArchive = async () => {
    if (!archiveTarget) return;
    setBusy(true); setArchiveError('');
    try {
      await archiveAccount(archiveTarget.id);
      setArchiveTarget(null);
      setSelectedId(null);
      loadRows();
      refreshCounts();
    } catch (err: any) {
      setArchiveError(err?.message || 'Could not archive');
    } finally { setBusy(false); }
  };

  // Clears the amber pill once the metal has actually changed hands.
  const doConfirmHandover = async () => {
    if (!selectedAccount) return;
    setBusy(true);
    try {
      await confirmHandover([selectedAccount.id]);
      setNotice(`Physical handover confirmed for ${selectedAccount.ic_company_name}.`);
      loadRows();
    } catch (err: any) {
      setNotice(err?.message || 'Could not confirm the handover');
    } finally { setBusy(false); }
  };

  const doRestore = async (id: number) => {
    setBusy(true);
    try {
      await restoreAccount(id);
      loadRows();
      refreshCounts();
    } finally { setBusy(false); }
  };

  const doPurge = async () => {
    if (!purgeTarget || purgeConfirm !== 'DELETE') return;
    setBusy(true);
    try {
      await purgeAccount(purgeTarget.id, purgeConfirm);
      setPurgeTarget(null);
      setPurgeConfirm('');
      loadRows();
      refreshCounts();
    } finally { setBusy(false); }
  };

  // When drilled in, the client list uses the Customer column layout.
  // col counts incl. leading checkbox: customer=22 (site Metal/Card/Fob/Dispenser
  // + IC/AM/CCM/Office role pills), all=16, ic=15 (no role pills — Office is a
  // holder concept that only applies to customer accounts).
  const tableTab: TabType = drill || tab === 'office' ? 'customer' : tab;
  // Base counts include the leading checkbox column; drop it without delete rights.
  const baseColSpan = tableTab === 'customer' ? 22 : tableTab === 'all' ? 16 : 15;
  const colSpan = canDelete ? baseColSpan : baseColSpan - 1;

  // Lower-frequency header actions, grouped under ⋯ More. Selection-dependent
  // entries stay listed but disabled, with the reason spelled out — a hidden
  // action is indistinguishable from a missing one.
  const moreActions: ActionItem[] = [
    ...(canDelete || isAdmin ? [{
      label: 'Reassign Manager…',
      onSelect: () => setReassign({ name: null, role: 'am' as const }),
    }] : []),
    { label: 'Export…', onSelect: () => setShowExport(true), separated: canDelete || isAdmin },
    ...(canDelete ? [
      {
        label: 'Edit Account',
        onSelect: () => selectedAccount && openEditId(selectedAccount.id),
        disabled: !selectedAccount,
        hint: 'Select a client row first',
        separated: true,
      },
      {
        label: 'Delete Account',
        onSelect: () => { setArchiveError(''); setArchiveTarget(selectedAccount); },
        disabled: !selectedAccount,
        hint: 'Select a client row first',
        danger: true,
      },
    ] : []),
  ];

  return (
    <Layout>
      <div className="p-6 max-w-full mx-auto space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-[#1a1a1a]">Key Registry</h1>
            <p className="text-sm text-cw-muted">
              {isCustodyTab
                ? `${custodyTotal} ${tab === 'checkedin' ? 'returned' : 'active'} custody record${custodyTotal !== 1 ? 's' : ''}`
                : `${total} record${total !== 1 ? 's' : ''}`}
            </p>
          </div>
          {/* ── Action row ────────────────────────────────────────────────
              Visible: the five high-frequency daily actions. Everything
              lower-frequency (Reassign Manager, Export, Edit, Delete) lives in
              the ⋯ More overflow so this row stays scannable. The handover
              confirm is contextual — it only exists while a flagged row is
              selected, so it adds no permanent clutter. */}
          <div className="flex flex-wrap gap-2 justify-end items-start">
            <button
              onClick={() => setCheckOutOpen(true)}
              title={selectedSnapshot ? `Pre-filled with ${selectedSnapshot.name}` : 'Check keys out to an employee or IC'}
              className="px-4 py-2 bg-[#C0272D] text-white text-sm font-medium rounded hover:bg-[#a82227] transition-colors"
            >
              ↗ Check Out Keys
            </button>
            <button
              onClick={() => setCheckInFor({ assignmentId: null, account: selectedSnapshot })}
              title={selectedSnapshot ? `Pre-filled with ${selectedSnapshot.name}` : 'Record returned keys'}
              className="px-4 py-2 border border-[#1a1a1a] text-[#1a1a1a] text-sm font-medium rounded hover:border-[#C0272D] hover:text-[#C0272D] transition-colors"
            >
              ↙ Check In Keys
            </button>
            <span className="w-px bg-cw-border self-stretch mx-1" aria-hidden="true" />
            <button onClick={() => openAdd('customer')} className="px-4 py-2 bg-[#C0272D] text-white text-sm font-medium rounded hover:bg-[#a82227] transition-colors">
              + Add Customer
            </button>
            <button onClick={() => openAdd('ic')} className="px-4 py-2 border border-cw-border text-cw-text text-sm font-medium rounded hover:bg-gray-50 transition-colors">
              + Add IC
            </button>
            <button onClick={() => setShowImport(true)} className="px-4 py-2 border border-[#1a1a1a] text-[#1a1a1a] text-sm font-medium rounded hover:border-[#C0272D] hover:text-[#C0272D] transition-colors">
              ↑ Import from Excel
            </button>

            {(canDelete || isAdmin) && selectedAccount?.pending_handover && (
              <button
                onClick={doConfirmHandover}
                disabled={busy}
                title={`Mark the physical keys for ${selectedAccount.ic_company_name} as handed over`}
                className="px-4 py-2 border border-[#e8cf8a] bg-[#fff8e6] text-[#7a5a00] text-sm font-medium rounded hover:border-[#C0272D] hover:text-[#C0272D] disabled:opacity-50 transition-colors"
              >
                ✓ Confirm physical handover
              </button>
            )}

            <ActionMenu items={moreActions} />
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

        {/* Transient notice (sign-off link re-sends, email outcomes) */}
        {notice && (
          <div className="flex items-center justify-between gap-3 text-sm bg-[#f4f4f2] border border-cw-border rounded px-3 py-2 text-cw-text">
            <span>{notice}</span>
            <button onClick={() => setNotice('')} className="text-cw-muted hover:text-cw-text">×</button>
          </div>
        )}

        {/* Search — not shown on the pure people-roster tabs (they have their own) */}
        {!isPeopleTab && (
          <input
            className="input max-w-xs focus:ring-[#C0272D] focus:border-[#C0272D]"
            placeholder={isCustodyTab ? 'Search by holder, client, or key…' : 'Search by name, number, or manager…'}
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          />
        )}

        {/* CW Employees filter chips + search */}
        {isStaffTab && (
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex border-b border-cw-border gap-6">
              {STAFF_CHIPS.map((c) => (
                <button
                  key={c.key}
                  onClick={() => setStaffChip(c.key)}
                  className={`pb-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
                    staffChip === c.key ? 'border-[#C0272D] text-[#C0272D]' : 'border-transparent text-[#6b6b68] hover:text-[#1a1a1a]'
                  }`}
                >
                  {c.label}
                </button>
              ))}
            </div>
            <div className="flex-1" />
            <input
              className="input max-w-xs focus:ring-[#C0272D] focus:border-[#C0272D]"
              placeholder="Search by name or email…"
              value={staffSearch}
              onChange={(e) => setStaffSearch(e.target.value)}
            />
          </div>
        )}

        {/* Custody · Roster (AMs / CCMs) · CW Employees · Archived · client table */}
        {isCustodyTab ? (
          tab === 'checkedout' ? (
            <CheckedOutTable
              rows={custody}
              loading={custodyLoading}
              sort={custodySort}
              onSort={sortCustody}
              onCheckIn={(a) => setCheckInFor({
                assignmentId: a.id,
                account: a.account_id ? { id: a.account_id, name: a.account_name } : null,
              })}
              onNotice={setNotice}
            />
          ) : (
            <CheckedInTable
              rows={custody}
              loading={custodyLoading}
              sort={custodySort}
              onSort={sortCustody}
            />
          )
        ) : isStaffTab ? (
          <CWEmployeesTable
            rows={filteredStaff}
            loading={staffLoading}
            onSelect={openStaff}
          />
        ) : isRosterTab ? (
          <RosterTable
            role={tab as 'am' | 'ccm'}
            rows={roster}
            loading={rosterLoading}
            onSelect={openPerson}
            canReassign={canDelete || isAdmin}
            onReassign={(person) => setReassign({ name: person, role: tab === 'ccm' ? 'ccm' : 'am' })}
          />
        ) : isArchivedTab ? (
          <ArchivedTable
            rows={accounts}
            loading={loading}
            canDelete={canDelete}
            isAdmin={isAdmin}
            onRestore={doRestore}
            onPurge={(a) => { setPurgeConfirm(''); setPurgeTarget(a); }}
          />
        ) : (
          <RegistryTable
            tab={tableTab}
            accounts={accounts}
            loading={loading}
            colSpan={colSpan}
            selectable
            selectedId={selectedId}
            onToggleSelect={toggleSelect}
            onRowClick={onRowClick}
            onEdit={openEdit}
          />
        )}

        {/* Pagination */}
        {(() => {
          const count = isCustodyTab ? custodyTotal : total;
          if (isPeopleTab || count <= LIMIT) return null;
          return (
            <div className="flex items-center gap-3 justify-center">
              <button className="btn-secondary" disabled={page === 1} onClick={() => setPage(p => p - 1)}>← Prev</button>
              <span className="text-sm text-cw-muted">Page {page} of {Math.ceil(count / LIMIT)}</span>
              <button className="btn-secondary" disabled={page * LIMIT >= count} onClick={() => setPage(p => p + 1)}>Next →</button>
            </div>
          );
        })()}
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

      {showExport && (
        <RegistryExportModal tab={tab} search={debouncedSearch} onClose={() => setShowExport(false)} />
      )}

      {/* Key custody — both modals open within the registry context and pre-fill
          the client from the selected row. */}
      {checkOutOpen && (
        <CheckOutModal
          presetAccount={selectedSnapshot}
          onClose={() => setCheckOutOpen(false)}
          onDone={onCustodyChanged}
        />
      )}

      {reassign && (
        <ReassignModal
          sourceName={reassign.name ?? undefined}
          role={reassign.name ? reassign.role : undefined}
          onClose={() => setReassign(null)}
          onDone={() => { loadRoster(); refreshCounts(); }}
        />
      )}

      {checkInFor && (
        <CheckInModal
          presetAccount={checkInFor.account}
          presetAssignmentId={checkInFor.assignmentId}
          onClose={() => setCheckInFor(null)}
          onDone={onCustodyChanged}
        />
      )}

      {/* Archive confirmation */}
      {archiveTarget && (
        <Modal title="Archive account" onClose={() => setArchiveTarget(null)} width="max-w-md">
          <p className="text-sm text-cw-text">
            Archive <span className="font-semibold">{archiveTarget.ic_company_name}</span>? The record leaves the
            registry but its history is preserved. You can restore it later.
          </p>
          {archiveError && (
            <p className="mt-3 text-sm text-[#C0272D] bg-[#fbeaea] border border-[#f0c9cb] rounded px-3 py-2">{archiveError}</p>
          )}
          <div className="flex gap-2 pt-4 border-t border-gray-200 mt-4">
            <button onClick={doArchive} disabled={busy} className="px-4 py-2 bg-[#C0272D] text-white text-sm font-medium rounded hover:bg-[#a82227] disabled:opacity-50 transition-colors">
              {busy ? 'Archiving…' : 'Archive'}
            </button>
            <button onClick={() => setArchiveTarget(null)} className="px-4 py-2 border border-[#1a1a1a] text-[#1a1a1a] text-sm font-medium rounded hover:bg-gray-50 transition-colors">Cancel</button>
          </div>
        </Modal>
      )}

      {/* Permanent delete (admin) — typed confirmation */}
      {purgeTarget && (
        <Modal title="Delete permanently" onClose={() => { setPurgeTarget(null); setPurgeConfirm(''); }} width="max-w-md">
          <p className="text-sm text-cw-text">
            This permanently deletes <span className="font-semibold">{purgeTarget.ic_company_name}</span>. This cannot
            be undone. Its audit history is retained. Type <span className="font-mono font-bold">DELETE</span> to confirm.
          </p>
          <input
            className="input mt-3 focus:ring-[#C0272D] focus:border-[#C0272D]"
            placeholder="DELETE"
            value={purgeConfirm}
            onChange={(e) => setPurgeConfirm(e.target.value)}
            autoFocus
          />
          <div className="flex gap-2 pt-4 border-t border-gray-200 mt-4">
            <button onClick={doPurge} disabled={busy || purgeConfirm !== 'DELETE'} className="px-4 py-2 bg-[#C0272D] text-white text-sm font-medium rounded hover:bg-[#a82227] disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
              {busy ? 'Deleting…' : 'Delete Permanently'}
            </button>
            <button onClick={() => { setPurgeTarget(null); setPurgeConfirm(''); }} className="px-4 py-2 border border-[#1a1a1a] text-[#1a1a1a] text-sm font-medium rounded hover:bg-gray-50 transition-colors">Cancel</button>
          </div>
        </Modal>
      )}
    </Layout>
  );
}
