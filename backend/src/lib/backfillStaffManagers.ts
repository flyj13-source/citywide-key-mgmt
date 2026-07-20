import db from './db';

export interface BackfillResult {
  created: number;
  distinctNames: number;
  byType: { account_manager: number; ccm: number; both: number };
  alreadyPresent: number;
}

/**
 * Seed the staff_managers roster from the client rows' existing
 * account_manager / ccm_manager TEXT values — one row per DISTINCT name.
 *
 * manager_type is inferred:
 *   'both'            — the name appears in BOTH account_manager and ccm_manager
 *   'account_manager' — only in account_manager
 *   'ccm'             — only in ccm_manager
 *
 * shift / day_night are left NULL for Cara to fill in later.
 *
 * IDEMPOTENT: a name already on the roster (case/space-insensitive match) is
 * skipped, never duplicated or overwritten — so this is safe to run on every
 * boot. Sentinel/test client rows (bc_client_number starting "999") are
 * excluded so the roster matches the Account-Manager / CCM roster tabs exactly.
 *
 * This NEVER touches the accounts table — client linkage stays on
 * accounts.account_manager / accounts.ccm_manager, resolved by name.
 */
export function backfillStaffManagers(): BackfillResult {
  const norm = (s: string) => s.trim().toLowerCase();

  const nameFilter = `
    record_type = 'customer'
    AND COALESCE(archived, 0) = 0
    AND (bc_client_number IS NULL OR bc_client_number NOT LIKE '999%')
  `;

  const amNames = (db.prepare(
    `SELECT DISTINCT TRIM(account_manager) AS n FROM accounts
     WHERE ${nameFilter} AND account_manager IS NOT NULL AND TRIM(account_manager) <> ''`
  ).all() as any[]).map((r) => Object.assign({}, r).n as string);

  const ccmNames = (db.prepare(
    `SELECT DISTINCT TRIM(ccm_manager) AS n FROM accounts
     WHERE ${nameFilter} AND ccm_manager IS NOT NULL AND TRIM(ccm_manager) <> ''`
  ).all() as any[]).map((r) => Object.assign({}, r).n as string);

  const amSet = new Set(amNames.map(norm));
  const ccmSet = new Set(ccmNames.map(norm));

  // Merge into one distinct-name map, keeping the first-seen display casing.
  const nameMap = new Map<string, string>(); // norm -> display
  for (const n of [...amNames, ...ccmNames]) {
    const k = norm(n);
    if (!nameMap.has(k)) nameMap.set(k, n);
  }

  // Names already on the roster (normalized) — skip these.
  const existing = new Set(
    (db.prepare('SELECT name FROM staff_managers').all() as any[])
      .map((r) => norm(Object.assign({}, r).name as string))
  );

  const insert = db.prepare(
    'INSERT INTO staff_managers (name, manager_type, shift, day_night) VALUES (?, ?, NULL, NULL)'
  );

  const byType = { account_manager: 0, ccm: 0, both: 0 };
  let created = 0;
  let alreadyPresent = 0;

  for (const [key, display] of nameMap) {
    if (existing.has(key)) { alreadyPresent++; continue; }
    const inAm = amSet.has(key);
    const inCcm = ccmSet.has(key);
    const type: 'account_manager' | 'ccm' | 'both' =
      inAm && inCcm ? 'both' : inAm ? 'account_manager' : 'ccm';
    insert.run(display, type);
    byType[type]++;
    created++;
  }

  return { created, distinctNames: nameMap.size, byType, alreadyPresent };
}
