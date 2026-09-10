// ── Test fixtures ────────────────────────────────────────────────────────────
// Nine records — three clients, one IC and five CW staff — for exercising key
// custody end to end without touching real data.
//
// Everything here is IDEMPOTENT: seeding twice creates nothing new, so it is
// safe on every boot and safe to re-run between test passes.
//
// The contact addresses deliberately point at an operator-owned mailbox, so a
// test run can never email a real employee or a real contractor.
//
// WHY THIS MANY. A single test manager could not exercise the things that
// actually go wrong in this system:
//   · two AMs, so a reassignment has a FROM and a TO;
//   · two CCMs on their own axis, so CCM moves prove they are independent of AM;
//   · three clients split 2/1 between the AMs, so a bulk reassignment moves a
//     non-trivial book and the roster totals visibly change on both sides;
//   · one crew member with NO email, because the missing-address red flag is a
//     real workflow and needs something to exercise it that is not a real
//     person.
//
// The whole set is flagged is_test = 1 and is excluded from every count,
// aggregate and export. The dashboard customer count must not move.

import db from './db';

// ── Staff ────────────────────────────────────────────────────────────────────
export const TEST_AM_ONE = 'ZZ Test AM One';
export const TEST_AM_TWO = 'ZZ Test AM Two';
export const TEST_CCM_ONE = 'ZZ Test CCM One';
export const TEST_CCM_TWO = 'ZZ Test CCM Two';
export const TEST_NO_EMAIL_STAFF_NAME = 'ZZ Test No-Email Staff';

/**
 * The single manager fixture this set replaces. Rows carrying this name are
 * migrated to AM One rather than left behind as an orphan holding keys nobody
 * can see on a roster.
 */
export const LEGACY_TEST_MANAGER_NAME = 'ZZ Test Manager';

// ── IC ───────────────────────────────────────────────────────────────────────
export const TEST_IC_NAME = 'ZZ TEST CONTRACTOR — Do Not Use';
export const TEST_VENDOR_NO = '09999900002';

// ── Clients ──────────────────────────────────────────────────────────────────
// The "— Do Not Use" suffix is load-bearing: these names are what a hurried
// person sees in a picker, and the warning belongs where the mistake happens.
export const TEST_CLIENT_A_NAME = 'ZZ TEST CLIENT A — Do Not Use';
export const TEST_CLIENT_B_NAME = 'ZZ TEST CLIENT B — Do Not Use';
export const TEST_CLIENT_C_NAME = 'ZZ TEST CLIENT C — Do Not Use';
export const TEST_CLIENT_A_BC = '09999900001';
export const TEST_CLIENT_B_BC = '09999900003';
export const TEST_CLIENT_C_BC = '09999900004';

export const TEST_EMAIL = 'keys@citywidekeys.com';
export const TEST_CLIENT_NOTES = 'Test fixture — safe to check out, transfer, and reset';

/** Back-compat aliases: client A is the original fixture, renamed in place. */
export const TEST_CLIENT_NAME = TEST_CLIENT_A_NAME;
export const TEST_CLIENT_BC = TEST_CLIENT_A_BC;

export interface FixtureStaffIds {
  amOne: number;
  amTwo: number;
  ccmOne: number;
  ccmTwo: number;
  /** The deliberately address-less crew member. */
  noEmail: number;
}

export interface FixtureClientIds {
  a: number;
  b: number;
  c: number;
}

export interface FixtureIds {
  clients: FixtureClientIds;
  ic: number;
  staff: FixtureStaffIds;
  created: string[];
  existing: string[];
  /** Anything the seed had to rewrite from an older fixture shape. */
  migrated: string[];
}

const one = (sql: string, ...params: any[]): any | null => {
  const raw = db.prepare(sql).get(...params) as any;
  return raw ? Object.assign({}, raw) : null;
};

const changes = (sql: string, ...params: any[]): number => {
  try { return db.prepare(sql).run(...params).changes as number; } catch { return 0; }
};

// ── Staff specs ──────────────────────────────────────────────────────────────

interface StaffSpec {
  key: string;
  name: string;
  // 'crew' is not a manager type the API will accept on a create, but it is
  // what a crew row already stores and what surfaceManagerType() expects to
  // suppress. The repair path writes this column on every boot, so the value
  // here has to match what production already holds or the seed would rewrite
  // a working row into a shape nothing asked for.
  manager_type: 'account_manager' | 'ccm' | 'both' | 'crew';
  role_category: 'manager' | 'crew';
  email: string | null;
}

