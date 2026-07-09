import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import fs from 'fs';

// Desktop builds override the data directory (→ %APPDATA%/CityWideKMS) and the
// schema location (→ packaged resources) via env vars. On Render/local dev these
// are unset and we fall back to the repo-relative ./database folder.
const dbDir = process.env.CITYWIDE_DB_DIR || path.join(process.cwd(), 'database');
const DB_PATH = path.join(dbDir, 'citywide.db');

if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

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

// record_type column ('ic' | 'customer')
if (!cols().includes('record_type'))
  db.exec("ALTER TABLE accounts ADD COLUMN record_type TEXT DEFAULT 'ic'");
db.exec("UPDATE accounts SET record_type='ic' WHERE record_type IS NULL");

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
