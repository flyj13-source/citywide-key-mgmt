import 'dotenv/config';
import { DatabaseSync } from 'node:sqlite';
import bcrypt from 'bcryptjs';
import path from 'path';
import fs from 'fs';
import { encrypt } from '../src/lib/crypto';

// Use the same DB_PATH resolution as db.ts so seed targets the persistent disk on Render
const DB_PATH = process.env.DB_PATH ||
  path.join(process.env.CITYWIDE_DB_DIR || path.join(__dirname, '..', 'database'), 'citywide.db');
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

// Idempotent migrations
const hasCols = (db.prepare('PRAGMA table_info(accounts)').all() as any[]).map((c: any) => c.name);
if (!hasCols.includes('record_type'))
  db.exec("ALTER TABLE accounts ADD COLUMN record_type TEXT DEFAULT 'ic'");
db.exec("UPDATE accounts SET record_type='ic' WHERE record_type IS NULL");
if (!hasCols.includes('bc_client_number'))
  db.exec('ALTER TABLE accounts ADD COLUMN bc_client_number TEXT');
if (!hasCols.includes('account_manager'))
  db.exec('ALTER TABLE accounts ADD COLUMN account_manager TEXT');
if (!hasCols.includes('ccm_manager'))
  db.exec('ALTER TABLE accounts ADD COLUMN ccm_manager TEXT');

// ─── Manager (idempotent — never overwrite an existing password) ────────────
const seedPassword = process.env.SEED_PASSWORD || 'demo1234';
const existingManager = db.prepare('SELECT id FROM managers WHERE email = ?').get('cara@citywideboston.com');
if (!existingManager) {
  const hash = bcrypt.hashSync(seedPassword, 10);
  db.prepare('INSERT INTO managers (name, email, password_hash, role) VALUES (?, ?, ?, ?)').run(
    'Cara Angeloni', 'cara@citywideboston.com', hash, 'admin'
  );
  console.log(`✓ Manager created: cara@citywideboston.com / ${seedPassword}`);
} else {
  console.log('✓ Manager cara@citywideboston.com already exists — password unchanged');
}

// ─── Accounts (IC Vendor format) ───────────────────────────
interface AccountSeed {
  ic_company_name: string;
  bc_vendor_number?: string;
  keys_yn?: number;
  security_app_yn?: number;
  metal_keys?: number;
  key_cards?: number;
  has_fob?: number;
  dispenser_keys?: number;
  lockbox_code?: string | null;
  door_code?: string | null;
  alarm_code?: string | null;
  notes?: string;
}

const accounts: AccountSeed[] = [
  {
    ic_company_name: 'ALVES CLEANING SERVICES INC',
    bc_vendor_number: '02014100020',
    keys_yn: 1, security_app_yn: 0,
    metal_keys: 2, key_cards: 0, has_fob: 0,
    dispenser_keys: 0, lockbox_code: null,
    door_code: null, alarm_code: null,
    notes: 'Demo record',
  },
  {
    ic_company_name: 'ICLEAN FACILITIES SERVICES INC',
    bc_vendor_number: '02014100203',
    keys_yn: 1, security_app_yn: 1,
    metal_keys: 3, key_cards: 1, has_fob: 1,
    dispenser_keys: 1, lockbox_code: '42',
    door_code: '1234', alarm_code: '0000',
    notes: 'Demo record with all key types',
  },
  {
    ic_company_name: 'SHARP CLEANING CORPORATION',
    bc_vendor_number: '02014100044',
    keys_yn: 0, security_app_yn: 0,
    metal_keys: 0, key_cards: 0, has_fob: 0,
    dispenser_keys: 0, lockbox_code: null,
    door_code: null, alarm_code: null,
    notes: 'Demo record — no keys',
  },
  {
    ic_company_name: 'AINE CONTRACTORS CORP',
    bc_vendor_number: '02014100181',
    keys_yn: 1, security_app_yn: 1,
    metal_keys: 1, key_cards: 2, has_fob: 1,
    dispenser_keys: 0, lockbox_code: '28',
    door_code: '5678', alarm_code: null,
    notes: 'Demo record',
  },
  {
    ic_company_name: 'HOWARD CLEANING SERVICES',
    bc_vendor_number: '02014100209',
    keys_yn: 1, security_app_yn: 0,
    metal_keys: 4, key_cards: 0, has_fob: 0,
    dispenser_keys: 2, lockbox_code: null,
    door_code: null, alarm_code: '9999',
    notes: 'Demo record with dispenser keys',
  },
];

const insertAccount = db.prepare(`
  INSERT OR IGNORE INTO accounts (
    ic_company_name, bc_vendor_number,
    keys_yn, security_app_yn,
    metal_keys, key_cards, has_fob, dispenser_keys,
    lockbox_code,
    door_code_encrypted, door_code_iv,
    alarm_code_encrypted, alarm_code_iv,
    notes, status, record_type
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
`);