const STAFF: StaffSpec[] = [
  { key: 'AM One', name: TEST_AM_ONE, manager_type: 'account_manager', role_category: 'manager', email: TEST_EMAIL },
  { key: 'AM Two', name: TEST_AM_TWO, manager_type: 'account_manager', role_category: 'manager', email: TEST_EMAIL },
  { key: 'CCM One', name: TEST_CCM_ONE, manager_type: 'ccm', role_category: 'manager', email: TEST_EMAIL },
  { key: 'CCM Two', name: TEST_CCM_TWO, manager_type: 'ccm', role_category: 'manager', email: TEST_EMAIL },
  // Email forced to NULL on every boot: a well-meaning edit that fills it in
  // would quietly remove the only safe way to test the missing-address path.
  { key: 'no-email staff', name: TEST_NO_EMAIL_STAFF_NAME, manager_type: 'crew', role_category: 'crew', email: null },
];

// ── Client specs ─────────────────────────────────────────────────────────────
// The holder grid is stated once, per client, and every site total is DERIVED
// from it. Writing both by hand is how a fixture ends up claiming two key cards
// while the grid holds one.

interface Grid {
  am_metal: number; am_card: number; am_fob: number; am_dispenser: number;
  ccm_metal: number; ccm_card: number; ccm_fob: number; ccm_dispenser: number;
  contractor_metal: number; contractor_card: number; contractor_fob: number; contractor_dispenser: number;
  office_metal: number; office_card: number; office_fob: number; office_dispenser: number;
}

const grid = (g: Partial<Grid>): Grid => ({
  am_metal: 0, am_card: 0, am_fob: 0, am_dispenser: 0,
  ccm_metal: 0, ccm_card: 0, ccm_fob: 0, ccm_dispenser: 0,
  contractor_metal: 0, contractor_card: 0, contractor_fob: 0, contractor_dispenser: 0,
  office_metal: 0, office_card: 0, office_fob: 0, office_dispenser: 0,
  ...g,
});

interface ClientSpec {
  key: 'a' | 'b' | 'c';
  label: string;
  name: string;
  bc: string;
  am: string;
  ccm: string;
  grid: Grid;
}

// AM One holds two clients and AM Two holds one, so an AM One → AM Two bulk
// reassignment has something real to move and both roster rows change.
const CLIENTS: ClientSpec[] = [
  {
    key: 'a', label: 'client A', name: TEST_CLIENT_A_NAME, bc: TEST_CLIENT_A_BC,
    am: TEST_AM_ONE, ccm: TEST_CCM_ONE,
    grid: grid({
      am_metal: 1, am_card: 1,
      ccm_metal: 1,
      contractor_metal: 2, contractor_fob: 1,
      office_fob: 1, office_dispenser: 1,
    }),
  },
  {
    key: 'b', label: 'client B', name: TEST_CLIENT_B_NAME, bc: TEST_CLIENT_B_BC,
    am: TEST_AM_ONE, ccm: TEST_CCM_ONE,
    grid: grid({ am_metal: 1, ccm_card: 1, contractor_metal: 1 }),
  },
  {
    key: 'c', label: 'client C', name: TEST_CLIENT_C_NAME, bc: TEST_CLIENT_C_BC,
    am: TEST_AM_TWO, ccm: TEST_CCM_TWO,
    grid: grid({ am_metal: 2, contractor_fob: 1 }),
  },
];

/**
 * Every column a client fixture owns, with its value. Site totals and the
 * per-holder subtotals are summed from the grid, so the row can never disagree
 * with itself. Returned as one record because the INSERT and the UPDATE are
 * both generated from it — a column added to one cannot go missing from the
 * other, and the placeholder count cannot drift from the value count.
 */
