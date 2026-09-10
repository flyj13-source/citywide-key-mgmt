import { useState, useEffect, useCallback } from 'react';
import Layout from '../components/Layout';
import {
  changePassword, getBackupStatus, runBackupNow, getCustodyNotification, setCustodyNotification,
  getCustodyDefaults, setCustodyDefaults, getEmailConfig, sendTestEmail,
  resetTestData, seedTestData, type TestDataResult,
  type BackupStatus, type CustodyNotificationSetting, type CustodyDefaults,
  type EmailConfig, type TestEmailResult,
} from '../lib/api';
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

  // ── Key custody notification recipient ─────────────────────────────────────
  // Stored in the database, not in a constant or an env var, so it survives the
  // person currently in that seat moving on.
  const [notify, setNotify] = useState<CustodyNotificationSetting | null>(null);
  const [notifyValue, setNotifyValue] = useState('');
  const [notifyLoading, setNotifyLoading] = useState(true);
  const [notifySaving, setNotifySaving] = useState(false);
  const [notifyError, setNotifyError] = useState('');
  const [notifyToast, setNotifyToast] = useState(false);

  // ── Default due window ─────────────────────────────────────────────────────
  // Every check-out opens with a due date already set, today + this many days.
  // Stored rather than hardcoded so "we give them 30 days" can become 14.
  const [due, setDue] = useState<CustodyDefaults | null>(null);
  const [dueValue, setDueValue] = useState('');
  const [dueSaving, setDueSaving] = useState(false);
  const [dueError, setDueError] = useState('');
  const [dueToast, setDueToast] = useState(false);

  const loadDue = useCallback(() => {
    getCustodyDefaults()
      .then((d) => { setDue(d); setDueValue(String(d.due_days)); })
      .catch(() => setDue(null));
  }, []);
  useEffect(() => { loadDue(); }, [loadDue]);

  // ── Email ──────────────────────────────────────────────────────────────────
  // Read-only picture of how mail is actually wired, plus the one button that
  // proves it. Admin only, because it sends real mail from the real mailbox.
  const [email, setEmail] = useState<EmailConfig | null>(null);
  const [emailLoading, setEmailLoading] = useState(true);
  const [testTo, setTestTo] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestEmailResult | null>(null);

  const loadEmail = useCallback(() => {
    setEmailLoading(true);
    getEmailConfig()
      .then(setEmail)
      .catch(() => setEmail(null))
      .finally(() => setEmailLoading(false));
  }, []);
  useEffect(() => { loadEmail(); }, [loadEmail]);

  const handleTestEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    setTesting(true); setTestResult(null);
    try {
      const r = await sendTestEmail(testTo.trim() || undefined);
      setTestResult(r);
    } catch (err: any) {
      // sendTestEmail is written not to throw; if it somehow does, show that
      // rather than leaving the button spinning with nothing said.
      setTestResult({
        ok: false, recipients: [], message_id: null, response: null,
        error: err?.message || String(err), skipped: false, attempts: 0,
      });
    } finally {
      setTesting(false);
      loadEmail();
    }
  };

  // ── Test data ──────────────────────────────────────────────────────────────
  // The deployed equivalent of `npm run test-data:reset`, which cannot reach
  // the managed host because there is no shell there.
  const [tdBusy, setTdBusy] = useState<'reset' | 'seed' | null>(null);
  const [tdResult, setTdResult] = useState<TestDataResult | null>(null);
  const [tdError, setTdError] = useState('');
  const [tdConfirm, setTdConfirm] = useState(false);
  const [tdTyped, setTdTyped] = useState('');

  const runTestData = async (which: 'reset' | 'seed') => {
    setTdBusy(which); setTdError(''); setTdResult(null);
    try {
      setTdResult(which === 'reset' ? await resetTestData(tdTyped.trim()) : await seedTestData());
      setTdConfirm(false);
      setTdTyped('');
    } catch (err: any) {
      setTdError(err?.message || String(err));
    } finally { setTdBusy(null); }
  };

  const handleSaveDue = async (e: React.FormEvent) => {
    e.preventDefault();
    setDueSaving(true); setDueError(''); setDueToast(false);
    try {
      await setCustodyDefaults(Number(dueValue));
      loadDue();
      setDueToast(true);
      setTimeout(() => setDueToast(false), 4000);
    } catch (err: any) {
      setDueError(err?.message || 'Could not save the due window');
    } finally { setDueSaving(false); }
  };

  const loadNotify = useCallback(async () => {
    setNotifyLoading(true);
    try {
      const d = await getCustodyNotification();
      setNotify(d);
      setNotifyValue(d.value || d.effective.join(', '));
    } catch {
      setNotify(null);
    } finally {
      setNotifyLoading(false);
    }
  }, []);
  useEffect(() => { loadNotify(); }, [loadNotify]);

  const handleSaveNotify = async (e: React.FormEvent) => {
    e.preventDefault();
    setNotifySaving(true); setNotifyError('');
    try {
      const d = await setCustodyNotification(notifyValue);
      setNotify(d);
      setNotifyValue(d.value);
      setNotifyToast(true);
      setTimeout(() => setNotifyToast(false), 3000);
    } catch (err: any) {
      setNotifyError(err?.message || 'Could not update the recipient');
    } finally {
      setNotifySaving(false);
    }
  };
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

        {/* Key custody notifications */}
        <div className="card overflow-hidden">
          <div className="px-5 py-3 bg-cw-black">
            <h2 className="text-white font-semibold text-sm">Key Custody Notifications</h2>
          </div>
          <form onSubmit={handleSaveNotify} className="px-5 py-4 space-y-4">
            <p className="text-sm text-cw-muted">
              Every key check-out, check-in, transfer and signed receipt is emailed to the holder <em>and</em> to the
              address below. Separate multiple recipients with commas.
            </p>

            <div>
              <label className="block text-sm font-medium text-cw-text mb-1">Notification recipient</label>
              <input
                type="text"
                value={notifyValue}
                onChange={(e) => setNotifyValue(e.target.value)}
                disabled={notifyLoading || notifySaving}
                className="input w-full"
                placeholder="cara@citywideboston.com"
                autoComplete="off"
              />
            </div>

            {notify && (
              <p className="text-xs text-cw-muted">
                Currently receiving: <span className="font-semibold text-[#1a1a1a]">{notify.effective.join(', ') || 'nobody'}</span>
                {notify.source !== 'settings' && (
                  <span className="ml-1 text-[#7a5a00]">
                    (falling back to the {notify.source === 'environment' ? 'CARA_EMAIL environment variable' : 'built-in default'} — save to store it here)
                  </span>
                )}
                {notify.updated_at && notify.updated_by && (
                  <> · last changed by {notify.updated_by} on {fmtWhen(notify.updated_at)}</>
                )}
              </p>
            )}

            {notifyError && (
              <p className="text-sm text-[#C0272D] bg-[#fbeaea] border border-[#f0c9cb] rounded px-3 py-2">{notifyError}</p>
            )}
            {notifyToast && (
              <p className="text-sm text-green-800 bg-green-50 border border-green-200 rounded px-3 py-2">
                ✓ Saved — the next custody email goes to this address.
              </p>
            )}

            <button
              type="submit"
              disabled={notifyLoading || notifySaving || !notifyValue.trim()}
              className="px-4 py-2 bg-[#C0272D] text-white text-sm font-medium rounded hover:bg-[#a82227] disabled:opacity-50 transition-colors"
            >
              {notifySaving ? 'Saving…' : 'Save recipient'}
            </button>
          </form>
        </div>

        {/* Email — configuration readout + test send */}
        <div className="card overflow-hidden">
          <div className="px-5 py-3 bg-cw-black flex items-center justify-between">
            <h2 className="text-white font-semibold text-sm">Email</h2>
            {email && (
              <span className={`text-[11px] px-2 py-0.5 rounded-full font-semibold ${
                email.provider_configured ? 'bg-green-100 text-green-800' : 'bg-[#fbeaea] text-[#C0272D]'
              }`}>
                {email.provider_configured
                  ? `${email.provider_key === 'resend' ? 'Resend' : 'SMTP'} configured`
                  : `${email.provider_key === 'resend' ? 'Resend' : 'SMTP'} not configured`}
              </span>
            )}
          </div>

          <div className="px-5 py-4 space-y-4">
            {emailLoading && <p className="text-sm text-cw-muted">Loading configuration…</p>}

            {email && (
              <>
                {/* What is actually wired, read-only. */}
                <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
                  {([
                    ['Provider', `${email.provider}${
                      email.provider_source === 'auto' ? '  (auto — RESEND_API_KEY is set)'
                      : email.provider_source === 'default' ? '  (default — MAIL_PROVIDER unset)'
                      : ''}`],
                    ...(email.provider_key === 'resend'
                      ? ([
                          ['Endpoint', email.resend.endpoint],
                          ['API key', email.resend.api_key_set ? `set (${email.resend.key_hint})` : '— not set —'],
                        ] as [string, string][])
                      : ([
                          ['SMTP host', `${email.smtp.host}:${email.smtp.port}`
                            + (email.smtp.host_source === 'default' ? '  (default — SMTP_HOST unset)' : '')],
                          ['Connection', email.smtp.tls_mode],
                          ['Authenticated as', email.smtp.user ?? '— not set —'],
                          ['Password', email.smtp.password_set ? 'set' : '— not set —'],
                        ] as [string, string][])),
                    ['From address', email.from.header ?? '— not set —'],
                    ['Reply-To', email.from.reply_to ?? 'none (replies go to the From address)'],
                    ['Notification recipient', email.notification_recipients.join(', ') || 'nobody'],
                    ['Environment', email.environment],
                  ] as [string, string][]).map(([k, v]) => (
                    <div key={k} className="flex flex-col">
                      <dt className="text-[11px] uppercase tracking-wide text-cw-muted">{k}</dt>
                      <dd className="text-[#1a1a1a] font-medium break-words">{v}</dd>
                    </div>
                  ))}
                </dl>

                {email.last_test && (
                  <p className="text-xs text-cw-muted">
                    Last test:{' '}
                    <span className={email.last_test.ok ? 'text-green-800 font-semibold' : 'text-[#C0272D] font-semibold'}>
                      {email.last_test.ok ? 'accepted' : 'failed'}
                    </span>
                    {' '}on {fmtWhen(email.last_test.at)}
                    {email.last_test.by && <> by {email.last_test.by}</>}
                    {email.last_test.recipients.length > 0 && <> → {email.last_test.recipients.join(', ')}</>}
                    {email.last_test.message_id && (
                      <> · <span className="font-mono">{email.last_test.message_id}</span></>
                    )}
                  </p>
                )}

                {/* Problems that a send would otherwise have to discover. */}
                {email.warnings.length > 0 && (
                  <div className="rounded border-2 border-[#C0272D] bg-[#fbeaea] px-4 py-3 space-y-1">
                    <div className="text-sm font-semibold text-[#C0272D]">
                      {email.warnings.length === 1 ? 'Configuration problem' : `${email.warnings.length} configuration problems`}
                    </div>
                    <ul className="list-disc pl-5 space-y-1">
                      {email.warnings.map((w) => (
                        <li key={w} className="text-sm text-[#1a1a1a]">{w}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {isAdmin ? (
                  <form onSubmit={handleTestEmail} className="space-y-3 pt-2 border-t border-gray-200">
                    <div className="flex flex-wrap items-end gap-3">
                      <div className="flex-1 min-w-[240px]">
                        <label className="block text-sm font-medium text-cw-text mb-1">
                          Send to <span className="text-cw-muted font-normal">— any address, including external</span>
                        </label>
                        <input
                          type="text"
                          value={testTo}
                          onChange={(e) => setTestTo(e.target.value)}
                          disabled={testing}
                          className="input w-full"
                          placeholder={email.notification_recipients.join(', ') || 'name@example.com'}
                          autoComplete="off"
                        />
                      </div>
                      <button
                        type="submit"
                        disabled={testing}
                        className="px-4 py-2 bg-[#C0272D] text-white text-sm font-medium rounded hover:bg-[#a82227] disabled:opacity-50 transition-colors"
                      >
                        {testing ? 'Sending…' : 'Send test email'}
                      </button>
                    </div>
                    <p className="text-[11px] text-gray-400">
                      Sends one CW-branded message stating the provider, how it was delivered, the From address and the timestamp.
                      Leave "Send to" empty to use the notification recipient. Both outcomes are written to the audit log.
                    </p>

                    {testResult && (
                      testResult.ok ? (
                        <div className="rounded border border-green-200 bg-green-50 px-4 py-3 space-y-1">
                          <div className="text-sm font-semibold text-green-800">
                            ✓ Accepted by {email.provider_key === 'resend' ? 'Resend' : email.smtp.host}
                            {' — '}delivered to {testResult.recipients.join(', ')}
                          </div>
                          {testResult.message_id && (
                            <div className="text-xs text-green-900">
                              Message ID <span className="font-mono break-all">{testResult.message_id}</span>
                            </div>
                          )}
                          {testResult.response && (
                            <div className="text-xs text-green-900 font-mono break-all">{testResult.response}</div>
                          )}
                          <div className="text-[11px] text-green-800">
                            Accepted by the server is not the same as landed in the inbox — check the mailbox, and the
                            junk folder, before calling it done.
                          </div>
                        </div>
                      ) : (
                        <div className="rounded border-2 border-[#C0272D] bg-[#fbeaea] px-4 py-3 space-y-1">
                          <div className="text-sm font-semibold text-[#C0272D]">
                            {testResult.skipped ? 'Not sent' : 'Rejected'}
                            {testResult.recipients.length > 0 && <> — {testResult.recipients.join(', ')}</>}
                          </div>
                          {/* The complete SMTP text, unabridged: whether this is
                              auth, TLS or a tenant block is only legible here. */}
                          <pre className="text-xs text-[#1a1a1a] whitespace-pre-wrap break-words font-mono bg-white/60 rounded px-2 py-1.5">
{testResult.error || 'No error text was returned.'}
                          </pre>
                          <div className="text-[11px] text-[#7a5a00]">
                            {email.provider_key === 'resend'
                              ? 'responseCode=401 → the API key · 403 with "domain is not verified" → verify the sending domain, or send from the shared sender to the account owner only · 422 → the message body · EFETCH → could not reach api.resend.com at all.'
                              : '5.7.57 / 535 → authentication · 5.7.139 → SMTP AUTH disabled for the tenant · 5.7.60 → the From address is not permitted to send as · ESOCKET / ETLS / wrong version number → the TLS handshake · 5.7.708 → tenant or IP block.'}
                          </div>
                        </div>
                      )
                    )}
                  </form>
                ) : (
                  <p className="text-xs text-cw-muted pt-2 border-t border-gray-200">
                    Sending a test email is restricted to administrators.
                  </p>
                )}
              </>
            )}
          </div>
        </div>

        {/* Default due window */}
        <div className="card overflow-hidden">
          <div className="px-5 py-3 bg-cw-black">
            <h2 className="text-white font-semibold text-sm">Key Check-Out Defaults</h2>
          </div>
          <form onSubmit={handleSaveDue} className="px-5 py-4 space-y-4">
            <p className="text-sm text-cw-muted">
              Every check-out opens with a due date already filled in — today plus this many days. It stays
              editable on each transaction; this only sets where it starts.
            </p>

            <div className="flex flex-wrap items-end gap-3">
              <div>
                <label className="block text-sm font-medium text-cw-text mb-1">Default due window</label>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={1}
                    max={3650}
                    value={dueValue}
                    onChange={(e) => setDueValue(e.target.value)}
                    disabled={dueSaving}
                    className="input w-24 text-center"
                  />
                  <span className="text-sm text-cw-muted">days</span>
                </div>
              </div>
              <button
                type="submit"
                disabled={dueSaving || !dueValue.trim()}
                className="px-4 py-2 bg-[#C0272D] text-white text-sm font-medium rounded hover:bg-[#a82227] disabled:opacity-50 transition-colors"
              >
                {dueSaving ? 'Saving…' : 'Save'}
              </button>
            </div>

            {due && (
              <p className="text-xs text-cw-muted">
                A check-out started now would be due{' '}
                <span className="font-semibold text-[#1a1a1a]">{due.example_due_at}</span>
                {due.is_default && <span className="ml-1 text-gray-400">(built-in default of {due.fallback_due_days} days)</span>}
                {due.updated_at && due.updated_by && <> · last changed by {due.updated_by} on {fmtWhen(due.updated_at)}</>}
              </p>
            )}

            {dueError && (
              <p className="text-sm text-[#C0272D] bg-[#fbeaea] border border-[#f0c9cb] rounded px-3 py-2">{dueError}</p>
            )}
            {dueToast && (
              <p className="text-sm text-green-800 bg-green-50 border border-green-200 rounded px-3 py-2">
                ✓ Saved — the next check-out opens with this due date.
              </p>
            )}
          </form>
        </div>

        {/* Test data */}
        {isAdmin && (
          <div className="card overflow-hidden">
            <div className="px-5 py-3 bg-cw-black">
              <h2 className="text-white font-semibold text-sm">Test Data</h2>
            </div>
            <div className="px-5 py-4 space-y-4">
              <p className="text-sm text-cw-muted">
                Nine <span className="font-semibold text-[#1a1a1a]">ZZ TEST</span> records — three clients, one
                contractor, two account managers, two contract compliance managers, and one crew member with no
                email for testing the missing-address flag. Clients A and B belong to AM One and client C to
                AM Two, so a reassignment has something real to move.
                They are excluded from every count, aggregate and export, and carry a{' '}
                <span className="inline-flex items-center rounded-full border border-[#b8860b] bg-[#fdf3d7] text-[#7a5a00] px-1.5 py-[1px] text-[10px] font-semibold uppercase tracking-wide">Test</span>{' '}
                pill wherever they appear.
              </p>

              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() => runTestData('seed')}
                  disabled={tdBusy !== null}
                  className="px-4 py-2 border border-[#1a1a1a] text-[#1a1a1a] text-sm font-medium rounded hover:border-[#C0272D] hover:text-[#C0272D] disabled:opacity-50 transition-colors"
                >
                  {tdBusy === 'seed' ? 'Repairing…' : 'Seed / repair fixtures'}
                </button>
                {!tdConfirm && (
                  <button
                    type="button"
                    onClick={() => setTdConfirm(true)}
                    disabled={tdBusy !== null}
                    className="px-4 py-2 border border-[#1a1a1a] text-[#1a1a1a] text-sm font-medium rounded hover:bg-[#fbeaea] hover:border-[#C0272D] hover:text-[#C0272D] disabled:opacity-50 transition-colors"
                  >
                    Reset test data…
                  </button>
                )}
              </div>
              {tdConfirm && (
                <div className="rounded border-2 border-[#C0272D] bg-[#fbeaea] px-4 py-3 space-y-2">
                  <div className="text-sm font-semibold text-[#C0272D]">
                    This deletes every key assignment, key form and audit row belonging to the ZZ TEST
                    records, then re-seeds all nine fixtures — including their AM and CCM links, so a
                    reassignment test starts from the same 2/1 split every time.
                  </div>
                  <label className="block text-sm text-[#1a1a1a]">
                    Type <span className="font-mono font-bold">RESET</span> to confirm:
                  </label>
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      type="text"
                      value={tdTyped}
                      onChange={(e) => setTdTyped(e.target.value)}
                      disabled={tdBusy !== null}
                      className="input w-40 font-mono"
                      placeholder="RESET"
                      autoComplete="off"
                      autoFocus
                    />
                    <button
                      type="button"
                      onClick={() => runTestData('reset')}
                      disabled={tdBusy !== null || tdTyped.trim().toUpperCase() !== 'RESET'}
                      className="px-4 py-2 bg-[#C0272D] text-white text-sm font-medium rounded hover:bg-[#a82227] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                      {tdBusy === 'reset' ? 'Resetting…' : 'Reset test data'}
                    </button>
                    <button
                      type="button"
                      onClick={() => { setTdConfirm(false); setTdTyped(''); }}
                      className="px-3 py-2 text-sm text-cw-muted hover:text-[#1a1a1a]"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              <p className="text-[11px] text-gray-400">
                Reset deletes only key assignments, key forms and audit rows belonging to the ZZ TEST records,
                then re-seeds them. Real client and staff data is never in scope — the result below reports the
                real customer count before and after.
              </p>

              {tdError && (
                <p className="text-sm text-[#C0272D] bg-[#fbeaea] border border-[#f0c9cb] rounded px-3 py-2">{tdError}</p>
              )}
              {tdResult && (
                <div className={`rounded border px-4 py-3 space-y-1 text-sm ${
                  tdResult.real_customers.unchanged
                    ? 'border-green-200 bg-green-50 text-green-800'
                    : 'border-2 border-[#C0272D] bg-[#fbeaea] text-[#C0272D]'
                }`}>
                  <div className="font-semibold">
                    {tdResult.real_customers.unchanged ? '✓ Done' : '⚠ Real data moved — investigate'}
                  </div>
                  {tdResult.deleted && (
                    <div>
                      Deleted {tdResult.deleted.assignments} assignment(s), {tdResult.deleted.forms} form(s),{' '}
                      {tdResult.deleted.audit} audit row(s).
                    </div>
                  )}
                  <div>
                    Clients #{tdResult.fixtures.clients.a} · #{tdResult.fixtures.clients.b} ·
                    {' '}#{tdResult.fixtures.clients.c} · IC #{tdResult.fixtures.ic}
                  </div>
                  <div>
                    AM #{tdResult.fixtures.staff.amOne} · #{tdResult.fixtures.staff.amTwo} ·
                    {' '}CCM #{tdResult.fixtures.staff.ccmOne} · #{tdResult.fixtures.staff.ccmTwo} ·
                    {' '}no-email crew #{tdResult.fixtures.staff.noEmail}
                    {tdResult.fixtures.created.length > 0 && <> · created: {tdResult.fixtures.created.join(', ')}</>}
                  </div>
                  {tdResult.fixtures.migrated?.length > 0 && (
                    <div className="text-[12px]">
                      Migrated: {tdResult.fixtures.migrated.join('; ')}
                    </div>
                  )}
                  <div>
                    Real customers: {tdResult.real_customers.before} → {tdResult.real_customers.after}
                    {tdResult.real_customers.unchanged ? ' (unchanged)' : ' — THIS SHOULD NOT HAVE CHANGED'}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

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
