import { Router, Response } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth';
import db from '../lib/db';

const router = Router();

// People-roster aggregates for the Account Manager / CCM tabs.
//
// Key-attribution interpretation: the schema has NO per-type-per-role breakdown
// (am_keys / ccm_keys are single per-client totals, not split by metal/card/…),
// so each key-type column below is the SUM of the CLIENT-level key column across
// all customers that person manages — i.e. "Keys Across Clients". Total Keys is
// the sum of the five type columns. Aggregation is done in SQL (GROUP BY), never
// client-side over hundreds of rows.
//
// Sentinel/test records (bc_client_number starting "999") are excluded so the
// rosters stay truthful, matching the dashboard hygiene rule.
function roster(column: 'account_manager' | 'ccm_manager') {
  const rows = db.prepare(`
    SELECT
      ${column}                          AS person,
      COUNT(*)                           AS clients_managed,
      COALESCE(SUM(metal_keys), 0)       AS metal_keys,
      COALESCE(SUM(key_cards), 0)        AS key_cards,
      COALESCE(SUM(has_fob), 0)          AS key_fobs,
      COALESCE(SUM(dispenser_keys), 0)   AS dispenser_keys,
      COALESCE(SUM(office_keys), 0)      AS office_keys
    FROM accounts
    WHERE record_type = 'customer'
      AND ${column} IS NOT NULL AND TRIM(${column}) <> ''
      AND (bc_client_number IS NULL OR bc_client_number NOT LIKE '999%')
    GROUP BY ${column}
    ORDER BY (
      COALESCE(SUM(metal_keys),0) + COALESCE(SUM(key_cards),0) + COALESCE(SUM(has_fob),0)
      + COALESCE(SUM(dispenser_keys),0) + COALESCE(SUM(office_keys),0)
    ) DESC, person ASC
  `).all() as any[];

  return rows.map((raw) => {
    const r = Object.assign({}, raw);
    const total_keys =
      r.metal_keys + r.key_cards + r.key_fobs + r.dispenser_keys + r.office_keys;
    return { ...r, total_keys };
  });
}

router.get('/account-managers', requireAuth, (_req: AuthRequest, res: Response) => {
  res.json({ managers: roster('account_manager') });
});

router.get('/ccms', requireAuth, (_req: AuthRequest, res: Response) => {
  res.json({ managers: roster('ccm_manager') });
});

export default router;
