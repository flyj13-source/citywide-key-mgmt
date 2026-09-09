// ── Custody defaults ─────────────────────────────────────────────────────────
// Every decision a check-out or check-in can make FOR the user is made here,
// server-side, so the modal opens already answered rather than empty. The rule
// is the same throughout: propose the common case, never lock it in.
//
// Two people use this: Cara's team, standing at a handover with a tablet, and
// the ICs receiving keys. Neither should have to build a transaction from
// nothing when the system already knows the client, the contractor assigned to
// it, and what keys are on site.

import db from './db';
import { getSetting } from './settings';
import { availabilityFor } from './custody';

/** Same trim-to-null the custody routes use; local because it is a per-file
 *  helper there rather than a shared export. */
const cleanText = (v: any): string | null => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};

export const DUE_DAYS_KEY = 'custody_default_due_days';
export const DEFAULT_DUE_DAYS = 30;

/** Configurable, because 30 days is a starting point and not a law. */
export function defaultDueDays(): number {
  const n = Number(getSetting(DUE_DAYS_KEY));
  return Number.isFinite(n) && n > 0 && n <= 3650 ? Math.floor(n) : DEFAULT_DUE_DAYS;
}

/** Today + the configured window, as YYYY-MM-DD for a date input. */
export function defaultDueDate(days = defaultDueDays()): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

export interface SuggestedHolder {
  id: number | null;
  name: string;
  email: string | null;
  type: 'employee' | 'ic';
  /** Why this person was proposed — shown on the button, so the default is
   *  never mysterious ("Check out to ALVES CLEANING — assigned IC"). */
  reason: string;
  has_email: boolean;
}

/**
 * Who normally takes this client's keys. The assigned IC first — they are the
 * ones on site — then the Account Manager. Returns null rather than guessing
 * when the client has neither, so the picker opens empty instead of wrong.
 */
export function suggestedHolderFor(account: any): SuggestedHolder | null {
  const icName = cleanText(account.ic_name);
  const vendorNo = cleanText(account.bc_vendor_number);

  // The assigned IC, matched on the vendor number first (exact) and on the
  // company name second — the name is free text on the client row and can
  // drift from the vendor record it points at.
  if (icName || vendorNo) {
    const raw = db.prepare(`
      SELECT id, ic_company_name, ic_email FROM accounts
       WHERE (record_type = 'ic' OR record_type IS NULL)
         AND COALESCE(archived, 0) = 0
         AND (
           (? <> '' AND bc_vendor_number = ?)
           OR (? <> '' AND UPPER(TRIM(ic_company_name)) = UPPER(TRIM(?)))
         )
       ORDER BY CASE WHEN bc_vendor_number = ? THEN 0 ELSE 1 END
       LIMIT 1
    `).get(vendorNo ?? '', vendorNo ?? '', icName ?? '', icName ?? '', vendorNo ?? '') as any;
    if (raw) {
      const ic = Object.assign({}, raw);
      const email = cleanText(ic.ic_email);
      return {
        id: ic.id, name: ic.ic_company_name, email, type: 'ic',
        reason: 'assigned IC', has_email: !!email,
      };
    }
    // Named on the client row but with no vendor record behind it. Still the
    // right answer for who holds the keys — it just cannot carry an address.
    if (icName) {
      return { id: null, name: icName, email: null, type: 'ic', reason: 'assigned IC', has_email: false };
    }
  }

  const amName = cleanText(account.account_manager);
  if (amName) {
    const raw = db.prepare(
      'SELECT id, name, email FROM staff_managers WHERE UPPER(TRIM(name)) = UPPER(TRIM(?)) AND COALESCE(active,1)=1 LIMIT 1'
    ).get(amName) as any;
    const m = raw ? Object.assign({}, raw) : null;
    const email = m ? cleanText(m.email) : null;
    return {
      id: m?.id ?? null, name: m?.name ?? amName, email, type: 'employee',
      reason: 'account manager', has_email: !!email,
    };
  }

  return null;
}

/**
 * The key types to pre-select. Everything the site actually has available, one
 * each — the common handover is a single key of each kind that exists there.
 * Quantities are a starting point; the form still lets them be changed.
 */
export function suggestedKeys(accountId: number) {
  return availabilityFor(accountId).map((a) => ({
    ...a,
    suggested: a.available > 0 ? 1 : 0,
  }));
}

/**
 * People who have actually held keys lately, most recent first. The holder
 * dropdown was alphabetical over 260+ records, which put the person you are
 * standing next to somewhere in the middle of a scroll.
 */
export function recentHolders(limit = 8) {
  const rows = (db.prepare(`
    SELECT assignee AS name,
           MAX(checked_out_at) AS last_used,
           holder_type, holder_id,
           MAX(assignee_email) AS email,
           COUNT(*) AS times
      FROM key_assignments
     WHERE assignee IS NOT NULL AND TRIM(assignee) <> ''
     GROUP BY assignee, holder_type, holder_id
     ORDER BY last_used DESC
     LIMIT ?
  `).all(limit) as any[]).map((r) => Object.assign({}, r));

  return rows.map((r) => ({
    id: r.holder_id ?? null,
    name: r.name as string,
    email: cleanText(r.email),
    type: (r.holder_type === 'ic' ? 'ic' : 'employee') as 'employee' | 'ic',
    last_used: r.last_used as string | null,
    times: Number(r.times) || 0,
  }));
}
