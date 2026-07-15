import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import * as XLSX from 'xlsx';
import { DatabaseSync } from 'node:sqlite';
import bcrypt from 'bcryptjs';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

// ── Isolated temp DB — the real citywide.db is NEVER touched ─────────────────
const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'citywide-test-'));
process.env.CITYWIDE_DB_DIR = TEST_DIR;
delete process.env.DB_PATH; // ensure we don't inherit a real /data path
process.env.JWT_SECRET = 'test-secret';
process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
process.env.SEED_PASSWORD = 'demo1234';
process.env.TEST_USER_EMAIL = 'test@citywideboston.com';
process.env.TEST_USER_PASSWORD = 'test-pass-1234';

const DB_FILE = path.join(TEST_DIR, 'citywide.db');
const ADMIN_EMAIL = 'cara@citywideboston.com';
const ADMIN_PASS = 'demo1234';
const TEST_EMAIL = 'test@citywideboston.com';
const TEST_PASS = 'test-pass-1234';

let app: Express;
let autoSeedIfEmpty: () => void;
let token: string;

function openDb() {
  return new DatabaseSync(DB_FILE);
}
function auth(req: request.Test) {
  return req.set('Authorization', `Bearer ${token}`);
}

beforeAll(async () => {
  // Import AFTER env is set so db.ts resolves to the temp DB, then seed via the
  // production path (autoSeedIfEmpty runs on every server start).
  app = (await import('../src/index')).default;
  autoSeedIfEmpty = (await import('../src/lib/autoSeed')).autoSeedIfEmpty;
  autoSeedIfEmpty();

  const res = await request(app).post('/api/auth/login').send({ email: ADMIN_EMAIL, password: ADMIN_PASS });
  expect(res.status).toBe(200);
  token = res.body.token;
});

// ═══════════════════════════════════════ AUTH ═══════════════════════════════
describe('AUTH', () => {
  it('login valid → token', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: ADMIN_EMAIL, password: ADMIN_PASS });
    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe('string');
    expect(res.body.manager.email).toBe(ADMIN_EMAIL);
  });

  it('login invalid → 401', async () => {
    const res = await request(app).post('/api/auth/login').send({ email: ADMIN_EMAIL, password: 'wrong' });
    expect(res.status).toBe(401);
  });

  it('protected route without token → 401', async () => {
    const res = await request(app).get('/api/accounts');
    expect(res.status).toBe(401);
  });

  it('change-password flow → old fails, new works', async () => {
    const NEW = 'newpass456'; // backend requires >= 8 chars
    const change = await auth(request(app).post('/api/auth/change-password'))
      .send({ currentPassword: ADMIN_PASS, newPassword: NEW });
    expect(change.status).toBe(200);

    const old = await request(app).post('/api/auth/login').send({ email: ADMIN_EMAIL, password: ADMIN_PASS });
    expect(old.status).toBe(401);

    const fresh = await request(app).post('/api/auth/login').send({ email: ADMIN_EMAIL, password: NEW });
    expect(fresh.status).toBe(200);

    // Restore so the rest of the suite keeps using ADMIN_PASS
    const restore = await auth(request(app).post('/api/auth/change-password'))
      .send({ currentPassword: NEW, newPassword: ADMIN_PASS });
    expect(restore.status).toBe(200);
  });
});

// ═══════════════════════════════════════ ACCOUNTS ═══════════════════════════
describe('ACCOUNTS', () => {
  it('create IC → returned + persisted', async () => {
    const res = await auth(request(app).post('/api/accounts')).send({
      record_type: 'ic',
      ic_company_name: 'TEST IC VENDOR LLC',
      bc_vendor_number: '02014109999',
    });
    expect(res.status).toBe(201);

    const got = await auth(request(app).get(`/api/accounts/${res.body.id}`));
    expect(got.status).toBe(200);
    expect(got.body.ic_company_name).toBe('TEST IC VENDOR LLC');
    expect(got.body.record_type).toBe('ic');
  });

  it('create customer with ALL fields → every field survives round-trip EXACTLY', async () => {
    const payload = {
      record_type: 'customer',
      ic_company_name: 'Downtown Tower Assoc', // "Client Name" is stored here
      bc_client_number: 'BC-CLIENT-7788',
      ic_name: 'ALVES CLEANING SERVICES INC',
      bc_vendor_number: '02014100020',
      account_manager: 'Maria Lopez',
      ccm_manager: 'James Chen',
      am_keys: 3,
      ccm_keys: 2,
      contractor_keys: 5,
      metal_keys: 7,
      key_cards: 4,
      dispenser_keys: 1,
      has_fob: 1,
      keys_yn: 1,
      lockbox_code: '4417',
      notes: 'VIP account — front desk 24/7',
    };
    const res = await auth(request(app).post('/api/accounts')).send(payload);
    expect(res.status).toBe(201);

    const a = (await auth(request(app).get(`/api/accounts/${res.body.id}`))).body;
    expect(a.ic_company_name).toBe(payload.ic_company_name);
    expect(a.bc_client_number).toBe(payload.bc_client_number);
    expect(a.ic_name).toBe(payload.ic_name);
    expect(a.bc_vendor_number).toBe(payload.bc_vendor_number);
    expect(a.account_manager).toBe(payload.account_manager);
    expect(a.ccm_manager).toBe(payload.ccm_manager);
    expect(a.am_keys).toBe(3);
    expect(a.ccm_keys).toBe(2);
    expect(a.contractor_keys).toBe(5);
    expect(a.metal_keys).toBe(7);
    expect(a.key_cards).toBe(4);
    expect(a.dispenser_keys).toBe(1);
    expect(a.has_fob).toBe(1);
    expect(a.lockbox_code).toBe('4417');
    expect(a.notes).toBe(payload.notes);
    expect(a.record_type).toBe('customer');
  });

  it('GET ?type= filters correctly', async () => {
    const ics = await auth(request(app).get('/api/accounts?type=ic&limit=1000'));
    expect(ics.body.accounts.length).toBeGreaterThan(0);
    expect(ics.body.accounts.every((a: any) => a.record_type === 'ic' || a.record_type === null)).toBe(true);

    const customers = await auth(request(app).get('/api/accounts?type=customer&limit=1000'));
    expect(customers.body.accounts.length).toBeGreaterThan(0);
    expect(customers.body.accounts.every((a: any) => a.record_type === 'customer')).toBe(true);
  });

  it('duplicate bc_vendor_number across accounts is ALLOWED (no 500/501)', async () => {
    const shared = '02014100777';
    const a = await auth(request(app).post('/api/accounts')).send({
      record_type: 'customer', ic_company_name: 'Site A', bc_vendor_number: shared,
    });
    const b = await auth(request(app).post('/api/accounts')).send({
      record_type: 'customer', ic_company_name: 'Site B', bc_vendor_number: shared,
    });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);

    const db = openDb();
    const c = (Object.assign({}, db.prepare(
      'SELECT COUNT(*) AS c FROM accounts WHERE bc_vendor_number = ?'
    ).get(shared)) as any).c;
    db.close();
    expect(c).toBe(2);
  });

  it('DELETE (admin + typed confirm) removes an account', async () => {
    const created = await auth(request(app).post('/api/accounts')).send({
      record_type: 'customer', ic_company_name: 'To Delete',
    });
    const del = await auth(request(app).delete(`/api/accounts/${created.body.id}`)).send({ confirm: 'DELETE' });
    expect(del.status).toBe(200);
    const got = await auth(request(app).get(`/api/accounts/${created.body.id}`));
    expect(got.status).toBe(404);
  });
});

