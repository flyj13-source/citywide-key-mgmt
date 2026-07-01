import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import Layout from '../components/Layout';
import Badge from '../components/Badge';
import Modal from '../components/Modal';
import { getAccounts, getAccount, createAccount, updateAccount } from '../lib/api';

const emptyForm = {
  name: '', total_keys: 0, am_keys: 0, ccm_keys: 0, contractor_keys: 0, dispenser_keys: 0,
  key_code: '', lockbox: '', has_fob: false, notes: '', status: 'active',
  ic_name: '', ic_id_number: '', customer_id: '',
  door_code: '', alarm_code: '', door_access_code: '',
};

function FieldGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs font-semibold text-cw-muted uppercase tracking-wide mb-2 border-b border-cw-border pb-1">{title}</div>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function Field({ label, fieldKey, type = 'text', form, setForm, hint }: {
  label: string; fieldKey: string; type?: string; form: any; setForm: (f: any) => void; hint?: string;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-cw-muted mb-1">{label}{hint && <span className="ml-1 text-gray-400 font-normal">— {hint}</span>}</label>
      <input
        type={type}
        className="input"
        value={form[fieldKey] ?? ''}
        onChange={(e) => setForm({ ...form, [fieldKey]: type === 'number' ? Number(e.target.value) : e.target.value })}
      />
    </div>
  );
}