function clientFields(c: ClientSpec): Record<string, any> {
  const g = c.grid;
  const sum = (k: 'metal' | 'card' | 'fob' | 'dispenser') =>
    g[`am_${k}` as keyof Grid] + g[`ccm_${k}` as keyof Grid]
    + g[`contractor_${k}` as keyof Grid] + g[`office_${k}` as keyof Grid];
  const holder = (h: 'am' | 'ccm' | 'contractor' | 'office') =>
    g[`${h}_metal` as keyof Grid] + g[`${h}_card` as keyof Grid]
    + g[`${h}_fob` as keyof Grid] + g[`${h}_dispenser` as keyof Grid];

  return {
    ic_company_name: c.name,
    bc_client_number: c.bc,
    record_type: 'customer',
    status: 'active',
    archived: 0,
    is_test: 1,

    account_manager: c.am,
    ccm_manager: c.ccm,
    ic_name: TEST_IC_NAME,
    bc_vendor_number: TEST_VENDOR_NO,

    // Site inventory — the Key Inventory row, summed from the grid.
    metal_keys: sum('metal'),
    key_cards: sum('card'),
    has_fob: sum('fob'),
    dispenser_keys: sum('dispenser'),
    office_keys_held: holder('office'),

    ...g,

    am_keys: holder('am'),
    ccm_keys: holder('ccm'),
    contractor_keys: holder('contractor'),

    keys_yn: 1,
    security_app_yn: 1,
    lockbox_code: 'TEST',
    notes: TEST_CLIENT_NOTES,

    // A fixture never carries a real secret, and a reset must not leave one
    // behind from an experiment.
    door_code_encrypted: null,
    door_code_iv: null,
    alarm_code_encrypted: null,
    alarm_code_iv: null,
  };
}

// ── Migration off the single-manager fixture ─────────────────────────────────

/**
 * 'ZZ Test Manager' was one person doing both jobs. Everything that named it
 * moves onto the split roster: the person becomes AM One, the AM column on the
 * test clients follows, and the CCM column goes to CCM One — which is what the
 * old row was standing in for on that axis.
 *
 * Scoped to fixture rows throughout, so a real record that happens to share the
 * name is never rewritten.
 */
function migrateLegacyManager(out: string[]): void {
  const legacy = one('SELECT id, COALESCE(is_test,0) AS is_test FROM staff_managers WHERE name = ?', LEGACY_TEST_MANAGER_NAME);

  if (legacy) {
    const amOne = one('SELECT id FROM staff_managers WHERE name = ?', TEST_AM_ONE);
    if (amOne) {
      // Both exist — the legacy row is now a duplicate. It is NOT deleted:
      // retiring it keeps whatever history points at it readable while taking
      // it out of every roster and picker.
      db.prepare('UPDATE staff_managers SET is_test = 1, active = 0 WHERE id = ?').run(legacy.id);
      out.push(`retired duplicate '${LEGACY_TEST_MANAGER_NAME}' (#${legacy.id}) — '${TEST_AM_ONE}' already exists`);
    } else {
      db.prepare(
        "UPDATE staff_managers SET name = ?, manager_type = 'account_manager', " +
        "role_category = 'manager', email = ?, active = 1, is_test = 1 WHERE id = ?"
      ).run(TEST_AM_ONE, TEST_EMAIL, legacy.id);
      out.push(`renamed '${LEGACY_TEST_MANAGER_NAME}' → '${TEST_AM_ONE}' (#${legacy.id})`);
    }
  }

  // References follow the person even when the roster row was already gone,
  // because an assignment naming a manager who does not exist is exactly the
  // orphan this migration exists to avoid.
  // Client rows only. An AM column on an IC record is meaningless, and moving
  // a name onto one would leave the fixture set describing something the app
  // has no way to render.
  const am = changes(
    "UPDATE accounts SET account_manager = ? WHERE account_manager = ? " +
    "AND COALESCE(is_test,0) = 1 AND record_type = 'customer'",
    TEST_AM_ONE, LEGACY_TEST_MANAGER_NAME,
  );
  const ccm = changes(
    "UPDATE accounts SET ccm_manager = ? WHERE ccm_manager = ? " +
    "AND COALESCE(is_test,0) = 1 AND record_type = 'customer'",
    TEST_CCM_ONE, LEGACY_TEST_MANAGER_NAME,
  );
  if (am || ccm) out.push(`repointed ${am} AM and ${ccm} CCM link(s) on test clients`);

  const asn = changes(
    'UPDATE key_assignments SET assignee = ? WHERE assignee = ?',
    TEST_AM_ONE, LEGACY_TEST_MANAGER_NAME,
  );
  const frm = changes(
    'UPDATE key_form_docs SET holder_name = ? WHERE holder_name = ?',
    TEST_AM_ONE, LEGACY_TEST_MANAGER_NAME,
  );
  if (asn || frm) out.push(`moved ${asn} assignment(s) and ${frm} key form(s) to '${TEST_AM_ONE}'`);
}

