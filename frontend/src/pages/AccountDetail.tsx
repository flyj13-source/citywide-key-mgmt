import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import Layout from '../components/Layout';
import Badge from '../components/Badge';
import { getAccount, revealCode } from '../lib/api';

function MetricCard({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="card p-4 text-center">
      <div className="text-2xl font-bold text-[#1a1a1a]">{value}</div>
      <div className="text-xs text-cw-muted mt-1">{label}</div>
    </div>
  );
}

function CodeReveal({ accountId, type, hasCode }: { accountId: number; type: 'door' | 'alarm' | 'door_access'; hasCode: boolean }) {
  const [revealed, setRevealed] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  if (!hasCode) return <span className="text-cw-muted">—</span>;

  if (revealed) {
    return (
      <span className="font-mono text-sm bg-gray-100 px-2 py-1 rounded select-all">
        {revealed}
        <button onClick={() => setRevealed(null)} className="ml-2 text-xs text-cw-muted hover:text-cw-text">hide</button>
      </span>
    );
  }

  return (
    <button
      onClick={async () => { setLoading(true); try { const d = await revealCode(accountId, type); setRevealed(d.code); } finally { setLoading(false); } }}
      disabled={loading}
      className="text-xs border border-[#C0272D] text-[#C0272D] rounded px-2 py-0.5 hover:bg-[#C0272D] hover:text-white transition-colors"
    >
      {loading ? 'Revealing…' : 'Reveal'}
    </button>
  );
}

export default function AccountDetail() {
  const { accountId } = useParams<{ accountId: string }>();
  const navigate = useNavigate();
  const [account, setAccount] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!accountId) return;
    getAccount(Number(accountId))
      .then(setAccount)
      .catch(() => setError('Account not found'))
      .finally(() => setLoading(false));
  }, [accountId]);

  if (loading) return <Layout><div className="p-8 text-cw-muted">Loading…</div></Layout>;
  if (error || !account) return <Layout><div className="p-8 text-red-500">{error || 'Not found'}</div></Layout>;

  const activeAssignments = (account.assignments || []).filter((a: any) => a.status === 'checked_out');
  const pastAssignments = (account.assignments || []).filter((a: any) => a.status !== 'checked_out');

  return (
    <Layout>
      <div className="p-6 max-w-5xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-start justify-between">
          <div>
            <button onClick={() => navigate('/registry')} className="text-xs text-cw-muted hover:text-cw-text mb-2 block">← Key Registry</button>
            <h1 className="text-xl font-bold text-[#1a1a1a]">{account.ic_company_name}</h1>
            <div className="flex items-center gap-3 mt-1">
              {account.bc_vendor_number && (
                <span className="font-mono text-sm text-cw-muted">{account.bc_vendor_number}</span>
              )}
              <Badge variant={account.status === 'active' ? 'green' : 'gray'}>{account.status}</Badge>
              <Badge variant={account.record_type === 'customer' ? 'yellow' : 'gray'}>
                {account.record_type === 'customer' ? 'Customer' : 'IC Vendor'}
              </Badge>
            </div>
          </div>
        </div>

        {/* Key Inventory */}
        <div>
          <h2 className="text-sm font-semibold text-cw-muted uppercase tracking-wide mb-3">Key Inventory</h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <MetricCard label="Keys Y/N" value={account.keys_yn ? 'Yes' : 'No'} />
            <MetricCard label="Security App" value={account.security_app_yn ? 'Yes' : 'No'} />
            <MetricCard label="Metal Keys" value={account.metal_keys ?? 0} />
            <MetricCard label="Key Cards" value={account.key_cards ?? 0} />
            <MetricCard label="Key Fobs" value={account.has_fob ?? 0} />
            <MetricCard label="Dispenser Keys" value={account.dispenser_keys ?? 0} />
            {account.record_type === 'customer' && <>
              <MetricCard label="AM Keys" value={account.am_keys ?? 0} />
              <MetricCard label="CCM Keys" value={account.ccm_keys ?? 0} />
              <MetricCard label="Contractor Keys" value={account.contractor_keys ?? 0} />
            </>}
          </div>
        </div>

        {/* Access Codes */}
        <div className="card p-4">
          <h2 className="text-sm font-semibold text-cw-muted uppercase tracking-wide mb-3">Access Codes</h2>
          <div className="divide-y divide-gray-100 text-sm">
            <div className="flex items-center justify-between py-2">
              <span className="text-cw-muted">Lockbox Code</span>
              <span className="font-mono text-sm">{account.lockbox_code || '—'}</span>
            </div>
            <div className="flex items-center justify-between py-2">
              <span className="text-cw-muted">Door Code</span>
              <CodeReveal accountId={account.id} type="door" hasCode={!!account.door_code_encrypted} />
            </div>
            <div className="flex items-center justify-between py-2">
              <span className="text-cw-muted">Alarm Code</span>
              <CodeReveal accountId={account.id} type="alarm" hasCode={!!account.alarm_code_encrypted} />
            </div>
            <div className="flex items-center justify-between py-2">
              <span className="text-cw-muted">Door Access Code</span>
              <CodeReveal accountId={account.id} type="door_access" hasCode={!!account.door_access_code_encrypted} />
            </div>
          </div>
        </div>

        {/* Current Key Holders */}
        <div>
          <h2 className="text-sm font-semibold text-cw-muted uppercase tracking-wide mb-3">
            Current Key Holders
            {activeAssignments.length > 0 && (
              <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded-full bg-yellow-100 text-yellow-800 text-xs">{activeAssignments.length} out</span>
            )}
          </h2>
          {activeAssignments.length === 0 ? (
            <p className="text-sm text-cw-muted">No keys currently checked out.</p>
          ) : (
            <div className="space-y-2">
              {activeAssignments.map((a: any) => (
                <div key={a.id} className="card p-3 flex items-center justify-between text-sm">
                  <div>
                    <span className="font-medium">{a.assignee}</span>
                    {a.keys_held && <span className="text-cw-muted ml-2 text-xs">({a.keys_held})</span>}
                  </div>
                  <div className="flex items-center gap-3 text-xs text-cw-muted">
                    <span>Out: {new Date(a.checked_out_at).toLocaleDateString()}</span>
                    {a.due_at && <span>Due: {new Date(a.due_at).toLocaleDateString()}</span>}
                    <Badge variant="yellow">Checked Out</Badge>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Notes */}
        {account.notes && (
          <div className="bg-yellow-50 border border-yellow-200 rounded p-4 text-sm text-yellow-800">
            <span className="font-medium">Notes: </span>{account.notes}
          </div>
        )}

        {/* Past Assignments */}
        {pastAssignments.length > 0 && (
          <div>
            <h2 className="text-sm font-semibold text-cw-muted uppercase tracking-wide mb-3">Past Assignments</h2>
            <div className="space-y-2">
              {pastAssignments.map((a: any) => (
                <div key={a.id} className="card p-3 flex items-center justify-between text-sm opacity-70">
                  <div>
                    <span className="font-medium">{a.assignee}</span>
                    {a.keys_held && <span className="text-cw-muted ml-2 text-xs">({a.keys_held})</span>}
                  </div>
                  <div className="flex items-center gap-3 text-xs text-cw-muted">
                    <span>{new Date(a.checked_out_at).toLocaleDateString()}</span>
                    <Badge variant="green">Returned</Badge>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </Layout>
  );
}