// ═══════════════════════════════════════ IMPORT ═════════════════════════════
describe('IMPORT', () => {
  const HEADERS = [
    'Client Name', 'BC Client Number', 'Independent Contractor', 'BC Vendor Number',
    'Account Manager', 'Contract Compliance Manager', 'Keys Y/N', 'AM Key', 'CCM Key',
    'Contractor Key', 'Metal Keys', 'Key Cards', 'Key Fobs', 'Dispenser Key',
    'Lockbox Code', 'Door Code', 'Alarm Code', 'Notes',
  ];

  function buildXlsx(rows: number): Buffer {
    const aoa: any[][] = [HEADERS];
    for (let i = 0; i < rows; i++) {
      // Only 12 distinct vendor numbers (repeated) + Y/blank Keys column.
      const vendor = `0201410${String(1000 + (i % 12)).padStart(4, '0')}`;
      aoa.push([
        `Client ${i}`, `BCC-${i}`, `IC COMPANY ${i % 40}`, vendor,
        `AM ${i % 8}`, `CCM ${i % 8}`, i % 3 === 0 ? '' : 'Y', i % 4, i % 5,
        i % 6, i % 7, i % 3, i % 2, i % 2,
        i % 10 === 0 ? String(1000 + i) : '', i % 15 === 0 ? String(2000 + i) : '',
        i % 20 === 0 ? String(9000 + i) : '', `Row note ${i}`,
      ]);
    }
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Registry');
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  }

  it('all 600 rows import; counts correct; CCM + key counts populated (not null)', async () => {
    const db0 = openDb();
    const before = (Object.assign({}, db0.prepare(
      "SELECT COUNT(*) AS c FROM accounts WHERE record_type = 'customer'"
    ).get()) as any).c;
    db0.close();

    // Step 1: preview (parses + validates, no DB write)
    const preview = await auth(request(app).post('/api/accounts/import'))
      .attach('file', buildXlsx(600), 'registry.xlsx');
    expect(preview.status).toBe(200);
    expect(preview.body.total).toBe(600);
    expect(preview.body.valid.length).toBe(600);
    expect(preview.body.errors.length).toBe(0);

    // Step 2: confirm (bulk insert in one transaction)
    const confirm = await auth(request(app).post('/api/accounts/import/confirm'))
      .send({ rows: preview.body.valid });
    expect(confirm.status).toBe(200);
    expect(confirm.body.inserted).toBe(600);

    const db = openDb();
    const after = (Object.assign({}, db.prepare(
      "SELECT COUNT(*) AS c FROM accounts WHERE record_type = 'customer'"
    ).get()) as any).c;
    expect(after - before).toBe(600);

    // Regression: CCM manager + role key counts must be POPULATED, never null.
    const nullCcm = (Object.assign({}, db.prepare(
      "SELECT COUNT(*) AS c FROM accounts WHERE ic_company_name LIKE 'Client %' AND ccm_manager IS NULL"
    ).get()) as any).c;
    expect(nullCcm).toBe(0);

    const nullKeys = (Object.assign({}, db.prepare(
      `SELECT COUNT(*) AS c FROM accounts WHERE ic_company_name LIKE 'Client %'
       AND (am_keys IS NULL OR ccm_keys IS NULL OR contractor_keys IS NULL)`
    ).get()) as any).c;
    expect(nullKeys).toBe(0);

    // Repeated vendor numbers really landed as duplicates.
    const distinctVendors = (Object.assign({}, db.prepare(
      "SELECT COUNT(DISTINCT bc_vendor_number) AS c FROM accounts WHERE ic_company_name LIKE 'Client %'"
    ).get()) as any).c;
    expect(distinctVendors).toBe(12);
    db.close();
  });

  // Regression coverage for the real-world silent-mapping-gap bug: AM mapped
  // but CCM Manager / Keys Y/N / Security App Y/N / Metal Keys / Key Cards /
  // Key Fobs / Dispenser Key all landed NULL/0. The preview response now
  // reports which headers matched vs. didn't, so this becomes visible instead
  // of silent.
  it('preview reports mappedHeaders and unmappedHeaders', async () => {
    const aoa = [
      ['Client Name', 'BC Client Number', 'Account Manager', 'Some Unrecognized Column'],
      ['Diagnostics Co', 'DIAG-1', 'AM Person', 'garbage'],
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'S');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const res = await auth(request(app).post('/api/accounts/import')).attach('file', buf, 'diag.xlsx');
    expect(res.status).toBe(200);
    expect(res.body.mappedHeaders).toEqual(expect.arrayContaining(['Client Name', 'BC Client Number', 'Account Manager']));
    expect(res.body.unmappedHeaders).toEqual(['Some Unrecognized Column']);
  });

  it('header matching is robust to NBSP, double spaces, trailing colon, and mixed case', async () => {
    const HEADERS_MESSY = [
      'Client Name', 'BC Client Number',
      'Contract Compliance Manager', // NBSP instead of regular spaces
      'Keys  Y/N', // double space
      'METAL KEYS:', // uppercase + trailing colon
      ' Key Cards ', // leading/trailing whitespace
      'key   fobs', // multi-space, lowercase
      'Dispenser Key',
    ];
    const aoa = [
      HEADERS_MESSY,
      ['Messy Header Co', 'MESSY-1', 'CCM Person X', 'Y', '5', '3', 'Y', '1'],
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'S');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const preview = await auth(request(app).post('/api/accounts/import')).attach('file', buf, 'messy.xlsx');
    expect(preview.status).toBe(200);
    expect(preview.body.unmappedHeaders).toEqual([]);

    const confirm = await auth(request(app).post('/api/accounts/import/confirm')).send({ rows: preview.body.valid });
    expect(confirm.body.inserted).toBe(1);

    const db = openDb();
    const row: any = Object.assign({}, db.prepare(
      'SELECT ccm_manager, keys_yn, metal_keys, key_cards, has_fob, dispenser_keys FROM accounts WHERE bc_client_number = ?'
    ).get('MESSY-1'));
    db.close();
    expect(row.ccm_manager).toBe('CCM Person X');
    expect(row.keys_yn).toBe(1);
    expect(row.metal_keys).toBe(5);
    expect(row.key_cards).toBe(3);
    expect(row.has_fob).toBe(1);
    expect(row.dispenser_keys).toBe(1);
  });

  it('preview 400s with unmappedHeaders when NO headers match at all', async () => {
    const aoa = [['Totally Unknown A', 'Totally Unknown B'], ['x', 'y']];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'S');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const res = await auth(request(app).post('/api/accounts/import')).attach('file', buf, 'bad.xlsx');
    expect(res.status).toBe(400);
    expect(res.body.unmappedHeaders).toEqual(['Totally Unknown A', 'Totally Unknown B']);
  });
});

