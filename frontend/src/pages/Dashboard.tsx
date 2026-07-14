import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import Layout from '../components/Layout';
import Badge from '../components/Badge';
import TestPill from '../components/TestPill';
import { getAccounts, getAssignments, getOverdue, getStaff, getAudit, getKeyHolderStats } from '../lib/api';

interface Metric { label: string; value: string | number; sub?: string; color?: string; }

function MetricCard({ label, value, sub, color = '' }: Metric) {
  return (
    <div className="card p-5">
      <div className="text-xs text-cw-muted uppercase tracking-wide mb-1">{label}</div>
      <div className={`text-3xl font-bold ${color || 'text-cw-text'}`}>{value}</div>
      {sub && <div className="text-xs text-cw-muted mt-1">{sub}</div>}
    </div>
  );
}

export default function Dashboard() {
  const [icCount, setIcCount] = useState(0);
  const [customerCount, setCustomerCount] = useState(0);
  const [activeAssignments, setActiveAssignments] = useState(0);
  const [overdueList, setOverdueList] = useState<any[]>([]);
  const [staffCount, setStaffCount] = useState(0);
  const [recentLogs, setRecentLogs] = useState<any[]>([]);
  const [keyStats, setKeyStats] = useState({ am_total: 0, ccm_total: 0, contractor_total: 0 });
  const [loading, setLoading] = useState(true);

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
    ]).then(([ic, cust, asgn, overdue, staff, audit, stats]) => {
      setIcCount(ic.total);
      setCustomerCount(cust.total);
      setActiveAssignments((asgn as any).total);
      setOverdueList(overdue);
      setStaffCount(staff.length);
      setRecentLogs(audit.logs);
      setKeyStats(stats);
    }).finally(() => setLoading(false));
  }, []);

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
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
          <MetricCard label="IC Vendors" value={icCount} sub="in key registry" />
          <MetricCard label="Customers" value={customerCount} sub="in key registry" />
          <MetricCard label="Active Check-Outs" value={activeAssignments} sub="keys currently out" />
          <MetricCard
            label="Overdue"
            value={overdueList.length}
            sub={overdueList.length > 0 ? 'require attention' : 'all on time'}
            color={overdueList.length > 0 ? 'text-red-600' : 'text-green-700'}
          />
          <MetricCard label="Staff Key Holders" value={staffCount} sub="active staff" />
        </div>

        {/* Keys by Holder */}
        <div className="card p-5">
          <h2 className="font-semibold text-sm mb-3 text-cw-text">Keys by Holder Role</h2>
          <div className="grid grid-cols-3 gap-4">
            {[
              { label: 'IC / Contractor Keys', value: keyStats.contractor_total },
              { label: 'Account Manager Keys', value: keyStats.am_total },
              { label: 'CCM Keys', value: keyStats.ccm_total },
            ].map(({ label, value }) => (
              <div key={label} className="text-center">
                <div className="text-2xl font-bold text-[#1a1a1a]">{value}</div>
                <div className="text-xs text-cw-muted mt-1">{label}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Overdue Panel */}
          <div className="card">
            <div className="px-5 py-4 border-b border-cw-border flex items-center justify-between">
              <h2 className="font-semibold text-sm">Overdue Assignments</h2>
              <Link to="/checkout" className="text-xs text-cw-red hover:underline">View all →</Link>
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
            <Link to="/checkout" className="btn-primary text-sm">Check Out Key</Link>
            <Link to="/registry" className="btn-secondary text-sm">View Registry</Link>
            <Link to="/vault" className="btn-secondary text-sm">Open Vault</Link>
            <Link to="/reports" className="btn-secondary text-sm">Export Report</Link>
            <Link to="/assistant" className="btn-secondary text-sm">Ask AI</Link>
          </div>
        </div>
      </div>
    </Layout>
  );
}
