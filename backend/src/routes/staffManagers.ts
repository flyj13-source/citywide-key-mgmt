import { Router, Response } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth';
import db from '../lib/db';
import { logAudit } from '../lib/audit';

const router = Router();

// ── Staff manager roster ─────────────────────────────────────────────────────
// First-class records for the PEOPLE who manage clients (Account Managers /
// CCMs), distinct from the `managers` LOGIN table. Their "client book" is
// resolved by matching this person's name against the accounts.account_manager
// / accounts.ccm_manager TEXT columns — the 577 client rows are never mutated
// here. All aggregation is done in SQL, never client-side.

type ManagerType = 'account_manager' | 'ccm' | 'both';

const VALID_TYPES: ManagerType[] = ['account_manager', 'ccm', 'both'];
const VALID_SHIFTS = ['1st', '2nd', '3rd'];
const VALID_DAY_NIGHT = ['day', 'night'];

// Shared client-book filter: real client rows only, matching the roster tabs.
const CLIENT_FILTER = `
  record_type = 'customer'
  AND COALESCE(archived, 0) = 0
  AND (bc_client_number IS NULL OR bc_client_number NOT LIKE '999%')
`;

/**
 * Metrics for one roster person, computed against the live client rows and
 * scoped by their manager_type:
 *   clients_managed        — distinct clients where they are AM and/or CCM
 *   keys_personally_held   — their own holder-grid column totals (am_keys where
 *                            AM + ccm_keys where CCM), from the transposed grid
 *   total_managed_inventory— every key at those clients (site Key-Inventory row
 *                            totals), counted once per client
 */
function managerMetrics(name: string, type: ManagerType) {
  const includeAm = type === 'account_manager' || type === 'both';
  const includeCcm = type === 'ccm' || type === 'both';

  // Guard: a mistyped/empty name must never match every unmanaged row.
  if (!name || !name.trim() || (!includeAm && !includeCcm)) {
    return { clients_managed: 0, keys_personally_held: 0, total_managed_inventory: 0 };
  }

  const matchClauses: string[] = [];
  const params: any[] = [];
  if (includeAm) { matchClauses.push('account_manager = ?'); params.push(name); }
  if (includeCcm) { matchClauses.push('ccm_manager = ?'); params.push(name); }
  const match = `(${matchClauses.join(' OR ')})`;

  const heldParts: string[] = [];
  if (includeAm) heldParts.push('SUM(CASE WHEN account_manager = ? THEN COALESCE(am_keys, 0) ELSE 0 END)');
  if (includeCcm) heldParts.push('SUM(CASE WHEN ccm_manager = ? THEN COALESCE(ccm_keys, 0) ELSE 0 END)');
  const heldExpr = heldParts.join(' + ');
  const heldParams: any[] = [];
  if (includeAm) heldParams.push(name);
  if (includeCcm) heldParams.push(name);

  const row = Object.assign({}, db.prepare(`
    SELECT
      COUNT(*) AS clients_managed,
      ${heldExpr} AS keys_personally_held,
      COALESCE(SUM(
        COALESCE(metal_keys,0) + COALESCE(key_cards,0) + COALESCE(has_fob,0) + COALESCE(dispenser_keys,0)
      ), 0) AS total_managed_inventory
    FROM accounts
    WHERE ${CLIENT_FILTER} AND ${match}
  `).get(...heldParams, ...params));

  return {
    clients_managed: Number(row.clients_managed) || 0,
    keys_personally_held: Number(row.keys_personally_held) || 0,
    total_managed_inventory: Number(row.total_managed_inventory) || 0,
  };
}

function serialize(m: any) {
  const row = Object.assign({}, m);
  const metrics = managerMetrics(row.name, row.manager_type as ManagerType);
  return {
    id: row.id,
    name: row.name,
    manager_type: row.manager_type,
    shift: row.shift ?? null,
    day_night: row.day_night ?? null,
    email: row.email ?? null,
    phone: row.phone ?? null,
    active: row.active === null || row.active === undefined ? 1 : Number(row.active),
    login_manager_id: row.login_manager_id ?? null,
    created_at: row.created_at,
    ...metrics,
  };
}