// ═══════════════════════════════════════ VAULT ══════════════════════════════
describe('VAULT', () => {
  const PLAINTEXT = 'DOORCODE-Zx91Q7';
  let accountId: number;

  it('create code → stored encrypted (raw value absent from DB file bytes)', async () => {
    const res = await auth(request(app).post('/api/accounts')).send({
      record_type: 'customer', ic_company_name: 'Vault Site', door_code: PLAINTEXT,
    });
    expect(res.status).toBe(201);
    accountId = res.body.id;

    // Scan the raw DB bytes (and the WAL) — plaintext must NOT appear anywhere.
    for (const f of [DB_FILE, `${DB_FILE}-wal`].filter((x) => fs.existsSync(x))) {
      expect(fs.readFileSync(f).includes(Buffer.from(PLAINTEXT))).toBe(false);
    }

    const db = openDb();
    const row: any = Object.assign({}, db.prepare('SELECT door_code_encrypted FROM accounts WHERE id = ?').get(accountId));
    db.close();
    expect(row.door_code_encrypted).toBeTruthy();
  });

  it('reveal → decrypts correctly + writes audit entry', async () => {
    const res = await auth(request(app).post(`/api/vault/reveal/${accountId}`)).send({ type: 'door' });
    expect(res.status).toBe(200);
    expect(res.body.code).toBe(PLAINTEXT);

    const db = openDb();
    const audit: any = Object.assign({}, db.prepare(
      "SELECT COUNT(*) AS c FROM audit_log WHERE action = 'vault_revealed' AND account_id = ?"
    ).get(accountId));
    db.close();
    expect(audit.c).toBeGreaterThanOrEqual(1);
  });
});

// ═══════════════════════════════════════ ASSIGNMENTS ════════════════════════
describe('ASSIGNMENTS', () => {
  let assignmentId: number;
  let acctId: number;

  beforeAll(async () => {
    const res = await auth(request(app).post('/api/accounts')).send({
      record_type: 'customer', ic_company_name: 'ASSIGN IC',
    });
    acctId = res.body.id;
  });

  it('check-out → status checked_out + audit row', async () => {
    const res = await auth(request(app).post('/api/assignments/checkout')).send({
      account_id: acctId, account_name: 'ASSIGN IC', assignee: 'Field Tech 1',
      key_type: 'physical', keys_held: '2 metal',
    });
    expect(res.status).toBe(201);
    assignmentId = res.body.id;

    const list = await auth(request(app).get('/api/assignments?status=checked_out&limit=1000'));
    const found = list.body.assignments.find((a: any) => a.id === assignmentId);
    expect(found.status).toBe('checked_out');
  });

  it('check-in → status returned + audit rows', async () => {
    const res = await auth(request(app).post('/api/assignments/checkin')).send({
      id: assignmentId, condition_on_return: 'good',
    });
    expect(res.status).toBe(200);

    const db = openDb();
    const row: any = Object.assign({}, db.prepare('SELECT status FROM key_assignments WHERE id = ?').get(assignmentId));
    const audits: any = Object.assign({}, db.prepare(
      "SELECT COUNT(*) AS c FROM audit_log WHERE action IN ('key_checked_out','key_checked_in') AND account_id = ?"
    ).get(acctId));
    db.close();
    expect(row.status).toBe('returned');
    expect(audits.c).toBe(2);
  });
});

// ═══════════════════════════════════════ SEED IDEMPOTENCE ═══════════════════
// autoSeedIfEmpty() runs on EVERY server start — this is the deploy-time path
// whose non-idempotence caused the password-reset regression.
describe('SEED IDEMPOTENCE', () => {
  it('re-running the boot seed leaves rows + manager password_hash byte-identical', async () => {
    const snapshot = () => {
      const db = openDb();
      const managers = (Object.assign({}, db.prepare('SELECT COUNT(*) AS c FROM managers').get()) as any).c;
      const accounts = (Object.assign({}, db.prepare('SELECT COUNT(*) AS c FROM accounts').get()) as any).c;
      const hash = (Object.assign({}, db.prepare('SELECT password_hash AS h FROM managers WHERE email = ?').get(ADMIN_EMAIL)) as any).h;
      db.close();
      return { managers, accounts, hash };
    };

    const first = snapshot();
    autoSeedIfEmpty();
    autoSeedIfEmpty();
    const third = snapshot();

    expect(third.managers).toBe(first.managers);
    expect(third.accounts).toBe(first.accounts);
    expect(third.hash).toBe(first.hash); // byte-identical — no password reset
  });
});

// ═══════════════════════════════════════ TEST USER ══════════════════════════
describe('TEST USER', () => {
  let testToken: string;

  it('is seeded with is_test=1 and can log in (is_test surfaced)', async () => {
    const db = openDb();
    const row: any = Object.assign({}, db.prepare('SELECT is_test, role, name FROM managers WHERE email = ?').get(TEST_EMAIL));
    db.close();
    expect(row.is_test).toBe(1);
    expect(row.role).toBe('admin');
    expect(row.name).toBe('Test Account (Cinch IT)');

    const login = await request(app).post('/api/auth/login').send({ email: TEST_EMAIL, password: TEST_PASS });
    expect(login.status).toBe(200);
    expect(login.body.manager.is_test).toBe(true);
    testToken = login.body.token;
  });

  it('re-running the boot seed never resets the test password', async () => {
    const db = openDb();
    const before = (Object.assign({}, db.prepare('SELECT password_hash AS h FROM managers WHERE email = ?').get(TEST_EMAIL)) as any).h;
    db.close();
    autoSeedIfEmpty();
    const login = await request(app).post('/api/auth/login').send({ email: TEST_EMAIL, password: TEST_PASS });
    expect(login.status).toBe(200);
    const db2 = openDb();
    const after = (Object.assign({}, db2.prepare('SELECT password_hash AS h FROM managers WHERE email = ?').get(TEST_EMAIL)) as any).h;
    db2.close();
    expect(after).toBe(before);
  });

  it('actions by the test user are flagged test_action:true; Cara actions are not', async () => {
    const mine = await request(app).post('/api/accounts')
      .set('Authorization', `Bearer ${testToken}`)
      .send({ record_type: 'customer', ic_company_name: 'TESTUSER-CREATED' });
    expect(mine.status).toBe(201);

    const caras = await auth(request(app).post('/api/accounts'))
      .send({ record_type: 'customer', ic_company_name: 'CARA-CREATED' });
    expect(caras.status).toBe(201);

    const db = openDb();
    const testMeta = (Object.assign({}, db.prepare(
      "SELECT metadata AS m FROM audit_log WHERE action='account_created' AND account_id = ?"
    ).get(mine.body.id)) as any).m;
    const caraMeta = (Object.assign({}, db.prepare(
      "SELECT metadata AS m FROM audit_log WHERE action='account_created' AND account_id = ?"
    ).get(caras.body.id)) as any).m;
    db.close();

    expect(JSON.parse(testMeta).test_action).toBe(true);
    expect(JSON.parse(caraMeta).test_action).toBeUndefined();
  });
});

