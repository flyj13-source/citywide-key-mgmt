import db from './db';

// ── Key custody model ────────────────────────────────────────────────────────
// A single check-out transaction can carry SEVERAL key types at once (2 metal
// keys + 1 fob, …). The set is stored on the assignment row as `keys_json`, a
// JSON array of { type, label, qty }. Legacy single-key rows (which only ever
// had the free-text key_type / keys_held pair) have keys_json = NULL and are
// surfaced as a best-effort single line so nothing in the history disappears.

export interface KeyLine {
  type: KeyTypeKey;
  label: string;
  qty: number;
}

export type KeyTypeKey = 'metal' | 'card' | 'fob' | 'dispenser';

/**
 * The four key types the registry tracks, each mapped to the client-site total
 * column on `accounts`. These are the SAME four rows as the Role Key Counts
 * grid in the Add/Edit Client modal (site total = sum across all holders), so
 * availability is computed against exactly the number the registry shows.
 */
export const KEY_TYPES: { key: KeyTypeKey; label: string; column: string }[] = [
  { key: 'metal', label: 'Metal Key', column: 'metal_keys' },
  { key: 'card', label: 'Key Card', column: 'key_cards' },
  { key: 'fob', label: 'Key Fob', column: 'has_fob' },
  { key: 'dispenser', label: 'Dispenser Key', column: 'dispenser_keys' },
];

const BY_KEY = new Map(KEY_TYPES.map((t) => [t.key, t]));

export const keyLabel = (type: string): string => BY_KEY.get(type as KeyTypeKey)?.label ?? type;

const num = (v: any): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

/**
 * Parse a request body's `keys` into validated lines. Unknown types, zero and
 * negative quantities are rejected loudly rather than silently dropped — a
 * check-out that recorded fewer keys than the person walked away with is worse
 * than an error message.
 */
export function parseKeyLines(input: any): { lines: KeyLine[]; error?: string } {
  if (!Array.isArray(input) || input.length === 0) {
    return { lines: [], error: 'Select at least one key type' };
  }
  const lines: KeyLine[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    const type = String(raw?.type ?? '').trim();
    const meta = BY_KEY.get(type as KeyTypeKey);
    if (!meta) return { lines: [], error: `Unknown key type "${type}"` };
    if (seen.has(type)) return { lines: [], error: `${meta.label} listed twice` };
    seen.add(type);
    const qty = num(raw?.qty);
    if (qty < 1) return { lines: [], error: `${meta.label} quantity must be at least 1` };
    lines.push({ type: meta.key, label: meta.label, qty });
  }
  return { lines };
}

/** Read an assignment row's key set, tolerating legacy single-key rows. */
export function readKeyLines(row: any): KeyLine[] {
  if (row?.keys_json) {
    try {
      const parsed = JSON.parse(row.keys_json);
      if (Array.isArray(parsed)) {
        return parsed
          .filter((k: any) => BY_KEY.has(k?.type))
          .map((k: any) => ({ type: k.type, label: k.label || keyLabel(k.type), qty: num(k.qty) || 1 }));
      }
    } catch { /* fall through to the legacy shape */ }
  }
  // Legacy row: one key, type inferred from the free text we were given.
  const legacy = legacyType(row?.key_type, row?.keys_held);
  return legacy ? [{ type: legacy, label: keyLabel(legacy), qty: 1 }] : [];
}

// Legacy rows carry a free-text key_type ('physical' | 'fob' | 'card' | 'code')
// plus a keys_held description. Map what we can; anything unclassifiable returns
// null so it is reported as "—" rather than invented into a type.
function legacyType(key_type: any, keys_held: any): KeyTypeKey | null {
  const s = `${key_type ?? ''} ${keys_held ?? ''}`.toLowerCase();
  if (/\bcard\b|keycard|key card/.test(s)) return 'card';
  if (/\bfob\b/.test(s)) return 'fob';
  if (/dispenser/.test(s)) return 'dispenser';
  if (/metal|physical/.test(s)) return 'metal';
  return null;
}

export const totalQty = (lines: KeyLine[]): number => lines.reduce((n, l) => n + l.qty, 0);

/** "2 × Metal Key · 1 × Key Fob" — the human summary stored on keys_held. */
export const summarizeKeys = (lines: KeyLine[]): string =>
  lines.map((l) => `${l.qty} × ${l.label}`).join(' · ');

// ── Availability ─────────────────────────────────────────────────────────────

export interface Availability {
  type: KeyTypeKey;
  label: string;
  site_total: number;
  checked_out: number;
  available: number;
}

