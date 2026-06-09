import { useEffect, useState, useCallback } from 'react';
import Layout from '../components/Layout';
import Badge from '../components/Badge';
import Modal from '../components/Modal';
import { getAccounts, getAccount, createAccount, updateAccount } from '../lib/api';

const emptyForm = {
  name: '', total_keys: 0, am_keys: 0, ccm_keys: 0, contractor_keys: 0,
  key_code: '', lockbox: '', has_fob: false, notes: '', status: 'active',
};

export default function Registry() {
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
    setForm({ ...account, has_fob: !!account.has_fob });
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
                <th className="text-center px-3 py-3 font-medium">Total</th>
                <th className="text-center px-3 py-3 font-medium">AM</th>
                <th className="text-center px-3 py-3 font-medium">CCM</th>
                <th className="text-center px-3 py-3 font-medium">IC</th>
                <th className="text-center px-3 py-3 font-medium">Fob</th>
                <th className="text-center px-3 py-3 font-medium">Lockbox</th>
                <th className="text-center px-3 py-3 font-medium">Codes</th>
                <th className="text-left px-3 py-3 font-medium">Notes</th>
                <th className="px-3 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-cw-border">
              {loading ? (
                <tr><td colSpan={10} className="px-4 py-8 text-center text-cw-muted">Loading…</td></tr>
              ) : accounts.length === 0 ? (
                <tr><td colSpan={10} className="px-4 py-8 text-center text-cw-muted">No accounts found</td></tr>
              ) : (
                accounts.map((a) => (
                  <tr key={a.id} className="hover:bg-gray-50 cursor-pointer" onClick={() => openDetail(a.id)}>
                    <td className="px-4 py-3 font-medium text-cw-text max-w-[200px] truncate">{a.name}</td>
                    <td className="px-3 py-3 text-center">
                      <span className="font-semibold">{a.total_keys}</span>
                    </td>
                    <td className="px-3 py-3 text-center text-cw-muted">{a.am_keys || '–'}</td>
                    <td className="px-3 py-3 text-center text-cw-muted">{a.ccm_keys || '–'}</td>
                    <td className="px-3 py-3 text-center text-cw-muted">{a.contractor_keys || '–'}</td>
                    <td className="px-3 py-3 text-center">{a.has_fob ? <Badge variant="blue">FOB</Badge> : '–'}</td>
                    <td className="px-3 py-3 text-center text-cw-muted">{a.lockbox || '–'}</td>
                    <td className="px-3 py-3 text-center">
                      <div className="flex gap-1 justify-center">
                        {a.alarm_code_encrypted && <Badge variant="yellow">Alarm</Badge>}
                        {a.door_code_encrypted && <Badge variant="gray">Door</Badge>}
                        {!a.alarm_code_encrypted && !a.door_code_encrypted && <span className="text-cw-muted">–</span>}
                      </div>
                    </td>
                    <td className="px-3 py-3 text-cw-muted text-xs max-w-[200px] truncate">{a.notes || '–'}</td>
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

      {/* Detail Modal */}
      {selected && !showEdit && (
        <Modal title={selected.name} onClose={() => setSelected(null)} width="max-w-2xl">
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-4 text-sm">
              <div><div className="text-xs text-cw-muted">Total Keys</div><div className="font-semibold">{selected.total_keys}</div></div>
              <div><div className="text-xs text-cw-muted">AM Keys</div><div className="font-semibold">{selected.am_keys}</div></div>
              <div><div className="text-xs text-cw-muted">CCM Keys</div><div className="font-semibold">{selected.ccm_keys}</div></div>
              <div><div className="text-xs text-cw-muted">IC Keys</div><div className="font-semibold">{selected.contractor_keys}</div></div>
              <div><div className="text-xs text-cw-muted">Fob</div><div>{selected.has_fob ? <Badge variant="blue">Yes</Badge> : '–'}</div></div>
              <div><div className="text-xs text-cw-muted">Lockbox #</div><div className="font-semibold">{selected.lockbox || '–'}</div></div>
            </div>
            {selected.notes && (
              <div className="bg-yellow-50 border border-yellow-200 rounded p-3 text-sm text-yellow-800">
                <span className="font-medium">Notes: </span>{selected.notes}
              </div>
            )}
            <div className="flex gap-2">
              {selected.alarm_code_encrypted && <Badge variant="yellow">Has Alarm Code (see Vault)</Badge>}
              {selected.door_code_encrypted && <Badge variant="gray">Has Door Code (see Vault)</Badge>}
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
              <button onClick={() => openEdit(selected)} className="btn-primary">Edit Account</button>
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
        >
          <div className="space-y-3">
            {[
              { label: 'Account Name', key: 'name', type: 'text' },
              { label: 'Total Keys', key: 'total_keys', type: 'number' },
              { label: 'AM Keys', key: 'am_keys', type: 'number' },
              { label: 'CCM Keys', key: 'ccm_keys', type: 'number' },
              { label: 'IC Keys', key: 'contractor_keys', type: 'number' },
              { label: 'Key Code', key: 'key_code', type: 'text' },
              { label: 'Lockbox #', key: 'lockbox', type: 'text' },
            ].map(({ label, key, type }) => (
              <div key={key}>
                <label className="block text-xs font-medium text-cw-muted mb-1">{label}</label>
                <input
                  type={type}
                  className="input"
                  value={(form as any)[key]}
                  onChange={(e) => setForm({ ...form, [key]: type === 'number' ? Number(e.target.value) : e.target.value })}
                />
              </div>
            ))}
            <div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={form.has_fob} onChange={(e) => setForm({ ...form, has_fob: e.target.checked })} />
                Has Key Fob
              </label>
            </div>
            <div>
              <label className="block text-xs font-medium text-cw-muted mb-1">Notes</label>
              <textarea className="input h-20 resize-none" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </div>
            <div className="flex gap-2 pt-2">
              <button onClick={showAdd ? saveNew : saveEdit} disabled={saving} className="btn-primary">
                {saving ? 'Saving…' : 'Save'}
              </button>
              <button onClick={() => { setShowEdit(false); setShowAdd(false); }} className="btn-secondary">Cancel</button>
            </div>
          </div>
        </Modal>
      )}
    </Layout>
  );
}