// ── Seed ─────────────────────────────────────────────────────────────────────

/**
 * Create the fixtures if absent, REPAIR them if present. Matching is by the
 * natural key each record already has — BC number, vendor number, roster name —
 * so a re-run finds what it made last time instead of duplicating it.
 *
 * Repair matters as much as create: a fixture that exists but has lost its
 * grid, its manager links or its vendor number is a fixture nothing can be
 * tested against, so every boot restores the complete picture.
 */
export function seedTestFixtures(): FixtureIds {
  const created: string[] = [];
  const existing: string[] = [];
  const migrated: string[] = [];

  migrateLegacyManager(migrated);

  // ── CW staff ───────────────────────────────────────────────────────────────
  const staffIds: Record<string, number> = {};
  for (const s of STAFF) {
    const found = one('SELECT id FROM staff_managers WHERE name = ?', s.name);
    if (found) {
      existing.push(s.key);
      db.prepare(
        'UPDATE staff_managers SET is_test = 1, email = ?, active = 1, manager_type = ?, role_category = ? WHERE id = ?'
      ).run(s.email, s.manager_type, s.role_category, found.id);
      staffIds[s.key] = found.id;
    } else {
      const r = db.prepare(`
        INSERT INTO staff_managers (name, manager_type, role_category, email, active, is_test)
        VALUES (?, ?, ?, ?, 1, 1)
      `).run(s.name, s.manager_type, s.role_category, s.email);
      staffIds[s.key] = Number(r.lastInsertRowid);
      created.push(s.key);
    }
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

  // ── Client sites ───────────────────────────────────────────────────────────
  const clientIds: Record<string, number> = {};
  for (const c of CLIENTS) {
    const fields = clientFields(c);
    const cols = Object.keys(fields);
    const vals = cols.map((k) => fields[k]);

    const found = one(
      "SELECT id FROM accounts WHERE bc_client_number = ? AND record_type = 'customer'",
      c.bc,
    );
    if (found) {
      existing.push(c.label);
      db.prepare(
        `UPDATE accounts SET ${cols.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`
      ).run(...vals, found.id);
      clientIds[c.key] = found.id;
    } else {
      const r = db.prepare(
        `INSERT INTO accounts (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
      ).run(...vals);
      clientIds[c.key] = Number(r.lastInsertRowid);
      created.push(c.label);
    }
  }

  return {
    clients: { a: clientIds.a, b: clientIds.b, c: clientIds.c },
    ic: ic.id,
    staff: {
      amOne: staffIds['AM One'],
      amTwo: staffIds['AM Two'],
      ccmOne: staffIds['CCM One'],
      ccmTwo: staffIds['CCM Two'],
      noEmail: staffIds['no-email staff'],
    },
    created, existing, migrated,
  };
}

/** How many fixture records the seed is responsible for. */
export const EXPECTED_FIXTURE_COUNT = CLIENTS.length + 1 + STAFF.length;

/** The names the seed guarantees, for diagnostics that check presence. */
export const EXPECTED_FIXTURE_NAMES = {
  clients: CLIENTS.map((c) => c.name),
  ic: TEST_IC_NAME,
  staff: STAFF.map((s) => s.name),
};

/** Every fixture staff name, in seed order. */
export const TEST_STAFF_NAMES = STAFF.map((s) => s.name);

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
 * entries tied to test records go, and the fixtures come back untouched —
 * including the AM/CCM links, which a reassignment test will have moved.
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

  // Re-seed after the wipe so the fixtures are always present afterwards, and
  // so a reassignment test starts from the documented 2/1 split every time.
  const fixtures = seedTestFixtures();
  return { assignments, forms, audit, fixtures };
}

// ── SQL fragments ────────────────────────────────────────────────────────────
// A key_assignment is a test row when it points at a fixture account OR is held
// by a fixture holder (a test staff member or the test IC). COALESCE guards the
// NULL cases — `NULL NOT IN (…)` is NULL, which would silently drop real rows
// that happen to have no account_id or no assignee.
export const NOT_TEST_ASSIGNMENT = `
  COALESCE(account_id, -1) NOT IN (SELECT id FROM accounts WHERE COALESCE(is_test, 0) = 1)
  AND COALESCE(assignee, '') NOT IN (
    SELECT name FROM staff_managers WHERE COALESCE(is_test, 0) = 1
    UNION SELECT ic_company_name FROM accounts WHERE COALESCE(is_test, 0) = 1
  )
`;