// ═══════════════════════════════════════ DASHBOARD HYGIENE ══════════════════
describe('DASHBOARD HYGIENE', () => {
  it("bc_client_number '999…' is excluded from the exclude_test count and key-holder sums", async () => {
    // Baselines
    const beforeCount = (await auth(request(app).get('/api/accounts?type=customer&exclude_test=1&limit=1'))).body.total;
    const beforeStats = (await auth(request(app).get('/api/accounts/key-holder-stats'))).body;

    // Add a sentinel-style test record with key counts
    const s = await auth(request(app).post('/api/accounts')).send({
      record_type: 'customer', ic_company_name: 'HYGIENE SENTINEL',
      bc_client_number: '99900123', am_keys: 5, ccm_keys: 5, contractor_keys: 5,
    });
    expect(s.status).toBe(201);

    // exclude_test count is unchanged; the plain count DOES include it
    const afterExcluded = (await auth(request(app).get('/api/accounts?type=customer&exclude_test=1&limit=1'))).body.total;
    const afterPlain = (await auth(request(app).get('/api/accounts?type=customer&limit=1'))).body.total;
    expect(afterExcluded).toBe(beforeCount);
    expect(afterPlain).toBeGreaterThan(beforeCount);

    // key-holder sums unchanged (sentinel's 5/5/5 excluded)
    const afterStats = (await auth(request(app).get('/api/accounts/key-holder-stats'))).body;
    expect(afterStats.am_total).toBe(beforeStats.am_total);
    expect(afterStats.ccm_total).toBe(beforeStats.ccm_total);
    expect(afterStats.contractor_total).toBe(beforeStats.contractor_total);

    // But it's still visible in the registry list (never hidden)
    const listed = (await auth(request(app).get('/api/accounts?search=HYGIENE SENTINEL&limit=10'))).body;
    expect(listed.accounts.some((a: any) => a.ic_company_name === 'HYGIENE SENTINEL')).toBe(true);
  });
});

// ═══════════════════ OFFICE-AS-HOLDER (TRANSPOSED GRID) & ROSTERS ═══════════
describe('OFFICE AS A HOLDER + PEOPLE ROSTERS', () => {
  it('office_keys_held round-trips through create → get', async () => {
    const res = await auth(request(app).post('/api/accounts')).send({
      record_type: 'customer', ic_company_name: 'OFFICE KEY SITE', office_metal: 9,
    });
    expect(res.status).toBe(201);
    const a = (await auth(request(app).get(`/api/accounts/${res.body.id}`))).body;
    expect(a.office_metal).toBe(9);
    expect(a.office_keys_held).toBe(9);
  });

  it('import maps flat "Office" column and per-cell "Office Metal"/"Office Fob" headers', async () => {
    const HEADERS = ['Client Name', 'BC Client Number', 'Office Key', 'Office Metal', 'Office Fob'];
    const rows = [
      ['OFFICE IMP A', 'BCC-OK-A', '3', '2', '1'],  // per-cell breakdown present → wins over flat total
      ['OFFICE IMP B', 'BCC-OK-B', 'Y', '', ''],    // no breakdown → flat "Office Key" Y→1 held as unspecified
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([HEADERS, ...rows]), 'S');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const preview = await auth(request(app).post('/api/accounts/import')).attach('file', buf, 'o.xlsx');
    expect(preview.status).toBe(200);
    const confirm = await auth(request(app).post('/api/accounts/import/confirm')).send({ rows: preview.body.valid });
    expect(confirm.body.inserted).toBe(2);

    const db = openDb();
    const get = (name: string) => Object.assign({}, db.prepare(
      'SELECT office_metal, office_fob, office_keys_held FROM accounts WHERE ic_company_name = ?'
    ).get(name)) as any;
    expect(get('OFFICE IMP A')).toMatchObject({ office_metal: 2, office_fob: 1, office_keys_held: 3 });
    expect(get('OFFICE IMP B')).toMatchObject({ office_metal: 0, office_fob: 0, office_keys_held: 1 });
    db.close();
  });

  it('office holder grid (all 4 types) round-trips through create → get', async () => {
    const res = await auth(request(app).post('/api/accounts')).send({
      record_type: 'customer', ic_company_name: 'ROLE OFFICE SITE',
      office_metal: 6, office_card: 1, office_fob: 2, office_dispenser: 3,
    });
    const a = (await auth(request(app).get(`/api/accounts/${res.body.id}`))).body;
    expect(a.office_metal).toBe(6);
    expect(a.office_card).toBe(1);
    expect(a.office_fob).toBe(2);
    expect(a.office_dispenser).toBe(3);
    expect(a.office_keys_held).toBe(12); // column total: 6+1+2+3
  });

  it('AM roster splits PERSONALLY HELD vs ACROSS CLIENTS (spot-check by hand)', async () => {
    const AM = 'ROSTER TESTER AM';
    // Two clients. Each also has a non-AM holder cell (contractor/office) of
    // type "metal" — those keys count toward the client-site Key Inventory
    // (metal_keys) but must NOT count toward AM's own personal total, proving
    // the two are independently derived from the same grid.
    await auth(request(app).post('/api/accounts')).send({
      record_type: 'customer', ic_company_name: 'RT CLIENT 1', account_manager: AM,
      am_metal: 2, am_card: 1, am_fob: 1, am_dispenser: 0,
      contractor_metal: 5,
    });
    await auth(request(app).post('/api/accounts')).send({
      record_type: 'customer', ic_company_name: 'RT CLIENT 2', account_manager: AM,
      am_metal: 3, am_card: 0, am_fob: 2, am_dispenser: 2,
      office_metal: 1,
    });

    const roster = (await auth(request(app).get('/api/managers/account-managers'))).body.managers;
    const row = roster.find((m: any) => m.person === AM);
    expect(row).toBeTruthy();
    expect(row.clients_managed).toBe(2);
    // PERSONALLY HOLDS (this role's holder-grid columns only)
    expect(row.personal_metal).toBe(5);      // 2+3
    expect(row.personal_cards).toBe(1);      // 1+0
    expect(row.personal_fobs).toBe(3);       // 1+2
    expect(row.personal_dispenser).toBe(2);  // 0+2
    expect(row.keys_held).toBe(11);          // am_keys column totals: 4 + 7
    // ACROSS THEIR CLIENTS (client-site Key Inventory row totals — includes
    // the contractor/office metal cells too, so metal_keys > personal_metal)
    expect(row.metal_keys).toBe(11);      // (2+5) + (3+1)
    expect(row.key_cards).toBe(1);        // 1 + 0
    expect(row.key_fobs).toBe(3);         // 1 + 2
    expect(row.dispenser_keys).toBe(2);   // 0 + 2
    expect(row.total_client_keys).toBe(17); // 11+1+3+2
  });

  it('AM roster is sorted by keys_held desc by default', async () => {
    const roster = (await auth(request(app).get('/api/managers/account-managers'))).body.managers;
    for (let i = 1; i < roster.length; i++) {
      expect(roster[i - 1].keys_held).toBeGreaterThanOrEqual(roster[i].keys_held);
    }
  });

  it('CCM roster groups by ccm_manager with personal + client split', async () => {
    const CCM = 'ROSTER TESTER CCM';
    // contractor_metal adds to the client-site metal total but not to the
    // CCM's own personal total — same split proof as the AM test above.
    await auth(request(app).post('/api/accounts')).send({
      record_type: 'customer', ic_company_name: 'RT CCM CLIENT', ccm_manager: CCM,
      ccm_metal: 4, contractor_metal: 3,
    });
    const roster = (await auth(request(app).get('/api/managers/ccms'))).body.managers;
    const row = roster.find((m: any) => m.person === CCM);
    expect(row).toBeTruthy();
    expect(row.clients_managed).toBe(1);
    expect(row.keys_held).toBe(4);          // ccm_keys column total (= ccm_metal)
    expect(row.personal_metal).toBe(4);
    expect(row.metal_keys).toBe(7);         // client-site row total: ccm_metal + contractor_metal
    expect(row.total_client_keys).toBe(7);
  });

  it('dashboard personally-held totals = each holder\'s own column total (AM/CCM/IC/Office)', async () => {
    const before = (await auth(request(app).get('/api/accounts/key-holder-stats'))).body;
    await auth(request(app).post('/api/accounts')).send({
      record_type: 'customer', ic_company_name: 'PERSONAL HELD SITE',
      contractor_metal: 10,
      am_metal: 5,
      ccm_metal: 3,
      office_metal: 2,
    });
    const after = (await auth(request(app).get('/api/accounts/key-holder-stats'))).body;
    expect(after.ic_personal - before.ic_personal).toBe(10);
    expect(after.am_personal - before.am_personal).toBe(5);
    expect(after.ccm_personal - before.ccm_personal).toBe(3);
    expect(after.office_personal - before.office_personal).toBe(2);
  });
});

