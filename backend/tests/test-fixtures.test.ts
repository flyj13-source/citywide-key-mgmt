import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'citywide-fixtures-'));
process.env.CITYWIDE_DB_DIR = TEST_DIR;
delete process.env.DB_PATH;
process.env.JWT_SECRET = 'test-secret';
process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
process.env.SEED_PASSWORD = 'demo1234';

const DB_FILE = path.join(TEST_DIR, 'citywide.db');
let app: Express;
let token: string;
let db: DatabaseSync;
let fx: typeof import('../src/lib/testFixtures');

const auth = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);
const scalar = (sql: string, ...p: any[]) =>
  Object.assign({}, db.prepare(sql).get(...p) as any).c as number;
/** One row as a plain object, or null. */
const scalarRow = (sql: string, ...p: any[]): any => {
  const raw = db.prepare(sql).get(...p) as any;
  return raw ? Object.assign({}, raw) : null;
};

beforeAll(async () => {
  app = (await import('../src/index')).default;
  (await import('../src/lib/autoSeed')).autoSeedIfEmpty();
  fx = await import('../src/lib/testFixtures');
  const login = await request(app).post('/api/auth/login')
    .send({ email: 'cara@citywideboston.com', password: 'demo1234' });
  token = login.body.token;
  db = new DatabaseSync(DB_FILE);
});

beforeEach(() => {
  // Children first — key_assignments carries a FK onto accounts, so clearing
  // the parent table ahead of it fails the constraint.
  db.exec('DELETE FROM key_assignments');
  db.exec('DELETE FROM key_form_docs');
  db.exec('DELETE FROM audit_log');
  db.exec("DELETE FROM accounts WHERE COALESCE(is_test,0)=0");
  db.exec("DELETE FROM staff_managers WHERE COALESCE(is_test,0)=0");
  fx.seedTestFixtures();
});

/** N real customers alongside the fixtures. */
const realCustomers = (n: number) => {
  for (let i = 0; i < n; i++) {
    db.prepare(
      "INSERT INTO accounts (ic_company_name, bc_client_number, record_type, status, archived, is_test, metal_keys, account_manager) VALUES (?,?,'customer','active',0,0,3,'Real Manager')"
    ).run(`REAL SITE ${String(i).padStart(3, '0')}`, `010147${String(i).padStart(5, '0')}`);
  }
};

describe('§1 THE FOUR FIXTURES', () => {
  it('creates a client, an IC and a staff member', () => {
    const client = Object.assign({}, db.prepare(
      "SELECT * FROM accounts WHERE bc_client_number = '09999900001'"
    ).get() as any);
    expect(client).toMatchObject({
      ic_company_name: 'ZZ TEST CLIENT — Do Not Use',
      record_type: 'customer', is_test: 1,
      account_manager: 'ZZ Test Manager', ccm_manager: 'ZZ Test Manager',
      ic_name: 'ZZ TEST CONTRACTOR — Do Not Use', bc_vendor_number: '09999900002',
      metal_keys: 4, key_cards: 2, has_fob: 2, dispenser_keys: 1,
      lockbox_code: 'TEST',
    });
    // Codes stay NULL — a fixture must never carry a secret.
    expect(client.door_code_encrypted).toBeNull();
    expect(client.alarm_code_encrypted).toBeNull();

    const ic = Object.assign({}, db.prepare(
      "SELECT * FROM accounts WHERE bc_vendor_number = '09999900002' AND record_type='ic'"
    ).get() as any);
    expect(ic).toMatchObject({
      ic_company_name: 'ZZ TEST CONTRACTOR — Do Not Use', is_test: 1,
      ic_primary_contact: 'ZZ Test Contact', ic_email: 'keys@citywidekeys.com',
    });

    const staff = Object.assign({}, db.prepare(
      "SELECT * FROM staff_managers WHERE name = 'ZZ Test Manager'"
    ).get() as any);
    expect(staff).toMatchObject({
      manager_type: 'both', role_category: 'manager',
      email: 'keys@citywidekeys.com', is_test: 1, active: 1,
    });
  });

  it('populates the holder grid so there is something to move', () => {
    const c = Object.assign({}, db.prepare(
      "SELECT * FROM accounts WHERE bc_client_number = '09999900001'"
    ).get() as any);
    expect(c).toMatchObject({
      am_metal: 1, am_card: 1,
      ccm_metal: 1,
      contractor_metal: 2, contractor_fob: 1,
      office_fob: 1, office_dispenser: 1,
    });
  });

  it('is IDEMPOTENT — seeding again creates nothing', () => {
    const before = scalar('SELECT COUNT(*) AS c FROM accounts');
    const beforeStaff = scalar('SELECT COUNT(*) AS c FROM staff_managers');
    const again = fx.seedTestFixtures();
    expect(again.created).toEqual([]);
    expect(again.existing.sort()).toEqual(['client', 'ic', 'no-email staff', 'staff']);
    expect(scalar('SELECT COUNT(*) AS c FROM accounts')).toBe(before);
    expect(scalar('SELECT COUNT(*) AS c FROM staff_managers')).toBe(beforeStaff);
  });

  it('both contacts point at the operator inbox, never a real person', () => {
    const emails = [
      Object.assign({}, db.prepare("SELECT ic_email AS e FROM accounts WHERE bc_vendor_number='09999900002'").get() as any).e,
      Object.assign({}, db.prepare("SELECT email AS e FROM staff_managers WHERE name='ZZ Test Manager'").get() as any).e,
    ];
    expect(emails).toEqual(['keys@citywidekeys.com', 'keys@citywidekeys.com']);
  });
});

