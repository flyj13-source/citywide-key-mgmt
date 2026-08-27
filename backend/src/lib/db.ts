import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import fs from 'fs';

// DB_PATH env var → /data/citywide.db on Render persistent disk
// CITYWIDE_DB_DIR → Electron desktop (%APPDATA%/CityWideKMS)
// default → ./database/citywide.db for local dev
const DB_PATH = process.env.DB_PATH ||
  path.join(process.env.CITYWIDE_DB_DIR || path.join(process.cwd(), 'database'), 'citywide.db');
const dbDir = path.dirname(DB_PATH);

if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

// Diagnostic: printed on every boot so Render logs confirm which file is live
console.log(`[db] DB_PATH=${DB_PATH} exists=${fs.existsSync(DB_PATH)} DB_PATH_env=${process.env.DB_PATH ?? '(unset — using default)'}`);

const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

// Apply schema (CREATE TABLE IF NOT EXISTS — safe to run every startup)
const schemaPath =
  process.env.CITYWIDE_SCHEMA_PATH || path.join(dbDir, 'schema.sql') ;
const fallbackSchema = path.join(process.cwd(), 'database', 'schema.sql');
const resolvedSchema = fs.existsSync(schemaPath) ? schemaPath : fallbackSchema;
if (fs.existsSync(resolvedSchema)) {
  const schema = fs.readFileSync(resolvedSchema, 'utf8');
  db.exec(schema);
}

// Safe migrations — run after schema so columns exist on fresh DBs
function cols(): string[] {
  return (db.prepare('PRAGMA table_info(accounts)').all() as any[]).map((c) => c.name);
}

// Rename name → ic_company_name (SQLite 3.25+)
if (cols().includes('name') && !cols().includes('ic_company_name'))
  db.exec('ALTER TABLE accounts RENAME COLUMN name TO ic_company_name');

// New columns
const needed: [string, string][] = [
  ['ic_company_name', 'TEXT'],
  ['bc_vendor_number', 'TEXT'],
  ['keys_yn', 'INTEGER DEFAULT 0'],
  ['security_app_yn', 'INTEGER DEFAULT 0'],
  ['metal_keys', 'INTEGER DEFAULT 0'],
  ['key_cards', 'INTEGER DEFAULT 0'],
  ['dispenser_keys', 'INTEGER DEFAULT 0'],
  ['office_keys', 'INTEGER DEFAULT 0'],
  ['ic_office_keys', 'INTEGER DEFAULT 0'],
  ['am_office_keys', 'INTEGER DEFAULT 0'],
  ['ccm_office_keys', 'INTEGER DEFAULT 0'],
  ['archived', 'INTEGER DEFAULT 0'],
  ['archived_at', 'DATETIME'],
  ['archived_by', 'TEXT'],
  ['am_metal_keys', 'INTEGER DEFAULT 0'],
  ['am_key_cards', 'INTEGER DEFAULT 0'],
  ['am_key_fobs', 'INTEGER DEFAULT 0'],
  ['ccm_metal_keys', 'INTEGER DEFAULT 0'],
  ['ccm_key_cards', 'INTEGER DEFAULT 0'],
  ['ccm_key_fobs', 'INTEGER DEFAULT 0'],
  ['contractor_metal_keys', 'INTEGER DEFAULT 0'],
  ['contractor_key_cards', 'INTEGER DEFAULT 0'],
  ['contractor_key_fobs', 'INTEGER DEFAULT 0'],
  // Holder × type grid (TRANSPOSED — Office is a HOLDER, not a type).
  ['am_metal', 'INTEGER DEFAULT 0'],
  ['am_card', 'INTEGER DEFAULT 0'],
  ['am_fob', 'INTEGER DEFAULT 0'],
  ['am_dispenser', 'INTEGER DEFAULT 0'],
  ['ccm_metal', 'INTEGER DEFAULT 0'],
  ['ccm_card', 'INTEGER DEFAULT 0'],
  ['ccm_fob', 'INTEGER DEFAULT 0'],
  ['ccm_dispenser', 'INTEGER DEFAULT 0'],
  ['contractor_metal', 'INTEGER DEFAULT 0'],
  ['contractor_card', 'INTEGER DEFAULT 0'],
  ['contractor_fob', 'INTEGER DEFAULT 0'],
  ['contractor_dispenser', 'INTEGER DEFAULT 0'],
  ['office_metal', 'INTEGER DEFAULT 0'],
  ['office_card', 'INTEGER DEFAULT 0'],
  ['office_fob', 'INTEGER DEFAULT 0'],
  ['office_dispenser', 'INTEGER DEFAULT 0'],
  ['office_keys_held', 'INTEGER DEFAULT 0'],
  ['lockbox_code', 'TEXT'],
  ['door_access_code_encrypted', 'TEXT'],
  ['door_access_code_iv', 'TEXT'],
  // legacy kept for compat
  ['ic_name', 'TEXT'],
  ['ic_id_number', 'TEXT'],
  ['customer_id', 'TEXT'],
  ['am_keys', 'INTEGER DEFAULT 0'],
  ['ccm_keys', 'INTEGER DEFAULT 0'],
  ['contractor_keys', 'INTEGER DEFAULT 0'],
  ['bc_client_number', 'TEXT'],
  ['account_manager', 'TEXT'],
  ['ccm_manager', 'TEXT'],
  // Contact address for an IC vendor, so a contractor holder can be emailed.
  ['ic_email', 'TEXT'],
];

