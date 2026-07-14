import db from './db';
import type { AuthRequest } from '../middleware/auth';

/**
 * Central audit writer. Every entry created by a manager with is_test=1 gets a
 * `test_action: true` flag merged into its metadata so the UI can badge it —
 * visible, never hidden. Use this instead of inline INSERTs so the flag can
 * never be forgotten at a call site.
 */
export function logAudit(
  req: AuthRequest,
  action: string,
  account_name: string | null,
  account_id: number | bigint | string | null,
  metadata: Record<string, any> = {}
): void {
  const meta = req.manager?.is_test ? { ...metadata, test_action: true } : metadata;
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
