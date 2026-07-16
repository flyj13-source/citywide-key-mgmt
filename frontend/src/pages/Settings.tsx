import { useState, useEffect, useCallback } from 'react';
import Layout from '../components/Layout';
import { changePassword, getBackupStatus, runBackupNow, type BackupStatus } from '../lib/api';
import { getManager } from '../lib/auth';

function fmtBytes(n: number | null): string {
  if (!n) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
function fmtWhen(iso: string): string {
  // SQLite CURRENT_TIMESTAMP is UTC without a zone marker; treat it as UTC.
  const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export default function Settings() {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [pwError, setPwError] = useState('');
  const [pwLoading, setPwLoading] = useState(false);
  const [pwToast, setPwToast] = useState(false);

  const isAdmin = getManager()?.role === 'admin';
  const [backup, setBackup] = useState<BackupStatus | null>(null);
  const [backupLoading, setBackupLoading] = useState(true);
  const [backupRunning, setBackupRunning] = useState(false);
  const [backupErr, setBackupErr] = useState('');

  const loadBackup = useCallback(async () => {
    setBackupLoading(true);
    try {
      setBackup(await getBackupStatus());
    } catch {
      setBackup(null);
    } finally {
      setBackupLoading(false);
    }
  }, []);
  useEffect(() => {
    loadBackup();
  }, [loadBackup]);

  const handleRunBackup = async () => {
    setBackupRunning(true);
    setBackupErr('');
    try {
      const r = await runBackupNow();
      if (r.status !== 'ok') setBackupErr(r.message || 'Backup failed');
      await loadBackup();
    } catch (e: any) {
      setBackupErr(e?.message || 'Backup failed');
    } finally {
      setBackupRunning(false);
    }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPwError('');

    if (newPassword.length < 8) {
      setPwError('New password must be at least 8 characters'); return;
    }
    if (newPassword !== confirmPassword) {
      setPwError('New passwords do not match'); return;
    }

    setPwLoading(true);
    try {
      await changePassword(currentPassword, newPassword);
      setCurrentPassword(''); setNewPassword(''); setConfirmPassword('');
      setPwToast(true);
      setTimeout(() => setPwToast(false), 3000);
    } catch (err: any) {
      setPwError(err.message || 'Password update failed');
    } finally {
      setPwLoading(false);
    }
  };

  return (
    <Layout>
      <div className="p-6 max-w-2xl mx-auto space-y-6">
        <div>
          <h1 className="text-xl font-bold">Settings</h1>
          <p className="text-sm text-cw-muted">M365 integrations and system configuration</p>
        </div>

        {/* Change Password */}
        <div className="card overflow-hidden">
          <div className="px-5 py-3 bg-cw-black">
            <h2 className="text-white font-semibold text-sm">Change Password</h2>
          </div>
          <form onSubmit={handleChangePassword} className="px-5 py-4 space-y-4">
            <div>
              <label className="block text-sm font-medium text-cw-text mb-1">Current password</label>
              <input
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                required
                className="input w-full"
                autoComplete="current-password"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-cw-text mb-1">New password</label>
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                required
                minLength={8}
                className="input w-full"
                autoComplete="new-password"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-cw-text mb-1">Confirm new password</label>
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                className="input w-full"
                autoComplete="new-password"
              />
            </div>

            {pwError && <div className="text-sm text-red-600">{pwError}</div>}

            {pwToast && (
              <div className="text-sm font-medium text-white bg-[#C0272D] px-4 py-2 rounded">
                Password updated
              </div>
            )}

            <button type="submit" disabled={pwLoading} className="btn-primary">
              {pwLoading ? 'Updating…' : 'Update password'}
            </button>
          </form>
        </div>

        {/* Backups — is the automated protection alive? */}
        <div className="card overflow-hidden">
          <div className="px-5 py-3 bg-cw-black flex items-center justify-between">
            <h2 className="text-white font-semibold text-sm">Backups</h2>
            {isAdmin && (
              <button
                onClick={handleRunBackup}
                disabled={backupRunning}
                className="text-xs bg-white/10 hover:bg-white/20 text-white px-3 py-1 rounded disabled:opacity-50 transition-colors"
              >
                {backupRunning ? 'Running…' : 'Run backup now'}
              </button>
            )}
          </div>
          <div className="px-5 py-4">
            {backupLoading ? (
              <div className="text-sm text-cw-muted">Loading…</div>
            ) : !backup?.latest ? (
              <div className="text-sm text-cw-muted">
                No backup has run yet. {isAdmin ? 'Click “Run backup now” to create the first one.' : ''}
              </div>
            ) : (
              <div className="flex items-center gap-3 flex-wrap">
                <span
                  className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-bold ${
                    backup.latest.status === 'ok'
                      ? 'bg-green-100 text-green-800'
                      : 'bg-[#C0272D] text-white'
                  }`}
                >
                  {backup.latest.status === 'ok' ? 'OK' : 'FAILED'}
                </span>
                <span className="text-sm text-cw-text">
                  Last backup: <strong>{fmtWhen(backup.latest.created_at)}</strong>
                  {' · '}
                  {backup.latest.row_count ?? '—'} rows
                  {' · '}
                  {fmtBytes(backup.latest.size_bytes)}
                </span>
                <span className="text-xs text-cw-muted font-mono truncate max-w-[240px]">
                  {backup.latest.destination}
                </span>
              </div>
            )}
            {backup?.latest?.status === 'failed' && backup.latest.message && (
              <div className="mt-2 text-sm text-[#C0272D] bg-[#fbeaea] border border-[#f0c9cb] rounded px-3 py-2">
                {backup.latest.message}
              </div>
            )}
            {backupErr && (
              <div className="mt-2 text-sm text-[#C0272D] bg-[#fbeaea] border border-[#f0c9cb] rounded px-3 py-2">
                {backupErr}
              </div>
            )}
            {backup && backup.recent.length > 1 && (
              <details className="mt-3">
                <summary className="text-xs text-cw-muted cursor-pointer select-none">Recent runs</summary>
                <ul className="mt-2 space-y-1">
                  {backup.recent.map((r, i) => (
                    <li key={i} className="text-xs text-cw-muted flex items-center gap-2">
                      <span className={r.status === 'ok' ? 'text-green-700' : 'text-[#C0272D]'}>
                        {r.status === 'ok' ? '✓' : '✗'}
                      </span>
                      <span>{fmtWhen(r.created_at)}</span>
                      <span>· {r.row_count ?? '—'} rows</span>
                      <span className="font-mono truncate max-w-[200px]">· {r.destination || '—'}</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        </div>

        {[
          {
            title: 'SMTP / Outlook',
            fields: [
              { label: 'SMTP Host', value: 'smtp.office365.com', hint: 'Office 365 SMTP relay' },
              { label: 'SMTP Port', value: '587', hint: 'STARTTLS' },
              { label: 'SMTP User', value: 'SMTP_USER in .env', hint: 'e.g. cara@citywideboston.com' },
              { label: 'SMTP Password', value: '••••••••', hint: 'App password from Outlook settings' },
            ],
          },
          {
            title: 'Microsoft Teams',
            fields: [
              { label: 'Incoming Webhook URL', value: 'TEAMS_WEBHOOK_URL in .env', hint: 'Add Incoming Webhook connector to Facilities channel' },
            ],
          },
          {
            title: 'OneDrive / SharePoint',
            fields: [
              { label: 'Local OneDrive Path', value: 'LOCAL_ONEDRIVE_PATH in .env', hint: 'Path to synced OneDrive folder on this machine' },
            ],
          },
          {
            title: 'Security',
            fields: [
              { label: 'JWT Secret', value: 'JWT_SECRET in .env', hint: 'Change in production — minimum 32 chars' },
              { label: 'Encryption Key', value: 'ENCRYPTION_KEY in .env', hint: '32-byte hex key for AES-256-GCM vault' },
              { label: 'Anthropic API Key', value: 'ANTHROPIC_API_KEY in .env', hint: 'Required for AI Assistant feature' },
            ],
          },
          {
            title: 'Backups & Cloud Storage',
            fields: [
              { label: 'Backup Encryption Key', value: 'BACKUP_ENCRYPTION_KEY in .env', hint: '64 hex chars — openssl rand -hex 32' },
              { label: 'S3 Endpoint', value: 'BACKUP_S3_ENDPOINT in .env', hint: 'Cloudflare R2 / Backblaze B2 / AWS S3 endpoint' },
              { label: 'S3 Bucket', value: 'BACKUP_S3_BUCKET in .env', hint: 'Destination bucket for off-disk backups' },
              { label: 'S3 Key / Secret', value: 'BACKUP_S3_KEY · BACKUP_S3_SECRET', hint: 'Access credentials (git-ignored)' },
              { label: 'Cron Trigger Token', value: 'BACKUP_TRIGGER_TOKEN', hint: 'Shared secret the Render cron uses to trigger backups' },
            ],
          },
        ].map((section) => (
          <div key={section.title} className="card overflow-hidden">
            <div className="px-5 py-3 bg-cw-black">
              <h2 className="text-white font-semibold text-sm">{section.title}</h2>
            </div>
            <div className="divide-y divide-cw-border">
              {section.fields.map((f) => (
                <div key={f.label} className="px-5 py-3 flex items-center justify-between">
                  <div>
                    <div className="text-sm font-medium">{f.label}</div>
                    <div className="text-xs text-cw-muted">{f.hint}</div>
                  </div>
                  <code className="text-xs bg-gray-100 border border-cw-border px-2 py-1 rounded text-cw-muted max-w-[200px] truncate">
                    {f.value}
                  </code>
                </div>
              ))}
            </div>
          </div>
        ))}

        <div className="card p-5 border-l-4 border-l-yellow-400">
          <h3 className="font-semibold text-sm mb-2">Configuration Instructions</h3>
          <ol className="text-sm text-cw-muted space-y-2 list-decimal list-inside">
            <li>Copy <code className="bg-gray-100 px-1 rounded">.env.example</code> to <code className="bg-gray-100 px-1 rounded">backend/.env</code></li>
            <li>Generate an Outlook app password at <strong>account.microsoft.com → Security → App passwords</strong></li>
            <li>Add Teams webhook: open Teams → channel → Connectors → Incoming Webhook</li>
            <li>Set <code className="bg-gray-100 px-1 rounded">LOCAL_ONEDRIVE_PATH</code> to your OneDrive sync folder (Excel saves there automatically)</li>
            <li>Set <code className="bg-gray-100 px-1 rounded">ANTHROPIC_API_KEY</code> from <strong>console.anthropic.com</strong></li>
          </ol>
        </div>
      </div>
    </Layout>
  );
}
