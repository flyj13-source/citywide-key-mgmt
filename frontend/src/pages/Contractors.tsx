import { useEffect, useState } from 'react';
import Layout from '../components/Layout';
import Badge from '../components/Badge';
import Modal from '../components/Modal';
import { getContractors, inviteContractor, getAccounts } from '../lib/api';

export default function Contractors() {
  const [contractors, setContractors] = useState<any[]>([]);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [showInvite, setShowInvite] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', assigned_accounts: [] as string[] });
  const [accSearch, setAccSearch] = useState('');
  const [saving, setSaving] = useState(false);
  const [lastLink, setLastLink] = useState('');

  useEffect(() => {
    getContractors().then(setContractors);
    getAccounts({ limit: '300' }).then((d) => setAccounts(d.accounts));
  }, []);

  const handleInvite = async () => {
    setSaving(true);
    try {
      const r = await inviteContractor(form);
      setLastLink(r.magic_link);
      getContractors().then(setContractors);
      setForm({ name: '', email: '', assigned_accounts: [] });
      setShowInvite(false);
    } finally {
      setSaving(false);
    }
  };

  const toggleAccount = (name: string) => {
    setForm((f) => ({
      ...f,
      assigned_accounts: f.assigned_accounts.includes(name)
        ? f.assigned_accounts.filter((a) => a !== name)
        : [...f.assigned_accounts, name],
    }));
  };

  const filteredAccounts = accSearch
    ? accounts.filter((a) => a.name.toLowerCase().includes(accSearch.toLowerCase()))
    : accounts;

  return (
    <Layout>
      <div className="p-6 max-w-5xl mx-auto space-y-5">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold">Contractor Portal</h1>
            <p className="text-sm text-cw-muted">Magic link e-signature system · PDF receipt generated on sign</p>
          </div>
          <button onClick={() => setShowInvite(true)} className="btn-primary">+ Invite Contractor</button>
        </div>

        {lastLink && (
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
            <div className="text-sm font-medium text-blue-800 mb-1">Magic link generated</div>
            <div className="font-mono text-xs text-blue-700 break-all mb-2">{lastLink}</div>
            <div className="flex gap-2">
              <button onClick={() => { navigator.clipboard.writeText(lastLink); }} className="text-xs text-blue-700 hover:underline">Copy link</button>
              <button onClick={() => setLastLink('')} className="text-xs text-blue-500 hover:underline">Dismiss</button>
            </div>
          </div>
        )}

        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-cw-black text-white text-xs">
                <th className="text-left px-4 py-3 font-medium">Contractor</th>
                <th className="text-left px-4 py-3 font-medium">Email</th>
                <th className="text-center px-4 py-3 font-medium">Status</th>
                <th className="text-left px-4 py-3 font-medium">Accounts</th>
                <th className="text-left px-4 py-3 font-medium">Signed At</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-cw-border">
              {contractors.length === 0 ? (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-cw-muted">No contractors yet</td></tr>
              ) : contractors.map((c) => {
                const accounts = JSON.parse(c.assigned_accounts || '[]');
                return (
                  <tr key={c.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-medium">{c.name}</td>
                    <td className="px-4 py-3 text-cw-muted text-xs">{c.email}</td>
                    <td className="px-4 py-3 text-center">
                      <Badge variant={c.status === 'signed' ? 'green' : c.status === 'expired' ? 'red' : 'yellow'}>
                        {c.status}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-xs text-cw-muted">{accounts.length} accounts</td>
                    <td className="px-4 py-3 text-xs text-cw-muted">
                      {c.signed_at ? new Date(c.signed_at).toLocaleDateString() : '—'}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex gap-2">
                        {c.status === 'signed' && (
                          <a
                            href={`/api/contractors/${c.id}/pdf`}
                            className="text-xs text-cw-red hover:underline"
                            target="_blank"
                            rel="noreferrer"
                          >PDF</a>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {showInvite && (
        <Modal title="Invite Contractor" onClose={() => setShowInvite(false)} width="max-w-xl">
          <div className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-cw-muted mb-1">Contractor Name</label>
              <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div>
              <label className="block text-xs font-medium text-cw-muted mb-1">Email</label>
              <input type="email" className="input" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </div>
            <div>
              <label className="block text-xs font-medium text-cw-muted mb-2">Assign Accounts ({form.assigned_accounts.length} selected)</label>
              <input
                className="input mb-2"
                placeholder="Search accounts…"
                value={accSearch}
                onChange={(e) => setAccSearch(e.target.value)}
              />
              <div className="max-h-48 overflow-y-auto border border-cw-border rounded divide-y divide-cw-border">
                {filteredAccounts.slice(0, 50).map((a) => (
                  <label key={a.id} className="flex items-center gap-2 px-3 py-2 hover:bg-gray-50 cursor-pointer text-sm">
                    <input
                      type="checkbox"
                      checked={form.assigned_accounts.includes(a.name)}
                      onChange={() => toggleAccount(a.name)}
                    />
                    {a.name}
                  </label>
                ))}
              </div>
            </div>
            {form.assigned_accounts.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {form.assigned_accounts.map((name) => (
                  <span key={name} className="badge-gray text-xs">
                    {name}
                    <button onClick={() => toggleAccount(name)} className="ml-1 text-cw-muted hover:text-cw-text">×</button>
                  </span>
                ))}
              </div>
            )}
            <p className="text-xs text-cw-muted">A magic link (48hr TTL) will be generated. The contractor signs via canvas on their device and a PDF is created with their signature and SHA-256 hash.</p>
            <div className="flex gap-2">
              <button onClick={handleInvite} disabled={saving || !form.name || !form.email} className="btn-primary">
                {saving ? 'Generating link…' : 'Send Invitation'}
              </button>
              <button onClick={() => setShowInvite(false)} className="btn-secondary">Cancel</button>
            </div>
          </div>
        </Modal>
      )}
    </Layout>
  );
}