// ═══════════════════════════════════════ SOFT DELETE (ARCHIVE) ══════════════
describe('ARCHIVE / RESTORE / PURGE', () => {
  it('archive removes the account from tabs + counts but preserves audit history', async () => {
    const created = await auth(request(app).post('/api/accounts')).send({
      record_type: 'customer', ic_company_name: 'ARCHIVE ME', bc_client_number: 'BCC-ARCH-1',
    });
    const id = created.body.id;

    const beforeCount = (await auth(request(app).get('/api/accounts?type=customer&limit=1'))).body.total;

    const arch = await auth(request(app).post(`/api/accounts/${id}/archive`));
    expect(arch.status).toBe(200);

    // Gone from the normal customer list + count
    const afterCount = (await auth(request(app).get('/api/accounts?type=customer&limit=1'))).body.total;
    expect(beforeCount - afterCount).toBe(1);
    const list = (await auth(request(app).get('/api/accounts?type=customer&search=ARCHIVE ME&limit=50'))).body;
    expect(list.accounts.some((a: any) => a.id === id)).toBe(false);

    // Present in the archived view with archived_by set
    const archived = (await auth(request(app).get('/api/accounts?type=all&archived=1&limit=1000'))).body;
    const row = archived.accounts.find((a: any) => a.id === id);
    expect(row).toBeTruthy();
    expect(row.archived).toBe(1);
    expect(row.archived_by).toBe('Cara Angeloni');

    // Audit history is untouched and still queryable
    const db = openDb();
    const audits = (Object.assign({}, db.prepare(
      "SELECT COUNT(*) AS c FROM audit_log WHERE account_id = ? AND action IN ('account_created','account_archived')"
    ).get(id)) as any).c;
    db.close();
    expect(audits).toBe(2);
  });

  it('restore returns the account to the registry', async () => {
    const created = await auth(request(app).post('/api/accounts')).send({
      record_type: 'ic', ic_company_name: 'RESTORE ME', bc_vendor_number: '02014990001',
    });
    const id = created.body.id;
    await auth(request(app).post(`/api/accounts/${id}/archive`));

    const restore = await auth(request(app).post(`/api/accounts/${id}/restore`));
    expect(restore.status).toBe(200);

    const list = (await auth(request(app).get('/api/accounts?type=ic&search=RESTORE ME&limit=50'))).body;
    expect(list.accounts.some((a: any) => a.id === id)).toBe(true);
    const archived = (await auth(request(app).get('/api/accounts?type=all&archived=1&limit=1000'))).body;
    expect(archived.accounts.some((a: any) => a.id === id)).toBe(false);
  });

  it('archive is BLOCKED when keys are checked out', async () => {
    const created = await auth(request(app).post('/api/accounts')).send({
      record_type: 'customer', ic_company_name: 'HAS CUSTODY',
    });
    const id = created.body.id;
    await auth(request(app).post('/api/assignments/checkout')).send({
      account_id: id, account_name: 'HAS CUSTODY', assignee: 'Tech', key_type: 'physical',
    });

    const blocked = await auth(request(app).post(`/api/accounts/${id}/archive`));
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatch(/Return checked-out keys/i);

    // Still present in the registry
    const list = (await auth(request(app).get('/api/accounts?type=customer&search=HAS CUSTODY&limit=50'))).body;
    expect(list.accounts.some((a: any) => a.id === id)).toBe(true);
  });

  it('purge requires admin + typed DELETE; then hard-removes the row (audit remains)', async () => {
    const created = await auth(request(app).post('/api/accounts')).send({
      record_type: 'customer', ic_company_name: 'PURGE ME',
    });
    const id = created.body.id;

    // Wrong confirmation → 400, row still exists
    const bad = await auth(request(app).delete(`/api/accounts/${id}`)).send({ confirm: 'nope' });
    expect(bad.status).toBe(400);
    expect((await auth(request(app).get(`/api/accounts/${id}`))).status).toBe(200);

    // Correct confirmation → 200, row gone
    const ok = await auth(request(app).delete(`/api/accounts/${id}`)).send({ confirm: 'DELETE' });
    expect(ok.status).toBe(200);
    expect((await auth(request(app).get(`/api/accounts/${id}`))).status).toBe(404);

    // Audit rows survive the purge (reference the name string)
    const db = openDb();
    const audits = (Object.assign({}, db.prepare(
      "SELECT COUNT(*) AS c FROM audit_log WHERE account_id = ? AND action = 'account_purged'"
    ).get(id)) as any).c;
    db.close();
    expect(audits).toBe(1);
  });

  it('roster + key-holder stats exclude archived customers', async () => {
    const AM = 'ARCHIVE ROSTER AM';
    const c1 = await auth(request(app).post('/api/accounts')).send({
      record_type: 'customer', ic_company_name: 'ARCH ROSTER 1', account_manager: AM, am_keys: 5, metal_keys: 4,
    });
    await auth(request(app).post('/api/accounts')).send({
      record_type: 'customer', ic_company_name: 'ARCH ROSTER 2', account_manager: AM, am_keys: 3, metal_keys: 2,
    });
    const before = (await auth(request(app).get('/api/managers/account-managers'))).body.managers.find((m: any) => m.person === AM);
    expect(before.clients_managed).toBe(2);
    expect(before.keys_held).toBe(8);

    await auth(request(app).post(`/api/accounts/${c1.body.id}/archive`));

    const after = (await auth(request(app).get('/api/managers/account-managers'))).body.managers.find((m: any) => m.person === AM);
    expect(after.clients_managed).toBe(1);
    expect(after.keys_held).toBe(3);   // archived client's 5 excluded
    expect(after.metal_keys).toBe(2);  // archived client's 4 excluded
  });
});

