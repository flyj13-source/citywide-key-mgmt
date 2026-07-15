import { Router, Response } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth';
import db from '../lib/db';

const router = Router();

// People-roster aggregates for the Account Manager / CCM tabs, in TWO groups:
//
//   PERSONALLY HOLDS  — what's in that person's pocket:
//       keys_held    = SUM of their role-count field (am_keys / ccm_keys)
//       office_held  = SUM of their role office field (am_office_keys / …)
//
//   ACROSS THEIR CLIENTS — every key that exists at the clients they manage:
//       metal_keys, key_cards, key_fobs, dispenser_keys, office_keys
//       (client-level type columns) + total_client_keys (sum of those five)
//
// All aggregation is done in SQL (GROUP BY + SUMs) — never client-side over
// hundreds of rows. Sentinel/test records (bc_client_number starting "999") are
// excluded so the rosters stay truthful, matching the dashboard hygiene rule.
function roster(groupCol: 'account_manager' | 'ccm_manager', role: 'am' | 'ccm') {
  const personalKeysCol = `${role}_keys`;      // computed total (metal+cards+fobs)
  const personalOfficeCol = `${role}_office_keys`;
  const rows = db.prepare(`
    SELECT
      ${groupCol}                          AS person,
      COUNT(*)                             AS clients_managed,
      COALESCE(SUM(${personalKeysCol}), 0) AS keys_held,
      COALESCE(SUM(${personalOfficeCol}), 0) AS office_held,
      -- PERSONALLY HOLDS, per type (SUM of the role's per-type breakdown)
      COALESCE(SUM(${role}_metal_keys), 0) AS personal_metal,
      COALESCE(SUM(${role}_key_cards), 0)  AS personal_cards,
      COALESCE(SUM(${role}_key_fobs), 0)   AS personal_fobs,
      -- ACROSS THEIR CLIENTS (client-level type columns)
      COALESCE(SUM(metal_keys), 0)         AS metal_keys,
      COALESCE(SUM(key_cards), 0)          AS key_cards,
      COALESCE(SUM(has_fob), 0)            AS key_fobs,
      COALESCE(SUM(dispenser_keys), 0)     AS dispenser_keys,
      COALESCE(SUM(office_keys), 0)        AS office_keys
    FROM accounts
    WHERE record_type = 'customer'
      AND COALESCE(archived, 0) = 0
      AND ${groupCol} IS NOT NULL AND TRIM(${groupCol}) <> ''
      AND (bc_client_number IS NULL OR bc_client_number NOT LIKE '999%')
    GROUP BY ${groupCol}
    ORDER BY (COALESCE(SUM(${personalKeysCol}), 0) + COALESCE(SUM(${personalOfficeCol}), 0)) DESC, person ASC
  `).all() as any[];

  return rows.map((raw) => {
    const r = Object.assign({}, raw);
    // Total personally held = role keys (metal+cards+fobs, incl. any legacy
    // uncategorised total) + the role's office keys.
    const total_held = r.keys_held + r.office_held;
    const total_client_keys =
      r.metal_keys + r.key_cards + r.key_fobs + r.dispenser_keys + r.office_keys;
    return { ...r, total_held, total_client_keys };
  });
}

router.get('/account-managers', requireAuth, (_req: AuthRequest, res: Response) => {
  res.json({ managers: roster('account_manager', 'am') });
});

router.get('/ccms', requireAuth, (_req: AuthRequest, res: Response) => {
  res.json({ managers: roster('ccm_manager', 'ccm') });
});

export default router;
