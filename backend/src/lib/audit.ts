import db from './db';
import type { AuthRequest } from '../middleware/auth';

/**
 * Central audit writer. Every entry created by a manager with is_test=1 gets a
 * `test_action: true` flag merged into its metadata so the UI can badge it —
 * visible, never hidden. Use this instead of inline INSERTs so the flag can
 * never be forgotten at a call site.
 */
/**
 * Is this entry about a test FIXTURE? Checked by account id and by name, so an
 * entry that only carries one of the two is still flagged. Test activity is
 * badged, never hidden — an auditor must be able to tell it apart at a glance,
 * and silently dropping it would be worse than showing it.
 */
function touchesTestFixture(account_id: any, account_name: string | null): boolean {
  try {
    if (account_id != null && account_id !== '') {
      const r = db.prepare('SELECT COALESCE(is_test,0) AS t FROM accounts WHERE id = ?').get(Number(account_id)) as any;
      if (r && Object.assign({}, r).t === 1) return true;
    }
    if (account_name) {
      const a = db.prepare(
        'SELECT 1 AS x FROM accounts WHERE COALESCE(is_test,0)=1 AND ic_company_name = ?'
      ).get(account_name) as any;
      if (a) return true;
      const s = db.prepare(
        'SELECT 1 AS x FROM staff_managers WHERE COALESCE(is_test,0)=1 AND name = ?'
      ).get(account_name) as any;
      if (s) return true;
    }
  } catch { /* a flagging failure must never lose the audit entry itself */ }
  return false;
}

export function logAudit(
  req: AuthRequest,
  action: string,
  account_name: string | null,
  account_id: number | bigint | string | null,
  metadata: Record<string, any> = {}
): void {
  const isTest = req.manager?.is_test || touchesTestFixture(account_id, account_name);
  const meta = isTest ? { ...metadata, test_action: true } : metadata;
  db.prepare(
    'INSERT INTO audit_log (action, account_name, account_id, manager, metadata) VALUES (?, ?, ?, ?, ?)'
  ).run(
    action,
    account_name,
    account_id === null || account_id === undefined ? null : Number(account_id),
    req.manager?.name ?? 'System',
    JSON.stringify(meta)
  );
}