// ═══════════════════════════════════════ CHECKOUT ACCOUNT SEARCH ════════════
// The Check Out Key picker searches ALL accounts server-side by name and must
// never surface archived ones.
describe('CHECKOUT ACCOUNT SEARCH', () => {
  it('finds customers AND ICs by ic_company_name via type=all, excludes archived', async () => {
    const cust = await auth(request(app).post('/api/accounts')).send({
      record_type: 'customer', ic_company_name: 'ZORP CHECKOUT CLIENT',
    });
    await auth(request(app).post('/api/accounts')).send({
      record_type: 'ic', ic_company_name: 'ZORP CHECKOUT VENDOR', bc_vendor_number: '02014990900',
    });

    const found = (await auth(request(app).get('/api/accounts?type=all&search=ZORP CHECKOUT&limit=20'))).body;
    const names = found.accounts.map((a: any) => a.ic_company_name);
    expect(names).toContain('ZORP CHECKOUT CLIENT');
    expect(names).toContain('ZORP CHECKOUT VENDOR');
    // rows carry ic_company_name (the field the picker binds to), not a null `name`
    expect(found.accounts.every((a: any) => typeof a.ic_company_name === 'string')).toBe(true);

    // Archive the customer → it disappears from the picker's search
    await auth(request(app).post(`/api/accounts/${cust.body.id}/archive`));
    const after = (await auth(request(app).get('/api/accounts?type=all&search=ZORP CHECKOUT&limit=20'))).body;
    expect(after.accounts.map((a: any) => a.ic_company_name)).not.toContain('ZORP CHECKOUT CLIENT');
    expect(after.accounts.map((a: any) => a.ic_company_name)).toContain('ZORP CHECKOUT VENDOR');
  });
});

// ═══════════════════ HOLDER GRID (16-CELL TRANSPOSED MODEL) ═════════════════
// Rows are key TYPES (Metal/Card/Fob/Dispenser), columns are HOLDERS
// (AM/CCM/Contractor-IC/Office). A cell field name is `${holder}_${type}`.
describe('HOLDER GRID (16-CELL) — ROW + COLUMN TOTALS', () => {
  it('all 16 grid cells round-trip; row totals + column totals compute correctly', async () => {
    const payload = {
      record_type: 'customer', ic_company_name: 'GRID SITE',
      am_metal: 2, am_card: 1, am_fob: 1, am_dispenser: 0,
      ccm_metal: 0, ccm_card: 3, ccm_fob: 0, ccm_dispenser: 1,
      contractor_metal: 4, contractor_card: 0, contractor_fob: 1, contractor_dispenser: 2,
      office_metal: 1, office_card: 1, office_fob: 1, office_dispenser: 1,
    };
    const res = await auth(request(app).post('/api/accounts')).send(payload);
    expect(res.status).toBe(201);
    const a = (await auth(request(app).get(`/api/accounts/${res.body.id}`))).body;

    // all 16 grid cells round-trip byte-identical
    for (const k of Object.keys(payload)) {
      if (k === 'record_type' || k === 'ic_company_name') continue;
      expect(a[k], k).toBe((payload as any)[k]);
    }

    // COLUMN totals (one holder, all 4 types)
    expect(a.am_keys).toBe(4);          // 2+1+1+0
    expect(a.ccm_keys).toBe(4);         // 0+3+0+1
    expect(a.contractor_keys).toBe(7);  // 4+0+1+2
    expect(a.office_keys_held).toBe(4); // 1+1+1+1

    // ROW totals (one type, all 4 holders) = the client-site Key Inventory
    expect(a.metal_keys).toBe(7);       // 2+0+4+1
    expect(a.key_cards).toBe(5);        // 1+3+0+1
    expect(a.has_fob).toBe(3);          // 1+0+1+1
    expect(a.dispenser_keys).toBe(4);   // 0+1+2+1
  });

  it('legacy total is preserved when the grid is empty, recomputed when entered', async () => {
    // legacy-style write: flat column total, no grid breakdown
    const created = await auth(request(app).post('/api/accounts')).send({
      record_type: 'customer', ic_company_name: 'LEGACY GRID SITE', am_keys: 5,
    });
    const id = created.body.id;
    let a = (await auth(request(app).get(`/api/accounts/${id}`))).body;
    expect(a.am_keys).toBe(5);
    expect(a.am_metal).toBe(0);

    // edit something else, grid still empty → total must NOT be zeroed
    await auth(request(app).put(`/api/accounts/${id}`)).send({
      ic_company_name: 'LEGACY GRID SITE', am_keys: 5,
      am_metal: 0, am_card: 0, am_fob: 0, am_dispenser: 0,
    });
    a = (await auth(request(app).get(`/api/accounts/${id}`))).body;
    expect(a.am_keys).toBe(5);

    // now enter a grid breakdown → total recomputes from the cells
    await auth(request(app).put(`/api/accounts/${id}`)).send({
      ic_company_name: 'LEGACY GRID SITE', am_metal: 2, am_card: 1, am_fob: 0, am_dispenser: 0,
    });
    a = (await auth(request(app).get(`/api/accounts/${id}`))).body;
    expect(a.am_keys).toBe(3);

    // clearing a previously-set grid honors the intentional zero
    await auth(request(app).put(`/api/accounts/${id}`)).send({
      ic_company_name: 'LEGACY GRID SITE', am_metal: 0, am_card: 0, am_fob: 0, am_dispenser: 0,
    });
    a = (await auth(request(app).get(`/api/accounts/${id}`))).body;
    expect(a.am_keys).toBe(0);
  });

  it('AM roster personal per-type sums match a hand-check', async () => {
    const AM = 'GRID HANDCHECK AM';
    await auth(request(app).post('/api/accounts')).send({
      record_type: 'customer', ic_company_name: 'GH 1', account_manager: AM,
      am_metal: 2, am_card: 1, am_fob: 1, am_dispenser: 1,
    });
    await auth(request(app).post('/api/accounts')).send({
      record_type: 'customer', ic_company_name: 'GH 2', account_manager: AM,
      am_metal: 3, am_card: 0, am_fob: 2, am_dispenser: 2,
    });
    const row = (await auth(request(app).get('/api/managers/account-managers'))).body.managers.find((m: any) => m.person === AM);
    expect(row.personal_metal).toBe(5);      // 2+3
    expect(row.personal_cards).toBe(1);      // 1+0
    expect(row.personal_fobs).toBe(3);       // 1+2
    expect(row.personal_dispenser).toBe(3);  // 1+2
    expect(row.keys_held).toBe(12);          // (2+1+1+1)+(3+0+2+2)
    expect(row.total_held).toBe(12);
  });
});

