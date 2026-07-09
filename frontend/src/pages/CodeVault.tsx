import { useEffect, useState } from 'react';
import Layout from '../components/Layout';
import Badge from '../components/Badge';
import Modal from '../components/Modal';
import { getVault, revealCode, addVaultCode, getAccounts } from '../lib/api';

interface RevealedCode {
  id: number;
  type: 'door' | 'alarm';
  code: string;
  expiresAt: number;
}

export default function CodeVault() {
  const [entries, setEntries] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [revealed, setRevealed] = useState<RevealedCode | null>(null);
  const [search, setSearch] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [addForm, setAddForm] = useState({ account_id: '', door_code: '', alarm_code: '' });
  const [saving, setSaving] = useState(false);
  const [revealing, setRevealing] = useState<string | null>(null);

  useEffect(() => {
    getVault()
      .then((d) => { setEntries(d); })
      .catch(() => { /* error handled by global 401 guard; non-auth errors leave table empty */ })
      .finally(() => setLoading(false));
    getAccounts({ limit: '300' }).then((d) => setAccounts(d.accounts)).catch(() => {});
  }, []);

  // Auto-hide revealed code after 5 seconds
  useEffect(() => {
    if (!revealed) return;
    const remaining = revealed.expiresAt - Date.now();
    if (remaining <= 0) { setRevealed(null); return; }
    const t = setTimeout(() => setRevealed(null), remaining);
    return () => clearTimeout(t);
  }, [revealed]);

  const handleReveal = async (id: number, type: 'door' | 'alarm') => {
    const key = `${id}-${type}`;
    setRevealing(key);
    try {
      const data = await revealCode(id, type);
      setRevealed({ id, type, code: data.code, expiresAt: Date.now() + 5000 });
    } finally {
      setRevealing(null);
    }
  };

  const handleAdd = async () => {
    setSaving(true);
    try {
      await addVaultCode({ account_id: Number(addForm.account_id), door_code: addForm.door_code || undefined, alarm_code: addForm.alarm_code || undefined });
      setShowAdd(false);
      setAddForm({ account_id: '', door_code: '', alarm_code: '' });
      getVault().then(setEntries);
    } finally {
      setSaving(false);
    }
  };

  const filtered = entries.filter((e) => (e.name ?? '').toLowerCase().includes(search.toLowerCase()));

  const isRevealed = (id: number, type: 'door' | 'alarm') =>
    revealed?.id === id && revealed.type === type;

  return (
    <Layout>
      <div className="p-6 max-w-5xl mx-auto space-y-5">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold">Code Vault</h1>
            <p className="text-sm text-cw-muted">AES-256-GCM encrypted · All reveals are audit logged</p>
          </div>
          <button onClick={() => setShowAdd(true)} className="btn-primary">+ Add Code</button>
        </div>

        {revealed && (
          <div className="bg-cw-black text-white rounded-lg px-5 py-4 flex items-center justify-between">
            <div>
              <div className="text-xs text-gray-400 uppercase tracking-wide mb-1">
                {revealed.type === 'door' ? 'Door Code' : 'Alarm Code'} — auto-hiding in 5 seconds
              </div>
              <div className="text-2xl font-mono font-bold tracking-widest text-cw-red">{revealed.code}</div>
            </div>
            <button onClick={() => setRevealed(null)} className="text-gray-400 hover:text-white text-xl">×</button>
          </div>
        )}

        <div className="flex gap-3">
          <input
            className="input max-w-xs"
            placeholder="Search vault entries…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-cw-black text-white text-xs">
                <th className="text-left px-4 py-3 font-medium">Account</th>
                <th className="text-center px-4 py-3 font-medium">Alarm Code</th>
                <th className="text-center px-4 py-3 font-medium">Door Code</th>
                <th className="text-center px-4 py-3 font-medium">Lockbox #</th>
                <th className="text-center px-4 py-3 font-medium">Fob</th>
                <th className="text-left px-4 py-3 font-medium">Notes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-cw-border">
              {loading ? (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-cw-muted">Loading…</td></tr>
              ) : filtered.map((e) => (
                <tr key={e.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium max-w-[220px] truncate">{e.name}</td>
                  <td className="px-4 py-3 text-center">
                    {e.has_alarm_code ? (
                      isRevealed(e.id, 'alarm') ? (
                        <span className="font-mono text-cw-red font-bold">{revealed!.code}</span>
                      ) : (
                        <button
                          onClick={() => handleReveal(e.id, 'alarm')}
                          disabled={revealing === `${e.id}-alarm`}
                          className="text-xs bg-yellow-50 border border-yellow-200 text-yellow-800 px-3 py-1 rounded hover:bg-yellow-100 transition-colors"
                        >
                          {revealing === `${e.id}-alarm` ? '…' : '👁 Reveal'}
                        </button>
                      )
                    ) : <span className="text-cw-muted">–</span>}
                  </td>
                  <td className="px-4 py-3 text-center">
                    {e.has_door_code ? (
                      isRevealed(e.id, 'door') ? (
                        <span className="font-mono text-cw-red font-bold">{revealed!.code}</span>
                      ) : (
                        <button
                          onClick={() => handleReveal(e.id, 'door')}
                          disabled={revealing === `${e.id}-door`}
                          className="text-xs bg-gray-50 border border-cw-border text-cw-text px-3 py-1 rounded hover:bg-gray-100 transition-colors"
                        >
                          {revealing === `${e.id}-door` ? '…' : '👁 Reveal'}
                        </button>
                      )
                    ) : <span className="text-cw-muted">–</span>}
                  </td>
                  <td className="px-4 py-3 text-center">
                    {e.lockbox ? <Badge variant="blue">#{e.lockbox}</Badge> : <span className="text-cw-muted">–</span>}
                  </td>
                  <td className="px-4 py-3 text-center">
                    {e.has_fob ? <Badge variant="gray">FOB</Badge> : <span className="text-cw-muted">–</span>}
                  </td>
                  <td className="px-4 py-3 text-xs text-cw-muted max-w-[200px] truncate">{e.notes || '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && filtered.length === 0 && (
            <div className="px-4 py-8 text-center text-cw-muted text-sm">No vault entries found</div>
          )}
        </div>
      </div>

      {showAdd && (
        <Modal title="Add Vault Code" onClose={() => setShowAdd(false)}>
          <div className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-cw-muted mb-1">Account</label>
              <select className="input" value={addForm.account_id} onChange={(e) => setAddForm({ ...addForm, account_id: e.target.value })}>
                <option value="">— Select account —</option>
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.ic_company_name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-cw-muted mb-1">Door Code (leave blank to skip)</label>
              <input className="input font-mono" placeholder="e.g. 1234*" value={addForm.door_code} onChange={(e) => setAddForm({ ...addForm, door_code: e.target.value })} />
            </div>
            <div>
              <label className="block text-xs font-medium text-cw-muted mb-1">Alarm Code (leave blank to skip)</label>
              <input className="input font-mono" placeholder="e.g. 5678" value={addForm.alarm_code} onChange={(e) => setAddForm({ ...addForm, alarm_code: e.target.value })} />
            </div>
            <p className="text-xs text-cw-muted">Codes are encrypted with AES-256-GCM before storage.</p>
            <div className="flex gap-2">
              <button onClick={handleAdd} disabled={saving || !addForm.account_id} className="btn-primary">
                {saving ? 'Encrypting…' : 'Save Encrypted'}
              </button>
              <button onClick={() => setShowAdd(false)} className="btn-secondary">Cancel</button>
            </div>
          </div>
        </Modal>
      )}
    </Layout>
  );
}