describe('§1a THE CLIENT IS POPULATED, NOT A SHELL', () => {
  it('carries every field a workflow needs', () => {
    fx.seedTestFixtures();
    const c = scalarRow(
      'SELECT * FROM accounts WHERE bc_client_number = ? AND record_type = ?',
      '09999900001', 'customer',
    );
    expect(c).toMatchObject({
      ic_company_name: 'ZZ TEST CLIENT — Do Not Use',
      account_manager: 'ZZ Test Manager', ccm_manager: 'ZZ Test Manager',
      ic_name: 'ZZ TEST CONTRACTOR — Do Not Use', bc_vendor_number: '09999900002',
      keys_yn: 1, security_app_yn: 1,
      metal_keys: 4, key_cards: 2, has_fob: 2, dispenser_keys: 1,
      lockbox_code: 'TEST',
      notes: 'Test fixture — safe to check out, transfer, and reset',
      is_test: 1,
    });
    // Nothing sensitive lives on a test record.
    expect(c.door_code_encrypted).toBeNull();
    expect(c.alarm_code_encrypted).toBeNull();
  });

  it('has a holder grid, so there is something to move', () => {
    fx.seedTestFixtures();
    const c = scalarRow('SELECT * FROM accounts WHERE bc_client_number = ?', '09999900001');
    expect(c).toMatchObject({
      am_metal: 1, am_card: 1, am_fob: 0, am_dispenser: 0,
      ccm_metal: 1, ccm_card: 0, ccm_fob: 0, ccm_dispenser: 0,
      contractor_metal: 2, contractor_card: 0, contractor_fob: 1, contractor_dispenser: 0,
      office_metal: 0, office_card: 0, office_fob: 1, office_dispenser: 1,
    });
  });

  it('a hollowed-out row is refilled by the next seed', () => {
    const ids = fx.seedTestFixtures();
    db.prepare(
      'UPDATE accounts SET security_app_yn = 0, notes = NULL, metal_keys = 0, am_metal = 0 WHERE id = ?'
    ).run(ids.client);
    fx.seedTestFixtures();
    expect(scalarRow('SELECT security_app_yn, notes, metal_keys, am_metal FROM accounts WHERE id = ?', ids.client))
      .toMatchObject({
        security_app_yn: 1, metal_keys: 4, am_metal: 1,
        notes: 'Test fixture — safe to check out, transfer, and reset',
      });
  });
});

