// ── Test fixtures ────────────────────────────────────────────────────────────
// Three records — a client, a CW staff member and an IC — for exercising forms
// and key custody end to end without touching real data.
//
// Everything here is IDEMPOTENT: seeding twice creates nothing new, so it is
// safe on every boot and safe to re-run between test passes.
//
// The contact addresses deliberately point at an operator-owned mailbox, so a
// test run can never email a real employee or a real contractor.
//
// Four fixtures, not three: the fourth has NO email on purpose, because the
// missing-address red-flag path is a real workflow and needs something to
// exercise it that is not a real person.

import db from './db';

export const TEST_CLIENT_NAME = 'ZZ TEST CLIENT — Do Not Use';
export const TEST_CLIENT_BC = '09999900001';
export const TEST_IC_NAME = 'ZZ TEST CONTRACTOR — Do Not Use';
export const TEST_VENDOR_NO = '09999900002';
export const TEST_MANAGER_NAME = 'ZZ Test Manager';
export const TEST_NO_EMAIL_STAFF_NAME = 'ZZ Test No-Email Staff';
export const TEST_EMAIL = 'keys@citywidekeys.com';

export interface FixtureIds {
  client: number;
  ic: number;
  manager: number;
  /** The deliberately address-less crew member. */
  noEmailStaff: number;
  created: string[];
  existing: string[];
}

const one = (sql: string, ...params: any[]): any | null => {
  const raw = db.prepare(sql).get(...params) as any;
  return raw ? Object.assign({}, raw) : null;
};

/**
 * Create the three fixtures if absent. Matching is by the natural key each
 * record already has — BC number, vendor number, roster name — so a re-run
 * finds what it made last time instead of duplicating it.
 */
