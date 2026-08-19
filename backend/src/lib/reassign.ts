import db from './db';

// ── Bulk manager reassignment ────────────────────────────────────────────────
// Transfers a manager's CLIENTS and their key responsibility to another manager
// in one atomic action.
//
// THE CENTRAL SUBTLETY: the holder-grid cells (am_metal/am_card/am_fob/
// am_dispenser, and the ccm_* set) are keyed by ROLE, not by person. The person
// is the name in accounts.account_manager / accounts.ccm_manager. So changing
// the name IS the transfer — the grid values are deliberately left untouched
// and are thereby re-attributed to the new manager. Zeroing or copying them
// would destroy or duplicate real key counts. We still record exactly how many
// keys moved with each client so the audit trail shows the consequence.

export type Role = 'am' | 'ccm';

export const ROLE_COLUMN: Record<Role, 'account_manager' | 'ccm_manager'> = {
  am: 'account_manager',
  ccm: 'ccm_manager',
};
export const ROLE_LABEL: Record<Role, string> = {
  am: 'Account Manager',
  ccm: 'Contract Compliance Manager',
};
const KEY_TYPES = ['metal', 'card', 'fob', 'dispenser'] as const;
const TYPE_LABEL: Record<string, string> = {
  metal: 'Metal Key', card: 'Key Card', fob: 'Key Fob', dispenser: 'Dispenser Key',
};

// Same hygiene rule the rosters use: archived rows and 999-sentinel test records
// never participate, so the numbers stay truthful.
const CLIENT_FILTER = `
  record_type = 'customer'
  AND COALESCE(archived, 0) = 0
  AND (bc_client_number IS NULL OR bc_client_number NOT LIKE '999%')
`;

export interface ReassignClient {
  id: number;
  name: string;
  bc_client_number: string | null;
  keys: { type: string; label: string; qty: number }[];
  total_keys: number;
  pending_handover: boolean;
}

/** Every client this manager holds in this role, with the keys they hold there. */
export function clientsFor(managerName: string, role: Role): ReassignClient[] {
  const col = ROLE_COLUMN[role];
  const rows = db.prepare(`
    SELECT id, ic_company_name, bc_client_number,
           COALESCE(${role}_metal,0)     AS k_metal,
           COALESCE(${role}_card,0)      AS k_card,
           COALESCE(${role}_fob,0)       AS k_fob,
           COALESCE(${role}_dispenser,0) AS k_dispenser,
           COALESCE(pending_handover,0)  AS pending_handover
      FROM accounts
     WHERE ${CLIENT_FILTER} AND ${col} = ?
     ORDER BY ic_company_name ASC
  `).all(managerName) as any[];

  return rows.map((raw) => {
    const r = Object.assign({}, raw);
    const keys = KEY_TYPES
      .map((t) => ({ type: t as string, label: TYPE_LABEL[t], qty: Number(r[`k_${t}`]) || 0 }))
      .filter((k) => k.qty > 0);
    return {
      id: r.id,
      name: r.ic_company_name,
      bc_client_number: r.bc_client_number ?? null,
      keys,
      total_keys: keys.reduce((n, k) => n + k.qty, 0),
      pending_handover: !!r.pending_handover,
    };
  });
}

/** Resolve a staff_managers row, or null. */
export function staffById(id: number): any | null {
  const raw = db.prepare('SELECT * FROM staff_managers WHERE id = ?').get(id) as any;
  return raw ? Object.assign({}, raw) : null;
}

/**
 * Is `target` allowed to hold `role`? AM→AM and CCM→CCM only; a person typed
 * 'both' can take either. Crew are never valid targets — they manage no clients.
 */
export function canHoldRole(target: any, role: Role): boolean {
  const rc = target.role_category ?? 'manager';
  if (rc !== 'manager' && rc !== 'both') return false;
  const mt = target.manager_type;
  if (mt === 'both') return true;
  return role === 'am' ? mt === 'account_manager' : mt === 'ccm';
}

export interface TransferResult {
  moved: { id: number; name: string; bc_client_number: string | null; keys_transferred: number; keys: any[] }[];
  totalClients: number;
  totalKeys: number;
  keyTypesAffected: string[];
}

/**
 * Apply the transfer. Caller supplies the already-validated client id list.
 * ATOMIC: every selected client moves or none does — a partial reassignment
 * would leave the registry lying about who is responsible for what.
 */