export default function Registry() {
  const navigate = useNavigate();
  const [accounts, setAccounts] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<any>(null);
  const [showEdit, setShowEdit] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ ...emptyForm });
  const [saving, setSaving] = useState(false);
  const LIMIT = 50;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getAccounts({ search, page: String(page), limit: String(LIMIT) });
      setAccounts(data.accounts);
      setTotal(data.total);
    } finally {
      setLoading(false);
    }
  }, [search, page]);

  useEffect(() => { load(); }, [load]);

  const openDetail = async (id: number) => {
    const data = await getAccount(id);
    setSelected(data);
  };

  const openEdit = (account: any) => {
    setForm({ ...emptyForm, ...account, has_fob: !!account.has_fob });
    setShowEdit(true);
  };

  const saveEdit = async () => {
    setSaving(true);
    try {
      await updateAccount(selected?.id || form.name, form);
      setShowEdit(false);
      load();
    } finally {
      setSaving(false);
    }
  };

  const saveNew = async () => {
    setSaving(true);
    try {
      await createAccount(form);
      setShowAdd(false);
      setForm({ ...emptyForm });
      load();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Layout>
      <div className="p-6 max-w-7xl mx-auto space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold">Key Registry</h1>
            <p className="text-sm text-cw-muted">{total} accounts</p>
          </div>
          <button onClick={() => { setForm({ ...emptyForm }); setShowAdd(true); }} className="btn-primary">
            + Add Account
          </button>
        </div>

        <div className="flex gap-3">
          <input
            className="input max-w-xs"
            placeholder="Search accounts…"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          />
        </div>

        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-cw-black text-white text-xs">
                <th className="text-left px-4 py-3 font-medium">Account</th>
                <th className="text-left px-3 py-3 font-medium">Customer ID</th>
                <th className="text-center px-3 py-3 font-medium">Total</th>
                <th className="text-center px-3 py-3 font-medium">AM</th>
                <th className="text-center px-3 py-3 font-medium">CCM</th>
                <th className="text-center px-3 py-3 font-medium">IC</th>
                <th className="text-center px-3 py-3 font-medium">Disp.</th>
                <th className="text-left px-3 py-3 font-medium">IC Name</th>
                <th className="text-center px-3 py-3 font-medium">Fob</th>
                <th className="text-center px-3 py-3 font-medium">Codes</th>
                <th className="px-3 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-cw-border">
              {loading ? (
                <tr><td colSpan={11} className="px-4 py-8 text-center text-cw-muted">Loading…</td></tr>
              ) : accounts.length === 0 ? (
                <tr><td colSpan={11} className="px-4 py-8 text-center text-cw-muted">No accounts found</td></tr>
              ) : (
                accounts.map((a) => (
                  <tr
                    key={a.id}
                    className="hover:bg-gray-50 cursor-pointer"
                    onClick={() => navigate(`/registry/${a.id}`)}
                  >
                    <td className="px-4 py-3 font-medium text-cw-text max-w-[180px] truncate">{a.name}</td>
                    <td className="px-3 py-3 text-cw-muted text-xs font-mono">{a.customer_id || '–'}</td>
                    <td className="px-3 py-3 text-center"><span className="font-semibold">{a.total_keys}</span></td>
                    <td className="px-3 py-3 text-center text-cw-muted">{a.am_keys || '–'}</td>
                    <td className="px-3 py-3 text-center text-cw-muted">{a.ccm_keys || '–'}</td>
                    <td className="px-3 py-3 text-center text-cw-muted">{a.contractor_keys || '–'}</td>
                    <td className="px-3 py-3 text-center text-cw-muted">{a.dispenser_keys || '–'}</td>
                    <td className="px-3 py-3 text-xs text-cw-muted max-w-[120px] truncate">{a.ic_name || '–'}</td>
                    <td className="px-3 py-3 text-center">{a.has_fob ? <Badge variant="blue">FOB</Badge> : '–'}</td>
                    <td className="px-3 py-3 text-center">
                      <div className="flex gap-1 justify-center flex-wrap">
                        {a.alarm_code_encrypted && <Badge variant="yellow">Alarm</Badge>}
                        {a.door_code_encrypted && <Badge variant="gray">Door</Badge>}
                        {a.door_access_code_encrypted && <Badge variant="gray">Access</Badge>}
                        {!a.alarm_code_encrypted && !a.door_code_encrypted && !a.door_access_code_encrypted && <span className="text-cw-muted">–</span>}
                      </div>
                    </td>
                    <td className="px-3 py-3" onClick={(e) => e.stopPropagation()}>
                      <button
                        onClick={() => { openDetail(a.id).then(() => openEdit(a)); }}
                        className="text-xs text-cw-red hover:underline"
                      >Edit</button>
                    </td>
                  </tr>
                ))
              )}
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

      {/* Detail Modal (quick view, not full detail page) */}
      {selected && !showEdit && (
        <Modal title={selected.name} onClose={() => setSelected(null)} width="max-w-2xl">
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-4 text-sm">
              <div><div className="text-xs text-cw-muted">Customer ID</div><div className="font-mono text-sm">{selected.customer_id || '–'}</div></div>
              <div><div className="text-xs text-cw-muted">Total Keys</div><div className="font-semibold">{selected.total_keys}</div></div>
              <div><div className="text-xs text-cw-muted">AM Keys</div><div className="font-semibold">{selected.am_keys}</div></div>
              <div><div className="text-xs text-cw-muted">CCM Keys</div><div className="font-semibold">{selected.ccm_keys}</div></div>
              <div><div className="text-xs text-cw-muted">IC Keys</div><div className="font-semibold">{selected.contractor_keys}</div></div>
              <div><div className="text-xs text-cw-muted">Dispenser Keys</div><div className="font-semibold">{selected.dispenser_keys || 0}</div></div>
              <div><div className="text-xs text-cw-muted">IC Name</div><div className="font-semibold">{selected.ic_name || '–'}</div></div>
              <div><div className="text-xs text-cw-muted">IC ID #</div><div className="font-semibold">{selected.ic_id_number || '–'}</div></div>
              <div><div className="text-xs text-cw-muted">Fob</div><div>{selected.has_fob ? <Badge variant="blue">Yes</Badge> : '–'}</div></div>
              <div><div className="text-xs text-cw-muted">Lockbox #</div><div className="font-semibold">{selected.lockbox || '–'}</div></div>
            </div>
            {selected.notes && (
              <div className="bg-yellow-50 border border-yellow-200 rounded p-3 text-sm text-yellow-800">
                <span className="font-medium">Notes: </span>{selected.notes}
              </div>
            )}
            <div className="flex gap-2 flex-wrap">
              {selected.alarm_code_encrypted && <Badge variant="yellow">Has Alarm Code (see Vault)</Badge>}
              {selected.door_code_encrypted && <Badge variant="gray">Has Door Code (see Vault)</Badge>}
              {selected.door_access_code_encrypted && <Badge variant="gray">Has Door Access Code (see Vault)</Badge>}
            </div>

            {selected.assignments?.length > 0 && (
              <div>
                <div className="text-xs font-medium text-cw-muted uppercase mb-2">Assignment History</div>
                <div className="space-y-2">
                  {selected.assignments.map((a: any) => (
                    <div key={a.id} className="flex items-center justify-between text-sm border border-cw-border rounded px-3 py-2">
                      <div>
                        <span className="font-medium">{a.assignee}</span>
                        {a.keys_held && <span className="text-cw-muted ml-2 text-xs">({a.keys_held})</span>}
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge variant={a.status === 'checked_out' ? 'yellow' : 'green'}>
                          {a.status === 'checked_out' ? 'Out' : 'Returned'}
                        </Badge>
                        <span className="text-xs text-cw-muted">{new Date(a.checked_out_at).toLocaleDateString()}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="flex gap-2 pt-2">
              <button onClick={() => navigate(`/registry/${selected.id}`)} className="btn-primary">Full Detail →</button>
              <button onClick={() => openEdit(selected)} className="btn-secondary">Edit Account</button>
              <button onClick={() => setSelected(null)} className="btn-secondary">Close</button>
            </div>
          </div>
        </Modal>
      )}

      {/* Edit/Add Modal */}
      {(showEdit || showAdd) && (
        <Modal
          title={showAdd ? 'Add Account' : `Edit: ${form.name}`}
          onClose={() => { setShowEdit(false); setShowAdd(false); }}
          width="max-w-2xl"
        >
          <div className="space-y-5 max-h-[70vh] overflow-y-auto pr-1">
            <FieldGroup title="Account Info">
              <Field label="Account Name" fieldKey="name" form={form} setForm={setForm} />
              <div>
                <label className="block text-xs font-medium text-cw-muted mb-1">Status</label>
                <select className="input" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                </select>
              </div>
            </FieldGroup>

            <FieldGroup title="Key Counts">
              <div className="grid grid-cols-2 gap-2">
                {[
                  { label: 'Total Keys', fieldKey: 'total_keys' },
                  { label: 'AM Keys', fieldKey: 'am_keys' },
                  { label: 'CCM Keys', fieldKey: 'ccm_keys' },
                  { label: 'IC Keys', fieldKey: 'contractor_keys' },
                  { label: 'Dispenser Keys', fieldKey: 'dispenser_keys' },
                ].map(({ label, fieldKey }) => (
                  <Field key={fieldKey} label={label} fieldKey={fieldKey} type="number" form={form} setForm={setForm} />
                ))}
              </div>
            </FieldGroup>

            <FieldGroup title="IC Assignment">
              <div className="grid grid-cols-2 gap-2">
                <Field label="IC Name" fieldKey="ic_name" form={form} setForm={setForm} />
                <Field label="IC ID Number" fieldKey="ic_id_number" form={form} setForm={setForm} />
              </div>
            </FieldGroup>

            <FieldGroup title="Customer Info">
              <Field label="Customer ID" fieldKey="customer_id" form={form} setForm={setForm} hint="Unique billing / QuickBooks account number" />
            </FieldGroup>

            <FieldGroup title="Access Codes">
              <div className="grid grid-cols-1 gap-2">
                <Field label="Door Code" fieldKey="door_code" form={form} setForm={setForm} />
                <Field label="Alarm Code" fieldKey="alarm_code" form={form} setForm={setForm} />
                <Field label="Door Access Code" fieldKey="door_access_code" form={form} setForm={setForm} />
              </div>
              <p className="text-xs text-cw-muted">Codes are encrypted at rest. Leave blank to keep existing value.</p>
            </FieldGroup>

            <FieldGroup title="Other">
              <div className="grid grid-cols-2 gap-2">
                <Field label="Key Code" fieldKey="key_code" form={form} setForm={setForm} />
                <Field label="Lockbox #" fieldKey="lockbox" form={form} setForm={setForm} />
              </div>
              <div>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={!!form.has_fob} onChange={(e) => setForm({ ...form, has_fob: e.target.checked })} />
                  Has Key Fob
                </label>
              </div>
              <div>
                <label className="block text-xs font-medium text-cw-muted mb-1">Notes</label>
                <textarea className="input h-20 resize-none" value={form.notes ?? ''} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
              </div>
            </FieldGroup>
          </div>
          <div className="flex gap-2 pt-4 border-t border-cw-border mt-4">
            <button onClick={showAdd ? saveNew : saveEdit} disabled={saving} className="btn-primary">
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button onClick={() => { setShowEdit(false); setShowAdd(false); }} className="btn-secondary">Cancel</button>
          </div>
        </Modal>
      )}
    </Layout>
  );
}
