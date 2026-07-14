import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import * as XLSX from 'xlsx';
import { DatabaseSync } from 'node:sqlite';
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

  it('DELETE removes an account', async () => {
    const created = await auth(request(app).post('/api/accounts')).send({
      record_type: 'customer', ic_company_name: 'To Delete',
    });
    const del = await auth(request(app).delete(`/api/accounts/${created.body.id}`));
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
