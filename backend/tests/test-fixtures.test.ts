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

const AM1 = 'ZZ Test AM One';
const AM2 = 'ZZ Test AM Two';
const CCM1 = 'ZZ Test CCM One';
const CCM2 = 'ZZ Test CCM Two';
const CREW = 'ZZ Test No-Email Staff';
const IC = 'ZZ TEST CONTRACTOR — Do Not Use';
const CLIENT_A = 'ZZ TEST CLIENT A — Do Not Use';
const CLIENT_B = 'ZZ TEST CLIENT B — Do Not Use';
const CLIENT_C = 'ZZ TEST CLIENT C — Do Not Use';
const MAILBOX = 'keys@citywidekeys.com';

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
  // The migration tests deliberately resurrect the pre-split fixture, and a
  // retired copy of it is still is_test=1 — so it survives the line above and
  // would follow them into every later test's counts.
  db.exec("DELETE FROM staff_managers WHERE name = 'ZZ Test Manager'");
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

describe('§1 THE NINE FIXTURES', () => {
  it('creates three clients, an IC, two AMs, two CCMs and a crew member', () => {
    for (const [bc, name, am, ccm] of [
      ['09999900001', CLIENT_A, AM1, CCM1],
      ['09999900003', CLIENT_B, AM1, CCM1],
      ['09999900004', CLIENT_C, AM2, CCM2],
    ]) {
      const c = scalarRow('SELECT * FROM accounts WHERE bc_client_number = ?', bc);
      expect(c, `client ${name}`).toMatchObject({
        ic_company_name: name, record_type: 'customer', is_test: 1,
        account_manager: am, ccm_manager: ccm,
        ic_name: IC, bc_vendor_number: '09999900002',
        lockbox_code: 'TEST', keys_yn: 1, security_app_yn: 1,
        notes: 'Test fixture — safe to check out, transfer, and reset',
      });
      // Codes stay NULL — a fixture must never carry a secret.
      expect(c.door_code_encrypted).toBeNull();
      expect(c.alarm_code_encrypted).toBeNull();
    }

    expect(scalarRow("SELECT * FROM accounts WHERE bc_vendor_number = '09999900002' AND record_type='ic'"))
      .toMatchObject({
        ic_company_name: IC, is_test: 1,
        ic_primary_contact: 'ZZ Test Contact', ic_email: MAILBOX,
      });

    for (const [name, type] of [[AM1, 'account_manager'], [AM2, 'account_manager'], [CCM1, 'ccm'], [CCM2, 'ccm']]) {
      expect(scalarRow('SELECT * FROM staff_managers WHERE name = ?', name), name).toMatchObject({
        manager_type: type, role_category: 'manager', email: MAILBOX, is_test: 1, active: 1,
      });
    }
  });

  it('gives each client the holder grid it is specified to have', () => {
    expect(scalarRow("SELECT * FROM accounts WHERE bc_client_number='09999900001'")).toMatchObject({
      am_metal: 1, am_card: 1, am_fob: 0, am_dispenser: 0,
      ccm_metal: 1, ccm_card: 0, ccm_fob: 0, ccm_dispenser: 0,
      contractor_metal: 2, contractor_card: 0, contractor_fob: 1, contractor_dispenser: 0,
      office_metal: 0, office_card: 0, office_fob: 1, office_dispenser: 1,
    });
    expect(scalarRow("SELECT * FROM accounts WHERE bc_client_number='09999900003'")).toMatchObject({
      am_metal: 1, am_card: 0, ccm_metal: 0, ccm_card: 1,
      contractor_metal: 1, contractor_fob: 0, office_fob: 0, office_dispenser: 0,
    });
    expect(scalarRow("SELECT * FROM accounts WHERE bc_client_number='09999900004'")).toMatchObject({
      am_metal: 2, am_card: 0, ccm_metal: 0, ccm_card: 0,
      contractor_metal: 0, contractor_fob: 1, office_fob: 0, office_dispenser: 0,
    });
  });

  it('the site inventory row agrees with the grid on every client', () => {
    // The failure this guards is a fixture that claims two key cards while the
    // grid holds one — a discrepancy that makes every reconciliation test lie.
    for (const bc of ['09999900001', '09999900003', '09999900004']) {
      const c = scalarRow('SELECT * FROM accounts WHERE bc_client_number = ?', bc);
      for (const [total, cell] of [
        ['metal_keys', 'metal'], ['key_cards', 'card'],
        ['has_fob', 'fob'], ['dispenser_keys', 'dispenser'],
      ]) {
        const summed = ['am', 'ccm', 'contractor', 'office']
          .reduce((n, h) => n + Number(c[`${h}_${cell}`] ?? 0), 0);
        expect(Number(c[total]), `${bc}.${total}`).toBe(summed);
      }
      expect(Number(c.am_keys), `${bc}.am_keys`).toBe(
        c.am_metal + c.am_card + c.am_fob + c.am_dispenser);
      expect(Number(c.ccm_keys), `${bc}.ccm_keys`).toBe(
        c.ccm_metal + c.ccm_card + c.ccm_fob + c.ccm_dispenser);
      expect(Number(c.contractor_keys), `${bc}.contractor_keys`).toBe(
        c.contractor_metal + c.contractor_card + c.contractor_fob + c.contractor_dispenser);
      expect(Number(c.office_keys_held), `${bc}.office_keys_held`).toBe(
        c.office_metal + c.office_card + c.office_fob + c.office_dispenser);
    }
  });

  it('splits the client book 2/1 so a reassignment has something to move', () => {
const book = (col: string, name: string) =>
      scalar(`SELECT COUNT(*) AS c FROM accounts WHERE record_type='customer' AND ${col} = ?`, name);
    expect(book('account_manager', AM1)).toBe(2);
    expect(book('account_manager', AM2)).toBe(1);
    // CCM is its own axis: CCM One holds the same two, CCM Two the third.
    expect(book('ccm_manager', CCM1)).toBe(2);
    expect(book('ccm_manager', CCM2)).toBe(1);
  });

  it('is IDEMPOTENT — seeding again creates nothing', () => {
    const before = scalar('SELECT COUNT(*) AS c FROM accounts');
    const beforeStaff = scalar('SELECT COUNT(*) AS c FROM staff_managers');
    const again = fx.seedTestFixtures();
    expect(again.created).toEqual([]);
    expect(again.existing.sort()).toEqual(
      ['AM One', 'AM Two', 'CCM One', 'CCM Two', 'client A', 'client B', 'client C', 'ic', 'no-email staff']
    );
    expect(again.migrated).toEqual([]);
    expect(scalar('SELECT COUNT(*) AS c FROM accounts')).toBe(before);
    expect(scalar('SELECT COUNT(*) AS c FROM staff_managers')).toBe(beforeStaff);
  });

  it('every contact points at the operator inbox, never a real person', () => {
    const emails = (db.prepare(
      'SELECT email AS e FROM staff_managers WHERE COALESCE(is_test,0)=1 AND email IS NOT NULL'
    ).all() as any[]).map((r) => Object.assign({}, r).e);
    const icEmail = scalarRow("SELECT ic_email AS e FROM accounts WHERE bc_vendor_number='09999900002'").e;
    expect([...emails, icEmail].every((e) => e === MAILBOX)).toBe(true);
    expect(emails).toHaveLength(4);   // the four managers; crew has none
  });

  it('a hollowed-out row is refilled by the next seed', () => {
    const ids = fx.seedTestFixtures();
    db.prepare(
      'UPDATE accounts SET security_app_yn = 0, notes = NULL, metal_keys = 0, am_metal = 0, ' +
      'account_manager = NULL, ccm_manager = NULL WHERE id = ?'
    ).run(ids.clients.a);
    fx.seedTestFixtures();
    expect(scalarRow(
      'SELECT security_app_yn, notes, metal_keys, am_metal, account_manager, ccm_manager FROM accounts WHERE id = ?',
      ids.clients.a,
    )).toMatchObject({
      security_app_yn: 1, metal_keys: 4, am_metal: 1,
      account_manager: AM1, ccm_manager: CCM1,
      notes: 'Test fixture — safe to check out, transfer, and reset',
    });
  });
});

