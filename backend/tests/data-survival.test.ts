import { describe, it, expect, beforeAll, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import * as XLSX from 'xlsx';
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

// ── Isolated temp DB — the real citywide.db is NEVER touched ─────────────────
const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'citywide-survive-'));
process.env.CITYWIDE_DB_DIR = TEST_DIR;
delete process.env.DB_PATH;
process.env.JWT_SECRET = 'survive-secret';
// Deterministic 32-byte key so encrypt/decrypt round-trips across reopens.
process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
process.env.SEED_PASSWORD = 'demo1234';

const DB_FILE = path.join(TEST_DIR, 'citywide.db');
const ADMIN_EMAIL = 'cara@citywideboston.com';
const ADMIN_PASS = 'demo1234';

let app: Express;
let token: string;

/** Open a FRESH connection to the DB file — i.e. reopen it from scratch. */
function reopenDb() {
  return new DatabaseSync(DB_FILE);
}
function auth(req: request.Test) {
  return req.set('Authorization', `Bearer ${token}`);
}

/** Re-run the FULL boot sequence against the same file, as a deploy would:
 *  fresh module registry → db.ts re-runs migrations → guarded autoSeed. */
async function reboot() {
  vi.resetModules();
  await import('../src/lib/db'); // re-executes migrations against the same file
  const { autoSeedIfEmpty } = await import('../src/lib/autoSeed');
  autoSeedIfEmpty();
}

beforeAll(async () => {
  app = (await import('../src/index')).default;
  const { autoSeedIfEmpty } = await import('../src/lib/autoSeed');
  autoSeedIfEmpty();
  const res = await request(app).post('/api/auth/login').send({ email: ADMIN_EMAIL, password: ADMIN_PASS });
  expect(res.status).toBe(200);
  token = res.body.token;
});

// ════════════════════════════════ INPUT ROUND-TRIP ══════════════════════════
describe('INPUT ROUND-TRIP — typed data survives a DB reopen', () => {
  // Plaintext scalar fields that must come back byte-identical from the file.
  const CUSTOMER = {
    record_type: 'customer',
    ic_company_name: 'Beacon Hill Medical Plaza',
    bc_client_number: '01014277001',
    ic_name: 'ALVES CLEANING SERVICES INC',
    bc_vendor_number: '02014100020',
    account_manager: 'Maria Lopez',
    ccm_manager: 'James Chen',
    keys_yn: 1, security_app_yn: 1,
    metal_keys: 7, key_cards: 4, has_fob: 1, dispenser_keys: 2, office_keys: 9,
    ic_office_keys: 3, am_office_keys: 4, ccm_office_keys: 2,
    am_keys: 5, ccm_keys: 6, contractor_keys: 8,
    lockbox_code: '4417',
    notes: 'VIP — front desk 24/7 · loading dock B',
  };
  const DOOR = 'DOOR-9137-Zx';
  const ALARM = 'ALARM-5521-Qw';

  const scalarCols = [
    'ic_company_name', 'bc_client_number', 'ic_name', 'bc_vendor_number',
    'account_manager', 'ccm_manager', 'keys_yn', 'security_app_yn',
    'metal_keys', 'key_cards', 'has_fob', 'dispenser_keys', 'office_keys',
    'ic_office_keys', 'am_office_keys', 'ccm_office_keys',
    'am_keys', 'ccm_keys', 'contractor_keys', 'lockbox_code', 'notes',
  ];

  it('customer: every field byte-identical after close + reopen', async () => {
    const created = await auth(request(app).post('/api/accounts'))
      .send({ ...CUSTOMER, door_code: DOOR, alarm_code: ALARM });
    expect(created.status).toBe(201);
    const id = created.body.id;

    // Reopen the file from a brand-new connection and read the raw row.
    const db = reopenDb();
    const row: any = Object.assign({}, db.prepare('SELECT * FROM accounts WHERE id = ?').get(id));
    db.close();

    for (const col of scalarCols) {
      expect(row[col], `field ${col}`).toBe((CUSTOMER as any)[col]);
    }
    // Codes are stored ENCRYPTED (plaintext must be absent from the bytes)…
    expect(row.door_code_encrypted).toBeTruthy();
    expect(row.alarm_code_encrypted).toBeTruthy();
    for (const f of [DB_FILE, `${DB_FILE}-wal`].filter((x) => fs.existsSync(x))) {
      const bytes = fs.readFileSync(f);
      expect(bytes.includes(Buffer.from(DOOR))).toBe(false);
      expect(bytes.includes(Buffer.from(ALARM))).toBe(false);
    }
    // …and decrypt back to the exact plaintext via the reveal API.
    const door = await auth(request(app).post(`/api/vault/reveal/${id}`)).send({ type: 'door' });
    const alarm = await auth(request(app).post(`/api/vault/reveal/${id}`)).send({ type: 'alarm' });
    expect(door.body.code).toBe(DOOR);
    expect(alarm.body.code).toBe(ALARM);

    // And the API GET returns the same values.
    const got = (await auth(request(app).get(`/api/accounts/${id}`))).body;
    for (const col of scalarCols) expect(got[col]).toBe((CUSTOMER as any)[col]);
  });

  it('IC vendor: every field byte-identical after close + reopen', async () => {
    const IC = {
      record_type: 'ic',
      ic_company_name: 'SHARP CLEANING CORPORATION',
      bc_vendor_number: '02014100044',
      keys_yn: 1, security_app_yn: 0,
      metal_keys: 3, key_cards: 1, has_fob: 1, dispenser_keys: 0, office_keys: 2,
      ic_office_keys: 2, am_office_keys: 0, ccm_office_keys: 0,
      lockbox_code: '28', notes: 'Vendor keys held at CW office',
    };
    const created = await auth(request(app).post('/api/accounts')).send(IC);
    const id = created.body.id;

    const db = reopenDb();
    const row: any = Object.assign({}, db.prepare('SELECT * FROM accounts WHERE id = ?').get(id));
    db.close();
    for (const [k, v] of Object.entries(IC)) {
      if (k === 'record_type') { expect(row.record_type).toBe('ic'); continue; }
      expect(row[k], `field ${k}`).toBe(v);
    }
  });
});