// Normalize/validate an incoming type; returns null if invalid.
function cleanType(v: any): ManagerType | null {
  return VALID_TYPES.includes(v) ? (v as ManagerType) : null;
}
function cleanEnum(v: any, allowed: string[]): string | null {
  if (v === undefined || v === null || v === '') return null;
  return allowed.includes(v) ? v : null;
}
function cleanText(v: any): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

// ── GET /api/staff-managers — full roster with computed metrics ──────────────
router.get('/', requireAuth, (req: AuthRequest, res: Response) => {
  const includeInactive = req.query.include_inactive === '1' || req.query.include_inactive === 'true';
  const where = includeInactive ? '1=1' : 'COALESCE(active, 1) = 1';
  const rows = db.prepare(
    `SELECT * FROM staff_managers WHERE ${where} ORDER BY name ASC`
  ).all();
  res.json({ managers: rows.map(serialize) });
});

// ── GET /api/staff-managers/:id — one manager + their client book ────────────
router.get('/:id', requireAuth, (req: AuthRequest, res: Response) => {
  const m = db.prepare('SELECT * FROM staff_managers WHERE id = ?').get(req.params.id) as any;
  if (!m) return res.status(404).json({ error: 'Manager not found' });
  const row = Object.assign({}, m);
  const type = row.manager_type as ManagerType;
  const includeAm = type === 'account_manager' || type === 'both';
  const includeCcm = type === 'ccm' || type === 'both';

  const matchClauses: string[] = [];
  const params: any[] = [];
  if (includeAm) { matchClauses.push('account_manager = ?'); params.push(row.name); }
  if (includeCcm) { matchClauses.push('ccm_manager = ?'); params.push(row.name); }

  let clients: any[] = [];
  if (matchClauses.length && row.name && String(row.name).trim()) {
    const raw = db.prepare(`
      SELECT id, ic_company_name, bc_client_number, ic_name,
             account_manager, ccm_manager,
             COALESCE(am_keys,0) AS am_keys, COALESCE(ccm_keys,0) AS ccm_keys,
             COALESCE(contractor_keys,0) AS contractor_keys, COALESCE(office_keys_held,0) AS office_keys_held,
             COALESCE(metal_keys,0) AS metal_keys, COALESCE(key_cards,0) AS key_cards,
             COALESCE(has_fob,0) AS key_fobs, COALESCE(dispenser_keys,0) AS dispenser_keys
      FROM accounts
      WHERE ${CLIENT_FILTER} AND (${matchClauses.join(' OR ')})
      ORDER BY ic_company_name ASC
    `).all(...params) as any[];

    clients = raw.map((c) => {
      const client = Object.assign({}, c);
      const isAm = includeAm && client.account_manager === row.name;
      const isCcm = includeCcm && client.ccm_manager === row.name;
      const roles: string[] = [];
      if (isAm) roles.push('AM');
      if (isCcm) roles.push('CCM');
      // Keys THIS person personally holds at THIS client (their grid columns).
      const keys_here = (isAm ? client.am_keys : 0) + (isCcm ? client.ccm_keys : 0);
      return {
        id: client.id,
        ic_company_name: client.ic_company_name,
        bc_client_number: client.bc_client_number,
        ic_name: client.ic_name,
        account_manager: client.account_manager,
        ccm_manager: client.ccm_manager,
        role: roles.join(' + ') || '—',
        keys_here,
        // full holder breakdown at the client (for the "Keys at this client" column)
        am_keys: client.am_keys, ccm_keys: client.ccm_keys,
        contractor_keys: client.contractor_keys, office_keys_held: client.office_keys_held,
        metal_keys: client.metal_keys, key_cards: client.key_cards,
        key_fobs: client.key_fobs, dispenser_keys: client.dispenser_keys,
      };
    });
  }

  res.json({ manager: serialize(m), clients });
});