describe('§1a MIGRATION OFF THE SINGLE-MANAGER FIXTURE', () => {
  /** Put the database back the way it looked before the split. */
  const rewind = () => {
    db.exec(`DELETE FROM staff_managers WHERE name IN ('${AM1}','${AM2}','${CCM1}','${CCM2}')`);
    db.prepare(
      "INSERT INTO staff_managers (name, manager_type, role_category, email, active, is_test) " +
      "VALUES ('ZZ Test Manager', 'both', 'manager', ?, 1, 1)"
    ).run(MAILBOX);
    db.exec("UPDATE accounts SET account_manager='ZZ Test Manager', ccm_manager='ZZ Test Manager' WHERE COALESCE(is_test,0)=1");
  };

  it('renames the old row rather than leaving it orphaned beside a new one', () => {
    rewind();
    const oldId = scalarRow("SELECT id FROM staff_managers WHERE name='ZZ Test Manager'").id;

    const r = fx.seedTestFixtures();

    expect(scalarRow("SELECT id FROM staff_managers WHERE name='ZZ Test Manager'")).toBeNull();
    // The SAME row, renamed — not a new person with the old one left behind.
    expect(r.staff.amOne).toBe(oldId);
    expect(scalarRow('SELECT * FROM staff_managers WHERE id = ?', oldId)).toMatchObject({
      name: AM1, manager_type: 'account_manager', role_category: 'manager', active: 1, is_test: 1,
    });
    expect(r.migrated.join(' ')).toMatch(/renamed 'ZZ Test Manager' → 'ZZ Test AM One'/);
  });

  it('moves the AM link to AM One and the CCM link to CCM One', () => {
    rewind();
    fx.seedTestFixtures();
    expect(scalar("SELECT COUNT(*) AS c FROM accounts WHERE record_type='customer' AND account_manager='ZZ Test Manager'")).toBe(0);
    expect(scalar("SELECT COUNT(*) AS c FROM accounts WHERE record_type='customer' AND ccm_manager='ZZ Test Manager'")).toBe(0);
    // Client A and B end up where the spec puts them; C is re-linked to AM Two
    // by the ordinary repair path.
    expect(scalarRow("SELECT account_manager AS am, ccm_manager AS ccm FROM accounts WHERE bc_client_number='09999900001'"))
      .toMatchObject({ am: AM1, ccm: CCM1 });
  });

  it('custody history follows the person instead of pointing at a name nobody has', async () => {
    rewind();
    const clientId = scalarRow("SELECT id FROM accounts WHERE bc_client_number='09999900001'").id;
    await auth(request(app).post('/api/assignments/checkout')).send({
      account_id: clientId, holder: 'ZZ Test Manager', holder_email: MAILBOX,
      holder_type: 'employee', keys: [{ type: 'metal', qty: 1 }],
    });
    expect(scalar("SELECT COUNT(*) AS c FROM key_assignments WHERE assignee='ZZ Test Manager'")).toBe(1);

    fx.seedTestFixtures();

    expect(scalar("SELECT COUNT(*) AS c FROM key_assignments WHERE assignee='ZZ Test Manager'")).toBe(0);
    expect(scalar('SELECT COUNT(*) AS c FROM key_assignments WHERE assignee = ?', AM1)).toBe(1);
    expect(scalar('SELECT COUNT(*) AS c FROM key_form_docs WHERE holder_name = ?', AM1)).toBe(1);
  });

  it('retires — never deletes — a legacy row when AM One already exists', () => {
    db.prepare(
      "INSERT INTO staff_managers (name, manager_type, role_category, email, active, is_test) " +
      "VALUES ('ZZ Test Manager', 'both', 'manager', ?, 1, 1)"
    ).run(MAILBOX);
    const r = fx.seedTestFixtures();
    const legacy = scalarRow("SELECT * FROM staff_managers WHERE name='ZZ Test Manager'");
    // Still there (nothing is deleted) but off every roster and picker.
    expect(legacy).toMatchObject({ active: 0, is_test: 1 });
    expect(r.migrated.join(' ')).toMatch(/retired duplicate/);
  });

  it('never rewrites a real record that happens to share the name', () => {
    db.prepare(
      "INSERT INTO accounts (ic_company_name, bc_client_number, record_type, status, archived, is_test, account_manager) " +
      "VALUES ('REAL SITE X','01014299999','customer','active',0,0,'ZZ Test Manager')"
    ).run();
    fx.seedTestFixtures();
    // The migration is scoped to is_test rows: a real client keeps its value,
    // wrong as it may be, because guessing on real data is worse.
    expect(scalarRow("SELECT account_manager AS am FROM accounts WHERE bc_client_number='01014299999'").am)
      .toBe('ZZ Test Manager');
  });
});

