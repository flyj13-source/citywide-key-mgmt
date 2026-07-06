import 'dotenv/config';
import { DatabaseSync } from 'node:sqlite';
import bcrypt from 'bcryptjs';
import path from 'path';
import fs from 'fs';
import { encrypt } from '../src/lib/crypto';

const DB_PATH = path.join(__dirname, 'citywide.db');
if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

// ─── Manager ───────────────────────────────────────────────
const seedPassword = process.env.SEED_PASSWORD || 'demo1234';
const hash = bcrypt.hashSync(seedPassword, 10);
db.prepare('INSERT INTO managers (name, email, password_hash, role) VALUES (?, ?, ?, ?)').run(
  'Cara Angeloni', 'cara@citywideboston.com', hash, 'admin'
);
console.log(`✓ Manager seeded: cara@citywideboston.com / ${seedPassword}`);

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
  INSERT INTO accounts (
    ic_company_name, bc_vendor_number,
    keys_yn, security_app_yn,
    metal_keys, key_cards, has_fob, dispenser_keys,
    lockbox_code,
    door_code_encrypted, door_code_iv,
    alarm_code_encrypted, alarm_code_iv,
    notes, status
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
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
    a.notes ?? null,
  );
  inserted++;
}
console.log(`✓ Seeded ${inserted} IC vendor accounts`);

db.prepare('INSERT INTO audit_log (action, account_name, account_id, manager, metadata) VALUES (?, ?, ?, ?, ?)').run(
  'system_seed', null, null, 'System', JSON.stringify({ accounts: inserted, version: '2.0' })
);

console.log('\n✅ Database seeded successfully!');
console.log(`   Login: cara@citywideboston.com / ${seedPassword}\n`);
db.close();