const existing = cols();
const freshlyAddedGridCols = needed
  .filter(([col]) => col.match(/^(am_metal|am_card|am_fob|am_dispenser|ccm_metal|ccm_card|ccm_fob|ccm_dispenser|contractor_metal|contractor_card|contractor_fob|contractor_dispenser|office_metal|office_card|office_fob|office_dispenser)$/))
  .some(([col]) => !existing.includes(col));
for (const [col, def] of needed) {
  if (!existing.includes(col))
    db.exec(`ALTER TABLE accounts ADD COLUMN ${col} ${def}`);
}

// ── One-time data migration: role×type grid TRANSPOSE (Office becomes a
// HOLDER, not a key TYPE). Runs only the first time the new grid columns are
// added to this DB, and each copy is itself guarded (only fires when the
// destination is still 0 and the source has data) — so it is safe even if
// this branch ever re-runs, and it NEVER overwrites data someone has already
// entered into the new fields. Nothing is dropped; old columns stay in place.
if (freshlyAddedGridCols) {
  // 1) Old 9-cell role×type breakdown (am_metal_keys/am_key_cards/am_key_fobs,
  //    same for ccm_/contractor_) → the new am_metal/am_card/am_fob, etc.
  //    Same underlying data, just renamed fields; am_dispenser/ccm_dispenser/
  //    contractor_dispenser have no prior equivalent and stay 0.
  for (const role of ['am', 'ccm', 'contractor']) {
    db.exec(`
      UPDATE accounts SET
        ${role}_metal = ${role}_metal_keys,
        ${role}_card  = ${role}_key_cards,
        ${role}_fob   = ${role}_key_fobs
      WHERE ${role}_metal = 0 AND ${role}_card = 0 AND ${role}_fob = 0
        AND (${role}_metal_keys > 0 OR ${role}_key_cards > 0 OR ${role}_key_fobs > 0)
    `);
  }
  // 2) Legacy site-level office_keys (Office used to be a TYPE, one flat count)
  //    → office_metal. Ambiguous by nature (no prior type breakdown existed for
  //    office keys), so it lands entirely in the "metal" cell as the most common
  //    physical form — reported to the user rather than silently guessed at.
  db.exec(`
    UPDATE accounts SET office_metal = office_keys
    WHERE office_metal = 0 AND office_keys > 0
  `);
  const migrated = Object.assign({}, db.prepare(
    "SELECT COUNT(*) AS c FROM accounts WHERE office_metal > 0 AND office_metal = office_keys"
  ).get()).c as number;
  if (migrated > 0) {
    console.log(`✓ [migration] Copied legacy office_keys → office_metal for ${migrated} row(s) (ambiguous type, defaulted to "metal")`);
  }
  // NOTE: the old per-role office bolt-on columns (ic_office_keys/am_office_keys/
  // ccm_office_keys — "office-type keys attributed to role X") are intentionally
  // NOT migrated into the new grid. They represented a different concept (a
  // role's office-key count) than the new model (keys the Office HOLDER itself
  // has, by type) and conflating them would fabricate data. Those columns are
  // left in place, untouched, and no longer read by the app.
}