describe('§1b THE NO-EMAIL FIXTURE — the failure path needs a subject', () => {
  it('exists as crew with no address, flagged is_test', () => {
    expect(scalarRow(
      'SELECT name, email, role_category, active, COALESCE(is_test,0) AS is_test ' +
      'FROM staff_managers WHERE name = ?', CREW,
    )).toMatchObject({ role_category: 'crew', email: null, active: 1, is_test: 1 });
  });

  it('an address filled in by mistake is put back on the next seed', () => {
    db.prepare("UPDATE staff_managers SET email = 'oops@example.test' WHERE name = ?").run(CREW);
    fx.seedTestFixtures();
    // Otherwise a well-meaning edit silently removes the only way to test the
    // "no address on file" path.
    expect(scalarRow('SELECT email FROM staff_managers WHERE name = ?', CREW).email).toBeNull();
  });

  it('checking out to them hits the missing-email gate', async () => {
    const ids = fx.seedTestFixtures();
    const res = await auth(request(app).post('/api/assignments/checkout')).send({
      account_id: ids.clients.a, holder: CREW,
      holder_type: 'employee', keys: [{ type: 'metal', qty: 1 }],
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('HOLDER_EMAIL_MISSING');

    // …and goes through once a reason is given, flagged as unsigned.
    const forced = await auth(request(app).post('/api/assignments/checkout')).send({
      account_id: ids.clients.a, holder: CREW,
      holder_type: 'employee', keys: [{ type: 'metal', qty: 1 }],
      no_email_reason: 'Testing the red-flag path',
    });
    expect(forced.status).toBe(201);
    expect(forced.body.signature_status).toBe('signature_unavailable');
  });
});

describe('§1d /api/_diag REPORTS THE FIXTURES', () => {
  it('reports all nine present, with the identifying fields', async () => {
    fx.seedTestFixtures();
    const res = await auth(request(app).get('/api/_diag'));
    expect(res.status).toBe(200);
    expect(res.body.test_fixtures).toMatchObject({
      expected: 9, present: 9, complete: true,
      expected_contact: MAILBOX,
      is_test_column: { accounts: true, staff_managers: true },
    });
    expect(res.body.test_fixtures.records.clients.a).toMatchObject({
      name: CLIENT_A, is_test: 1, account_manager: AM1, ccm_manager: CCM1,
      ic_name: IC, bc_vendor_number: '09999900002', lockbox_code: 'TEST',
    });
    expect(res.body.test_fixtures.records.clients.c).toMatchObject({
      name: CLIENT_C, account_manager: AM2, ccm_manager: CCM2,
    });
    // Every grid is populated, so there is something to move.
    for (const k of ['a', 'b', 'c']) {
      expect(res.body.test_fixtures.records.clients[k].grid_total).toBeGreaterThan(0);
    }
    expect(res.body.test_fixtures.records.staff[CREW]).toMatchObject({ email: null, is_test: 1 });
    // The split is visible from production without opening the registry.
    expect(res.body.test_fixtures.am_client_split[AM1]).toBe(2);
    expect(res.body.test_fixtures.am_client_split[AM2]).toBe(1);
    expect(res.body.test_fixtures.legacy_manager).toBeNull();
  });

  it('separates real customers from the count including fixtures', async () => {
    realCustomers(5);
    const res = await auth(request(app).get('/api/_diag'));
    expect(res.body.test_fixtures.real_customers).toBe(5);
    expect(res.body.test_fixtures.customers_including_test).toBe(8);
  });

  it('says so when a fixture is missing', async () => {
    db.prepare('DELETE FROM staff_managers WHERE name = ?').run(CREW);
    const res = await auth(request(app).get('/api/_diag'));
    expect(res.body.test_fixtures).toMatchObject({ present: 8, complete: false });
    expect(res.body.test_fixtures.records.staff[CREW]).toBeNull();
  });
});

describe('§3 THE RESET BUTTON', () => {
  it('wipes test activity, re-seeds, and reports the real count unmoved', async () => {
    realCustomers(6);
    const ids = fx.seedTestFixtures();
    await auth(request(app).post('/api/assignments/checkout')).send({
      account_id: ids.clients.a, holder: AM1,
      holder_email: MAILBOX, holder_type: 'employee',
      keys: [{ type: 'metal', qty: 1 }],
    });

    const res = await auth(request(app).post('/api/settings/test-data/reset')).send({ confirm: 'RESET' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.real_customers).toMatchObject({ before: 6, after: 6, unchanged: true });
    expect(res.body.deleted.assignments).toBeGreaterThan(0);
    expect(res.body.fixtures.staff.noEmail).toBeGreaterThan(0);
    expect(scalar('SELECT COUNT(*) AS c FROM key_assignments')).toBe(0);
    // The fixtures are back, not merely deleted: three clients + one IC.
    expect(scalar("SELECT COUNT(*) AS c FROM accounts WHERE COALESCE(is_test,0)=1")).toBe(4);
  });

  it('puts a reassigned client book back where it started', async () => {
    fx.seedTestFixtures();
    // A reassignment test moves AM One's book to AM Two…
    db.prepare("UPDATE accounts SET account_manager = ? WHERE account_manager = ? AND record_type='customer'").run(AM2, AM1);
    expect(scalar("SELECT COUNT(*) AS c FROM accounts WHERE record_type='customer' AND account_manager = ?", AM2)).toBe(3);

    const res = await auth(request(app).post('/api/settings/test-data/reset')).send({ confirm: 'RESET' });
    expect(res.status).toBe(200);
    // …and the reset restores the 2/1 split, so the next run starts identically.
    expect(scalar("SELECT COUNT(*) AS c FROM accounts WHERE record_type='customer' AND account_manager = ?", AM1)).toBe(2);
    expect(scalar("SELECT COUNT(*) AS c FROM accounts WHERE record_type='customer' AND account_manager = ?", AM2)).toBe(1);
  });

  it('refuses to run without the typed confirmation', async () => {
    const ids = fx.seedTestFixtures();
    await auth(request(app).post('/api/assignments/checkout')).send({
      account_id: ids.clients.a, holder: AM1,
      holder_email: MAILBOX, holder_type: 'employee',
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
    ).run(ids.clients.a);

    const res = await auth(request(app).post('/api/settings/test-data/seed')).send({});
    expect(res.status).toBe(200);
    expect(scalarRow(
      'SELECT am_metal, am_card, contractor_metal, lockbox_code, account_manager, ic_name FROM accounts WHERE id = ?',
      ids.clients.a,
    )).toMatchObject({
      am_metal: 1, am_card: 1, contractor_metal: 2, lockbox_code: 'TEST',
      account_manager: AM1, ic_name: IC,
    });
  });
});

describe('§2 ISOLATION — fixtures never pollute real numbers', () => {
  it('the customer count is unchanged by the three fixture clients', async () => {
    realCustomers(577);
    const res = await auth(request(app).get('/api/accounts?type=customer&limit=1'));
    // 577 real, not 580 — the fixtures are in the table but not in the count.
    expect(res.body.total).toBe(577);
    expect(scalar("SELECT COUNT(*) AS c FROM accounts WHERE record_type='customer'")).toBe(580);
  });

  it('the IC count is unchanged by the fixture', async () => {
    db.prepare("INSERT INTO accounts (ic_company_name, bc_vendor_number, record_type, is_test) VALUES ('REAL IC','02014100001','ic',0)").run();
    const res = await auth(request(app).get('/api/accounts?type=ic&limit=1'));
    expect(res.body.total).toBe(1);
  });

  it('registry rows exclude the fixtures unless include_test=1', async () => {
    realCustomers(3);
    const off = await auth(request(app).get('/api/accounts?type=customer&limit=100'));
    expect(off.body.accounts.some((a: any) => a.is_test === 1)).toBe(false);

    const on = await auth(request(app).get('/api/accounts?type=customer&limit=100&include_test=1'));
    expect(on.body.accounts.some((a: any) => a.is_test === 1)).toBe(true);
    expect(on.body.total).toBe(off.body.total + 3);
  });

  it('select-all-matching cannot sweep up a fixture', async () => {
    realCustomers(5);
    const res = await auth(request(app).get('/api/accounts/ids?type=customer'));
    expect(res.body.total).toBe(5);
    expect(res.body.items.some((i: any) => /ZZ TEST/.test(i.ic_company_name))).toBe(false);
  });

  it('roster aggregates exclude the fixture clients and managers', async () => {
    realCustomers(2);
    db.prepare("UPDATE accounts SET account_manager='Real Manager' WHERE COALESCE(is_test,0)=0 AND record_type='customer'").run();
    db.prepare("INSERT INTO staff_managers (name, manager_type, role_category, active, is_test) VALUES ('Real Manager','account_manager','manager',1,0)").run();

    const res = await auth(request(app).get('/api/staff-managers/roster?role=am'));
    const names = res.body.managers.map((m: any) => m.name);
    expect(names).toContain('Real Manager');
    expect(names).not.toContain(AM1);
    expect(names).not.toContain(AM2);
    // …and no test client is in anyone's managed inventory.
    const real = res.body.managers.find((m: any) => m.name === 'Real Manager');
    expect(real.clients_managed).toBe(2);
  });

  it('the AM roster endpoint excludes the fixture managers', async () => {
    const res = await auth(request(app).get('/api/managers/account-managers'));
    expect(res.body.managers.some((m: any) => /ZZ Test/.test(m.person ?? ''))).toBe(false);
  });

  it('the dashboard key-holder totals ignore the fixture grids', async () => {
    realCustomers(3);
    // Every real site here has an empty holder grid, so anything non-zero
    // could only have come from a fixture.
    const res = await auth(request(app).get('/api/accounts/key-holder-stats'));
    expect(res.body).toMatchObject({
      am_personal: 0, ccm_personal: 0, ic_personal: 0, office_personal: 0,
    });
  });

  it('the staff roster excludes the fixtures unless include_test is set', async () => {
    db.prepare("INSERT INTO staff_managers (name, manager_type, role_category, active, is_test) VALUES ('Real Person','ccm','manager',1,0)").run();
    const off = await auth(request(app).get('/api/staff'));
    expect(off.body.map((s: any) => s.name)).toEqual(['Real Person']);

    const on = await auth(request(app).get('/api/staff?include_test=1'));
    expect(on.body.map((s: any) => s.name).sort())
      .toEqual(['Real Person', AM1, AM2, CCM1, CCM2, CREW].sort());
  });

  it('a fixture check-out stays out of the active-custody count', async () => {
    realCustomers(1);
    const realId = scalarRow(
      "SELECT id FROM accounts WHERE COALESCE(is_test,0)=0 AND record_type='customer'"
    ).id as number;
    db.prepare("INSERT INTO staff_managers (name, manager_type, role_category, email, active, is_test) VALUES ('Real Person','ccm','manager','real@example.com',1,0)").run();

    const ids = fx.seedTestFixtures();
    await auth(request(app).post('/api/assignments/checkout')).send({
      account_id: ids.clients.a, holder: AM1,
      holder_email: MAILBOX, holder_type: 'employee',
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

  it('exports exclude the fixtures by default and include them on request', async () => {
    realCustomers(2);
    const off = await auth(request(app).post('/api/exports/registry'))
      .send({ scope: 'current', tab: 'customer', format: 'csv' });
    expect(off.text ?? off.body.toString()).not.toMatch(/ZZ TEST CLIENT/);

    const on = await auth(request(app).post('/api/exports/registry'))
      .send({ scope: 'current', tab: 'customer', format: 'csv', includeTest: true });
    const text = on.text ?? on.body.toString();
    for (const n of [CLIENT_A, CLIENT_B, CLIENT_C]) expect(text).toContain(n);
  });
});

describe('§2a THE ROSTER TABS SHOW THE FIXTURES WHEN ASKED', () => {
  it('include_test=1 puts both test AMs on the AM tab with their own totals', async () => {
    realCustomers(2);
    const res = await auth(request(app).get('/api/staff-managers/roster?role=am&include_test=1'));
    const by = (n: string) => res.body.managers.find((m: any) => m.name === n);

    expect(by(AM1)).toMatchObject({ is_test: 1, clients_managed: 2 });
    expect(by(AM2)).toMatchObject({ is_test: 1, clients_managed: 1 });
    // AM One: client A (1 metal + 1 card) + client B (1 metal).
    expect(by(AM1)).toMatchObject({ personal_metal: 2, personal_cards: 1, total_held: 3 });
    // AM Two: client C, 2 metal.
    expect(by(AM2)).toMatchObject({ personal_metal: 2, personal_cards: 0, total_held: 2 });
  });

  it('the CCM tab is a separate axis, not a copy of the AM tab', async () => {
    const res = await auth(request(app).get('/api/staff-managers/roster?role=ccm&include_test=1'));
    const by = (n: string) => res.body.managers.find((m: any) => m.name === n);
    expect(by(CCM1)).toMatchObject({ clients_managed: 2, personal_metal: 1, personal_cards: 1 });
    expect(by(CCM2)).toMatchObject({ clients_managed: 1, total_held: 0 });
    // The AMs are not on the CCM tab at all.
    expect(res.body.managers.some((m: any) => m.name === AM1)).toBe(false);
  });

  it('a real manager never picks up fixture keys, whichever way the tab is asked', async () => {
    realCustomers(2);
    db.prepare("UPDATE accounts SET account_manager='Real Manager', am_metal=5 WHERE COALESCE(is_test,0)=0 AND record_type='customer'").run();
    db.prepare("INSERT INTO staff_managers (name, manager_type, role_category, active, is_test) VALUES ('Real Manager','account_manager','manager',1,0)").run();

    for (const q of ['role=am', 'role=am&include_test=1']) {
      const res = await auth(request(app).get(`/api/staff-managers/roster?${q}`));
      const real = res.body.managers.find((m: any) => m.name === 'Real Manager');
      expect(real, q).toMatchObject({ is_test: 0, clients_managed: 2, personal_metal: 10 });
    }
  });

  it('a bulk AM reassignment moves a real book and both rows change', async () => {
    const before = await auth(request(app).get('/api/staff-managers/roster?role=am&include_test=1'));
    const b = (r: any, n: string) => r.body.managers.find((m: any) => m.name === n);
    expect(b(before, AM1).clients_managed).toBe(2);

    const ids = fx.seedTestFixtures();
    const eligible = await auth(request(app).get(`/api/managers/${ids.staff.amOne}/reassignable?role=am`));
    expect(eligible.status).toBe(200);
    expect(eligible.body.clients).toHaveLength(2);

    const res = await auth(request(app).post('/api/managers/reassign')).send({
      fromId: ids.staff.amOne, toId: ids.staff.amTwo, role: 'am',
      clientIds: eligible.body.clients.map((c: any) => c.id),
      sendHandover: false,
    });
    expect(res.status).toBe(200);

    const after = await auth(request(app).get('/api/staff-managers/roster?role=am&include_test=1'));
    expect(b(after, AM1).clients_managed).toBe(0);
    expect(b(after, AM2).clients_managed).toBe(3);
    // The CCM axis is untouched — that is the whole point of two of each.
    const ccm = await auth(request(app).get('/api/staff-managers/roster?role=ccm&include_test=1'));
    expect(b(ccm, CCM1).clients_managed).toBe(2);
  });
});

describe('§3 SAFETY RAILS', () => {
  it('a fixture cannot be archived through the normal flow', async () => {
    const id = fx.seedTestFixtures().clients.a;
    const res = await auth(request(app).post(`/api/accounts/${id}/archive`)).send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('TEST_FIXTURE_PROTECTED');
    expect(scalarRow('SELECT archived FROM accounts WHERE id=?', id)).toMatchObject({ archived: 0 });
  });

  it('a fixture cannot be purged through the normal flow', async () => {
    const id = fx.seedTestFixtures().clients.b;
    const res = await auth(request(app).delete(`/api/accounts/${id}`)).send({ confirm: CLIENT_B });
    expect(res.status).toBe(409);
    expect(scalar('SELECT COUNT(*) AS c FROM accounts WHERE id=?', id)).toBe(1);
  });

  it('bulk archive names a fixture back instead of archiving it', async () => {
    realCustomers(1);
    const real = scalarRow("SELECT id FROM accounts WHERE COALESCE(is_test,0)=0 AND record_type='customer'").id;
    const ids = fx.seedTestFixtures();
    const res = await auth(request(app).post('/api/accounts/bulk-archive'))
      .send({ ids: [real, ids.clients.a, ids.clients.c] });
    expect(res.body.archived).toBe(1);
    expect(res.body.blocked.filter((b: any) => b.reason === 'test_fixture')).toHaveLength(2);
    expect(scalarRow('SELECT archived FROM accounts WHERE id=?', ids.clients.a)).toMatchObject({ archived: 0 });
  });

  it('audit entries touching a fixture carry test_action', async () => {
    const ids = fx.seedTestFixtures();
    await auth(request(app).post('/api/assignments/checkout')).send({
      account_id: ids.clients.a, holder: AM1,
      holder_email: MAILBOX, holder_type: 'employee',
      keys: [{ type: 'metal', qty: 1 }],
    });
    const meta = JSON.parse(scalarRow(
      "SELECT metadata FROM audit_log WHERE action='key_checked_out' ORDER BY id DESC LIMIT 1"
    ).metadata);
    expect(meta.test_action).toBe(true);
  });

  it('reset wipes test activity, keeps the fixtures, and leaves real data alone', async () => {
    realCustomers(4);
    const ids = fx.seedTestFixtures();
    await auth(request(app).post('/api/assignments/checkout')).send({
      account_id: ids.clients.b, holder: CCM1,
      holder_email: MAILBOX, holder_type: 'employee',
      keys: [{ type: 'metal', qty: 1 }],
    });
    expect(scalar('SELECT COUNT(*) AS c FROM key_assignments')).toBeGreaterThan(0);
    expect(scalar('SELECT COUNT(*) AS c FROM key_form_docs')).toBeGreaterThan(0);

    const realBefore = scalar("SELECT COUNT(*) AS c FROM accounts WHERE COALESCE(is_test,0)=0 AND record_type='customer'");
    const r = fx.resetTestData();

    expect(scalar('SELECT COUNT(*) AS c FROM key_assignments')).toBe(0);
    expect(scalar('SELECT COUNT(*) AS c FROM key_form_docs')).toBe(0);
    // All nine survive — four accounts, five staff rows.
    expect(Object.values(r.fixtures.clients).every((v) => v > 0)).toBe(true);
    expect(Object.values(r.fixtures.staff).every((v) => v > 0)).toBe(true);
    expect(scalar("SELECT COUNT(*) AS c FROM accounts WHERE COALESCE(is_test,0)=1")).toBe(4);
    expect(scalar("SELECT COUNT(*) AS c FROM staff_managers WHERE COALESCE(is_test,0)=1")).toBe(5);
    // …and real data is untouched.
    expect(scalar("SELECT COUNT(*) AS c FROM accounts WHERE COALESCE(is_test,0)=0 AND record_type='customer'"))
      .toBe(realBefore);
  });

  it('reset never deletes a real assignment', async () => {
    realCustomers(1);
    const real = scalarRow("SELECT id FROM accounts WHERE COALESCE(is_test,0)=0 AND record_type='customer'").id;
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
      account_id: ids.clients.a, holder: AM1,
      holder_email: MAILBOX, holder_type: 'employee',
      keys: [{ type: 'metal', qty: 1 }, { type: 'card', qty: 1 }],
    });
    expect(out.status).toBe(201);
    // total_keys is the holder's WHOLE position, not just what this event
    // moved: AM One's standing grid attribution (3 keys across clients A and
    // B) plus the 2 just checked out.
    expect(out.body.key_form).toMatchObject({
      event_type: 'checkout', holder_name: AM1, total_keys: 5,
    });
    // The roster identity lands on the form header — and it is now specific.
    expect(out.body.key_form.holder_role).toBe('AM');
    expect(out.body.key_form).not.toHaveProperty('holder_shift');

    const back = await auth(request(app).post('/api/assignments/checkin'))
      .send({ id: out.body.id, condition_on_return: 'good' });
    expect(back.status).toBe(200);
    expect(back.body.key_form.event_type).toBe('checkin');
  });

  it('a CCM check-out is labelled CCM, not AM', async () => {
    const ids = fx.seedTestFixtures();
    const out = await auth(request(app).post('/api/assignments/checkout')).send({
      account_id: ids.clients.b, holder: CCM2,
      holder_email: MAILBOX, holder_type: 'employee',
      keys: [{ type: 'card', qty: 1 }],
    });
    expect(out.status).toBe(201);
    expect(out.body.key_form.holder_role).toBe('CCM');
  });

  it('transfer between the two test AMs, and from an AM to the IC', async () => {
    const ids = fx.seedTestFixtures();
    await auth(request(app).post('/api/assignments/checkout')).send({
      account_id: ids.clients.a, holder: AM1,
      holder_email: MAILBOX, holder_type: 'employee',
      keys: [{ type: 'metal', qty: 2 }],
    });

    // AM → AM: the case a single manager fixture could not express at all.
    const between = await auth(request(app).post('/api/assignments/transfer')).send({
      account_id: ids.clients.a, mode: 'keys',
      from_holder: AM1, to_holder: AM2,
      to_holder_type: 'employee', to_holder_email: MAILBOX,
      keys: [{ type: 'metal', qty: 1 }],
    });
    expect(between.status).toBe(201);
    expect(between.body.key_forms.from.holder_name).toBe(AM1);
    expect(between.body.key_forms.to.holder_name).toBe(AM2);

    // AM → IC, across holder types.
    const toIc = await auth(request(app).post('/api/assignments/transfer')).send({
      account_id: ids.clients.a, mode: 'keys',
      from_holder: AM1, to_holder: IC,
      to_holder_type: 'ic', to_holder_email: MAILBOX,
      keys: [{ type: 'metal', qty: 1 }],
    });
    expect(toIc.status).toBe(201);
    expect(toIc.body.key_forms.to.holder_name).toBe(IC);
  });

  it('one holder can carry keys from more than one client', async () => {
    const ids = fx.seedTestFixtures();
    for (const id of [ids.clients.a, ids.clients.b]) {
      const r = await auth(request(app).post('/api/assignments/checkout')).send({
        account_id: id, holder: AM1, holder_email: MAILBOX,
        holder_type: 'employee', keys: [{ type: 'metal', qty: 1 }],
      });
      expect(r.status).toBe(201);
    }
    const res = await auth(request(app).get('/api/assignments?status=checked_out&include_test=1&limit=50'));
    const mine = res.body.assignments.filter((a: any) => a.assignee === AM1);
    expect(mine).toHaveLength(2);
    expect(new Set(mine.map((a: any) => a.account_name)).size).toBe(2);
  });

  it('the fixture forms are findable in the Forms tab', async () => {
    const ids = fx.seedTestFixtures();
    await auth(request(app).post('/api/assignments/checkout')).send({
      account_id: ids.clients.a, holder: AM1,
      holder_email: MAILBOX, holder_type: 'employee',
      keys: [{ type: 'metal', qty: 1 }],
    });
    const res = await auth(request(app).get('/api/key-forms?search=ZZ Test'));
    expect(res.body.total).toBeGreaterThan(0);
    expect(res.body.forms[0].holder_email).toBe(MAILBOX);
  });
});