// ═══════════════════════════════════════ DELETE PERMISSIONS ═════════════════
describe('CAN_DELETE PERMISSIONS', () => {
  it('Cara is seeded with can_delete=1 and it flows through login', async () => {
    const db = openDb();
    const cd = (Object.assign({}, db.prepare('SELECT can_delete FROM managers WHERE email = ?').get(ADMIN_EMAIL)) as any).can_delete;
    db.close();
    expect(cd).toBe(1);
    const login = await request(app).post('/api/auth/login').send({ email: ADMIN_EMAIL, password: ADMIN_PASS });
    expect(login.body.manager.can_delete).toBe(true);
  });

  it('a manager WITHOUT can_delete gets 403 on archive/restore/purge', async () => {
    const db = openDb();
    db.prepare('INSERT INTO managers (name, email, password_hash, role, can_delete) VALUES (?, ?, ?, ?, 0)')
      .run('No Delete', 'nodelete@cw.com', bcrypt.hashSync('pass1234', 10), 'manager');
    db.close();
    const login = await request(app).post('/api/auth/login').send({ email: 'nodelete@cw.com', password: 'pass1234' });
    expect(login.body.manager.can_delete).toBe(false);
    const noDel = login.body.token;

    const created = await auth(request(app).post('/api/accounts')).send({ record_type: 'customer', ic_company_name: 'PERM TEST' });
    const arch = await request(app).post(`/api/accounts/${created.body.id}/archive`).set('Authorization', `Bearer ${noDel}`);
    expect(arch.status).toBe(403);
    expect(arch.body.error).toMatch(/Delete access required — contact Cara Angeloni/);
    const del = await request(app).delete(`/api/accounts/${created.body.id}`).set('Authorization', `Bearer ${noDel}`).send({ confirm: 'DELETE' });
    expect(del.status).toBe(403);
  });

  it('admin can grant can_delete via PATCH /managers/:id/permissions (audit-logged), then that manager can archive', async () => {
    const db = openDb();
    const mgr: any = Object.assign({}, db.prepare('SELECT id FROM managers WHERE email = ?').get('nodelete@cw.com'));
    db.close();

    const grant = await auth(request(app).patch(`/api/managers/${mgr.id}/permissions`)).send({ can_delete: true });
    expect(grant.status).toBe(200);
    expect(grant.body.can_delete).toBe(true);

    const db2 = openDb();
    const audit = (Object.assign({}, db2.prepare("SELECT COUNT(*) AS c FROM audit_log WHERE action = 'permissions_changed'").get()) as any).c;
    db2.close();
    expect(audit).toBeGreaterThanOrEqual(1);

    // now that manager can archive
    const login = await request(app).post('/api/auth/login').send({ email: 'nodelete@cw.com', password: 'pass1234' });
    const created = await auth(request(app).post('/api/accounts')).send({ record_type: 'customer', ic_company_name: 'PERM GRANTED' });
    const arch = await request(app).post(`/api/accounts/${created.body.id}/archive`).set('Authorization', `Bearer ${login.body.token}`);
    expect(arch.status).toBe(200);
  });

  it('non-admin cannot grant permissions', async () => {
    const login = await request(app).post('/api/auth/login').send({ email: 'nodelete@cw.com', password: 'pass1234' });
    const db = openDb();
    const mgr: any = Object.assign({}, db.prepare('SELECT id FROM managers WHERE email = ?').get(ADMIN_EMAIL));
    db.close();
    const res = await request(app).patch(`/api/managers/${mgr.id}/permissions`).set('Authorization', `Bearer ${login.body.token}`).send({ can_delete: false });
    expect(res.status).toBe(403);
  });
});

// ═══════════════════════════════════════ IMPORT DRY-RUN ═════════════════════
describe('UPDATE-MODE IMPORT DRY-RUN', () => {
  it('reports fields it WOULD backfill without writing', async () => {
    // existing customer with empty account_manager + ccm_manager + role counts
    await auth(request(app).post('/api/accounts')).send({
      record_type: 'customer', ic_company_name: 'DRYRUN CO', bc_client_number: 'DRYRUN-1',
    });

    const rows = [
      { ic_company_name: 'DRYRUN CO', bc_client_number: 'DRYRUN-1', account_manager: 'New AM', ccm_manager: 'New CCM', am_keys: 3, office_keys_held: 2 },
      { ic_company_name: 'GHOST', bc_client_number: 'DRYRUN-NONE', account_manager: 'X' }, // unmatched
    ];
    const res = await auth(request(app).post('/api/accounts/import/dry-run')).send({ rows });
    expect(res.status).toBe(200);
    expect(res.body.matched).toBe(1);
    expect(res.body.unmatched).toBe(1);
    expect(res.body.wouldFill.account_manager).toBe(1);
    expect(res.body.wouldFill.ccm_manager).toBe(1);
    expect(res.body.wouldFill.am_keys).toBe(1);
    expect(res.body.wouldFill.office_keys_held).toBe(1);

    // dry-run wrote nothing: the row's account_manager is still empty
    const got = (await auth(request(app).get('/api/accounts?type=customer&search=DRYRUN CO&limit=1'))).body.accounts[0];
    expect(got.account_manager == null || got.account_manager === '').toBe(true);
  });

  it('does not report populated fields (never overwrites)', async () => {
    await auth(request(app).post('/api/accounts')).send({
      record_type: 'customer', ic_company_name: 'DRYRUN FULL', bc_client_number: 'DRYRUN-2', account_manager: 'Existing AM',
    });
    const res = await auth(request(app).post('/api/accounts/import/dry-run')).send({
      rows: [{ ic_company_name: 'DRYRUN FULL', bc_client_number: 'DRYRUN-2', account_manager: 'Would Overwrite' }],
    });
    expect(res.body.matched).toBe(1);
    expect(res.body.wouldFill.account_manager ?? 0).toBe(0); // populated → not filled
  });
});