export function seedTestFixtures(): FixtureIds {
  const created: string[] = [];
  const existing: string[] = [];

  // ── CW staff member ────────────────────────────────────────────────────────
  let mgr = one('SELECT id FROM staff_managers WHERE name = ?', TEST_MANAGER_NAME);
  if (mgr) {
    existing.push('staff');
    // Keep the flag and address true even if the row predates this seed.
    db.prepare(
      "UPDATE staff_managers SET is_test = 1, email = ?, active = 1, " +
      "manager_type = 'both', role_category = 'manager' WHERE id = ?"
    ).run(TEST_EMAIL, mgr.id);
  } else {
    const r = db.prepare(`
      INSERT INTO staff_managers
        (name, manager_type, role_category, email, active, is_test)
      VALUES (?, 'both', 'manager', ?, 1, 1)
    `).run(TEST_MANAGER_NAME, TEST_EMAIL);
    mgr = { id: Number(r.lastInsertRowid) };
    created.push('staff');
  }

  // ── CW staff member with NO email ──────────────────────────────────────────
  // Exists so the "no address on file" path — the red flag, the blocked
  // signature, the written reason — can be exercised without picking on a real
  // employee. The address is forced back to NULL on every boot: a well-meaning
  // edit that fills it in would quietly remove the only way to test that path.
  let noEmail = one('SELECT id FROM staff_managers WHERE name = ?', TEST_NO_EMAIL_STAFF_NAME);
  if (noEmail) {
    existing.push('no-email staff');
    db.prepare('UPDATE staff_managers SET is_test = 1, email = NULL, active = 1 WHERE id = ?')
      .run(noEmail.id);
  } else {
    const r = db.prepare(`
      INSERT INTO staff_managers
        (name, manager_type, role_category, email, active, is_test)
      VALUES (?, 'crew', 'crew', NULL, 1, 1)
    `).run(TEST_NO_EMAIL_STAFF_NAME);
    noEmail = { id: Number(r.lastInsertRowid) };
    created.push('no-email staff');
  }

  // ── IC vendor ──────────────────────────────────────────────────────────────
  let ic = one(
    "SELECT id FROM accounts WHERE bc_vendor_number = ? AND (record_type = 'ic' OR record_type IS NULL)",
    TEST_VENDOR_NO,
  );
  if (ic) {
    existing.push('ic');
    db.prepare(`
      UPDATE accounts SET
        is_test = 1, ic_company_name = ?, ic_email = ?, ic_primary_contact = ?,
        record_type = 'ic', status = 'active', archived = 0
      WHERE id = ?
    `).run(TEST_IC_NAME, TEST_EMAIL, 'ZZ Test Contact', ic.id);
  } else {
    const r = db.prepare(`
      INSERT INTO accounts
        (ic_company_name, bc_vendor_number, ic_primary_contact, ic_email,
         record_type, status, archived, is_test)
      VALUES (?, ?, 'ZZ Test Contact', ?, 'ic', 'active', 0, 1)
    `).run(TEST_IC_NAME, TEST_VENDOR_NO, TEST_EMAIL);
    ic = { id: Number(r.lastInsertRowid) };
    created.push('ic');
  }

  // ── Client site ────────────────────────────────────────────────────────────
  // The holder grid is populated so there is something to move around: AM,
  // CCM, contractor and office each hold a slice of the site's inventory.
  let client = one(
    "SELECT id FROM accounts WHERE bc_client_number = ? AND record_type = 'customer'",
    TEST_CLIENT_BC,
  );
  if (client) {
    existing.push('client');
    // REPAIR, not just re-flag. A row that exists but lost its grid, its
    // manager links or its vendor number is a fixture that cannot be used for
    // anything, so every boot restores the complete picture.
    db.prepare(`
      UPDATE accounts SET
        is_test = 1, ic_company_name = ?, record_type = 'customer',
        status = 'active', archived = 0,
        account_manager = ?, ccm_manager = ?, ic_name = ?, bc_vendor_number = ?,
        metal_keys = 4, key_cards = 2, has_fob = 2, dispenser_keys = 1, office_keys_held = 2,
        am_metal = 1, am_card = 1, am_fob = 0, am_dispenser = 0,
        ccm_metal = 1, ccm_card = 0, ccm_fob = 0, ccm_dispenser = 0,
        contractor_metal = 2, contractor_card = 0, contractor_fob = 1, contractor_dispenser = 0,
        office_metal = 0, office_card = 0, office_fob = 1, office_dispenser = 1,
        am_keys = 2, ccm_keys = 1, contractor_keys = 3,
        keys_yn = 1, security_app_yn = 0, lockbox_code = 'TEST',
        door_code_encrypted = NULL, door_code_iv = NULL,
        alarm_code_encrypted = NULL, alarm_code_iv = NULL
      WHERE id = ?
    `).run(
      TEST_CLIENT_NAME, TEST_MANAGER_NAME, TEST_MANAGER_NAME,
      TEST_IC_NAME, TEST_VENDOR_NO, client.id,
    );
  } else {
    const r = db.prepare(`
      INSERT INTO accounts (
        ic_company_name, bc_client_number, record_type, status, archived, is_test,
        account_manager, ccm_manager, ic_name, bc_vendor_number,
        metal_keys, key_cards, has_fob, dispenser_keys, office_keys_held,
        am_metal, am_card, am_fob, am_dispenser,
        ccm_metal, ccm_card, ccm_fob, ccm_dispenser,
        contractor_metal, contractor_card, contractor_fob, contractor_dispenser,
        office_metal, office_card, office_fob, office_dispenser,
        am_keys, ccm_keys, contractor_keys,
        keys_yn, security_app_yn, lockbox_code
      ) VALUES (
        ?, ?, 'customer', 'active', 0, 1,
        ?, ?, ?, ?,
        4, 2, 2, 1, 2,
        1, 1, 0, 0,
        1, 0, 0, 0,
        2, 0, 1, 0,
        0, 0, 1, 1,
        2, 1, 3,
        1, 0, 'TEST'
      )
    `).run(
      TEST_CLIENT_NAME, TEST_CLIENT_BC,
      TEST_MANAGER_NAME, TEST_MANAGER_NAME, TEST_IC_NAME, TEST_VENDOR_NO,
    );
    client = { id: Number(r.lastInsertRowid) };
    created.push('client');
  }

  return {
    client: client.id, ic: ic.id, manager: mgr.id, noEmailStaff: noEmail.id,
    created, existing,
  };
}