let inserted = 0;
for (const a of accounts) {
  let door_enc: string | null = null, door_iv: string | null = null;
  let alarm_enc: string | null = null, alarm_iv: string | null = null;
  if (a.door_code) { const r = encrypt(a.door_code); door_enc = r.encrypted; door_iv = r.iv; }
  if (a.alarm_code) { const r = encrypt(a.alarm_code); alarm_enc = r.encrypted; alarm_iv = r.iv; }

  insertAccount.run(
    a.ic_company_name, a.bc_vendor_number ?? null,
    a.keys_yn ?? 0, a.security_app_yn ?? 0,
    a.metal_keys ?? 0, a.key_cards ?? 0, a.has_fob ?? 0, a.dispenser_keys ?? 0,
    a.lockbox_code ?? null,
    door_enc, door_iv,
    alarm_enc, alarm_iv,
    a.notes ?? null, 'ic',
  );
  inserted++;
}

// ─── Customer demo records ──────────────────────────────────
interface CustomerSeed extends AccountSeed {
  record_type: 'customer';
  am_keys?: number;
  ccm_keys?: number;
  contractor_keys?: number;
  bc_client_number?: string;
  ic_name?: string;
  account_manager?: string;
  ccm_manager?: string;
}
const customers: CustomerSeed[] = [
  {
    ic_company_name: 'DEMO MEDICAL CENTER',
    bc_client_number: '01014200001',
    bc_vendor_number: '02014200001',
    ic_name: 'ALVES CLEANING SERVICES INC',
    account_manager: 'Demo Manager A',
    ccm_manager: 'Demo Manager B',
    keys_yn: 1, security_app_yn: 1,
    metal_keys: 3, key_cards: 2, has_fob: 1,
    dispenser_keys: 1, lockbox_code: '55',
    door_code: '7890', alarm_code: null,
    am_keys: 1, ccm_keys: 2, contractor_keys: 3,
    notes: 'Demo customer record — medical facility',
    record_type: 'customer',
  },
  {
    ic_company_name: 'DEMO BANK BRANCH',
    bc_client_number: '01014200002',
    bc_vendor_number: '02014200002',
    ic_name: 'HOWARD CLEANING SERVICES',
    account_manager: 'Demo Manager A',
    ccm_manager: 'Demo Manager B',
    keys_yn: 1, security_app_yn: 0,
    metal_keys: 1, key_cards: 0, has_fob: 0,
    dispenser_keys: 0, lockbox_code: null,
    door_code: null, alarm_code: '3456',
    am_keys: 1, ccm_keys: 1, contractor_keys: 2,
    notes: 'Demo customer record — bank branch',
    record_type: 'customer',
  },
];

let custInserted = 0;
for (const c of customers) {
  let door_enc: string | null = null, door_iv: string | null = null;
  let alarm_enc: string | null = null, alarm_iv: string | null = null;
  if (c.door_code) { const r = encrypt(c.door_code); door_enc = r.encrypted; door_iv = r.iv; }
  if (c.alarm_code) { const r = encrypt(c.alarm_code); alarm_enc = r.encrypted; alarm_iv = r.iv; }

  // Use a dedicated statement that includes am/ccm/contractor keys and new manager fields
  const custStmt = db.prepare(`
    INSERT OR IGNORE INTO accounts (
      ic_company_name, bc_client_number, bc_vendor_number,
      ic_name, account_manager, ccm_manager,
      keys_yn, security_app_yn,
      metal_keys, key_cards, has_fob, dispenser_keys,
      am_keys, ccm_keys, contractor_keys,
      lockbox_code,
      door_code_encrypted, door_code_iv,
      alarm_code_encrypted, alarm_code_iv,
      notes, status, record_type
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
  `);
  const res = custStmt.run(
    c.ic_company_name, c.bc_client_number ?? null, c.bc_vendor_number ?? null,
    c.ic_name ?? null, c.account_manager ?? null, c.ccm_manager ?? null,
    c.keys_yn ?? 0, c.security_app_yn ?? 0,
    c.metal_keys ?? 0, c.key_cards ?? 0, c.has_fob ?? 0, c.dispenser_keys ?? 0,
    c.am_keys ?? 0, c.ccm_keys ?? 0, c.contractor_keys ?? 0,
    c.lockbox_code ?? null,
    door_enc, door_iv,
    alarm_enc, alarm_iv,
    c.notes ?? null, 'customer',
  ) as { changes: number };
  if (res.changes > 0) custInserted++;
}
console.log(`✓ Seeded ${inserted} IC vendor accounts, ${custInserted} customer accounts (skipped existing)`);

if (inserted > 0) {
  db.prepare('INSERT INTO audit_log (action, account_name, account_id, manager, metadata) VALUES (?, ?, ?, ?, ?)').run(
    'system_seed', null, null, 'System', JSON.stringify({ accounts: inserted, version: '2.0' })
  );
}

console.log('\n✅ Database seeded successfully!');
console.log(`   Login: cara@citywideboston.com / ${seedPassword}\n`);
db.close();
