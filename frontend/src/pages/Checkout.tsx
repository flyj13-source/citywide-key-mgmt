import { useEffect, useState } from 'react';
import Layout from '../components/Layout';
import Badge from '../components/Badge';
import { getAccounts, getAssignments, checkout, checkin } from '../lib/api';

export default function Checkout() {
  const [accounts, setAccounts] = useState<any[]>([]);
  const [assignments, setAssignments] = useState<any[]>([]);
  const [activeTab, setActiveTab] = useState<'out' | 'in'>('out');
  const [form, setForm] = useState({
    account_id: '', account_name: '', assignee: '', assignee_email: '',
    key_type: 'physical', keys_held: '', due_at: '', notes: '',
  });
  const [checkinId, setCheckinId] = useState('');
  const [condition, setCondition] = useState('good');
  const [checkinNotes, setCheckinNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState('');
  const [error, setError] = useState('');
  const [searchAcc, setSearchAcc] = useState('');

  useEffect(() => {
    getAccounts({ limit: '200' }).then((d) => setAccounts(d.accounts));
    loadAssignments();
  }, []);

  const loadAssignments = () => {
    getAssignments({ status: 'checked_out', limit: '100' }).then((d) => setAssignments(d.assignments));
  };

  const filteredAccounts = searchAcc
    ? accounts.filter((a) => a.name.toLowerCase().includes(searchAcc.toLowerCase()))
    : accounts;

  const selectAccount = (a: any) => {
    setForm({ ...form, account_id: a.id, account_name: a.name });
    setSearchAcc(a.name);
  };

  const handleCheckout = async () => {
    if (!form.account_id || !form.assignee) { setError('Account and assignee are required'); return; }
    setSaving(true); setError(''); setSuccess('');
    try {
      await checkout({ ...form, account_id: Number(form.account_id) });
      setSuccess(`Key checked out to ${form.assignee} for ${form.account_name}`);
      setForm({ account_id: '', account_name: '', assignee: '', assignee_email: '', key_type: 'physical', keys_held: '', due_at: '', notes: '' });
      setSearchAcc('');
      loadAssignments();
    } catch (e: any) { setError(e.message); }
    finally { setSaving(false); }
  };

  const handleCheckin = async () => {
    if (!checkinId) { setError('Select an assignment to check in'); return; }
    setSaving(true); setError(''); setSuccess('');
    try {
      const a = assignments.find((x) => x.id === Number(checkinId));
      await checkin({ id: Number(checkinId), condition_on_return: condition, notes: checkinNotes });
      setSuccess(`Key returned for ${a?.account_name}`);
      setCheckinId(''); setCondition('good'); setCheckinNotes('');
      loadAssignments();
    } catch (e: any) { setError(e.message); }
    finally { setSaving(false); }
  };

  const overdueIds = new Set(
    assignments.filter((a) => a.due_at && new Date(a.due_at) < new Date()).map((a) => a.id)
  );

  return (
    <Layout>
      <div className="p-6 max-w-5xl mx-auto space-y-6">
        <div>
          <h1 className="text-xl font-bold">Check Out / In</h1>
          <p className="text-sm text-cw-muted">{assignments.length} keys currently checked out</p>
        </div>

        {success && (
          <div className="bg-green-50 border border-green-200 rounded px-4 py-3 text-sm text-green-800 flex items-center justify-between">
            <span>✓ {success}</span>
            <button onClick={() => setSuccess('')} className="text-green-600 hover:text-green-800">×</button>
          </div>
        )}
        {error && (
          <div className="bg-red-50 border border-red-200 rounded px-4 py-3 text-sm text-red-800 flex items-center justify-between">
            <span>{error}</span>
            <button onClick={() => setError('')} className="text-red-600">×</button>
          </div>
        )}

        <div className="flex gap-1 border-b border-cw-border">
          {(['out', 'in'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-5 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
                activeTab === tab ? 'border-cw-red text-cw-red' : 'border-transparent text-cw-muted hover:text-cw-text'
              }`}
            >
              {tab === 'out' ? 'Check Out' : 'Check In'}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Form panel */}
          <div className="card p-5 space-y-4">
            {activeTab === 'out' ? (
              <>
                <h2 className="font-semibold text-sm">Check Out Key</h2>
                <div className="relative">
                  <label className="block text-xs font-medium text-cw-muted mb-1">Account</label>
                  <input
                    className="input"
                    placeholder="Search account…"
                    value={searchAcc}
                    onChange={(e) => { setSearchAcc(e.target.value); setForm({ ...form, account_id: '', account_name: '' }); }}
                  />
                  {searchAcc && !form.account_id && filteredAccounts.length > 0 && (
                    <div className="absolute z-10 w-full bg-white border border-cw-border rounded shadow-lg max-h-48 overflow-y-auto mt-1">
                      {filteredAccounts.slice(0, 20).map((a) => (
                        <button key={a.id} onClick={() => selectAccount(a)} className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50">
                          {a.name}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <div>
                  <label className="block text-xs font-medium text-cw-muted mb-1">Assignee Name</label>
                  <input className="input" placeholder="Staff or contractor name" value={form.assignee} onChange={(e) => setForm({ ...form, assignee: e.target.value })} />
                </div>
                <div>
                  <label className="block text-xs font-medium text-cw-muted mb-1">Assignee Email</label>
                  <input type="email" className="input" placeholder="optional" value={form.assignee_email} onChange={(e) => setForm({ ...form, assignee_email: e.target.value })} />
                </div>
                <div>
                  <label className="block text-xs font-medium text-cw-muted mb-1">Keys Held</label>
                  <input className="input" placeholder="e.g. Front door + supply closet" value={form.keys_held} onChange={(e) => setForm({ ...form, keys_held: e.target.value })} />
                </div>
                <div>
                  <label className="block text-xs font-medium text-cw-muted mb-1">Key Type</label>
                  <select className="input" value={form.key_type} onChange={(e) => setForm({ ...form, key_type: e.target.value })}>
                    <option value="physical">Physical Key</option>
                    <option value="fob">Key Fob</option>
                    <option value="card">Key Card</option>
                    <option value="code">Access Code</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-cw-muted mb-1">Due Date</label>
                  <input type="date" className="input" value={form.due_at} onChange={(e) => setForm({ ...form, due_at: e.target.value })} />
                </div>
                <div>
                  <label className="block text-xs font-medium text-cw-muted mb-1">Notes</label>
                  <textarea className="input h-16 resize-none" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
                </div>
                <button onClick={handleCheckout} disabled={saving} className="btn-primary w-full">
                  {saving ? 'Processing…' : 'Check Out Key'}
                </button>
              </>
            ) : (
              <>
                <h2 className="font-semibold text-sm">Check In Key</h2>
                <div>
                  <label className="block text-xs font-medium text-cw-muted mb-1">Select Assignment to Return</label>
                  <select className="input" value={checkinId} onChange={(e) => setCheckinId(e.target.value)}>
                    <option value="">— Select —</option>
                    {assignments.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.account_name} — {a.assignee}{overdueIds.has(a.id) ? ' ⚠ OVERDUE' : ''}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-cw-muted mb-1">Condition on Return</label>
                  <select className="input" value={condition} onChange={(e) => setCondition(e.target.value)}>
                    <option value="good">Good</option>
                    <option value="damaged">Damaged</option>
                    <option value="missing_copy">Missing Copy</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-cw-muted mb-1">Notes</label>
                  <textarea className="input h-16 resize-none" value={checkinNotes} onChange={(e) => setCheckinNotes(e.target.value)} />
                </div>
                <button onClick={handleCheckin} disabled={saving} className="btn-primary w-full">
                  {saving ? 'Processing…' : 'Check In Key'}
                </button>
              </>
            )}
          </div>

          {/* Active assignments */}
          <div className="card overflow-hidden">
            <div className="px-4 py-3 border-b border-cw-border">
              <h2 className="font-semibold text-sm">Currently Checked Out ({assignments.length})</h2>
            </div>
            <div className="overflow-y-auto max-h-[500px] divide-y divide-cw-border">
              {assignments.map((a) => (
                <div key={a.id} className="px-4 py-3">
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="text-sm font-medium">{a.account_name}</div>
                      <div className="text-xs text-cw-muted">{a.assignee}</div>
                      {a.keys_held && <div className="text-xs text-cw-muted italic">{a.keys_held}</div>}
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      {overdueIds.has(a.id) ? (
                        <Badge variant="red">Overdue</Badge>
                      ) : a.due_at ? (
                        <Badge variant="yellow">Due {new Date(a.due_at).toLocaleDateString()}</Badge>
                      ) : (
                        <Badge variant="gray">No due date</Badge>
                      )}
                    </div>
                  </div>
                </div>
              ))}
              {assignments.length === 0 && (
                <div className="px-4 py-8 text-center text-cw-muted text-sm">No active check-outs</div>
              )}
            </div>
          </div>
        </div>
      </div>
    </Layout>
  );
}