// ═══════════════════════════════════════ REAL SHEET HEADER REGRESSION ═══════
// Reproduces the actual production import bug: the real registry sheet has
// BOTH a manager-NAME column ("Contract Compliance Manager") AND a separate,
// later, short KEY-COUNT column ("CCM") — plus "IC"/"AM"/"Office" key-count
// columns. A bare 'ccm' alias used to point at ccm_manager, colliding with the
// name column; the blank "CCM" key-count column silently overwrote the real
// name on import. This suite locks in the fix with the sheet's EXACT header
// row, in order, verified from the source file.
describe('REAL SHEET HEADERS — CCM name vs CCM/IC/AM/Office key-count columns', () => {
  const REAL_HEADERS = [
    'Client Name', 'BC Client Number', 'Independent Contractor', 'BC Vendor Number',
    'Account Manager', 'Contract Compliance Manager', 'Keys Y/N', 'Security App Y/N',
    'Metal Keys', 'Key Cards', 'Key Fobs', 'Dispenser Key',
    'Lockbox Code', 'Door Code', 'Alarm Code',
    'IC', 'AM', 'CCM', 'Office', 'Notes',
  ];

  function buildRealSheet(): Buffer {
    const aoa: any[][] = [REAL_HEADERS];
    aoa.push([
      'Riverside Plaza', 'RS-EXACT-1', 'ALVES CLEANING SERVICES INC', '02014100020',
      'John Smith', 'Matthew Wagnac', 'Y', 'Y',
      '3', '2', '1', '0',
      '4417', '1234', '5678',
      '2', '1', '1', '1', 'VIP account',
    ]);
    aoa.push([
      'Harbor Towers', 'RS-EXACT-2', 'SHARP CLEANING CORP', '02014100044',
      'Jane Doe', 'Daniel Bordenave', '', '',
      '1', '0', '0', '1',
      '', '', '',
      '1', '0', '0', '0', '',
    ]);
    aoa.push([
      'Beacon Mall', 'RS-EXACT-3', 'HOWARD CLEANING SERVICES', '02014100209',
      '', '', '', '',
      '', '', '', '',
      '', '', '',
      '', '', '', '', '',
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Registry');
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  }

  it('all 20 headers map with zero collisions; ccm_manager populated; IC/AM/CCM/Office route to the correct key-count fields', async () => {
    const preview = await auth(request(app).post('/api/accounts/import'))
      .attach('file', buildRealSheet(), 'real-headers.xlsx');
    expect(preview.status).toBe(200);

    // Every header recognized, nothing unmapped, and — critically — no two
    // different headers collide on the same destination field.
    expect(preview.body.unmappedHeaders).toEqual([]);
    expect(preview.body.mappedHeaders.length).toBe(20);
    expect(preview.body.fieldCollisions).toEqual([]);

    expect(preview.body.total).toBe(3);
    expect(preview.body.valid.length).toBe(3);
    expect(preview.body.errors.length).toBe(0);

    const row1 = preview.body.valid.find((r: any) => r.bc_client_number === 'RS-EXACT-1');
    // The name column populated ccm_manager — NOT blanked by the "CCM" key-count column.
    expect(row1.account_manager).toBe('John Smith');
    expect(row1.ccm_manager).toBe('Matthew Wagnac');
    // IC / AM / CCM / Office key-count columns route to the correct fields —
    // not confused with account_manager / ccm_manager.
    expect(row1.contractor_keys).toBe(2);
    expect(row1.am_keys).toBe(1);
    expect(row1.ccm_keys).toBe(1);
    expect(row1.office_keys_held).toBe(1);

    const row2 = preview.body.valid.find((r: any) => r.bc_client_number === 'RS-EXACT-2');
    expect(row2.ccm_manager).toBe('Daniel Bordenave');

    // Confirm the insert, then verify what actually landed in the DB —
    // byte-identical to what the preview reported, nothing lost on write.
    const confirm = await auth(request(app).post('/api/accounts/import/confirm'))
      .send({ rows: preview.body.valid });
    expect(confirm.body.inserted).toBe(3);

    const db = openDb();
    const stored: any = Object.assign({}, db.prepare(
      'SELECT account_manager, ccm_manager, contractor_keys, am_keys, ccm_keys, office_keys_held FROM accounts WHERE bc_client_number = ?'
    ).get('RS-EXACT-1'));
    db.close();
    expect(stored.account_manager).toBe('John Smith');
    expect(stored.ccm_manager).toBe('Matthew Wagnac');
    expect(stored.contractor_keys).toBe(2);
    expect(stored.am_keys).toBe(1);
    expect(stored.ccm_keys).toBe(1);
    expect(stored.office_keys_held).toBe(1);
  });

  it('update-mode backfills ccm_manager where NULL, never touches an already-populated row, never duplicates', async () => {
    const already = await auth(request(app).post('/api/accounts')).send({
      record_type: 'customer', ic_company_name: 'Already Has CCM', bc_client_number: 'RS-UPD-1',
      ccm_manager: 'Existing Manager Name',
    });
    const missing = await auth(request(app).post('/api/accounts')).send({
      record_type: 'customer', ic_company_name: 'Missing CCM', bc_client_number: 'RS-UPD-2',
    });

    const aoa = [
      ['Client Name', 'BC Client Number', 'Contract Compliance Manager'],
      ['Already Has CCM', 'RS-UPD-1', 'Should Not Overwrite'],
      ['Missing CCM', 'RS-UPD-2', 'Newly Backfilled Name'],
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'S');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const preview = await auth(request(app).post('/api/accounts/import')).attach('file', buf, 'upd.xlsx');
    // Both bc_client_numbers already exist → both land in `warnings`, not `valid`.
    expect(preview.body.warnings.length).toBe(2);
    expect(preview.body.valid.length).toBe(0);

    const confirm = await auth(request(app).post('/api/accounts/import/confirm')).send({
      rows: preview.body.warnings.map((w: any) => w.data),
      mode: 'upsert',
    });
    expect(confirm.body.inserted).toBe(0); // never duplicates
    expect(confirm.body.updated).toBe(2);

    const already2 = (await auth(request(app).get(`/api/accounts/${already.body.id}`))).body;
    const missing2 = (await auth(request(app).get(`/api/accounts/${missing.body.id}`))).body;
    expect(already2.ccm_manager).toBe('Existing Manager Name'); // untouched
    expect(missing2.ccm_manager).toBe('Newly Backfilled Name'); // backfilled
  });
});