describe('§1b THE NO-EMAIL FIXTURE — the failure path needs a subject', () => {
  it('exists as crew with no address, flagged is_test', () => {
    const row = scalarRow(
      "SELECT name, email, role_category, active, COALESCE(is_test,0) AS is_test " +
      "FROM staff_managers WHERE name = 'ZZ Test No-Email Staff'"
    );
    expect(row).toMatchObject({ role_category: 'crew', email: null, active: 1, is_test: 1 });
  });

  it('an address filled in by mistake is put back on the next seed', () => {
    db.prepare("UPDATE staff_managers SET email = 'oops@example.test' WHERE name = 'ZZ Test No-Email Staff'").run();
    fx.seedTestFixtures();
    const row = scalarRow("SELECT email FROM staff_managers WHERE name = 'ZZ Test No-Email Staff'");
    // Otherwise a well-meaning edit silently removes the only way to test the
    // "no address on file" path.
    expect(row.email).toBeNull();
  });

  it('checking out to them hits the missing-email gate', async () => {
    const ids = fx.seedTestFixtures();
    const res = await auth(request(app).post('/api/assignments/checkout')).send({
      account_id: ids.client, holder: 'ZZ Test No-Email Staff',
      holder_type: 'employee', keys: [{ type: 'metal', qty: 1 }],
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('HOLDER_EMAIL_MISSING');

    // …and goes through once a reason is given, flagged as unsigned.
    const forced = await auth(request(app).post('/api/assignments/checkout')).send({
      account_id: ids.client, holder: 'ZZ Test No-Email Staff',
      holder_type: 'employee', keys: [{ type: 'metal', qty: 1 }],
      no_email_reason: 'Testing the red-flag path',
    });
    expect(forced.status).toBe(201);
    expect(forced.body.signature_status).toBe('signature_unavailable');
  });
});

describe('§1d /api/_diag REPORTS THE FIXTURES', () => {
  it('reports four present, with the identifying fields', async () => {
    fx.seedTestFixtures();
    const res = await auth(request(app).get('/api/_diag'));
    expect(res.status).toBe(200);
    expect(res.body.test_fixtures).toMatchObject({
      expected: 4, present: 4, complete: true,
      expected_contact: 'keys@citywidekeys.com',
      is_test_column: { accounts: true, staff_managers: true },
    });
    expect(res.body.test_fixtures.records.client).toMatchObject({
      name: 'ZZ TEST CLIENT — Do Not Use', is_test: 1,
      account_manager: 'ZZ Test Manager', ic_name: 'ZZ TEST CONTRACTOR — Do Not Use',
      bc_vendor_number: '09999900002', lockbox_code: 'TEST',
    });
    // The grid is populated, so there is something to move.
    expect(res.body.test_fixtures.records.client.grid_total).toBeGreaterThan(0);
    expect(res.body.test_fixtures.records.no_email_staff).toMatchObject({ email: null, is_test: 1 });
  });

  it('separates real customers from the count including fixtures', async () => {
    realCustomers(5);
    const res = await auth(request(app).get('/api/_diag'));
    expect(res.body.test_fixtures.real_customers).toBe(5);
    expect(res.body.test_fixtures.customers_including_test).toBe(6);
  });

  it('says so when a fixture is missing', async () => {
    db.prepare("DELETE FROM staff_managers WHERE name = 'ZZ Test No-Email Staff'").run();
    const res = await auth(request(app).get('/api/_diag'));
    expect(res.body.test_fixtures).toMatchObject({ present: 3, complete: false });
    expect(res.body.test_fixtures.records.no_email_staff).toBeNull();
  });
});

describe('§3 THE RESET BUTTON', () => {
  it('wipes test activity, re-seeds, and reports the real count unmoved', async () => {
    realCustomers(6);
    const ids = fx.seedTestFixtures();
    await auth(request(app).post('/api/assignments/checkout')).send({
      account_id: ids.client, holder: 'ZZ Test Manager',
      holder_email: 'keys@citywidekeys.com', holder_type: 'employee',
      keys: [{ type: 'metal', qty: 1 }],
    });

    const res = await auth(request(app).post('/api/settings/test-data/reset')).send({ confirm: 'RESET' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.real_customers).toMatchObject({ before: 6, after: 6, unchanged: true });
    expect(res.body.deleted.assignments).toBeGreaterThan(0);
    expect(res.body.fixtures.noEmailStaff).toBeGreaterThan(0);
    expect(scalar('SELECT COUNT(*) AS c FROM key_assignments')).toBe(0);
    // The fixtures are back, not merely deleted.
    expect(scalar("SELECT COUNT(*) AS c FROM accounts WHERE COALESCE(is_test,0)=1")).toBe(2);
  });

  it('refuses to run without the typed confirmation', async () => {
    const ids = fx.seedTestFixtures();
    await auth(request(app).post('/api/assignments/checkout')).send({
      account_id: ids.client, holder: 'ZZ Test Manager',
      holder_email: 'keys@citywidekeys.com', holder_type: 'employee',
      keys: [{ type: 'metal', qty: 1 }],
    });
    const before = scalar('SELECT COUNT(*) AS c FROM key_assignments');
    expect(before).toBeGreaterThan(0);

    for (const body of [{}, { confirm: '' }, { confirm: 'yes' }, { confirm: 'reset please' }]) {
      const res = await auth(request(app).post('/api/settings/test-data/reset')).send(body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('CONFIRMATION_REQUIRED');
    }
    // Nothing was deleted by any of those.
    expect(scalar('SELECT COUNT(*) AS c FROM key_assignments')).toBe(before);

    // Case-insensitive, whitespace-tolerant — but it has to be the word.
    const ok = await auth(request(app).post('/api/settings/test-data/reset')).send({ confirm: ' reset ' });
    expect(ok.status).toBe(200);
  });

  it('is admin only', async () => {
    const bcrypt = (await import('bcryptjs')).default;
    db.prepare("INSERT OR IGNORE INTO managers (name, email, password_hash, role) VALUES ('Viewer','viewer2@citywideboston.com',?, 'manager')")
      .run(bcrypt.hashSync('demo1234', 10));
    const login = await request(app).post('/api/auth/login')
      .send({ email: 'viewer2@citywideboston.com', password: 'demo1234' });
    const res = await request(app).post('/api/settings/test-data/reset')
      .set('Authorization', `Bearer ${login.body.token}`).send({ confirm: 'RESET' });
    expect(res.status).toBe(403);
  });

  it('seed repairs a damaged fixture without touching its activity', async () => {
    const ids = fx.seedTestFixtures();
    // Someone blanks the grid and the links.
    db.prepare(
      'UPDATE accounts SET am_metal=0, am_card=0, contractor_metal=0, lockbox_code=NULL, ' +
      'account_manager=NULL, ic_name=NULL WHERE id = ?'
    ).run(ids.client);

    const res = await auth(request(app).post('/api/settings/test-data/seed')).send({});
    expect(res.status).toBe(200);
    const row = scalarRow('SELECT am_metal, am_card, contractor_metal, lockbox_code, account_manager, ic_name FROM accounts WHERE id = ?', ids.client);
    expect(row).toMatchObject({
      am_metal: 1, am_card: 1, contractor_metal: 2, lockbox_code: 'TEST',
      account_manager: 'ZZ Test Manager', ic_name: 'ZZ TEST CONTRACTOR — Do Not Use',
    });
  });
});

describe('§2 ISOLATION — fixtures never pollute real numbers', () => {
  it('the customer count is unchanged by the fixture', async () => {
    realCustomers(577);
    const res = await auth(request(app).get('/api/accounts?type=customer&limit=1'));
    // 577 real, not 578 — the fixture is in the table but not in the count.
    expect(res.body.total).toBe(577);
    expect(scalar("SELECT COUNT(*) AS c FROM accounts WHERE record_type='customer'")).toBe(578);
  });

  it('the IC count is unchanged by the fixture', async () => {
    db.prepare("INSERT INTO accounts (ic_company_name, bc_vendor_number, record_type, is_test) VALUES ('REAL IC','02014100001','ic',0)").run();
    const res = await auth(request(app).get('/api/accounts?type=ic&limit=1'));
    expect(res.body.total).toBe(1);
  });

  it('registry rows exclude the fixture unless include_test=1', async () => {
    realCustomers(3);
    const off = await auth(request(app).get('/api/accounts?type=customer&limit=100'));
    expect(off.body.accounts.some((a: any) => a.is_test === 1)).toBe(false);

    const on = await auth(request(app).get('/api/accounts?type=customer&limit=100&include_test=1'));
    expect(on.body.accounts.some((a: any) => a.is_test === 1)).toBe(true);
    expect(on.body.total).toBe(off.body.total + 1);
  });

  it('select-all-matching cannot sweep up a fixture', async () => {
    realCustomers(5);
    const res = await auth(request(app).get('/api/accounts/ids?type=customer'));
    expect(res.body.total).toBe(5);
    expect(res.body.items.some((i: any) => /ZZ TEST/.test(i.ic_company_name))).toBe(false);
  });

  it('roster aggregates exclude the fixture client and manager', async () => {
    realCustomers(2);
    db.prepare("UPDATE accounts SET account_manager='Real Manager' WHERE COALESCE(is_test,0)=0 AND record_type='customer'").run();
    db.prepare("INSERT INTO staff_managers (name, manager_type, role_category, active, is_test) VALUES ('Real Manager','account_manager','manager',1,0)").run();

    const res = await auth(request(app).get('/api/staff-managers/roster?role=am'));
    const names = res.body.managers.map((m: any) => m.name);
    expect(names).toContain('Real Manager');
    expect(names).not.toContain('ZZ Test Manager');
    // …and the test client is not in anyone's managed inventory.
    const real = res.body.managers.find((m: any) => m.name === 'Real Manager');
    expect(real.clients_managed).toBe(2);
  });

  it('the AM roster endpoint excludes the fixture client', async () => {
    const res = await auth(request(app).get('/api/managers/account-managers'));
    expect(res.body.managers.some((m: any) => m.person === 'ZZ Test Manager')).toBe(false);
  });

  it('the dashboard key-holder totals ignore the fixture grid', async () => {
    realCustomers(3);
    // Every real site here has an empty holder grid, so anything non-zero
    // could only have come from the fixture.
    const res = await auth(request(app).get('/api/accounts/key-holder-stats'));
    expect(res.body).toMatchObject({
      am_personal: 0, ccm_personal: 0, ic_personal: 0, office_personal: 0,
    });
  });

  it('the staff roster excludes the fixture unless include_test is set', async () => {
    db.prepare("INSERT INTO staff_managers (name, manager_type, role_category, active, is_test) VALUES ('Real Person','ccm','manager',1,0)").run();
    const off = await auth(request(app).get('/api/staff'));
    expect(off.body.map((s: any) => s.name)).toEqual(['Real Person']);

    const on = await auth(request(app).get('/api/staff?include_test=1'));
    expect(on.body.map((s: any) => s.name).sort())
      .toEqual(['Real Person', 'ZZ Test Manager', 'ZZ Test No-Email Staff']);
  });

  it('a fixture check-out stays out of the active-custody count', async () => {
    realCustomers(1);
    const realId = Object.assign({}, db.prepare(
      "SELECT id FROM accounts WHERE COALESCE(is_test,0)=0 AND record_type='customer'"
    ).get() as any).id as number;
    db.prepare("INSERT INTO staff_managers (name, manager_type, role_category, email, active, is_test) VALUES ('Real Person','ccm','manager','real@example.com',1,0)").run();

    const ids = fx.seedTestFixtures();
    await auth(request(app).post('/api/assignments/checkout')).send({
      account_id: ids.client, holder: fx.TEST_MANAGER_NAME,
      holder_email: fx.TEST_EMAIL, holder_type: 'employee',
      keys: [{ type: 'metal', qty: 1 }],
    });
    await auth(request(app).post('/api/assignments/checkout')).send({
      account_id: realId, holder: 'Real Person',
      holder_email: 'real@example.com', holder_type: 'employee',
      keys: [{ type: 'metal', qty: 1 }],
    });

    const off = await auth(request(app).get('/api/assignments?status=checked_out&limit=1'));
    expect(off.body.total).toBe(1);          // the real one only
    const on = await auth(request(app).get('/api/assignments?status=checked_out&limit=1&include_test=1'));
    expect(on.body.total).toBe(2);           // both, when asked for

    // The signature-gap card counts the real one only.
    const gaps = await auth(request(app).get('/api/assignments/signature-gaps'));
    expect(gaps.body.total_missing).toBe(1);
  });

  it('exports exclude the fixture by default and include it on request', async () => {
    realCustomers(2);
    const off = await auth(request(app).post('/api/exports/registry'))
      .send({ scope: 'current', tab: 'customer', format: 'csv' });
    expect(off.text ?? off.body.toString()).not.toMatch(/ZZ TEST CLIENT/);

    const on = await auth(request(app).post('/api/exports/registry'))
      .send({ scope: 'current', tab: 'customer', format: 'csv', includeTest: true });
    expect(on.text ?? on.body.toString()).toMatch(/ZZ TEST CLIENT/);
  });
});

describe('§3 SAFETY RAILS', () => {
  it('a fixture cannot be archived through the normal flow', async () => {
    const id = fx.seedTestFixtures().client;
    const res = await auth(request(app).post(`/api/accounts/${id}/archive`)).send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('TEST_FIXTURE_PROTECTED');
    expect(Object.assign({}, db.prepare('SELECT archived FROM accounts WHERE id=?').get(id) as any))
      .toMatchObject({ archived: 0 });
  });

  it('a fixture cannot be purged through the normal flow', async () => {
    const id = fx.seedTestFixtures().client;
    const res = await auth(request(app).delete(`/api/accounts/${id}`)).send({ confirm: 'ZZ TEST CLIENT — Do Not Use' });
    expect(res.status).toBe(409);
    expect(scalar('SELECT COUNT(*) AS c FROM accounts WHERE id=?', id)).toBe(1);
  });

  it('bulk archive names a fixture back instead of archiving it', async () => {
    realCustomers(1);
    const real = Object.assign({}, db.prepare("SELECT id FROM accounts WHERE COALESCE(is_test,0)=0 AND record_type='customer'").get() as any).id;
    const testId = fx.seedTestFixtures().client;
    const res = await auth(request(app).post('/api/accounts/bulk-archive')).send({ ids: [real, testId] });
    expect(res.body.archived).toBe(1);
    expect(res.body.blocked.some(
      (b: any) => b.reason === 'test_fixture' && /ZZ TEST CLIENT/.test(b.name)
    )).toBe(true);
    expect(Object.assign({}, db.prepare('SELECT archived FROM accounts WHERE id=?').get(testId) as any))
      .toMatchObject({ archived: 0 });
  });

  it('audit entries touching a fixture carry test_action', async () => {
    const ids = fx.seedTestFixtures();
    await auth(request(app).post('/api/assignments/checkout')).send({
      account_id: ids.client, holder: 'ZZ Test Manager',
      holder_email: 'keys@citywidekeys.com', holder_type: 'employee',
      keys: [{ type: 'metal', qty: 1 }],
    });
    const meta = JSON.parse(Object.assign({}, db.prepare(
      "SELECT metadata FROM audit_log WHERE action='key_checked_out' ORDER BY id DESC LIMIT 1"
    ).get() as any).metadata);
    expect(meta.test_action).toBe(true);
  });

  it('reset wipes test activity, keeps the fixtures, and leaves real data alone', async () => {
    realCustomers(4);
    const ids = fx.seedTestFixtures();
    await auth(request(app).post('/api/assignments/checkout')).send({
      account_id: ids.client, holder: 'ZZ Test Manager',
      holder_email: 'keys@citywidekeys.com', holder_type: 'employee',
      keys: [{ type: 'metal', qty: 1 }],
    });
    expect(scalar('SELECT COUNT(*) AS c FROM key_assignments')).toBeGreaterThan(0);
    expect(scalar('SELECT COUNT(*) AS c FROM key_form_docs')).toBeGreaterThan(0);

    const realBefore = scalar("SELECT COUNT(*) AS c FROM accounts WHERE COALESCE(is_test,0)=0 AND record_type='customer'");
    const r = fx.resetTestData();

    expect(scalar('SELECT COUNT(*) AS c FROM key_assignments')).toBe(0);
    expect(scalar('SELECT COUNT(*) AS c FROM key_form_docs')).toBe(0);
    // All four fixtures survive — two accounts, two staff rows.
    expect(r.fixtures.client).toBeGreaterThan(0);
    expect(r.fixtures.noEmailStaff).toBeGreaterThan(0);
    expect(scalar("SELECT COUNT(*) AS c FROM accounts WHERE COALESCE(is_test,0)=1")).toBe(2);
    expect(scalar("SELECT COUNT(*) AS c FROM staff_managers WHERE COALESCE(is_test,0)=1")).toBe(2);
    // …and real data is untouched.
    expect(scalar("SELECT COUNT(*) AS c FROM accounts WHERE COALESCE(is_test,0)=0 AND record_type='customer'"))
      .toBe(realBefore);
  });

  it('reset never deletes a real assignment', async () => {
    realCustomers(1);
    const real = Object.assign({}, db.prepare("SELECT id FROM accounts WHERE COALESCE(is_test,0)=0 AND record_type='customer'").get() as any).id;
    db.prepare(
      "INSERT INTO key_assignments (account_id, account_name, assignee, status) VALUES (?, 'REAL SITE 000', 'Real Person', 'checked_out')"
    ).run(real);
    fx.resetTestData();
    expect(scalar("SELECT COUNT(*) AS c FROM key_assignments WHERE assignee='Real Person'")).toBe(1);
  });
});

describe('§4 THE FULL LOOP RUNS AGAINST THE FIXTURES', () => {
  it('check-out → form → check-in, all on test records', async () => {
    const ids = fx.seedTestFixtures();

    const out = await auth(request(app).post('/api/assignments/checkout')).send({
      account_id: ids.client, holder: 'ZZ Test Manager',
      holder_email: 'keys@citywidekeys.com', holder_type: 'employee',
      keys: [{ type: 'metal', qty: 1 }, { type: 'card', qty: 1 }],
    });
    expect(out.status).toBe(201);
    expect(out.body.key_form).toMatchObject({
      event_type: 'checkout', holder_name: 'ZZ Test Manager', total_keys: 2,
    });
    // The roster identity lands on the form header.
    expect(out.body.key_form.holder_role).toBe('AM + CCM');
    expect(out.body.key_form).not.toHaveProperty('holder_shift');

    const back = await auth(request(app).post('/api/assignments/checkin'))
      .send({ id: out.body.id, condition_on_return: 'good' });
    expect(back.status).toBe(200);
    expect(back.body.key_form.event_type).toBe('checkin');
  });

  it('transfer between the fixture staff member and the fixture IC', async () => {
    const ids = fx.seedTestFixtures();
    await auth(request(app).post('/api/assignments/checkout')).send({
      account_id: ids.client, holder: 'ZZ Test Manager',
      holder_email: 'keys@citywidekeys.com', holder_type: 'employee',
      keys: [{ type: 'metal', qty: 2 }],
    });
    const res = await auth(request(app).post('/api/assignments/transfer')).send({
      account_id: ids.client, mode: 'keys',
      from_holder: 'ZZ Test Manager', to_holder: 'ZZ TEST CONTRACTOR — Do Not Use',
      to_holder_type: 'ic', to_holder_email: 'keys@citywidekeys.com',
      keys: [{ type: 'metal', qty: 1 }],
    });
    expect(res.status).toBe(201);
    expect(res.body.key_forms.from.holder_name).toBe('ZZ Test Manager');
    expect(res.body.key_forms.to.holder_name).toBe('ZZ TEST CONTRACTOR — Do Not Use');
  });

  it('the fixture forms are findable in the Forms tab', async () => {
    const ids = fx.seedTestFixtures();
    await auth(request(app).post('/api/assignments/checkout')).send({
      account_id: ids.client, holder: 'ZZ Test Manager',
      holder_email: 'keys@citywidekeys.com', holder_type: 'employee',
      keys: [{ type: 'metal', qty: 1 }],
    });
    const res = await auth(request(app).get('/api/key-forms?search=ZZ Test'));
    expect(res.body.total).toBeGreaterThan(0);
    expect(res.body.forms[0].holder_email).toBe('keys@citywidekeys.com');
  });
});