// ════════════════════════════════ IMPORT ROUND-TRIP ═════════════════════════
describe('IMPORT ROUND-TRIP — 600-row sheet survives a reopen', () => {
  const HEADERS = [
    'Client Name', 'BC Client Number', 'Independent Contractor', 'BC Vendor Number',
    'Account Manager', 'Contract Compliance Manager', 'Keys Y/N', 'AM Key', 'CCM Key',
    'Contractor Key', 'Metal Keys', 'Key Cards', 'Key Fobs', 'Dispenser Key',
    'Office Key', 'Lockbox Code', 'Door Code', 'Alarm Code', 'Notes',
  ];
  const MARK = 'IMPSURV';

  function buildSheet(): Buffer {
    const aoa: any[][] = [HEADERS];
    for (let i = 0; i < 600; i++) {
      const bad = i < 10; // first 10 rows are deliberately invalid (no Client Name)
      const vendor = `0201410${String(1000 + (i % 12)).padStart(4, '0')}`; // repeats
      aoa.push([
        bad ? '' : `${MARK} Client ${i}`, `${MARK}-${i}`, `IC CO ${i % 40}`, vendor,
        `AM ${i % 8}`, `CCM ${i % 8}`, i % 3 === 0 ? '' : 'Y', i % 4, i % 5,
        i % 6, i % 7, i % 3, i % 2, i % 2, i % 4,
        i % 10 === 0 ? String(1000 + i) : '',
        i % 20 === 0 ? String(9000 + i) : '', i % 25 === 0 ? String(3000 + i) : '',
        `Row ${i}`,
      ]);
    }
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Registry');
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  }

  it('imports 590, reports 10 bad rows with real messages, survives reopen', async () => {
    const buf = buildSheet();
    const preview = await auth(request(app).post('/api/accounts/import')).attach('file', buf, 's.xlsx');
    expect(preview.status).toBe(200);
    expect(preview.body.total).toBe(600);
    expect(preview.body.valid.length).toBe(590);
    expect(preview.body.errors.length).toBe(10);
    // real, human error messages — not empty
    expect(preview.body.errors.every((e: any) => typeof e.message === 'string' && e.message.length > 0)).toBe(true);
    expect(preview.body.errors[0].message).toMatch(/Client Name/i);

    const confirm = await auth(request(app).post('/api/accounts/import/confirm')).send({ rows: preview.body.valid });
    expect(confirm.body.inserted).toBe(590);

    // Reopen the file and count — the 590 are durably on disk.
    const db = reopenDb();
    const count = (Object.assign({}, db.prepare(
      "SELECT COUNT(*) AS c FROM accounts WHERE ic_company_name LIKE ?"
    ).get(`${MARK} Client %`)) as any).c;
    expect(count).toBe(590);

    // Spot-check 5 rows field-by-field against what the sheet declared.
    for (const i of [10, 137, 299, 450, 599]) {
      const r: any = Object.assign({}, db.prepare(
        'SELECT ic_company_name, bc_client_number, account_manager, ccm_manager, office_keys, contractor_keys FROM accounts WHERE bc_client_number = ?'
      ).get(`${MARK}-${i}`));
      expect(r.ic_company_name).toBe(`${MARK} Client ${i}`);
      expect(r.account_manager).toBe(`AM ${i % 8}`);
      expect(r.ccm_manager).toBe(`CCM ${i % 8}`);
      expect(r.office_keys).toBe(i % 4);
      expect(r.contractor_keys).toBe(i % 6);
    }
    db.close();
  });
});