// bc_vendor_number must NOT be unique — one IC serves many clients (same vendor# on many rows).
// SQLite auto-indexes backing a UNIQUE constraint cannot be dropped via DROP INDEX; must rebuild.
{
  const indexes = (db.prepare('PRAGMA index_list(accounts)').all() as any[]).map((i: any) => i.name);
  if (indexes.includes('sqlite_autoindex_accounts_1')) {
    const currentCols = (db.prepare('PRAGMA table_info(accounts)').all() as any[]);
    const colDefs = currentCols.map((c) => {
      let def = `${c.name} ${c.type}`;
      if (c.notnull && c.name !== 'id') def += ' NOT NULL';
      if (c.dflt_value !== null) def += ` DEFAULT ${c.dflt_value}`;
      return def;
    }).join(', ');
    const colNames = currentCols.map((c) => c.name).join(', ');
    db.exec(`
      CREATE TABLE accounts_new (${colDefs});
      INSERT INTO accounts_new SELECT ${colNames} FROM accounts;
      DROP TABLE accounts;
      ALTER TABLE accounts_new RENAME TO accounts;
    `);
  }
}

// record_type column ('ic' | 'customer')
if (!cols().includes('record_type'))
  db.exec("ALTER TABLE accounts ADD COLUMN record_type TEXT DEFAULT 'ic'");
db.exec("UPDATE accounts SET record_type='ic' WHERE record_type IS NULL");

// Backup run log — one row per scheduled/manual backup. Written by the backup
// lib (which may open its own connection from the cron path); created here too
// so the /api/backups/status endpoint can always read it even before the first
// backup runs. Idempotent.
db.exec(`
  CREATE TABLE IF NOT EXISTS backups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    status TEXT NOT NULL,
    row_count INTEGER,
    size_bytes INTEGER,
    destination TEXT,
    filename TEXT,
    duration_ms INTEGER,
    message TEXT,
    detail TEXT
  )
`);

