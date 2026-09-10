// ── One-time mailbox updates ─────────────────────────────────────────────────
// Cara's mail moved from cara@citywideboston.com to cangeloni@gocitywide.com.
// Two things had to change, and both are DATA, not code:
//
//   1. her staff_managers row — where holder-side notifications and signature
//      requests reach her, and
//   2. the custody notification recipient setting — where the copy of every
//      check-in, check-out and form lands.
//
// The app runs on a managed host with no shell, so the only way to reach the
// deployed database is at boot. That makes the guard below the important part:
// each update runs ONCE, recorded against a key in the settings table, and
// never again. Without it, an address later corrected in the UI would be
// silently overwritten on the next deploy — which is exactly the kind of quiet
// reversal nobody would think to look for.
//
// Her LOGIN (the managers table) is deliberately untouched. Changing it would
// change how she signs in, and that was decided separately.

import db from './db';
import { getSetting, setSetting, CUSTODY_NOTIFY_KEY } from './settings';

export const CARA_NEW_EMAIL = 'cangeloni@gocitywide.com';
export const CARA_OLD_EMAIL = 'cara@citywideboston.com';
export const CARA_ROSTER_NAME = 'Cara Angeloni';

/** One key per update, so a future move gets its own run rather than reusing this one. */
const APPLIED_KEY = 'mailbox_update_cangeloni_v1';

export interface MailboxUpdateReport {
  applied: boolean;
  /** Why it did nothing, when it did nothing. */
  reason?: string;
  staff_rows_updated: number;
  staff_matched: { id: number; name: string; was: string | null }[];
  notify_before: string | null;
  notify_after: string | null;
}

/**
 * Move Cara's roster address and the custody notification recipient onto the
 * new mailbox. Idempotent by construction: after the first successful run the
 * marker is set and every later boot returns immediately.
 */
export function applyMailboxUpdates(actor = 'System deploy'): MailboxUpdateReport {
  const empty: MailboxUpdateReport = {
    applied: false, staff_rows_updated: 0, staff_matched: [],
    notify_before: null, notify_after: null,
  };

  if (getSetting(APPLIED_KEY)) {
    return { ...empty, reason: 'already applied' };
  }

  // Matched on NAME, not on the old address. A shared mailbox would move
  // somebody else's row too, and the roster is the record of who this is.
  const matched = (db.prepare(
    'SELECT id, name, email FROM staff_managers WHERE LOWER(TRIM(name)) = LOWER(TRIM(?))'
  ).all(CARA_ROSTER_NAME) as any[]).map((r) => {
    const row = Object.assign({}, r);
    return { id: row.id as number, name: row.name as string, was: (row.email ?? null) as string | null };
  });

  let staffUpdated = 0;
  for (const m of matched) {
    if (m.was === CARA_NEW_EMAIL) continue;
    staffUpdated += db.prepare('UPDATE staff_managers SET email = ? WHERE id = ?')
      .run(CARA_NEW_EMAIL, m.id).changes as number;
  }

  const notifyBefore = getSetting(CUSTODY_NOTIFY_KEY);
  setSetting(CUSTODY_NOTIFY_KEY, CARA_NEW_EMAIL, actor);
  const notifyAfter = getSetting(CUSTODY_NOTIFY_KEY);

  setSetting(APPLIED_KEY, new Date().toISOString(), actor);

  const report: MailboxUpdateReport = {
    applied: true,
    staff_rows_updated: staffUpdated,
    staff_matched: matched,
    notify_before: notifyBefore,
    notify_after: notifyAfter,
  };

  // The audit trail carries the before values, because "what was it previously"
  // is the first question anyone asks when mail stops arriving.
  try {
    db.prepare(
      'INSERT INTO audit_log (action, account_name, account_id, manager, metadata) VALUES (?, ?, ?, ?, ?)'
    ).run('mailbox_updated', null, null, actor, JSON.stringify({
      key: APPLIED_KEY,
      new_email: CARA_NEW_EMAIL,
      staff_rows_updated: staffUpdated,
      staff_matched: matched,
      custody_notify_before: notifyBefore,
      custody_notify_after: notifyAfter,
      login_unchanged: CARA_OLD_EMAIL,
      note: 'Roster address and custody notification recipient only. The managers '
        + 'login row was deliberately left as it was.',
    }));
  } catch { /* an audit failure must not stop a boot */ }

  return report;
}

/** What /api/_diag reports, so the deployed state is checkable from outside. */
export function mailboxUpdateState(): {
  applied_at: string | null;
  roster: { id: number; name: string; email: string | null }[];
  custody_notify_setting: string | null;
  login_email_still: string | null;
} {
  const roster = (db.prepare(
    'SELECT id, name, email FROM staff_managers WHERE LOWER(TRIM(name)) = LOWER(TRIM(?))'
  ).all(CARA_ROSTER_NAME) as any[]).map((r) => {
    const row = Object.assign({}, r);
    return { id: row.id as number, name: row.name as string, email: (row.email ?? null) as string | null };
  });

  let loginEmail: string | null = null;
  try {
    const raw = db.prepare('SELECT email FROM managers WHERE LOWER(TRIM(name)) = LOWER(TRIM(?)) LIMIT 1')
      .get(CARA_ROSTER_NAME) as any;
    loginEmail = raw ? (Object.assign({}, raw).email ?? null) : null;
  } catch { loginEmail = null; }

  return {
    applied_at: getSetting(APPLIED_KEY),
    roster,
    custody_notify_setting: getSetting(CUSTODY_NOTIFY_KEY),
    login_email_still: loginEmail,
  };
}
