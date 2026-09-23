// ── Signature links: lifetime, state, renewal ────────────────────────────────
// Every signable document carries a magic link. This module owns how long that
// link lives, what state a Key Form's link is in, and what happens when one
// runs out unsigned.
//
// NOTHING HERE SENDS MAIL. Expiring-soon and expired are flags on the Key Forms
// tab and the dashboard; a renewal mints a fresh link silently. The only email
// a holder ever gets about a form is the one somebody chooses to send.

import crypto from 'crypto';
import db from './db';

/** Five days. The one TTL every signature link in the system uses. */
export const SIGNATURE_TTL_MS = 5 * 24 * 60 * 60 * 1000;
/** Plain-language form of the TTL, for the sentences that state it. */
export const SIGNATURE_TTL_LABEL = '5 days';
/** A link inside this window of expiry is flagged "Expiring soon" (day 4 of 5). */
export const EXPIRING_SOON_MS = 24 * 60 * 60 * 1000;
/**
 * How many times an unsigned form's link is renewed automatically before it is
 * left Expired for a person to deal with. Original link + 2 renewals = 15 days
 * of an open link; past that, silence is an answer somebody should look at.
 */
export const MAX_AUTO_RENEWALS = 2;

export const newExpiry = (from: Date = new Date()): string =>
  new Date(from.getTime() + SIGNATURE_TTL_MS).toISOString();

export const newToken = (): string => crypto.randomBytes(32).toString('hex');

