import { useEffect, useState } from 'react';
import Layout from '../components/Layout';
import Badge from '../components/Badge';
import { getOverdue, downloadExcel, sendOutlookAlert, sendTeamsAlert } from '../lib/api';

export default function Reports() {
  const [overdue, setOverdue] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<Record<string, 'idle' | 'loading' | 'success' | 'error'>>({
    excel: 'idle', outlook: 'idle', teams: 'idle',
  });
  const [statusMsg, setStatusMsg] = useState<Record<string, string>>({});

  useEffect(() => {
    getOverdue().then((d) => { setOverdue(d); setLoading(false); });
  }, []);

  const setS = (key: string, s: 'idle' | 'loading' | 'success' | 'error', msg = '') => {
    setStatus((prev) => ({ ...prev, [key]: s }));
    setStatusMsg((prev) => ({ ...prev, [key]: msg }));
  };

  const handleExcel = async () => {
    setS('excel', 'loading');
    try { await downloadExcel(); setS('excel', 'success', 'Excel downloaded'); }
    catch (e: any) { setS('excel', 'error', e.message); }
  };

  const handleOutlook = async () => {
    setS('outlook', 'loading');
    try {
      const r = await sendOutlookAlert();
      setS('outlook', 'success', r.message || `Sent alert for ${r.sent} overdue assignments`);
    } catch (e: any) { setS('outlook', 'error', e.message); }
  };

  const handleTeams = async () => {
    setS('teams', 'loading');
    try {
      await sendTeamsAlert();
      setS('teams', 'success', 'Teams alert sent');
    } catch (e: any) { setS('teams', 'error', e.message); }
  };

  const ActionCard = ({ id, title, description, icon, onClick, disabled }: any) => (
    <div className="card p-5">
      <div className="flex items-start gap-3 mb-3">
        <div className="text-2xl">{icon}</div>
        <div>
          <div className="font-semibold text-sm">{title}</div>
          <div className="text-xs text-cw-muted mt-0.5">{description}</div>
        </div>
      </div>
      <button
        onClick={onClick}
        disabled={status[id] === 'loading' || disabled}
        className="btn-primary w-full text-sm"
      >
        {status[id] === 'loading' ? 'Working…' : title}
      </button>
      {status[id] === 'success' && (
        <div className="mt-2 text-xs text-green-700 bg-green-50 border border-green-200 rounded px-2 py-1">
          ✓ {statusMsg[id]}
        </div>
      )}
      {status[id] === 'error' && (
        <div className="mt-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1">
          ✗ {statusMsg[id]}
        </div>
      )}
    </div>
  );

  return (
    <Layout>
      <div className="p-6 max-w-5xl mx-auto space-y-6">
        <div>
          <h1 className="text-xl font-bold">Reports & Alerts</h1>
          <p className="text-sm text-cw-muted">Export data and send M365 alerts</p>
        </div>

        {/* Overdue summary */}
        <div className="card p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold text-sm">Overdue Summary</h2>
            {overdue.length > 0 && <Badge variant="red">{overdue.length} overdue</Badge>}
          </div>
          {loading ? (
            <p className="text-sm text-cw-muted">Loading…</p>
          ) : overdue.length === 0 ? (
            <p className="text-sm text-green-700">✓ No overdue assignments</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-cw-muted border-b border-cw-border">
                    <th className="text-left pb-2">Account</th>
                    <th className="text-left pb-2">Assignee</th>
                    <th className="text-left pb-2">Due Date</th>
                    <th className="text-left pb-2">Days Overdue</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-cw-border">
                  {overdue.map((o) => (
                    <tr key={o.id}>
                      <td className="py-2 font-medium">{o.account_name}</td>
                      <td className="py-2 text-cw-muted">{o.assignee}</td>
                      <td className="py-2 text-cw-muted">{new Date(o.due_at).toLocaleDateString()}</td>
                      <td className="py-2"><Badge variant="red">{Math.max(0, o.days_overdue ?? Math.floor((Date.now() - new Date(o.due_at).getTime()) / 86400000))}d</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Action cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          <ActionCard
            id="excel"
            title="Export to Excel"
            description="Download full key registry, active assignments, overdue list, and staff holdings as .xlsx"
            icon="📊"
            onClick={handleExcel}
          />
          <ActionCard
            id="outlook"
            title="Send Outlook Alert"
            description="Email overdue key assignment report via SMTP to cara@citywideboston.com"
            icon="✉"
            onClick={handleOutlook}
            disabled={overdue.length === 0}
          />
          <ActionCard
            id="teams"
            title="Send Teams Alert"
            description="Post adaptive card with overdue list to configured Teams channel webhook"
            icon="💬"
            onClick={handleTeams}
            disabled={overdue.length === 0}
          />
        </div>

        <div className="card p-5 bg-gray-50">
          <h3 className="font-semibold text-sm mb-2">OneDrive Sync</h3>
          <p className="text-sm text-cw-muted">
            When Excel is exported and <code className="bg-white border border-cw-border px-1 rounded text-xs">LOCAL_ONEDRIVE_PATH</code> is configured in <code className="bg-white border border-cw-border px-1 rounded text-xs">.env</code>,
            the report is also saved directly to your OneDrive sync folder and automatically uploaded to SharePoint.
          </p>
        </div>
      </div>
    </Layout>
  );
}
