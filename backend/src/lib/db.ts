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
];

const existing = cols();
for (const [col, def] of needed) {
  if (!existing.includes(col))
    db.exec(`ALTER TABLE accounts ADD COLUMN ${col} ${def}`);
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

// is_test flag on managers — marks the dedicated troubleshooting account so its
// actions can be badged in the audit UI. PRAGMA-guarded: added only if absent.
const managerCols = (db.prepare('PRAGMA table_info(managers)').all() as any[]).map(
  (c) => Object.assign({}, c).name
);
if (!managerCols.includes('is_test'))
  db.exec('ALTER TABLE managers ADD COLUMN is_test INTEGER DEFAULT 0');

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