export function performTransfer(opts: {
  fromName: string;
  toName: string;
  role: Role;
  clientIds: number[];
  markHandover: boolean;
}): TransferResult {
  const { fromName, toName, role, clientIds, markHandover } = opts;
  const col = ROLE_COLUMN[role];

  // Snapshot BEFORE mutating — this is both the audit payload and the undo data.
  const all = clientsFor(fromName, role);
  const selected = all.filter((c) => clientIds.includes(c.id));

  const typesAffected = new Set<string>();
  for (const c of selected) for (const k of c.keys) typesAffected.add(k.label);

  db.exec('BEGIN IMMEDIATE');
  try {
    const update = markHandover
      ? db.prepare(
          `UPDATE accounts
              SET ${col} = ?, pending_handover = 1, pending_handover_from = ?,
                  pending_handover_to = ?, pending_handover_role = ?, pending_handover_at = ?
            WHERE id = ? AND ${col} = ?`
        )
      : db.prepare(`UPDATE accounts SET ${col} = ? WHERE id = ? AND ${col} = ?`);

    const now = new Date().toISOString();
    for (const c of selected) {
      // NOTE: the ${role}_* grid cells are intentionally NOT touched. They belong
      // to the ROLE; re-pointing the role's name re-attributes them.
      const res: any = markHandover
        ? update.run(toName, fromName, toName, role, now, c.id, fromName)
        : update.run(toName, c.id, fromName);
      if (res.changes !== 1) {
        // The row changed under us (someone else reassigned it first). Abort the
        // whole batch rather than commit a half-applied transfer.
        throw new Error(`Client "${c.name}" is no longer assigned to ${fromName} — nothing was changed`);
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  }

  return {
    moved: selected.map((c) => ({
      id: c.id, name: c.name, bc_client_number: c.bc_client_number,
      keys_transferred: c.total_keys, keys: c.keys,
    })),
    totalClients: selected.length,
    totalKeys: selected.reduce((n, c) => n + c.total_keys, 0),
    keyTypesAffected: [...typesAffected],
  };
}

/**
 * Reverse a transfer from its recorded before/after. Atomic, and skips clients
 * that have since moved on to a third manager — restoring those would overwrite
 * a newer, deliberate decision.
 */
export function performUndo(opts: {
  fromName: string;
  toName: string;
  role: Role;
  clientIds: number[];
}): { restored: number[]; skipped: { id: number; current: string | null }[] } {
  const { fromName, toName, role, clientIds } = opts;
  const col = ROLE_COLUMN[role];
  const restored: number[] = [];
  const skipped: { id: number; current: string | null }[] = [];

  db.exec('BEGIN IMMEDIATE');
  try {
    const read = db.prepare(`SELECT id, ${col} AS current FROM accounts WHERE id = ?`);
    const revert = db.prepare(
      `UPDATE accounts
          SET ${col} = ?, pending_handover = 0, pending_handover_from = NULL,
              pending_handover_to = NULL, pending_handover_role = NULL, pending_handover_at = NULL
        WHERE id = ? AND ${col} = ?`
    );
    for (const id of clientIds) {
      const row = read.get(id) as any;
      const current = row ? Object.assign({}, row).current : null;
      if (current !== toName) { skipped.push({ id, current }); continue; }
      const res: any = revert.run(fromName, id, toName);
      if (res.changes === 1) restored.push(id);
      else skipped.push({ id, current });
    }
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  }
  return { restored, skipped };
}

/** Clear the amber pending-handover flag once the metal has physically moved. */
export function confirmHandover(clientIds: number[]): number {
  let n = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    const stmt = db.prepare(
      `UPDATE accounts
          SET pending_handover = 0, pending_handover_from = NULL, pending_handover_to = NULL,
              pending_handover_role = NULL, pending_handover_at = NULL
        WHERE id = ? AND COALESCE(pending_handover, 0) = 1`
    );
    for (const id of clientIds) n += (stmt.run(id) as any).changes;
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  }
  return n;
}

/** Email address for a roster person, if we have one. */
export function staffEmail(name: string): string | null {
  const raw = db.prepare(
    'SELECT email FROM staff_managers WHERE name = ? AND email IS NOT NULL AND TRIM(email) <> "" LIMIT 1'
  ).get(name) as any;
  return raw ? Object.assign({}, raw).email : null;
}
