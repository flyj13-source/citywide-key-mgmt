import { Router, Response } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth';
import db, { DATABASE_FILE } from '../lib/db';
import { buildInfo } from '../lib/buildInfo';
import { backfillStaffManagers } from '../lib/backfillStaffManagers';
import {
  TEST_CLIENT_A_BC, TEST_CLIENT_B_BC, TEST_CLIENT_C_BC,
  TEST_IC_NAME, TEST_VENDOR_NO, TEST_STAFF_NAMES, TEST_EMAIL,
  LEGACY_TEST_MANAGER_NAME, EXPECTED_FIXTURE_COUNT, EXPECTED_FIXTURE_NAMES,
} from '../lib/testFixtures';
import { logAudit } from '../lib/audit';

const router = Router();

// ── GET /api/_diag — deployed-state truth, in one call ───────────────────────
// Answers "what is actually running and what does its schema look like?"
// without needing dashboard access. ADMIN ONLY and JWT-protected: it reveals
// infrastructure shape (DB path, row counts), never any client data and never
// a decrypted access code.
//
// Kept permanently rather than removed after one use — it is the mechanism that
// makes a deploy verifiable in a single curl, which is the problem it was added
// to solve. Everything it returns is derived live, so it cannot go stale.

const GRID_HOLDERS = ['am', 'ccm', 'contractor', 'office'] as const;
const GRID_TYPES = ['metal', 'card', 'fob', 'dispenser'] as const;

const scalar = (sql: string, ...params: any[]): number => {
  try {
    return (Object.assign({}, db.prepare(sql).get(...params)) as any).c as number;
  } catch {
    return -1;
  }
};

const tableExists = (name: string): boolean =>
  scalar("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name=?", name) > 0;

/** The most recent audit entry for an import action — null if it never ran
 *  against THIS database. This is what distinguishes "the code shipped" from
 *  "the import was actually applied here". */
const lastImport = (action: string): { at: string; by: string; metadata: any } | null => {
  try {
    const row = db.prepare(
      'SELECT created_at, manager, metadata FROM audit_log WHERE action = ? ORDER BY id DESC LIMIT 1'
    ).get(action) as any;
    if (!row) return null;
    const r = Object.assign({}, row);
    return { at: r.created_at, by: r.manager, metadata: JSON.parse(r.metadata || '{}') };
  } catch {
    return null;
  }
};

const columnsOf = (table: string): string[] => {
  try {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as any[]).map((c) => Object.assign({}, c).name);
  } catch {
    return [];
  }
};

