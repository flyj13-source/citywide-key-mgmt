// ── Who holds what, at ONE client ────────────────────────────────────────────
// A client's keys are split across four holders on the account row: the Account
// Manager, the CCM, the contractor (IC) and the Office. Each has its own cells
// — am_metal/am_card/am_fob/am_dispenser, ccm_*, contractor_*, office_*.
//
// The custody flow used to ignore that split entirely and offer the SITE total
// (metal_keys, key_cards, …), which is the sum across all four. So checking in
// for the AM at a client holding six keys offered all six — including the
// contractor's and the Office's — and a return could be recorded against keys
// that person never had.
//
// This module is the ONE place a holder is resolved to a role on a client and
// that role to its cells. The Key Form's holdings snapshot reads it, and so do
// Check Out / Check In / Transfer, so the document and the transaction can
// never disagree about what somebody holds.

import db from './db';
import { KEY_TYPES, type KeyTypeKey } from './custody';

/** The four holders on a client row, and the column prefix each one owns. */
export type RoleKey = 'am' | 'ccm' | 'contractor' | 'office';

export const ROLE_LABEL: Record<RoleKey, string> = {
  am: 'Account Manager',
  ccm: 'Contract Compliance Manager',
  contractor: 'Independent Contractor',
  office: 'Office',
};

/** Short form, for the `via` column on a form line. */
export const ROLE_SHORT: Record<RoleKey, string> = {
  am: 'AM', ccm: 'CCM', contractor: 'IC', office: 'Office',
};

/** grid cell for a (role, key type) pair — e.g. am + metal → am_metal. */
export function cellFor(role: RoleKey, type: KeyTypeKey): string {
  return `${role}_${type}`;
}

const num = (v: any): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};
const norm = (v: any): string => String(v ?? '').trim().toLowerCase();

export interface RoleHolding {
  role: RoleKey;
  label: string;
  /** Per-type counts from that role's four cells. */
  keys: { type: KeyTypeKey; label: string; qty: number }[];
  total: number;
}

/**
 * Every role this holder occupies on this client, with the keys each one
 * carries. Usually one; a person who is both the AM and the CCM of a client
 * legitimately occupies two, and each has its own cells.
 *
 * `holderType: 'ic'` also matches the contractor slot — by company name, and by
 * vendor number where the roster carries one, because the IC name written on a
 * client row is free text and drifts.
 *
 * `includeEmpty` keeps a role the holder occupies but holds nothing in, which
 * is what lets the caller say "you are the AM here but hold no keys" instead of
 * the much worse "no role on this client".
 */
export function rolesForHolder(
  accountId: number,
  holderName: string,
  holderType?: string | null,
  opts: { includeEmpty?: boolean } = {},
): RoleHolding[] {
  const name = norm(holderName);
  if (!accountId || !name) return [];

  const raw = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId) as any;
  if (!raw) return [];
  const account = Object.assign({}, raw);

  const matched: RoleKey[] = [];
  if (norm(account.account_manager) === name) matched.push('am');
  if (norm(account.ccm_manager) === name) matched.push('ccm');

  // The contractor slot. An IC-typed holder matches on the company name or its
  // vendor number; an employee never occupies it.
  if (holderType === 'ic') {
    let isContractor = norm(account.ic_name) === name;
    if (!isContractor) {
      const vRaw = db.prepare(
        "SELECT bc_vendor_number FROM accounts WHERE (record_type='ic' OR record_type IS NULL) "
        + 'AND LOWER(TRIM(ic_company_name)) = LOWER(TRIM(?)) LIMIT 1'
      ).get(holderName) as any;
      const vendor = vRaw ? String(Object.assign({}, vRaw).bc_vendor_number ?? '').trim() : '';
      if (vendor && vendor === String(account.bc_vendor_number ?? '').trim()) isContractor = true;
    }
    if (isContractor) matched.push('contractor');
  }

  // "Office" is a holder, not a person — anyone recording for it says so
  // explicitly rather than being matched by name.
  if (name === 'office' || name === 'city wide office') matched.push('office');

  const out: RoleHolding[] = [];
  for (const role of matched) {
    const keys = KEY_TYPES.map((t) => ({
      type: t.key,
      label: t.label,
      qty: num(account[cellFor(role, t.key)]),
    }));
    const total = keys.reduce((n, k) => n + k.qty, 0);
    if (total > 0 || opts.includeEmpty) {
      out.push({ role, label: ROLE_LABEL[role], keys, total });
    }
  }
  return out;
}

/**
 * The holder's keys at this client, summed across every role they occupy.
 *
 * Summed rather than returned per role because the person is one person: an
 * AM who is also the CCM of a client holds the union, and asking them to pick
 * which hat a key came off is bookkeeping they never saw.
 */
export function holderKeysAtClient(
  accountId: number,
  holderName: string,
  holderType?: string | null,
): { type: KeyTypeKey; label: string; qty: number }[] {
  const roles = rolesForHolder(accountId, holderName, holderType);
  const by = new Map<KeyTypeKey, number>();
  for (const r of roles) {
    for (const k of r.keys) by.set(k.type, (by.get(k.type) ?? 0) + k.qty);
  }
  return KEY_TYPES.map((t) => ({ type: t.key, label: t.label, qty: by.get(t.key) ?? 0 }));
}

/**
 * Does this client's holder grid carry ANY attribution at all?
 *
 * A client imported before the grid existed has all sixteen cells at zero while
 * still carrying real site totals. There is nothing to scope TO on such a row,
 * so role scoping does not apply to it — the site total is the only truth the
 * record holds, and refusing a check-in against it would lock out every legacy
 * client. Scoping switches on the moment somebody fills the grid in.
 */
export function hasGrid(accountId: number): boolean {
  if (!accountId) return false;
  const raw = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId) as any;
  if (!raw) return false;
  const account = Object.assign({}, raw);
  const roles: RoleKey[] = ['am', 'ccm', 'contractor', 'office'];
  return roles.some((r) => KEY_TYPES.some((t) => num(account[cellFor(r, t.key)]) > 0));
}

/** Does this holder occupy ANY role on this client? Drives the empty state. */
export function hasRoleAtClient(
  accountId: number,
  holderName: string,
  holderType?: string | null,
): boolean {
  return rolesForHolder(accountId, holderName, holderType, { includeEmpty: true }).length > 0;
}

/** "Account Manager", or "Account Manager + CCM" when they wear two hats. */
export function roleSummary(
  accountId: number,
  holderName: string,
  holderType?: string | null,
): string | null {
  const roles = rolesForHolder(accountId, holderName, holderType, { includeEmpty: true });
  if (!roles.length) return null;
  return roles.map((r) => ROLE_SHORT[r.role]).join(' + ');
}
