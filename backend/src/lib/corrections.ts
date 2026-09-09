// ── Corrections ──────────────────────────────────────────────────────────────
// Two things go wrong with custody records, and they are NOT the same thing:
//
//   VOID          the record should not exist. Wrong holder, duplicate, typo.
//                 It leaves active custody entirely and stops counting.
//
//   ACKNOWLEDGE   the record is correct, but the signature will never arrive.
//                 The keys really did move; only the paperwork is stuck.
//
// Conflating them would be the failure mode worth avoiding: voiding a real
// check-out loses the fact that someone holds keys, and marking a mistaken
// record "acknowledged" asserts a custody event that never happened.
//
// NOTHING here deletes. Every correction is an UPDATE that leaves the row in
// place with who did it, when, and why — because a correction is itself an
// auditable event, and a deleted row cannot be audited.
//
// A signature is never fabricated. 'acknowledged_unsigned' is a distinct state
// with its own colour and its own label; it must never render as Signed, and
// the PDF must never show a signature line as satisfied.

import db from './db';

export const MIN_REASON_LENGTH = 10;

export type CorrectionKind = 'void' | 'acknowledge';

export interface ReasonCheck {
  ok: boolean;
  reason: string;
  error?: string;
}

/**
 * A reason is required and has to say something. Ten characters is not a
 * quality bar — it is enough to stop "x" and "asdf" being the permanent record
 * of why a custody entry disappeared from the active list.
 */
export function checkReason(raw: any): ReasonCheck {
  const reason = typeof raw === 'string' ? raw.trim() : '';
  if (!reason) {
    return { ok: false, reason: '', error: 'A reason is required — it becomes the audit record.' };
  }
  if (reason.length < MIN_REASON_LENGTH) {
    return {
      ok: false,
      reason,
      error: `Give at least ${MIN_REASON_LENGTH} characters. "${reason}" will not mean anything to whoever reads the audit log later.`,
    };
  }
  return { ok: true, reason };
}

export interface VoidOutcome {
  id: number;
  previous_status: string | null;
  /** True when a live signature link was killed by this void. */
  link_invalidated: boolean;
  holder: string | null;
  holder_email: string | null;
  account_name: string | null;
  total_keys: number;
}

/**
 * Void ONE assignment. Idempotent: voiding an already-voided record is a
 * no-op that returns null rather than overwriting the original reason and
 * actor, which are the whole point of the record.
 */
export function voidAssignment(
  id: number, reason: string, actor: string,
): VoidOutcome | null {
  const raw = db.prepare('SELECT * FROM key_assignments WHERE id = ?').get(id) as any;
  if (!raw) return null;
  const a = Object.assign({}, raw);
  if (a.status === 'voided') return null;

  const hadLink = !!a.signoff_token || !!a.checkin_signoff_token;

  db.prepare(`
    UPDATE key_assignments
       SET status_before_void = COALESCE(status_before_void, status),
           status = 'voided',
           voided_at = ?, voided_by = ?, void_reason = ?,
           -- The magic link dies with the record: loadByToken finds nothing,
           -- so the recipient gets "Invalid or expired link" rather than a
           -- signature page for something that should not exist.
           signoff_token = NULL, checkin_signoff_token = NULL
     WHERE id = ?
  `).run(new Date().toISOString(), actor, reason, id);

  return {
    id,
    previous_status: a.status ?? null,
    link_invalidated: hadLink,
    holder: a.assignee ?? null,
    holder_email: a.assignee_email ?? null,
    account_name: a.account_name ?? null,
    total_keys: Number(a.keys_json ? JSON.parse(a.keys_json).reduce((n: number, l: any) => n + (l.qty || 0), 0) : 0),
  };
}

export interface AcknowledgeOutcome {
  id: number;
  previous_signature_status: string | null;
  holder: string | null;
  account_name: string | null;
}

/**
 * Record that a signature will not be collected for an assignment, WITHOUT
 * claiming one was. Refuses when the record is already signed: overwriting a
 * real signature with "we gave up" would destroy the stronger evidence.
 */