// ── POST /api/staff-managers — create ───────────────────────────────────────
router.post('/', requireAuth, (req: AuthRequest, res: Response) => {
  const name = cleanText(req.body.name);
  const manager_type = cleanType(req.body.manager_type);
  if (!name) return res.status(400).json({ error: 'Name is required' });
  if (!manager_type) return res.status(400).json({ error: "manager_type must be one of 'account_manager', 'ccm', 'both'" });

  const shift = cleanEnum(req.body.shift, VALID_SHIFTS);
  const day_night = cleanEnum(req.body.day_night, VALID_DAY_NIGHT);
  const email = cleanText(req.body.email);
  const phone = cleanText(req.body.phone);
  const active = req.body.active === 0 || req.body.active === false || req.body.active === '0' ? 0 : 1;
  const login_manager_id = req.body.login_manager_id != null && req.body.login_manager_id !== ''
    ? Number(req.body.login_manager_id) : null;

  const result = db.prepare(
    `INSERT INTO staff_managers (name, manager_type, shift, day_night, email, phone, active, login_manager_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(name, manager_type, shift, day_night, email, phone, active, login_manager_id);

  const id = Number(result.lastInsertRowid);
  logAudit(req, 'staff_manager_created', name, null, { id, manager_type, shift, day_night });

  const created = db.prepare('SELECT * FROM staff_managers WHERE id = ?').get(id);
  res.status(201).json({ manager: serialize(created) });
});

// ── PATCH /api/staff-managers/:id — update (incl. soft-deactivate) ──────────
// Never hard-deletes. Setting active=false soft-deactivates for audit integrity.
router.patch('/:id', requireAuth, (req: AuthRequest, res: Response) => {
  const existing = db.prepare('SELECT * FROM staff_managers WHERE id = ?').get(req.params.id) as any;
  if (!existing) return res.status(404).json({ error: 'Manager not found' });

  const updates: string[] = [];
  const params: any[] = [];
  const changed: Record<string, any> = {};

  if ('name' in req.body) {
    const name = cleanText(req.body.name);
    if (!name) return res.status(400).json({ error: 'Name cannot be empty' });
    updates.push('name = ?'); params.push(name); changed.name = name;
  }
  if ('manager_type' in req.body) {
    const t = cleanType(req.body.manager_type);
    if (!t) return res.status(400).json({ error: "manager_type must be one of 'account_manager', 'ccm', 'both'" });
    updates.push('manager_type = ?'); params.push(t); changed.manager_type = t;
  }
  if ('shift' in req.body) {
    const shift = cleanEnum(req.body.shift, VALID_SHIFTS);
    updates.push('shift = ?'); params.push(shift); changed.shift = shift;
  }
  if ('day_night' in req.body) {
    const dn = cleanEnum(req.body.day_night, VALID_DAY_NIGHT);
    updates.push('day_night = ?'); params.push(dn); changed.day_night = dn;
  }
  if ('email' in req.body) {
    const email = cleanText(req.body.email);
    updates.push('email = ?'); params.push(email); changed.email = email;
  }
  if ('phone' in req.body) {
    const phone = cleanText(req.body.phone);
    updates.push('phone = ?'); params.push(phone); changed.phone = phone;
  }
  if ('active' in req.body) {
    const active = req.body.active === 0 || req.body.active === false || req.body.active === '0' ? 0 : 1;
    updates.push('active = ?'); params.push(active); changed.active = active;
  }
  if ('login_manager_id' in req.body) {
    const lid = req.body.login_manager_id != null && req.body.login_manager_id !== ''
      ? Number(req.body.login_manager_id) : null;
    updates.push('login_manager_id = ?'); params.push(lid); changed.login_manager_id = lid;
  }

  if (!updates.length) return res.status(400).json({ error: 'No valid fields to update' });

  params.push(req.params.id);
  db.prepare(`UPDATE staff_managers SET ${updates.join(', ')} WHERE id = ?`).run(...params);

  const action = 'active' in changed && changed.active === 0
    ? 'staff_manager_deactivated'
    : ('active' in changed && changed.active === 1 && existing.active === 0
      ? 'staff_manager_reactivated'
      : 'staff_manager_updated');
  logAudit(req, action, changed.name ?? existing.name, null, { id: Number(req.params.id), changes: changed });

  const updated = db.prepare('SELECT * FROM staff_managers WHERE id = ?').get(req.params.id);
  res.json({ manager: serialize(updated) });
});

export default router;
