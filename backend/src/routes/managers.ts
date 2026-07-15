import { Router, Response } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth';
import db from '../lib/db';
import { logAudit } from '../lib/audit';

const router = Router();

// People-roster aggregates for the Account Manager / CCM tabs, in TWO groups:
//
//   PERSONALLY HOLDS — what's in that person's pocket, by type (Metal/Card/
//     Fob/Dispenser — the holder-grid columns for this role) + Total (the
//     computed column total, am_keys/ccm_keys). Office is its own holder now,
//     not a per-role bolt-on, so it no longer appears here.
//
//   ACROSS THEIR CLIENTS — the client-site Key Inventory (Metal/Card/Fob/
//     Dispenser row totals) at every client this person manages.
//
// All aggregation is done in SQL (GROUP BY + SUMs) — never client-side over
// hundreds of rows. Sentinel/test records (bc_client_number starting "999") are
// excluded so the rosters stay truthful, matching the dashboard hygiene rule.
function roster(groupCol: 'account_manager' | 'ccm_manager', role: 'am' | 'ccm') {
  const personalKeysCol = `${role}_keys`; // computed column total (metal+card+fob+dispenser)
  const rows = db.prepare(`
    SELECT
      ${groupCol}                          AS person,
      COUNT(*)                             AS clients_managed,
      COALESCE(SUM(${personalKeysCol}), 0) AS keys_held,
      -- PERSONALLY HOLDS, per type (this role's holder-grid columns)
      COALESCE(SUM(${role}_metal), 0)      AS personal_metal,
      COALESCE(SUM(${role}_card), 0)       AS personal_cards,
      COALESCE(SUM(${role}_fob), 0)        AS personal_fobs,
      COALESCE(SUM(${role}_dispenser), 0)  AS personal_dispenser,
      -- ACROSS THEIR CLIENTS (client-site Key Inventory row totals)
      COALESCE(SUM(metal_keys), 0)         AS metal_keys,
      COALESCE(SUM(key_cards), 0)          AS key_cards,
      COALESCE(SUM(has_fob), 0)            AS key_fobs,
      COALESCE(SUM(dispenser_keys), 0)     AS dispenser_keys
    FROM accounts
    WHERE record_type = 'customer'
      AND COALESCE(archived, 0) = 0
      AND ${groupCol} IS NOT NULL AND TRIM(${groupCol}) <> ''
      AND (bc_client_number IS NULL OR bc_client_number NOT LIKE '999%')
    GROUP BY ${groupCol}
    ORDER BY COALESCE(SUM(${personalKeysCol}), 0) DESC, person ASC
  `).all() as any[];

  return rows.map((raw) => {
    const r = Object.assign({}, raw);
    const total_held = r.keys_held; // column total IS the personal total now
    const total_client_keys = r.metal_keys + r.key_cards + r.key_fobs + r.dispenser_keys;
    return { ...r, total_held, total_client_keys };
  });
}

router.get('/account-managers', requireAuth, (_req: AuthRequest, res: Response) => {
  res.json({ managers: roster('account_manager', 'am') });
});

router.get('/ccms', requireAuth, (_req: AuthRequest, res: Response) => {
  res.json({ managers: roster('ccm_manager', 'ccm') });
});

// ── Grant / revoke a manager's delete permission (admin only) ────────────────
// The Manage Users UI arrives later; the endpoint exists now so Cara can grant
// can_delete=1 to a teammate. Audit-logged.
router.patch('/:id/permissions', requireAuth, (req: AuthRequest, res: Response) => {
  if (req.manager?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin only' });
  }
  const target = db.prepare('SELECT id, name, email FROM managers WHERE id = ?').get(req.params.id) as any;
  if (!target) return res.status(404).json({ error: 'Manager not found' });

  const { can_delete } = req.body as { can_delete?: boolean | number };
  const value = can_delete ? 1 : 0;
  db.prepare('UPDATE managers SET can_delete = ? WHERE id = ?').run(value, req.params.id);

  logAudit(req, 'permissions_changed', null, null, {
    target_manager: target.email, can_delete: value === 1,
  });

  res.json({ id: target.id, email: target.email, can_delete: value === 1 });
});

export default router;