/**
 * How many keys of each type exist at a client and how many are already out.
 *
 *   available = client-site total − currently checked out
 *
 * `excludeAssignmentId` lets a caller re-price an existing transaction without
 * counting its own keys against it.
 */
export function availabilityFor(accountId: number, excludeAssignmentId?: number): Availability[] {
  const acct = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId) as any;
  const account = acct ? Object.assign({}, acct) : null;

  const openRows = (db.prepare(
    `SELECT id, keys_json, key_type, keys_held FROM key_assignments
      WHERE account_id = ? AND status = 'checked_out'`
  ).all(accountId) as any[]).map((r) => Object.assign({}, r));

  const out = new Map<string, number>();
  for (const row of openRows) {
    if (excludeAssignmentId != null && Number(row.id) === Number(excludeAssignmentId)) continue;
    for (const line of readKeyLines(row)) {
      out.set(line.type, (out.get(line.type) ?? 0) + line.qty);
    }
  }

  return KEY_TYPES.map((t) => {
    const site_total = account ? num(account[t.column]) : 0;
    const checked_out = out.get(t.key) ?? 0;
    return {
      type: t.key,
      label: t.label,
      site_total,
      checked_out,
      available: Math.max(0, site_total - checked_out),
    };
  });
}

/**
 * Reject a check-out that would take more keys of a type than the client has
 * left. Returns an error string, or null when the request fits.
 */
export function checkAvailability(accountId: number, lines: KeyLine[]): string | null {
  const avail = new Map(availabilityFor(accountId).map((a) => [a.type, a]));
  for (const line of lines) {
    const a = avail.get(line.type);
    if (!a) continue;
    if (line.qty > a.available) {
      return `Only ${a.available} ${a.label}${a.available === 1 ? '' : 's'} available at this client (${a.site_total} on site, ${a.checked_out} already checked out) — cannot check out ${line.qty}.`;
    }
  }
  return null;
}

// ── Record context shared by the routes, the mailer and the PDFs ─────────────

/**
 * The client-facing account number. Customers carry a BC client number; IC
 * vendor records carry a BC vendor number. Every custody notification and
 * report shows whichever one the record actually has, rather than a blank
 * column that reads as "this client has no number".
 */
export function bcNumberFor(account: any): string | null {
  if (!account) return null;
  const v = account.record_type === 'customer'
    ? (account.bc_client_number || account.bc_vendor_number)
    : (account.bc_vendor_number || account.bc_client_number);
  const s = v == null ? '' : String(v).trim();
  return s === '' ? null : s;
}

/** BC number for an assignment row, resolved through its account_id. */
export function bcNumberForAssignment(row: any): string | null {
  if (!row?.account_id) return null;
  const raw = db.prepare('SELECT record_type, bc_client_number, bc_vendor_number FROM accounts WHERE id = ?')
    .get(row.account_id) as any;
  return raw ? bcNumberFor(Object.assign({}, raw)) : null;
}

export interface TransferSignatureState {
  /** How many of the two required signatures have landed. */
  signed: number;
  total: 2;
  complete: boolean;
  from_signed: boolean;
  to_signed: boolean;
}

/**
 * A transfer is INCOMPLETE until both halves are signed: the releasing holder
 * signs a check-IN, the receiving holder signs a check-OUT. Both sides of a
 * transfer share a transfer_id, so the state is derived from the group rather
 * than duplicated onto each row (where the two copies could disagree).
 *
 * A transfer that had to draw on several of the from-holder's open check-outs
 * still produces exactly TWO signature forms: the check-in form lives on the
 * PRIMARY from-record (transfer_role='from' with the lowest id) and covers the
 * whole transferred key set.
 */
export function transferSignatureState(transferId: string): TransferSignatureState {
  const rows = (db.prepare(
    `SELECT id, transfer_role, signed_at, checkin_signed_at FROM key_assignments
      WHERE transfer_id = ? ORDER BY id ASC`
  ).all(transferId) as any[]).map((r) => Object.assign({}, r));

  const fromRows = rows.filter((r) => r.transfer_role === 'from');
  const toRow = rows.find((r) => r.transfer_role === 'to');

  const from_signed = !!fromRows[0]?.checkin_signed_at;
  const to_signed = !!toRow?.signed_at;
  const signed = (from_signed ? 1 : 0) + (to_signed ? 1 : 0);
  return { signed, total: 2, complete: signed === 2, from_signed, to_signed };
}