// ════════════════════════════════ RESTART SIMULATION ════════════════════════
describe('RESTART SIMULATION — 3 deploys never touch data', () => {
  it('counts, rows and manager password_hash are byte-identical after 3 reboots', async () => {
    const snapshot = () => {
      const db = reopenDb();
      const accounts = (Object.assign({}, db.prepare('SELECT COUNT(*) AS c FROM accounts').get()) as any).c;
      const managers = (Object.assign({}, db.prepare('SELECT COUNT(*) AS c FROM managers').get()) as any).c;
      const hash = (Object.assign({}, db.prepare('SELECT password_hash AS h FROM managers WHERE email = ?').get(ADMIN_EMAIL)) as any).h;
      // A stable fingerprint of every account row (id + name + key fields).
      const rows = (db.prepare(
        'SELECT id, ic_company_name, bc_client_number, office_keys, am_keys, archived FROM accounts ORDER BY id'
      ).all() as any[]).map((r) => JSON.stringify(Object.assign({}, r))).join('|');
      db.close();
      const fingerprint = crypto.createHash('sha256').update(rows).digest('hex');
      return { accounts, managers, hash, fingerprint };
    };

    const before = snapshot();
    await reboot();
    await reboot();
    await reboot();
    const after = snapshot();

    expect(after.accounts).toBe(before.accounts);
    expect(after.managers).toBe(before.managers);
    expect(after.hash).toBe(before.hash);           // password never reset
    expect(after.fingerprint).toBe(before.fingerprint); // no row modified
  });
});

// ════════════════════════════════ ARCHIVE SURVIVAL ══════════════════════════
describe('ARCHIVE SURVIVAL — archived state survives a reboot', () => {
  it('an archived record is still archived after the boot sequence re-runs', async () => {
    const created = await auth(request(app).post('/api/accounts')).send({
      record_type: 'customer', ic_company_name: 'ARCHIVE SURVIVOR',
    });
    const id = created.body.id;
    expect((await auth(request(app).post(`/api/accounts/${id}/archive`))).status).toBe(200);

    await reboot();

    const db = reopenDb();
    const row: any = Object.assign({}, db.prepare('SELECT archived, archived_by FROM accounts WHERE id = ?').get(id));
    db.close();
    expect(row.archived).toBe(1);
    expect(row.archived_by).toBeTruthy();
  });
});