router.get('/', requireAuth, (req: AuthRequest, res: Response) => {
  if (req.manager?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin only' });
  }

  const build = buildInfo();
  const accountCols = columnsOf('accounts');

  // 16 holder-grid cells
  const gridCells = GRID_HOLDERS.flatMap((h) => GRID_TYPES.map((t) => `${h}_${t}`));
  const gridPresent = gridCells.filter((c) => accountCols.includes(c));
  const gridMissing = gridCells.filter((c) => !accountCols.includes(c));

  // staff_managers roster
  const staffTable = tableExists('staff_managers');
  const staffCols = staffTable ? columnsOf('staff_managers') : [];
  const staffCount = staffTable ? scalar('SELECT COUNT(*) AS c FROM staff_managers') : -1;
  let roleDistribution: Record<string, number> = {};
  let managerTypeDistribution: Record<string, number> = {};
  if (staffTable && staffCols.includes('role_category')) {
    for (const raw of db.prepare(
      "SELECT COALESCE(role_category, '(null)') AS k, COUNT(*) AS c FROM staff_managers GROUP BY 1"
    ).all() as any[]) {
      const r = Object.assign({}, raw);
      roleDistribution[r.k] = r.c;
    }
    for (const raw of db.prepare(
      "SELECT COALESCE(manager_type, '(null)') AS k, COUNT(*) AS c FROM staff_managers GROUP BY 1"
    ).all() as any[]) {
      const r = Object.assign({}, raw);
      managerTypeDistribution[r.k] = r.c;
    }
  }

  // How many distinct managers the client rows imply — the backfill's input.
  // A gap between this and staff_managers means the backfill has not caught up.
  const distinctFromClients = scalar(`
    SELECT COUNT(*) AS c FROM (
      SELECT TRIM(account_manager) AS n FROM accounts
        WHERE record_type='customer' AND account_manager IS NOT NULL AND TRIM(account_manager) <> ''
      UNION
      SELECT TRIM(ccm_manager) FROM accounts
        WHERE record_type='customer' AND ccm_manager IS NOT NULL AND TRIM(ccm_manager) <> ''
    )
  `);

  // ── Test fixtures ──────────────────────────────────────────────────────────
  // Whether the ZZ TEST records actually exist ON THIS DATABASE, which is
  // otherwise unanswerable from outside: the seed runs at boot, so "the code
  // shipped" and "the rows are there" are different questions.
  const fixtureRow = (sql: string, ...p: any[]) => {
    try {
      const raw = db.prepare(sql).get(...p) as any;
      return raw ? Object.assign({}, raw) : null;
    } catch { return null; }
  };
  const smHasIsTest = columnsOf('staff_managers').includes('is_test');
  const acctHasIsTest = accountCols.includes('is_test');

  const clientRow = (bc: string) => fixtureRow(
    "SELECT id, ic_company_name AS name, COALESCE(is_test,0) AS is_test, account_manager, ccm_manager, " +
    "ic_name, bc_vendor_number, lockbox_code, " +
    "COALESCE(am_metal,0)+COALESCE(am_card,0)+COALESCE(am_fob,0)+COALESCE(am_dispenser,0)+" +
    "COALESCE(ccm_metal,0)+COALESCE(ccm_card,0)+COALESCE(ccm_fob,0)+COALESCE(ccm_dispenser,0)+" +
    "COALESCE(contractor_metal,0)+COALESCE(contractor_card,0)+COALESCE(contractor_fob,0)+COALESCE(contractor_dispenser,0)+" +
    "COALESCE(office_metal,0)+COALESCE(office_card,0)+COALESCE(office_fob,0)+COALESCE(office_dispenser,0) AS grid_total " +
    "FROM accounts WHERE bc_client_number = ? AND record_type = 'customer'", bc);

  const fxClients = {
    a: clientRow(TEST_CLIENT_A_BC),
    b: clientRow(TEST_CLIENT_B_BC),
    c: clientRow(TEST_CLIENT_C_BC),
  };
  const fxIc = fixtureRow(
    "SELECT id, ic_company_name AS name, COALESCE(is_test,0) AS is_test, ic_email, ic_primary_contact " +
    "FROM accounts WHERE bc_vendor_number = ? AND (record_type='ic' OR record_type IS NULL)", TEST_VENDOR_NO);

  // Keyed by name so a missing fixture reads as an explicit null rather than a
  // shorter array somebody has to count.
  const fxStaff: Record<string, any> = {};
  for (const n of TEST_STAFF_NAMES) {
    fxStaff[n] = smHasIsTest
      ? fixtureRow(
        'SELECT id, name, COALESCE(is_test,0) AS is_test, email, manager_type, role_category, active ' +
        'FROM staff_managers WHERE name = ?', n)
      : null;
  }

  // The pre-split fixture. Still on the roster means the migration has not run
  // on this database yet — which is the first thing to check when the AM tab
  // shows a manager nobody recognises.
  const legacyManager = smHasIsTest
    ? fixtureRow('SELECT id, name, COALESCE(is_test,0) AS is_test, active FROM staff_managers WHERE name = ?',
      LEGACY_TEST_MANAGER_NAME)
    : null;

  const fixtureRows = [...Object.values(fxClients), fxIc, ...Object.values(fxStaff)];
  const present = fixtureRows.filter((r) => r && r.is_test === 1).length;


  res.json({
    build: {
      commit: build.commit,
      commit_short: build.commitShort,
      source: build.source,
      built_at: build.builtAt,
      render_git_commit_env: process.env.RENDER_GIT_COMMIT ? 'set' : 'unset',
      node_env: process.env.NODE_ENV ?? null,
    },
    database: {
      path: DATABASE_FILE,
      on_mount: DATABASE_FILE.startsWith('/data'),
      tables: scalar("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table'"),
    },
    test_fixtures: {
      // The whole point: a full count means the seed ran and the rows are here.
      expected: EXPECTED_FIXTURE_COUNT,
      present,
      complete: present === EXPECTED_FIXTURE_COUNT,
      is_test_column: { accounts: acctHasIsTest, staff_managers: smHasIsTest },
      expected_names: EXPECTED_FIXTURE_NAMES,
      expected_contact: TEST_EMAIL,
      records: { clients: fxClients, ic: fxIc, staff: fxStaff },
      legacy_manager: legacyManager,
      // The AM One / AM Two split is only useful if the client book is split
      // 2/1 — a reassignment with nothing to move proves nothing.
      am_client_split: Object.fromEntries(
        TEST_STAFF_NAMES.map((n) => [n, Object.values(fxClients)
          .filter((c) => c && c.account_manager === n).length]),
      ),
      // How many rows are flagged in total — a fixture that got duplicated or
      // a real row wrongly flagged both show up here.
      flagged_totals: {
        accounts: scalar('SELECT COUNT(*) AS c FROM accounts WHERE COALESCE(is_test,0)=1'),
        staff_managers: smHasIsTest
          ? scalar('SELECT COUNT(*) AS c FROM staff_managers WHERE COALESCE(is_test,0)=1')
          : -1,
      },
      // What the isolation is actually worth right now.
      real_customers: scalar(
        "SELECT COUNT(*) AS c FROM accounts WHERE record_type='customer' AND COALESCE(is_test,0)=0"
      ),
      customers_including_test: scalar("SELECT COUNT(*) AS c FROM accounts WHERE record_type='customer'"),
    },
    holder_grid: {
      expected: gridCells.length,
      present: gridPresent.length,
      complete: gridMissing.length === 0,
      missing: gridMissing,
    },
    staff_managers: {
      table_exists: staffTable,
      row_count: staffCount,
      has_role_category: staffCols.includes('role_category'),
      role_category: roleDistribution,
      manager_type: managerTypeDistribution,
      distinct_managers_on_client_rows: distinctFromClients,
      backfill_gap: staffTable && distinctFromClients >= 0 ? Math.max(0, distinctFromClients - staffCount) : null,
    },
    counts: {
      customers: scalar("SELECT COUNT(*) AS c FROM accounts WHERE record_type = 'customer'"),
      ics: scalar("SELECT COUNT(*) AS c FROM accounts WHERE record_type = 'ic' OR record_type IS NULL"),
      archived: scalar('SELECT COUNT(*) AS c FROM accounts WHERE COALESCE(archived, 0) = 1'),
      key_assignments_open: scalar("SELECT COUNT(*) AS c FROM key_assignments WHERE status = 'checked_out'"),
      audit_rows: scalar('SELECT COUNT(*) AS c FROM audit_log'),
    },
    // ── Email backfill readiness ──────────────────────────────────────────
    // Answers, in one call: are the columns live, has anything actually been
    // imported into THIS database, and can a signature form reach a human?
    // "schema_ready true + coverage zero" means the build shipped but the
    // import was never run against this database.
    email_backfill: {
      schema_ready:
        accountCols.includes('ic_email') &&
        accountCols.includes('ic_primary_contact') &&
        staffCols.includes('email'),
      columns: {
        'accounts.ic_email': accountCols.includes('ic_email'),
        'accounts.ic_primary_contact': accountCols.includes('ic_primary_contact'),
        'staff_managers.email': staffCols.includes('email'),
      },
      coverage: {
        staff_total: staffCount,
        staff_with_email: staffCols.includes('email')
          ? scalar("SELECT COUNT(*) AS c FROM staff_managers WHERE email IS NOT NULL AND TRIM(email) <> ''")
          : -1,
        ics_total: scalar("SELECT COUNT(*) AS c FROM accounts WHERE record_type = 'ic' OR record_type IS NULL"),
        ics_with_email: accountCols.includes('ic_email')
          ? scalar("SELECT COUNT(*) AS c FROM accounts WHERE (record_type = 'ic' OR record_type IS NULL) AND ic_email IS NOT NULL AND TRIM(ic_email) <> ''")
          : -1,
        ics_with_primary_contact: accountCols.includes('ic_primary_contact')
          ? scalar("SELECT COUNT(*) AS c FROM accounts WHERE (record_type = 'ic' OR record_type IS NULL) AND ic_primary_contact IS NOT NULL AND TRIM(ic_primary_contact) <> ''")
          : -1,
        // The number that decides whether a signature form can be addressed.
        customers_total: scalar("SELECT COUNT(*) AS c FROM accounts WHERE record_type = 'customer' AND COALESCE(archived,0) = 0"),
        customers_resolving_to_ic_email: accountCols.includes('ic_email')
          ? scalar(`
              SELECT COUNT(*) AS c FROM accounts c1
               WHERE c1.record_type = 'customer' AND COALESCE(c1.archived,0) = 0
                 AND EXISTS (
                   SELECT 1 FROM accounts ic
                    WHERE (ic.record_type = 'ic' OR ic.record_type IS NULL)
                      AND COALESCE(ic.archived,0) = 0
                      AND ic.bc_vendor_number = c1.bc_vendor_number
                      AND ic.ic_email IS NOT NULL AND TRIM(ic.ic_email) <> ''
                 )`)
          : -1,
      },
      // Whether an import has EVER been applied to this database.
      last_import: {
        staff_emails: lastImport('staff_emails_imported'),
        ic_emails: lastImport('ic_emails_imported'),
      },
    },
    features: {
      // Presence of these columns is how a caller tells which builds are live.
      custody_multi_key: columnsOf('key_assignments').includes('keys_json'),
      custody_signoff: columnsOf('key_assignments').includes('signoff_token'),
      pending_handover: accountCols.includes('pending_handover'),
      key_forms: tableExists('key_forms'),
      // The registry uploader recognises the two email sheets. Present in the
      // build that added them, so a caller can tell whether the UI path is live.
      email_import_via_upload: true,
    },
  });
});

// ── POST /api/_diag/backfill-staff — re-run the roster backfill on demand ────
// The backfill already runs on every boot and is idempotent (it skips names
// already on the roster). This exposes the same call so a sparse roster can be
// repaired WITHOUT waiting for a redeploy — which matters when the roster is
// what a feature depends on. Admin only; reports exactly what it created.
router.post('/backfill-staff', requireAuth, (req: AuthRequest, res: Response) => {
  if (req.manager?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin only' });
  }
  const before = scalar('SELECT COUNT(*) AS c FROM staff_managers');
  const r = backfillStaffManagers();
  const after = scalar('SELECT COUNT(*) AS c FROM staff_managers');

  logAudit(req, 'staff_backfill_triggered', null, null, {
    before, after, created: r.created, by_type: r.byType,
    distinct_names: r.distinctNames, crew_created: r.crewCreated,
  });

  res.json({
    success: true,
    row_count_before: before,
    row_count_after: after,
    managers_created: r.created,
    by_type: r.byType,
    distinct_names_on_client_rows: r.distinctNames,
    crew_created: r.crewCreated,
    crew_promoted_to_both: r.crewPromotedToBoth,
    already_present: r.alreadyPresent,
  });
});

export default router;