export function acknowledgeAssignment(
  id: number, reason: string, actor: string,
): AcknowledgeOutcome | null | { refused: string } {
  const raw = db.prepare('SELECT * FROM key_assignments WHERE id = ?').get(id) as any;
  if (!raw) return null;
  const a = Object.assign({}, raw);
  if (a.status === 'voided') return { refused: 'This record is voided — there is nothing to acknowledge.' };
  if (a.signed_at) return { refused: 'This record is already signed. An acknowledgement would weaken it.' };
  if (a.signature_status === 'acknowledged_unsigned') return null;

  db.prepare(`
    UPDATE key_assignments
       SET signature_status = 'acknowledged_unsigned',
           acknowledged_at = ?, acknowledged_by = ?, acknowledge_reason = ?,
           -- No token means no reminder and no stale link. The signature is
           -- settled: it is not coming, and the record says so.
           signoff_token = NULL, checkin_signoff_token = NULL
     WHERE id = ?
  `).run(new Date().toISOString(), actor, reason, id);

  return {
    id,
    previous_signature_status: a.signature_status ?? null,
    holder: a.assignee ?? null,
    account_name: a.account_name ?? null,
  };
}

// ── Key forms ───────────────────────────────────────────────────────────────

export function voidKeyForm(id: number, reason: string, actor: string): { id: number; previous_status: string } | null {
  const raw = db.prepare('SELECT * FROM key_form_docs WHERE id = ?').get(id) as any;
  if (!raw) return null;
  const f = Object.assign({}, raw);
  if (f.status === 'voided') return null;

  db.prepare(`
    UPDATE key_form_docs
       SET status_before_void = COALESCE(status_before_void, status),
           status = 'voided',
           voided_at = ?, voided_by = ?, void_reason = ?,
           token = NULL
     WHERE id = ?
  `).run(new Date().toISOString(), actor, reason, id);
  return { id, previous_status: f.status };
}

export function acknowledgeKeyForm(
  id: number, reason: string, actor: string,
): { id: number; previous_status: string } | null | { refused: string } {
  const raw = db.prepare('SELECT * FROM key_form_docs WHERE id = ?').get(id) as any;
  if (!raw) return null;
  const f = Object.assign({}, raw);
  if (f.status === 'voided') return { refused: 'This form is voided — there is nothing to acknowledge.' };
  if (f.signed_at) return { refused: 'This form is already signed. An acknowledgement would weaken it.' };
  if (f.status === 'acknowledged_unsigned') return null;

  db.prepare(`
    UPDATE key_form_docs
       SET status_before_void = COALESCE(status_before_void, status),
           status = 'acknowledged_unsigned',
           acknowledged_at = ?, acknowledged_by = ?, acknowledge_reason = ?,
           token = NULL
     WHERE id = ?
  `).run(new Date().toISOString(), actor, reason, id);
  return { id, previous_status: f.status };
}

/**
 * SQL that excludes corrected records from anything counting live custody.
 * Every "active" query already keys on status = 'checked_out', and a voided
 * row no longer has that status, so this is belt-and-braces for the queries
 * that ask a looser question.
 */
export const NOT_VOIDED = "COALESCE(status, '') <> 'voided'";

/**
 * Every state that means "this record still needs a signature and does not
 * have one". Deliberately broader than 'awaiting_signature': a failed send and
 * a missing address are outstanding signatures too, and are the ones least
 * likely to resolve on their own.
 */
export const SIGNATURE_OUTSTANDING = [
  'awaiting_signature', 'signature_send_failed', 'signature_unavailable',
] as const;

/** Counts for the filter chips, so a chip can show a number or hide itself. */
export function correctionCounts(): {
  overdue: number; awaiting_signature: number; voided: number; acknowledged_unsigned: number;
} {
  const n = (sql: string): number => {
    try { return (Object.assign({}, db.prepare(sql).get()) as any).c as number; } catch { return 0; }
  };
  return {
    // Must match reports.getOverdue() exactly, or the chip and the list it
    // opens would disagree about the same records.
    overdue: n(
      "SELECT COUNT(*) AS c FROM key_assignments WHERE status = 'checked_out' " +
      "AND due_at IS NOT NULL AND due_at < datetime('now') " +
      "AND COALESCE(signature_status, '') <> 'acknowledged_unsigned'"
    ),
    // "Awaiting" means the signature is OUTSTANDING, not merely that a link is
    // in flight. A record whose email failed, or whose holder has no address,
    // is the most stuck of all — counting only 'awaiting_signature' would hide
    // exactly the ones this feature exists to clear.
    awaiting_signature: n(
      "SELECT COUNT(*) AS c FROM key_assignments WHERE status = 'checked_out' " +
      `AND COALESCE(signature_status, '') IN (${SIGNATURE_OUTSTANDING.map((x) => `'${x}'`).join(',')})`
    ),
    voided: n("SELECT COUNT(*) AS c FROM key_assignments WHERE status = 'voided'"),
    acknowledged_unsigned: n(
      "SELECT COUNT(*) AS c FROM key_assignments " +
      "WHERE COALESCE(signature_status, '') = 'acknowledged_unsigned' AND COALESCE(status,'') <> 'voided'"
    ),
  };
}
