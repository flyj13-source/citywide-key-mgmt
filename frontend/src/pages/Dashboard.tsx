import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import Layout from '../components/Layout';
import Badge from '../components/Badge';
import TestPill from '../components/TestPill';
import ManagerModal from '../components/ManagerModal';
import { getAccounts, getAssignments, getOverdue, getStaff, getAudit, getKeyHolderStats, getStaffManagers, getSignatureGaps, type StaffManager, type SignatureGaps } from '../lib/api';

interface Metric { label: string; value: string | number; sub?: string; color?: string; footer?: React.ReactNode; }

function MetricCard({ label, value, sub, color = '', footer }: Metric) {
  return (
    <div className="card p-5">
      <div className="text-xs text-cw-muted uppercase tracking-wide mb-1">{label}</div>
      <div className={`text-3xl font-bold ${color || 'text-cw-text'}`}>{value}</div>
      {sub && <div className="text-xs text-cw-muted mt-1">{sub}</div>}
      {footer && <div className="mt-1">{footer}</div>}
    </div>
  );
}

export default function Dashboard() {
  const [gaps, setGaps] = useState<SignatureGaps | null>(null);
  const navigate = useNavigate();
  const [icCount, setIcCount] = useState(0);
  const [customerCount, setCustomerCount] = useState(0);
  const [activeAssignments, setActiveAssignments] = useState(0);
  const [overdueList, setOverdueList] = useState<any[]>([]);
  const [staffCount, setStaffCount] = useState(0);
  const [recentLogs, setRecentLogs] = useState<any[]>([]);
  const [keyStats, setKeyStats] = useState({ ic_personal: 0, am_personal: 0, ccm_personal: 0, office_personal: 0 });
  const [archivedCount, setArchivedCount] = useState(0);
  const [staffManagers, setStaffManagers] = useState<StaffManager[]>([]);
  const [showAddManager, setShowAddManager] = useState(false);
  const [loading, setLoading] = useState(true);

  const loadManagers = () => getStaffManagers().then((d) => setStaffManagers(d.managers)).catch(() => {});

  useEffect(() => { getSignatureGaps().then(setGaps).catch(() => setGaps(null)); }, []);


  useEffect(() => {
    Promise.all([
      getAccounts({ limit: '1', type: 'ic' }),
      // exclude_test → sentinel/test records (bc_client_number 999*) don't inflate the count
      getAccounts({ limit: '1', type: 'customer', exclude_test: '1' }),
      getAssignments({ status: 'checked_out', limit: '1' }),
      getOverdue(),
      getStaff(),
      getAudit({ limit: '10' }),
      getKeyHolderStats(),
      getAccounts({ limit: '1', type: 'all', archived: '1' }),
      getStaffManagers().catch(() => ({ managers: [] as StaffManager[] })),
    ]).then(([ic, cust, asgn, overdue, staff, audit, stats, arch, mgrs]) => {
      setIcCount(ic.total);
      setCustomerCount(cust.total);
      setActiveAssignments((asgn as any).total);
      setOverdueList(overdue);
      setStaffCount(staff.length);
      setRecentLogs(audit.logs);
      setKeyStats(stats);
      setArchivedCount(arch.total);
      setStaffManagers(mgrs.managers);
    }).finally(() => setLoading(false));
  }, []);

  // Manager counts by type + shift (active managers only) for the Managers card.
  const mgrCounts = {
    ams: staffManagers.filter((m) => m.manager_type === 'account_manager' || m.manager_type === 'both').length,
    ccms: staffManagers.filter((m) => m.manager_type === 'ccm' || m.manager_type === 'both').length,
    shift1: staffManagers.filter((m) => m.shift === '1st').length,
    shift2: staffManagers.filter((m) => m.shift === '2nd').length,
    shift3: staffManagers.filter((m) => m.shift === '3rd').length,
    total: staffManagers.length,
  };

  const actionLabel: Record<string, string> = {
    key_checked_out: 'Key checked out',
    key_checked_in: 'Key returned',
    vault_revealed: 'Vault code revealed',
    account_created: 'Account created',
    account_updated: 'Account updated',
    excel_exported: 'Excel report exported',
    email_sent: 'Overdue alert emailed',
    teams_alert_sent: 'Teams alert sent',
    contractor_invited: 'Contractor invited',
    contractor_signed: 'Contractor signed',
    ai_query: 'AI query',
    system_seed: 'System initialized',
  };

  if (loading) {
    return (
      <Layout>
        <div className="flex items-center justify-center h-64 text-cw-muted">Loading…</div>
      </Layout>
    );
  }

  return (
    <Layout>
      <div className="p-6 max-w-6xl mx-auto space-y-6">
        <div>
          <h1 className="text-xl font-bold text-cw-text">Dashboard</h1>
          <p className="text-sm text-cw-muted">City Wide Boston · Key Management</p>
        </div>

        {/* Metrics */}
        <div className="grid grid-cols-2 lg:grid-cols-6 gap-4">
          <MetricCard label="IC Vendors" value={icCount} sub="in key registry" />
          <MetricCard
            label="Customers"
            value={customerCount}
            sub="in key registry"
            footer={archivedCount > 0
              ? <Link to="/registry?tab=archived" className="text-xs text-cw-red hover:underline">{archivedCount} archived →</Link>
              : undefined}
          />
          <MetricCard label="Active Check-Outs" value={activeAssignments} sub="keys currently out" />
          <MetricCard
            label="Overdue"
            value={overdueList.length}
            sub={overdueList.length > 0 ? 'require attention' : 'all on time'}
            color={overdueList.length > 0 ? 'text-red-600' : 'text-green-700'}
          />
          <MetricCard label="Staff Key Holders" value={staffCount} sub="active staff" />
          {/* Signature gap — red whenever anything is unsigned, because an
              unsigned key release is a liability, not a to-do. */}
          <MetricCard
            label="Without Signature"
            value={gaps?.total_missing ?? 0}
            sub={gaps && gaps.needs_attention > 0
              ? `${gaps.needs_attention} need follow-up`
              : gaps && gaps.total_missing > 0 ? 'awaiting signature' : 'all signed'}
            color={gaps && gaps.total_missing > 0 ? 'text-red-600' : 'text-green-700'}
            footer={gaps && gaps.total_missing > 0
              ? <Link to="/registry?tab=checkedout&signature=missing" className="text-xs text-cw-red hover:underline">
                  Review →
                </Link>
              : gaps && gaps.staff_without_email > 0
                ? <Link to="/registry?tab=cwemployees" className="text-xs text-cw-red hover:underline">
                    {gaps.staff_without_email} staff with no email →
                  </Link>
                : undefined}
          />
        </div>

        {/* Keys Personally Held — by holder column (AM/CCM/IC/Office) */}
        <div className="card p-5">
          <h2 className="font-semibold text-sm mb-3 text-cw-text">Keys Personally Held</h2>
          <div className="grid grid-cols-4 gap-4">
            {[
              { label: 'ICs', value: keyStats.ic_personal },
              { label: 'Account Managers', value: keyStats.am_personal },
              { label: 'CCMs', value: keyStats.ccm_personal },
              { label: 'Office', value: keyStats.office_personal },
            ].map(({ label, value }) => (
              <div key={label} className="text-center">
                <div className="text-2xl font-bold text-[#1a1a1a]">{value}</div>
                <div className="text-xs text-cw-muted mt-1">{label}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Managers roster summary — counts by type + shift, click through to roster */}
        <Link to="/managers" className="card p-5 block hover:border-[#C0272D] transition-colors">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold text-sm text-cw-text">Managers</h2>
            <span className="text-xs text-cw-red hover:underline">View roster →</span>
          </div>
          {mgrCounts.total === 0 ? (
            <div className="text-sm text-cw-muted">No managers on the roster yet.</div>
          ) : (
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
              <span><span className="font-bold text-[#1a1a1a]">{mgrCounts.ams}</span> <span className="text-cw-muted">AMs</span></span>
              <span className="text-gray-300">·</span>
              <span><span className="font-bold text-[#1a1a1a]">{mgrCounts.ccms}</span> <span className="text-cw-muted">CCMs</span></span>
              <span className="text-gray-300">·</span>
              <span><span className="font-bold text-[#1a1a1a]">{mgrCounts.shift1}</span> <span className="text-cw-muted">1st shift</span></span>
              <span><span className="font-bold text-[#1a1a1a]">{mgrCounts.shift2}</span> <span className="text-cw-muted">2nd</span></span>
              <span><span className="font-bold text-[#1a1a1a]">{mgrCounts.shift3}</span> <span className="text-cw-muted">3rd</span></span>
            </div>
          )}
        </Link>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Overdue Panel */}
          <div className="card">
            <div className="px-5 py-4 border-b border-cw-border flex items-center justify-between">
              <h2 className="font-semibold text-sm">Overdue Assignments</h2>
              <Link to="/registry?tab=checkedout" className="text-xs text-cw-red hover:underline">View all →</Link>
            </div>
            <div className="divide-y divide-cw-border">
              {overdueList.length === 0 ? (
                <div className="px-5 py-6 text-sm text-cw-muted text-center">
                  ✓ No overdue assignments
                </div>
              ) : (
                overdueList.slice(0, 6).map((o) => (
                  <div key={o.id} className="px-5 py-3 flex items-center justify-between">
                    <div>
                      <div className="text-sm font-medium text-cw-text">{o.account_name}</div>
                      <div className="text-xs text-cw-muted">{o.assignee}</div>
                    </div>
                    <Badge variant="red">{o.days_overdue ?? Math.floor((Date.now() - new Date(o.due_at).getTime()) / 86400000)}d overdue</Badge>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Recent Activity */}
          <div className="card">
            <div className="px-5 py-4 border-b border-cw-border flex items-center justify-between">
              <h2 className="font-semibold text-sm">Recent Activity</h2>
              <Link to="/audit" className="text-xs text-cw-red hover:underline">Full log →</Link>
            </div>
            <div className="divide-y divide-cw-border">
              {recentLogs.map((log) => {
                const isTest = (() => { try { return !!JSON.parse(log.metadata || '{}').test_action; } catch { return false; } })();
                return (
                  <div key={log.id} className="px-5 py-3">
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-cw-text">{actionLabel[log.action] || log.action}</span>
                      <span className="text-xs text-cw-muted">{new Date(log.created_at).toLocaleDateString()}</span>
                    </div>
                    <div className="text-xs text-cw-muted mt-0.5 flex items-center gap-1.5 flex-wrap">
                      {log.account_name && <span>{log.account_name} · </span>}
                      <span>{log.manager}</span>
                      {isTest && <TestPill />}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Quick actions */}
        <div className="card p-5">
          <h2 className="font-semibold text-sm mb-3">Quick Actions</h2>
          <div className="flex flex-wrap gap-2">
            <button onClick={() => setShowAddManager(true)} className="btn-primary text-sm">+ Add Manager</button>
            <Link to="/registry?tab=checkedout" className="btn-primary text-sm">Check Out Keys</Link>
            <Link to="/registry" className="btn-secondary text-sm">View Registry</Link>
            <Link to="/vault" className="btn-secondary text-sm">Open Vault</Link>
            <Link to="/reports" className="btn-secondary text-sm">Export Report</Link>
            <Link to="/assistant" className="btn-secondary text-sm">Ask AI</Link>
            <Link to="/registry?tab=archived" className="btn-secondary text-sm">Manage / Remove Accounts</Link>
          </div>
        </div>
      </div>

      {showAddManager && (
        <ManagerModal
          mode="add"
          onClose={() => setShowAddManager(false)}
          onSaved={() => { setShowAddManager(false); loadManagers(); navigate('/managers'); }}
        />
      )}
    </Layout>
  );
}
