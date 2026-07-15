import { describe, it, expect, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

// ── Isolated temp DB, hand-built with the OLD (pre-transpose) schema ─────────
// Simulates a real production DB — like the 577-row citywide.db — that has
// never seen the new 16-cell holder×type grid columns. Booting db.ts against
// it must: (1) add the 16 new columns + office_keys_held, (2) migrate the old
// 9-cell role×type breakdown into the new names, (3) migrate legacy
// office_keys → office_metal, and (4) never zero out any existing data.
const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'citywide-migration-'));
process.env.CITYWIDE_DB_DIR = TEST_DIR;
delete process.env.DB_PATH;
process.env.JWT_SECRET = 'migration-secret';
process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
process.env.SEED_PASSWORD = 'demo1234';

const DB_FILE = path.join(TEST_DIR, 'citywide.db');

// Build the pre-migration table by hand — only the columns a real legacy row
// would have. None of the 16 grid columns or office_keys_held exist yet.
function buildLegacyDb() {
  const db = new DatabaseSync(DB_FILE);
  db.exec(`
    CREATE TABLE accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ic_company_name TEXT,
      bc_client_number TEXT,
      bc_vendor_number TEXT,
      ic_name TEXT,
      account_manager TEXT,
      ccm_manager TEXT,
      record_type TEXT DEFAULT 'ic',
      keys_yn INTEGER DEFAULT 0,
      security_app_yn INTEGER DEFAULT 0,
      metal_keys INTEGER DEFAULT 0,
      key_cards INTEGER DEFAULT 0,
      has_fob INTEGER DEFAULT 0,
      dispenser_keys INTEGER DEFAULT 0,
      office_keys INTEGER DEFAULT 0,
      ic_office_keys INTEGER DEFAULT 0,
      am_office_keys INTEGER DEFAULT 0,
      ccm_office_keys INTEGER DEFAULT 0,
      am_keys INTEGER DEFAULT 0,
      ccm_keys INTEGER DEFAULT 0,
      contractor_keys INTEGER DEFAULT 0,
      am_metal_keys INTEGER DEFAULT 0,
      am_key_cards INTEGER DEFAULT 0,
      am_key_fobs INTEGER DEFAULT 0,
      ccm_metal_keys INTEGER DEFAULT 0,
      ccm_key_cards INTEGER DEFAULT 0,
      ccm_key_fobs INTEGER DEFAULT 0,
      contractor_metal_keys INTEGER DEFAULT 0,
      contractor_key_cards INTEGER DEFAULT 0,
      contractor_key_fobs INTEGER DEFAULT 0,
      lockbox_code TEXT,
      notes TEXT,
      status TEXT DEFAULT 'active',
      archived INTEGER DEFAULT 0
    )
  `);

  // Row A: a legacy customer with a full 9-cell role breakdown AND a flat
  // site-level office_keys total — exactly the shape a real pre-transpose row
  // would have (office was a TYPE back then). Built as INSERT + named UPDATEs
  // (one column per statement) so there is no placeholder/value count to get
  // wrong.
  db.prepare(`
    INSERT INTO accounts (ic_company_name, bc_client_number, record_type) VALUES (?, ?, 'customer')
  `).run('LEGACY ROW A', 'LEGACY-A');
  const setLegacyA = (col: string, val: number) => {
    db.prepare(`UPDATE accounts SET ${col} = ? WHERE bc_client_number = 'LEGACY-A'`).run(val);
  };
  setLegacyA('metal_keys', 5);
  setLegacyA('key_cards', 3);
  setLegacyA('has_fob', 1);
  setLegacyA('dispenser_keys', 0);
  setLegacyA('office_keys', 9);
  setLegacyA('ic_office_keys', 1);
  setLegacyA('am_office_keys', 0);
  setLegacyA('ccm_office_keys', 0);
  setLegacyA('am_keys', 4);
  setLegacyA('ccm_keys', 3);
  setLegacyA('contractor_keys', 5);
  setLegacyA('am_metal_keys', 2);
  setLegacyA('am_key_cards', 1);
  setLegacyA('am_key_fobs', 1);
  setLegacyA('ccm_metal_keys', 0);
  setLegacyA('ccm_key_cards', 3);
  setLegacyA('ccm_key_fobs', 0);
  setLegacyA('contractor_metal_keys', 4);
  setLegacyA('contractor_key_cards', 0);
  setLegacyA('contractor_key_fobs', 1);

  // Row B: a bare-bones legacy row with NOTHING filled in — the common case
  // (most of the real 577 rows have zeros everywhere). Must stay all-zero.
  db.prepare(`
    INSERT INTO accounts (ic_company_name, bc_client_number, record_type)
    VALUES ('LEGACY ROW B', 'LEGACY-B', 'ic')
  `).run();

  db.close();
}

