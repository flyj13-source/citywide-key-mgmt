// ── Resolving a return against open custody ──────────────────────────────────
// A person handing keys back does not know which transaction they came out on,
// and should never be asked. This works out the answer from the two facts they
// DO know — which client, and who is returning — and closes whatever records
// the returned keys actually satisfy.
//
// THE ALLOCATION RULE: oldest first. Keys are fungible within a type, so when
// someone holds two metal keys from two different check-outs and brings one
// back, the older record is the one that closes. Any other order would leave
// the stalest row open forever, which is exactly the row somebody is chasing.
//
// A record consumed in full is CLOSED. One consumed in part is SPLIT — the
// returned portion becomes its own closed row and the remainder stays open —
// so a partial return never reports keys as back when they are not.

import db from './db';
import { readKeyLines, summarizeKeys, type KeyLine } from './custody';

export interface OpenRecord {
  id: number;
  checked_out_at: string | null;
  keys: KeyLine[];
  row: any;
}

/**
 * Every open check-out for this holder at this client, OLDEST FIRST.
 *
 * Holder matching is case- and whitespace-insensitive because the same person
 * arrives spelled three ways across a roster, a client row and a free-text
 * entry. It is NOT fuzzy beyond that: two genuinely different names stay two
 * different people, and quietly merging them would move real custody onto the
 * wrong record.
 */
export function openRecordsFor(accountId: number, holder: string): OpenRecord[] {
  const name = String(holder ?? '').trim();
  if (!accountId || !name) return [];
  const rows = db.prepare(`
    SELECT * FROM key_assignments
     WHERE status = 'checked_out'
       AND account_id = ?
       AND LOWER(TRIM(assignee)) = LOWER(TRIM(?))
     ORDER BY COALESCE(checked_out_at, '') ASC, id ASC
  `).all(accountId, name) as any[];

  return rows.map((raw) => {
    const row = Object.assign({}, raw);
    return {
      id: row.id as number,
      checked_out_at: row.checked_out_at ?? null,
      keys: readKeyLines(row),
      row,
    };
  });
}

/** The union of everything this person has out at this client. */
export function unionKeys(records: OpenRecord[]): KeyLine[] {
  const by = new Map<string, KeyLine>();
  for (const r of records) {
    for (const k of r.keys) {
      const at = by.get(k.type);
      if (at) at.qty += k.qty;
      else by.set(k.type, { ...k });
    }
  }
  return [...by.values()];
}

export interface Allocation {
  /** Records fully consumed — these close outright. */
  close: OpenRecord[];
  /** One record consumed in part: `returning` closes, `remaining` stays out. */
  split: { record: OpenRecord; returning: KeyLine[]; remaining: KeyLine[] } | null;
  /** Records the return never reached — left open, untouched. */
  untouched: OpenRecord[];
  /**
   * Keys returned that no open record accounts for. Not an error: someone can
   * hand back a key whose check-out predates the system. These are reconciled
   * into a new closed record so the return is captured rather than refused.
   */
  unmatched: KeyLine[];
}

/**
 * Walk the open records oldest first, taking what the return covers.
 *
 * At most ONE record can end up split: records are consumed whole until the
 * returned quantity runs out, and the record it runs out inside is the only
 * partial one. That keeps the audit trail legible — a return produces one new
 * closed row per record it touched, never a scatter of fragments.
 */
export function allocateReturn(records: OpenRecord[], returning: KeyLine[]): Allocation {
  // Working copy — nothing here mutates the caller's lines or the DB rows.
  const pool = new Map<string, number>();
  for (const l of returning) pool.set(l.type, (pool.get(l.type) ?? 0) + l.qty);

  const close: OpenRecord[] = [];
  let split: Allocation['split'] = null;
  const untouched: OpenRecord[] = [];

  for (const rec of records) {
    if (split) { untouched.push(rec); continue; }

    const taken: KeyLine[] = [];
    const left: KeyLine[] = [];
    for (const k of rec.keys) {
      const available = pool.get(k.type) ?? 0;
      const take = Math.min(available, k.qty);
      if (take > 0) {
        pool.set(k.type, available - take);
        taken.push({ ...k, qty: take });
      }
      if (k.qty - take > 0) left.push({ ...k, qty: k.qty - take });
    }

    if (taken.length === 0) {
      // Nothing in this record was returned. It stays open, and later records
      // are still eligible — the return may target a specific key type this
      // record does not hold.
      untouched.push(rec);
    } else if (left.length === 0) {
      close.push(rec);
    } else {
      split = { record: rec, returning: taken, remaining: left };
    }
  }

  const unmatched: KeyLine[] = [];
  for (const l of returning) {
    const over = pool.get(l.type) ?? 0;
    if (over > 0) { unmatched.push({ ...l, qty: over }); pool.set(l.type, 0); }
  }

  return { close, split, untouched, unmatched };
}

/** What the modal needs to pre-fill itself and to write its one quiet line. */
export interface ReturnContext {
  open_count: number;
  keys: KeyLine[];
  /** ISO date of the earliest open check-out, or null when there is none. */
  since: string | null;
  record_ids: number[];
  /** Set when the holder has no address — the return can still be recorded. */
  holder_email: string | null;
  holder_type: 'employee' | 'ic' | null;
}

export function returnContext(accountId: number, holder: string): ReturnContext {
  const records = openRecordsFor(accountId, holder);
  const first = records[0];
  return {
    open_count: records.length,
    keys: unionKeys(records),
    since: first?.checked_out_at ?? null,
    record_ids: records.map((r) => r.id),
    holder_email: first ? (first.row.assignee_email ?? null) : null,
    holder_type: first ? (first.row.holder_type ?? null) : null,
  };
}

/** Human summary of what an allocation did, for the audit metadata. */
export function describeAllocation(a: Allocation): string {
  const parts: string[] = [];
  if (a.close.length) parts.push(`closed ${a.close.length} record${a.close.length === 1 ? '' : 's'}`);
  if (a.split) parts.push(`split #${a.split.record.id} (${summarizeKeys(a.split.remaining)} still out)`);
  if (a.unmatched.length) parts.push(`reconciled ${summarizeKeys(a.unmatched)} with no open record`);
  return parts.join('; ') || 'nothing to close';
}