/** SQLite DATETIME ('YYYY-MM-DD HH:MM:SS') and ISO both parse; null → null. */
export function parseWhen(v: any): Date | null {
  if (v == null || v === '') return null;
  const s = String(v);
  const d = new Date(s.includes('T') ? s : `${s.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export type LinkState = 'signed' | 'awaiting' | 'expiring_soon' | 'expired';

/**
 * Statuses in which a form is still waiting for a signature. Voided,
 * acknowledged-unsigned and superseded forms have left the signature cycle —
 * they are corrections, and flagging their links would be noise.
 */
export const PENDING_STATUSES = ['draft', 'sent', 'unsigned'] as const;
const PENDING_SQL = `status IN (${PENDING_STATUSES.map((s) => `'${s}'`).join(',')})`;

/**
 * The link state of one form row, or null when the form is outside the cycle.
 *
 * Evaluated from the row at read time, never stored, so a list is correct the
 * moment it is loaded even if no scheduled tick has run since the deadline.
 */
export function linkStateOf(row: any, now: Date = new Date()): LinkState | null {
  if (!row) return null;
  if (row.signed_at) return 'signed';
  if (!(PENDING_STATUSES as readonly string[]).includes(row.status)) return null;
  if (row.link_exhausted_at) return 'expired';
  const exp = parseWhen(row.token_expires_at);
  if (!exp || exp.getTime() <= now.getTime()) return 'expired';
  if (exp.getTime() - now.getTime() <= EXPIRING_SOON_MS) return 'expiring_soon';
  return 'awaiting';
}

/**
 * WHERE fragments for each state, so the list filter and the dashboard count
 * ask the database exactly the question linkStateOf answers for one row.
 * `now` is bound as two ISO parameters: [now, soon].
 */
export function linkStateWhere(state: LinkState): string {
  // token_expires_at is stored as ISO. Comparing ISO strings is chronological.
  switch (state) {
    case 'signed':
      return 'signed_at IS NOT NULL';
    case 'expired':
      return `signed_at IS NULL AND ${PENDING_SQL}
        AND (link_exhausted_at IS NOT NULL OR token_expires_at IS NULL OR token_expires_at <= ?)`;
    case 'expiring_soon':
      return `signed_at IS NULL AND ${PENDING_SQL} AND link_exhausted_at IS NULL
        AND token_expires_at > ? AND token_expires_at <= ?`;
    case 'awaiting':
      return `signed_at IS NULL AND ${PENDING_SQL} AND link_exhausted_at IS NULL
        AND token_expires_at > ?`;
  }
}

/** Positional params for linkStateWhere(state), given a clock. */
export function linkStateParams(state: LinkState, now: Date = new Date()): string[] {
  const n = now.toISOString();
  const soon = new Date(now.getTime() + EXPIRING_SOON_MS).toISOString();
  switch (state) {
    case 'signed': return [];
    case 'expired': return [n];
    case 'expiring_soon': return [n, soon];
    case 'awaiting': return [soon];
  }
}

export function linkStateCounts(now: Date = new Date()): Record<LinkState, number> {
  const count = (s: LinkState): number => {
    const r = db.prepare(`SELECT COUNT(*) AS c FROM key_form_docs WHERE ${linkStateWhere(s)}`)
      .get(...linkStateParams(s, now)) as any;
    return Number(Object.assign({}, r).c) || 0;
  };
  return {
    signed: count('signed'),
    awaiting: count('awaiting'),
    expiring_soon: count('expiring_soon'),
    expired: count('expired'),
  };
}

function audit(action: string, metadata: Record<string, any>): void {
  db.prepare(
    'INSERT INTO audit_log (action, account_name, account_id, manager, metadata) VALUES (?, ?, ?, ?, ?)'
  ).run(action, null, null, 'System', JSON.stringify(metadata));
}

export interface SweepResult {
  renewed: { id: number; form_no: string | null; cycle: number; expires_at: string }[];
  exhausted: { id: number; form_no: string | null }[];
}

/**
 * Renew every unsigned form whose link has run out, or stop it at the cap.
 *
 *   expired, renewals < 2  → fresh token, fresh 5-day expiry, renewals + 1,
 *                            back to Awaiting signature, audit
 *                            'signature_link_auto_renewed'
 *   expired, renewals = 2  → link_exhausted_at set, stays Expired, audit
 *                            'signature_link_exhausted' (once)
 *
 * Idempotent and safe to call from anywhere — the interval, the Key Forms
 * list, the dashboard. Each row is claimed with a compare-and-set on the token
 * it was read with, so two overlapping sweeps cannot both renew one form or
 * log a renewal twice.
 *
 * No email is sent. The fresh link is available from the Key Forms tab.
 */
export function sweepSignatureLinks(now: Date = new Date()): SweepResult {
  const result: SweepResult = { renewed: [], exhausted: [] };
  const due = (db.prepare(`
    SELECT id, form_no, holder_name, token, token_expires_at,
           COALESCE(link_renewals, 0) AS link_renewals
      FROM key_form_docs
     WHERE signed_at IS NULL AND ${PENDING_SQL}
       AND link_exhausted_at IS NULL
       AND (token_expires_at IS NULL OR token_expires_at <= ?)
     ORDER BY id ASC
  `).all(now.toISOString()) as any[]).map((r) => Object.assign({}, r));
  if (!due.length) return result;

  db.exec('BEGIN');
  try {
    for (const row of due) {
      const renewals = Number(row.link_renewals) || 0;
      if (renewals < MAX_AUTO_RENEWALS) {
        const token = newToken();
        const expires = newExpiry(now);
        const cycle = renewals + 1;
        const r = db.prepare(`
          UPDATE key_form_docs
             SET token = ?, token_expires_at = ?, link_renewals = ?, link_renewed_at = ?
           WHERE id = ? AND token IS ? AND signed_at IS NULL AND link_exhausted_at IS NULL
        `).run(token, expires, cycle, now.toISOString(), row.id, row.token);
        if (Number(r.changes) !== 1) continue;
        audit('signature_link_auto_renewed', {
          form_id: row.id, form_no: row.form_no, holder: row.holder_name,
          cycle, max_cycles: MAX_AUTO_RENEWALS,
          previous_expires_at: row.token_expires_at, new_expires_at: expires,
          emailed: false,
        });
        result.renewed.push({ id: row.id, form_no: row.form_no, cycle, expires_at: expires });
      } else {
        const r = db.prepare(`
          UPDATE key_form_docs SET link_exhausted_at = ?
           WHERE id = ? AND token IS ? AND signed_at IS NULL AND link_exhausted_at IS NULL
        `).run(now.toISOString(), row.id, row.token);
        if (Number(r.changes) !== 1) continue;
        audit('signature_link_exhausted', {
          form_id: row.id, form_no: row.form_no, holder: row.holder_name,
          renewals, max_cycles: MAX_AUTO_RENEWALS,
          expired_at: row.token_expires_at,
          note: 'Left Expired after the automatic renewals ran out — needs manual attention',
          emailed: false,
        });
        result.exhausted.push({ id: row.id, form_no: row.form_no });
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return result;
}

/**
 * A person is sending this form by hand. If its link is dead — expired, or
 * exhausted by the auto-renewal cap — revive it first, so the email never
 * carries a link that 410s on open. Resets the renewal count: manual attention
 * is exactly what the cap asks for, and it starts a fresh cycle.
 *
 * Returns true when a new link was minted.
 */
export function reviveLinkForManualSend(id: number, actor: string, now: Date = new Date()): boolean {
  const raw = db.prepare('SELECT * FROM key_form_docs WHERE id = ?').get(id) as any;
  if (!raw) return false;
  const row = Object.assign({}, raw);
  if (linkStateOf(row, now) !== 'expired') return false;
  const token = newToken();
  const expires = newExpiry(now);
  db.prepare(`
    UPDATE key_form_docs
       SET token = ?, token_expires_at = ?, link_renewals = 0,
           link_exhausted_at = NULL, link_renewed_at = ?
     WHERE id = ?
  `).run(token, expires, now.toISOString(), id);
  audit('signature_link_manually_renewed', {
    form_id: id, form_no: row.form_no, holder: row.holder_name,
    by: actor, was_exhausted: !!row.link_exhausted_at,
    previous_renewals: Number(row.link_renewals) || 0, new_expires_at: expires,
  });
  return true;
}

// ── The scheduler ────────────────────────────────────────────────────────────
// A plain interval. On Render Starter the service does not spin down (that is
// the free tier), so this fires — but a restart, a deploy or a crash still
// leaves gaps, which is why every read path also sweeps. The interval keeps the
// audit trail timely; the on-read sweep keeps the screen correct.

export const SWEEP_INTERVAL_MS = 15 * 60 * 1000;
let timer: NodeJS.Timeout | null = null;
export let lastSweepAt: string | null = null;

export function runSweepSafely(now: Date = new Date()): SweepResult | null {
  try {
    const r = sweepSignatureLinks(now);
    lastSweepAt = now.toISOString();
    if (r.renewed.length || r.exhausted.length) {
      console.log(
        `✓ [signature-links] ${r.renewed.length} renewed, ${r.exhausted.length} exhausted`,
      );
    }
    return r;
  } catch (e: any) {
    console.error('✗ [signature-links] sweep failed:', e?.message ?? e);
    return null;
  }
}

export function startSignatureLinkScheduler(): void {
  if (timer) return;
  runSweepSafely();
  timer = setInterval(() => runSweepSafely(), SWEEP_INTERVAL_MS);
  // Never hold the process open just for this.
  timer.unref?.();
}

export function stopSignatureLinkScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