// Staff manager roster — first-class records for the PEOPLE who manage clients
// (Account Managers / CCMs), separate from the `managers` login table. Created
// here too (idempotent) so the roster API can always read it even on a DB whose
// schema.sql predates this feature. Client linkage stays on accounts.* TEXT
// columns, matched by name — this table never mutates those rows.
db.exec(`
  CREATE TABLE IF NOT EXISTS staff_managers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    manager_type TEXT NOT NULL,
    shift TEXT,
    day_night TEXT,
    email TEXT,
    phone TEXT,
    active INTEGER DEFAULT 1,
    login_manager_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// ── Generalize staff_managers into the unified CW-staff roster ───────────────
// role_category widens the table from managers-only to ALL City Wide staff:
//   'manager' — an Account Manager / CCM (manager_type holds AM/CCM/both)
//   'crew'    — field crew, discovered from check-out history (manager_type is
//               the non-null sentinel 'crew' since the column predates this and
//               is NOT NULL; it is surfaced to the API/UI as null)
//   'both'    — a manager who ALSO appears as a crew assignee
// Every pre-existing row is a manager, so backfill role_category='manager' once.
const smCols = (db.prepare('PRAGMA table_info(staff_managers)').all() as any[]).map(
  (c) => Object.assign({}, c).name
);
if (!smCols.includes('role_category')) {
  db.exec("ALTER TABLE staff_managers ADD COLUMN role_category TEXT");
  db.exec("UPDATE staff_managers SET role_category = 'manager' WHERE role_category IS NULL");
}

// Key sign-off forms — append-only log of in-person e-signatures for employees
// and contractors receiving/returning keys. Created here too (idempotent) so the
// forms API can always read/write it even on a DB whose schema.sql predates it.
db.exec(`
  CREATE TABLE IF NOT EXISTS key_forms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    party_type TEXT NOT NULL,
    action TEXT NOT NULL,
    person_name TEXT NOT NULL,
    person_id INTEGER,
    person_email TEXT,
    account_names TEXT,
    key_details TEXT,
    notes TEXT,
    signature_data TEXT NOT NULL,
    signature_hash TEXT NOT NULL,
    signed_at DATETIME NOT NULL,
    collected_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// ── Key custody columns on key_assignments ──────────────────────────────────
// Multi-key transactions (keys_json), holder identity/type, the ACTOR who
// recorded each side of the transaction (distinct from the holder, for
// on-behalf recording), and the check-out sign-off fields. PRAGMA-guarded so
// existing rows and their history are untouched — legacy single-key rows keep
// keys_json NULL and are read back through their key_type/keys_held text.
const assignmentCols = (db.prepare('PRAGMA table_info(key_assignments)').all() as any[]).map(
  (c) => Object.assign({}, c).name
);
const assignmentNeeded: [string, string][] = [
  ['keys_json', 'TEXT'],
  ['holder_type', 'TEXT'],
  ['holder_id', 'INTEGER'],
  ['recorded_by', 'TEXT'],
  ['checkin_recorded_by', 'TEXT'],
  ['signoff_token', 'TEXT'],
  ['signoff_expires_at', 'DATETIME'],
  ['signed_at', 'DATETIME'],
  ['signature_data', 'TEXT'],
  ['signature_hash', 'TEXT'],
  ['pdf_path', 'TEXT'],
];
// Signature lifecycle. The status is EXPLICIT rather than inferred from
// signed_at being null, because "waiting for a signature that is coming" and
// "no signature will ever arrive" must never look the same to Cara:
//   signed                 — captured, PDF delivered
//   awaiting_signature     — link sent, holder has not signed yet   (amber)
//   signature_unavailable  — holder has no email; nothing was sent  (RED)
//   signature_send_failed  — email exists, SMTP gave up after 3 tries (RED)
//   not_required           — check-ins, which never demand one
assignmentNeeded.push(
  ['signature_status', "TEXT"],
  ['no_email_reason', 'TEXT'],            // typed justification for proceeding unsigned
  ['signed_in_person_by', 'TEXT'],        // the witness who captured a wet signature
  ['signature_send_attempts', 'INTEGER DEFAULT 0'],
  ['signature_send_error', 'TEXT'],
  ['signature_last_attempt_at', 'DATETIME'],
  // The other party when keys pass directly between two holders. Both sides
  // receive both signed PDFs.
  ['counterparty_name', 'TEXT'],
  ['counterparty_email', 'TEXT'],
);
for (const [col, def] of assignmentNeeded) {
  if (!assignmentCols.includes(col)) db.exec(`ALTER TABLE key_assignments ADD COLUMN ${col} ${def}`);
}

// Backfill the status for rows that predate the column, from what they already
// prove: a signature means signed, an open check-out means awaiting, a returned
// record never needed one.
if (!assignmentCols.includes('signature_status')) {
  db.exec("UPDATE key_assignments SET signature_status = 'signed' WHERE signed_at IS NOT NULL");
  db.exec("UPDATE key_assignments SET signature_status = 'awaiting_signature' WHERE signature_status IS NULL AND status = 'checked_out'");
  db.exec("UPDATE key_assignments SET signature_status = 'not_required' WHERE signature_status IS NULL");
}
db.exec('CREATE INDEX IF NOT EXISTS idx_key_assignments_sig_status ON key_assignments(signature_status)');
// Token lookup is a public, unauthenticated path — keep it indexed.
db.exec('CREATE INDEX IF NOT EXISTS idx_key_assignments_signoff_token ON key_assignments(signoff_token)');
db.exec('CREATE INDEX IF NOT EXISTS idx_key_assignments_status ON key_assignments(status)');

// ── Manager reassignment: physical-handover tracking ────────────────────────
// Reassigning a manager moves REGISTRY responsibility instantly; the physical
// keys still have to change hands. These columns keep those two truths
// separate: the registry is already correct, while pending_handover=1 flags
// that metal is still with the previous manager. Cleared when Cara confirms.
const acctCols2 = (db.prepare('PRAGMA table_info(accounts)').all() as any[]).map(
  (c) => Object.assign({}, c).name
);
const handoverNeeded: [string, string][] = [
  ['pending_handover', 'INTEGER DEFAULT 0'],
  ['pending_handover_from', 'TEXT'],
  ['pending_handover_to', 'TEXT'],
  ['pending_handover_role', 'TEXT'],
  ['pending_handover_at', 'DATETIME'],
];
for (const [col, def] of handoverNeeded) {
  if (!acctCols2.includes(col)) db.exec(`ALTER TABLE accounts ADD COLUMN ${col} ${def}`);
}

// is_test flag on managers — marks the dedicated troubleshooting account so its
// actions can be badged in the audit UI. PRAGMA-guarded: added only if absent.
const managerCols = (db.prepare('PRAGMA table_info(managers)').all() as any[]).map(
  (c) => Object.assign({}, c).name
);
if (!managerCols.includes('is_test'))
  db.exec('ALTER TABLE managers ADD COLUMN is_test INTEGER DEFAULT 0');
// can_delete — archive/restore/purge permission (Cara + the test account by default)
if (!managerCols.includes('can_delete'))
  db.exec('ALTER TABLE managers ADD COLUMN can_delete INTEGER DEFAULT 0');

// ── Desktop-only local tables (offline sync + queued AI) ────────────────────
// Created only in the Electron build so the Render schema stays untouched.
if (process.env.CITYWIDE_DESKTOP === '1') {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      method TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      payload TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      synced_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS sync_meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS ai_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      question TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      answer TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      answered_at DATETIME
    );
  `);
}

export const DATABASE_FILE = DB_PATH;
export default db;