/** Is this account a fixture? Used by the archive/delete guard. */
export function isTestAccount(id: number | string): boolean {
  const row = one('SELECT COALESCE(is_test, 0) AS t FROM accounts WHERE id = ?', id);
  return !!row && row.t === 1;
}

/** Every id currently flagged as a fixture — the reset's blast radius. */
export function testAccountIds(): number[] {
  return (db.prepare('SELECT id FROM accounts WHERE COALESCE(is_test, 0) = 1').all() as any[])
    .map((r) => Object.assign({}, r).id as number);
}

export function testHolderNames(): string[] {
  const names = new Set<string>();
  for (const r of db.prepare('SELECT name FROM staff_managers WHERE COALESCE(is_test, 0) = 1').all() as any[]) {
    names.add(Object.assign({}, r).name);
  }
  for (const r of db.prepare(
    "SELECT ic_company_name AS n FROM accounts WHERE COALESCE(is_test,0)=1 AND (record_type='ic' OR record_type IS NULL)"
  ).all() as any[]) {
    names.add(Object.assign({}, r).n);
  }
  return [...names].filter(Boolean);
}

export interface ResetReport {
  assignments: number;
  forms: number;
  audit: number;
  fixtures: FixtureIds;
}

/**
 * Wipe everything the fixtures produced, then re-seed them clean. This is what
 * lets the same test be run again and again: assignments, key forms and audit
 * entries tied to test records go, and the three fixtures come back untouched.
 *
 * It deletes ONLY rows reachable from a test record — never anything real.
 */
export function resetTestData(): ResetReport {
  const ids = testAccountIds();
  const holders = testHolderNames();

  let assignments = 0;
  let forms = 0;
  let audit = 0;

  db.exec('BEGIN IMMEDIATE');
  try {
    if (ids.length) {
      const ph = ids.map(() => '?').join(',');
      assignments += db.prepare(`DELETE FROM key_assignments WHERE account_id IN (${ph})`).run(...ids).changes as number;
      audit += db.prepare(`DELETE FROM audit_log WHERE account_id IN (${ph})`).run(...ids).changes as number;
    }
    if (holders.length) {
      const ph = holders.map(() => '?').join(',');
      assignments += db.prepare(
        `DELETE FROM key_assignments WHERE assignee IN (${ph})`
      ).run(...holders).changes as number;
      forms += db.prepare(
        `DELETE FROM key_form_docs WHERE holder_name IN (${ph})`
      ).run(...holders).changes as number;
      audit += db.prepare(
        `DELETE FROM audit_log WHERE account_name IN (${ph}) OR manager IN (${ph})`
      ).run(...holders, ...holders).changes as number;
    }
    // Audit rows naming a test client by name rather than by id.
    const clientNames = (db.prepare(
      'SELECT ic_company_name AS n FROM accounts WHERE COALESCE(is_test,0)=1'
    ).all() as any[]).map((r) => Object.assign({}, r).n).filter(Boolean);
    if (clientNames.length) {
      const ph = clientNames.map(() => '?').join(',');
      audit += db.prepare(`DELETE FROM audit_log WHERE account_name IN (${ph})`).run(...clientNames).changes as number;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  // Re-seed after the wipe so the fixtures are always present afterwards.
  const fixtures = seedTestFixtures();
  return { assignments, forms, audit, fixtures };
}

// ── SQL fragments ────────────────────────────────────────────────────────────
// A key_assignment is a test row when it points at a fixture account OR is held
// by a fixture holder (the test staff member or the test IC). COALESCE guards
// the NULL cases — `NULL NOT IN (…)` is NULL, which would silently drop real
// rows that happen to have no account_id or no assignee.
export const NOT_TEST_ASSIGNMENT = `
  COALESCE(account_id, -1) NOT IN (SELECT id FROM accounts WHERE COALESCE(is_test, 0) = 1)
  AND COALESCE(assignee, '') NOT IN (
    SELECT name FROM staff_managers WHERE COALESCE(is_test, 0) = 1
    UNION SELECT ic_company_name FROM accounts WHERE COALESCE(is_test, 0) = 1
  )
`;