function readRow(bcOrName: string) {
  const db = new DatabaseSync(DB_FILE);
  const row: any = Object.assign({}, db.prepare(
    'SELECT * FROM accounts WHERE bc_client_number = ? OR ic_company_name = ?'
  ).get(bcOrName, bcOrName));
  db.close();
  return row;
}

describe('GRID MIGRATION — legacy DB upgraded to the 16-cell holder×type grid', () => {
  it('adds all 16 grid columns + office_keys_held on first boot against a legacy DB', async () => {
    buildLegacyDb();
    vi.resetModules();
    await import('../src/lib/db'); // triggers the PRAGMA-guarded migration

    const db = new DatabaseSync(DB_FILE);
    const cols = (db.prepare('PRAGMA table_info(accounts)').all() as any[]).map((c: any) => c.name);
    db.close();
    for (const col of [
      'am_metal', 'am_card', 'am_fob', 'am_dispenser',
      'ccm_metal', 'ccm_card', 'ccm_fob', 'ccm_dispenser',
      'contractor_metal', 'contractor_card', 'contractor_fob', 'contractor_dispenser',
      'office_metal', 'office_card', 'office_fob', 'office_dispenser',
      'office_keys_held',
    ]) {
      expect(cols, col).toContain(col);
    }
  });

  it('migrates the old 9-cell role×type breakdown into the new field names, unchanged', () => {
    const a = readRow('LEGACY-A');
    expect(a.am_metal).toBe(2);
    expect(a.am_card).toBe(1);
    expect(a.am_fob).toBe(1);
    expect(a.ccm_metal).toBe(0);
    expect(a.ccm_card).toBe(3);
    expect(a.ccm_fob).toBe(0);
    expect(a.contractor_metal).toBe(4);
    expect(a.contractor_card).toBe(0);
    expect(a.contractor_fob).toBe(1);
    // No prior equivalent existed for dispenser — stays 0, not fabricated.
    expect(a.am_dispenser).toBe(0);
    expect(a.ccm_dispenser).toBe(0);
    expect(a.contractor_dispenser).toBe(0);
  });

  it('migrates legacy site-level office_keys → office_metal (ambiguous type, defaults to metal)', () => {
    const a = readRow('LEGACY-A');
    expect(a.office_keys).toBe(9);   // old column untouched, left in place
    expect(a.office_metal).toBe(9);  // migrated copy
    expect(a.office_card).toBe(0);
    expect(a.office_fob).toBe(0);
    expect(a.office_dispenser).toBe(0);
  });

  it('old per-role office bolt-on columns are left in place, untouched, and NOT migrated into the grid', () => {
    const a = readRow('LEGACY-A');
    // ic_office_keys/am_office_keys/ccm_office_keys represented a different
    // concept (a role's office-key count) than the new holder model — the
    // migration intentionally does not fold them in anywhere.
    expect(a.ic_office_keys).toBe(1);
    expect(a.am_office_keys).toBe(0);
    expect(a.ccm_office_keys).toBe(0);
  });

  it('a bare row with nothing filled in stays all-zero — no data fabricated', () => {
    const b = readRow('LEGACY-B');
    for (const col of [
      'am_metal', 'am_card', 'am_fob', 'am_dispenser',
      'ccm_metal', 'ccm_card', 'ccm_fob', 'ccm_dispenser',
      'contractor_metal', 'contractor_card', 'contractor_fob', 'contractor_dispenser',
      'office_metal', 'office_card', 'office_fob', 'office_dispenser',
      'office_keys_held', 'am_keys', 'ccm_keys', 'contractor_keys',
    ]) {
      expect(b[col], col).toBe(0);
    }
    // And its original scalar data survives untouched.
    expect(b.ic_company_name).toBe('LEGACY ROW B');
    expect(b.record_type).toBe('ic');
  });

  it('re-running the migration a second time is a no-op — never double-applies or overwrites', async () => {
    // Simulate a manual edit that happened after the first migration: change
    // office_metal to a different value than office_keys. A second boot must
    // NOT re-copy office_keys over it (the guard is "only if office_metal is
    // still 0"), so this hand-edited value must survive untouched.
    const db1 = new DatabaseSync(DB_FILE);
    db1.prepare("UPDATE accounts SET office_metal = 2 WHERE bc_client_number = 'LEGACY-A'").run();
    db1.close();

    // Force a fresh module registry so db.ts's module-load-time migration
    // logic actually re-executes against the same file (a real second boot).
    vi.resetModules();
    await import('../src/lib/db');

    const a = readRow('LEGACY-A');
    expect(a.office_metal).toBe(2); // hand-edited value preserved, not clobbered back to 9
  });
});
