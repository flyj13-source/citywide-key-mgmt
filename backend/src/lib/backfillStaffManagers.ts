import db from './db';

export interface BackfillResult {
  // Managers (unchanged contract — the original manager backfill).
  created: number;
  distinctNames: number;
  byType: { account_manager: number; ccm: number; both: number };
  alreadyPresent: number;
  // Crew (field staff discovered from check-out history).
  crewDistinct: number;      // distinct crew assignee names found
  crewCreated: number;       // new pure-crew rows inserted
  crewPromotedToBoth: number; // existing managers who ALSO appear as crew → 'both'
  crewAlreadyPresent: number; // crew names already on the roster as crew/both
}

/**
 * Seed the unified staff roster (staff_managers) in two passes.
 *
 * PASS 1 — MANAGERS: one row per DISTINCT name in the client rows'
 *   account_manager / ccm_manager TEXT values. manager_type is inferred
 *   ('both' if the name is in both columns, else 'account_manager' / 'ccm');
 *   role_category = 'manager'. shift / day_night left NULL for Cara to fill in.
 *
 * PASS 2 — CREW: field staff who exist only as free-text names on check-outs.
 *   Distinct names are collected from key_assignments.assignee and, for
 *   completeness, staff_key_holders.staff_name. For each distinct crew name:
 *     • already a manager on the roster → promote that row to role_category
 *       'both' (they manage AND hold field keys); manager_type is untouched.
 *     • already present as crew/both    → skipped.
 *     • otherwise                        → a new row is inserted with
 *       role_category='crew' and the non-null sentinel manager_type='crew'
 *       (the column is NOT NULL and predates crew; the API surfaces it as null).
 *
 * IDEMPOTENT: safe to run on every boot — nothing is duplicated or overwritten.
 * Sentinel/test client rows (bc_client_number starting "999") are excluded from
 * the manager pass so the roster matches the AM / CCM roster tabs exactly.
 *
 * This NEVER touches the accounts / key_assignments rows — staff linkage stays
 * on those source columns, resolved by name.
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

  // Existing roster, normalized → its current role_category. Skip/merge against
  // these rather than duplicating.
  const rosterRows = db.prepare('SELECT id, name, role_category FROM staff_managers').all() as any[];
  const existing = new Map<string, { id: number; role_category: string | null }>();
  for (const raw of rosterRows) {
    const r = Object.assign({}, raw);
    existing.set(norm(r.name as string), { id: r.id, role_category: r.role_category ?? null });
  }

  // ── PASS 1: managers ───────────────────────────────────────────────────────
  const insertManager = db.prepare(
    "INSERT INTO staff_managers (name, manager_type, role_category, shift, day_night) VALUES (?, ?, 'manager', NULL, NULL)"
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
    const info = insertManager.run(display, type);
    byType[type]++;
    created++;
    existing.set(key, { id: Number(info.lastInsertRowid), role_category: 'manager' });
  }

  // ── PASS 2: crew (from check-out history) ──────────────────────────────────
  const crewNames = (db.prepare(
    `SELECT DISTINCT TRIM(assignee) AS n FROM key_assignments
     WHERE assignee IS NOT NULL AND TRIM(assignee) <> ''`
  ).all() as any[]).map((r) => Object.assign({}, r).n as string);

  // staff_key_holders is a second (legacy) source of field-staff names.
  const holderNames = (db.prepare(
    `SELECT DISTINCT TRIM(staff_name) AS n FROM staff_key_holders
     WHERE staff_name IS NOT NULL AND TRIM(staff_name) <> ''`
  ).all() as any[]).map((r) => Object.assign({}, r).n as string);

  const crewMap = new Map<string, string>(); // norm -> display
  for (const n of [...crewNames, ...holderNames]) {
    const k = norm(n);
    if (!crewMap.has(k)) crewMap.set(k, n);
  }

  const insertCrew = db.prepare(
    "INSERT INTO staff_managers (name, manager_type, role_category, shift, day_night) VALUES (?, 'crew', 'crew', NULL, NULL)"
  );
  const promoteToBoth = db.prepare("UPDATE staff_managers SET role_category = 'both' WHERE id = ?");

  let crewCreated = 0;
  let crewPromotedToBoth = 0;
  let crewAlreadyPresent = 0;

  for (const [key, display] of crewMap) {
    const onRoster = existing.get(key);
    if (onRoster) {
      // Already a manager (or 'both') — a manager who also does field work.
      if (onRoster.role_category === 'manager') {
        promoteToBoth.run(onRoster.id);
        onRoster.role_category = 'both';
        crewPromotedToBoth++;
      } else {
        crewAlreadyPresent++; // already 'crew' or 'both'
      }
      continue;
    }
    const info = insertCrew.run(display);
    existing.set(key, { id: Number(info.lastInsertRowid), role_category: 'crew' });
    crewCreated++;
  }

  return {
    created,
    distinctNames: nameMap.size,
    byType,
    alreadyPresent,
    crewDistinct: crewMap.size,
    crewCreated,
    crewPromotedToBoth,
    crewAlreadyPresent,
  };
}
