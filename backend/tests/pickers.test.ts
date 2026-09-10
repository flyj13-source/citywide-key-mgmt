import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

// ── The pickers ──────────────────────────────────────────────────────────────
// Check Out / Check In / Transfer all choose from the SAME two lists: every
// non-archived account, and every possible holder. The failure this file
// guards is the one that prompted the work — a picker that silently showed a
// filtered subset, so half the registry could not be acted on at all.

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'citywide-pickers-'));
process.env.CITYWIDE_DB_DIR = TEST_DIR;
delete process.env.DB_PATH;
process.env.JWT_SECRET = 'test-secret';
process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
process.env.SEED_PASSWORD = 'demo1234';
delete process.env.SMTP_USER;
delete process.env.SMTP_PASS;

const DB_FILE = path.join(TEST_DIR, 'citywide.db');
let app: Express;
let token: string;
let db: DatabaseSync;

const auth = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);
const obj = (r: any) => (r ? Object.assign({}, r) : null);

beforeAll(async () => {
  app = (await import('../src/index')).default;
  (await import('../src/lib/autoSeed')).autoSeedIfEmpty();
  const login = await request(app).post('/api/auth/login')
    .send({ email: 'cara@citywideboston.com', password: 'demo1234' });
  token = login.body.token;
  db = new DatabaseSync(DB_FILE);
});

beforeEach(() => {
  db.exec('DELETE FROM key_assignments');
  db.exec('DELETE FROM key_form_docs');
  db.exec("DELETE FROM accounts WHERE COALESCE(is_test,0)=0");
  db.exec("DELETE FROM staff_managers WHERE COALESCE(is_test,0)=0");
});

/** N customers and M IC vendors, at realistic scale. */
const seed = (customers: number, ics: number) => {
  for (let i = 0; i < customers; i++) {
    db.prepare(
      "INSERT INTO accounts (ic_company_name, bc_client_number, record_type, status, archived, is_test, metal_keys)" +
      " VALUES (?,?,'customer','active',0,0,3)"
    ).run(`REAL SITE ${String(i).padStart(3, '0')}`, `010141${String(i).padStart(5, '0')}`);
  }
  for (let i = 0; i < ics; i++) {
    db.prepare(
      "INSERT INTO accounts (ic_company_name, bc_vendor_number, ic_primary_contact, ic_email, record_type, archived, is_test)" +
      " VALUES (?,?,?,?,'ic',0,0)"
    ).run(`AFC CLEANING ${String(i).padStart(2, '0')}`, `020141${String(i).padStart(5, '0')}`,
      `Contact ${i}`, i === 0 ? null : `ic${i}@example.com`);
  }
};

describe('§1 THE ACCOUNT PICKER LISTS EVERYTHING', () => {
  it('returns customers AND IC vendors, in separate groups', async () => {
    seed(20, 6);
    const res = await auth(request(app).get('/api/accounts/options'));
    expect(res.status).toBe(200);
    expect(res.body.customers.length).toBeGreaterThan(0);
    expect(res.body.ics.length).toBeGreaterThan(0);
    // Neither group leaks into the other — the headers have to mean something.
    expect(res.body.customers.every((c: any) => c.record_type === 'customer')).toBe(true);
    expect(res.body.ics.every((c: any) => c.record_type === 'ic')).toBe(true);
  });

  it('the empty query is a browsable list, not an empty one', async () => {
    seed(30, 5);
    // The old picker returned nothing until you guessed a name. Opening the
    // dropdown has to show records.
    const res = await auth(request(app).get('/api/accounts/options'));
    expect(res.body.customers.length).toBeGreaterThan(0);
    expect(res.body.ics.length).toBeGreaterThan(0);
  });

  it('caps each group SEPARATELY so customers cannot crowd out IC vendors', async () => {
    seed(577, 12);
    const res = await auth(request(app).get('/api/accounts/options'));
    expect(res.body.customers).toHaveLength(40);
    // The whole point of a per-group cap: 577 customers, and every IC vendor
    // still on the list.
    expect(res.body.ics.length).toBeGreaterThanOrEqual(12);
    // 577 real + the 3 fixtures: this endpoint includes them on purpose, and
    // is the one place that number is not a count anybody would quote.
    expect(res.body.totals.customers).toBe(580);
    expect(res.body.truncated).toBe(true);
  });

  it('never renders the whole registry — the payload is bounded', async () => {
    seed(577, 30);
    const res = await auth(request(app).get('/api/accounts/options'));
    const rows = res.body.customers.length + res.body.ics.length;
    expect(rows).toBeLessThanOrEqual(80);
    // And it is small: a picker row is four fields, not a whole account.
    expect(Object.keys(res.body.customers[0]).sort())
      .toEqual(['ic_name', 'id', 'is_test', 'name', 'number', 'record_type']);
  });

  it('carries no access code, encrypted or otherwise', async () => {
    seed(5, 2);
    const res = await auth(request(app).get('/api/accounts/options'));
    const text = JSON.stringify(res.body);
    for (const forbidden of ['door_code', 'alarm_code', 'lockbox']) {
      expect(text).not.toContain(forbidden);
    }
  });

  it('searches name AND number at once', async () => {
    seed(577, 10);
    // By name…
    const byName = await auth(request(app).get('/api/accounts/options?search=AFC'));
    expect(byName.body.ics.length).toBeGreaterThan(0);
    expect(byName.body.ics.every((r: any) => /AFC/i.test(r.name))).toBe(true);

    // …and by number, with the same endpoint and the same box.
    const byNumber = await auth(request(app).get('/api/accounts/options?search=0101410000'));
    expect(byNumber.body.customers.length).toBeGreaterThan(0);
    expect(byNumber.body.customers.every((r: any) => String(r.number).includes('0101410000'))).toBe(true);

    // A vendor number finds the vendor.
    const byVendor = await auth(request(app).get('/api/accounts/options?search=02014100003'));
    expect(byVendor.body.ics.map((r: any) => r.number)).toContain('02014100003');
  });

  it('shows each record the number that means something for its type', async () => {
    seed(3, 3);
    const res = await auth(request(app).get('/api/accounts/options'));
    expect(res.body.customers[0].number).toMatch(/^010141/);   // BC client #
    expect(res.body.ics[0].number).toMatch(/^020141/);         // BC vendor #
  });

  it('excludes archived records', async () => {
    seed(4, 2);
    db.exec("UPDATE accounts SET archived = 1 WHERE ic_company_name = 'REAL SITE 001'");
    const res = await auth(request(app).get('/api/accounts/options'));
    const names = res.body.customers.map((r: any) => r.name);
    expect(names).not.toContain('REAL SITE 001');
    expect(names).toContain('REAL SITE 002');
  });

  it('includes the test fixtures, flagged, and never first', async () => {
    seed(5, 2);
    const res = await auth(request(app).get('/api/accounts/options'));
    const test = res.body.customers.filter((r: any) => r.is_test === 1);
    // Reachable — a fixture nobody can select is not a fixture.
    expect(test.length).toBe(3);
    expect(test.every((r: any) => /ZZ TEST/.test(r.name))).toBe(true);
    // …but never the first thing under the cursor on real work.
    expect(res.body.customers[0].is_test).toBe(0);
  });

  it('is behind auth', async () => {
    const res = await request(app).get('/api/accounts/options');
    expect(res.status).toBe(401);
  });
});

describe('§2 THE HOLDER PICKER', () => {
  it('groups staff by what they do — AM, CCM, AM + CCM, Crew', async () => {
    db.prepare("INSERT INTO staff_managers (name, manager_type, role_category, email, active) VALUES ('Roster AM','account_manager','manager','am@x.com',1)").run();
    db.prepare("INSERT INTO staff_managers (name, manager_type, role_category, email, active) VALUES ('Roster CCM','ccm','manager','ccm@x.com',1)").run();
    db.prepare("INSERT INTO staff_managers (name, manager_type, role_category, email, active) VALUES ('Roster Both','both','manager','both@x.com',1)").run();
    db.prepare("INSERT INTO staff_managers (name, manager_type, role_category, email, active) VALUES ('Roster Crew','crew','crew','crew@x.com',1)").run();

    const res = await auth(request(app).get('/api/assignments/holders'));
    const role = (n: string) => res.body.employees.find((e: any) => e.name === n)?.role;
    expect(role('Roster AM')).toBe('AM');
    expect(role('Roster CCM')).toBe('CCM');
    expect(role('Roster Both')).toBe('AM + CCM');
    expect(role('Roster Crew')).toBe('Crew');
  });

  it('a crew row wins over a stale manager_type', async () => {
    // Crew rows predating the AM/CCM split can still carry a manager type.
    // What they DO is the thing the person picking needs to see.
    db.prepare("INSERT INTO staff_managers (name, manager_type, role_category, email, active) VALUES ('Stale Crew','account_manager','crew','sc@x.com',1)").run();
    const res = await auth(request(app).get('/api/assignments/holders'));
    expect(res.body.employees.find((e: any) => e.name === 'Stale Crew').role).toBe('Crew');
  });

  it('offers the IC vendor AND its named primary contact as separate people', async () => {
    seed(0, 3);
    const res = await auth(request(app).get('/api/assignments/holders'));
    const company = res.body.ics.find((i: any) => i.name === 'AFC CLEANING 01');
    const contact = res.body.ics.find((i: any) => i.name === 'AFC CLEANING 01 — Contact 1');
    expect(company).toBeTruthy();
    expect(contact).toBeTruthy();
    expect(company.role).toBe('IC Vendor');
    expect(contact.role).toBe('IC Contact');
    // Same vendor record behind both — only the name on the form differs.
    expect(contact.id).toBe(company.id);
    expect(contact.email).toBe(company.email);
  });

  it('gives every option a distinct key, so the contact is selectable', async () => {
    seed(0, 4);
    const res = await auth(request(app).get('/api/assignments/holders'));
    const keys = [...res.body.employees, ...res.body.ics].map((o: any) => o.key);
    // Selecting by id alone would resolve a contact to its company every time.
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.every(Boolean)).toBe(true);
  });

  it('flags the people with no address on file', async () => {
    seed(0, 3);
    const res = await auth(request(app).get('/api/assignments/holders'));
    const noMail = res.body.ics.find((i: any) => i.name === 'AFC CLEANING 00');
    expect(noMail.email).toBeNull();
    expect(noMail.has_email).toBe(false);
    // The fixture crew member is the staff-side case.
    const crew = res.body.employees.find((e: any) => e.name === 'ZZ Test No-Email Staff');
    expect(crew).toMatchObject({ has_email: false, role: 'Crew', is_test: 1 });
  });

  it('searches the contact name, not just the company', async () => {
    seed(0, 5);
    const res = await auth(request(app).get('/api/assignments/holders?search=Contact 3'));
    expect(res.body.ics.some((i: any) => i.name === 'AFC CLEANING 03 — Contact 3')).toBe(true);
  });

  it('leaves archived vendors out', async () => {
    seed(0, 3);
    db.exec("UPDATE accounts SET archived = 1 WHERE ic_company_name = 'AFC CLEANING 01'");
    const res = await auth(request(app).get('/api/assignments/holders'));
    expect(res.body.ics.some((i: any) => /AFC CLEANING 01/.test(i.name))).toBe(false);
  });
});

describe('§3 THE SMART DEFAULT', () => {
  it('suggests the client’s assigned IC as the holder', async () => {
    seed(0, 2);
    const vendor = obj(db.prepare("SELECT id, ic_company_name, bc_vendor_number FROM accounts WHERE ic_company_name='AFC CLEANING 01'").get());
    const acct = db.prepare(
      "INSERT INTO accounts (ic_company_name, bc_client_number, record_type, status, archived, metal_keys, ic_name, bc_vendor_number, account_manager)" +
      " VALUES ('SUGGEST SITE','01014199999','customer','active',0,4,?,?,'Some AM')"
    ).run(vendor.ic_company_name, vendor.bc_vendor_number);

    const res = await auth(request(app).get(`/api/assignments/checkout-context?account_id=${Number(acct.lastInsertRowid)}`));
    expect(res.status).toBe(200);
    expect(res.body.suggested_holder).toMatchObject({
      name: 'AFC CLEANING 01', type: 'ic', reason: 'assigned IC', id: vendor.id,
    });
  });

  it('falls back to the account manager when no IC is assigned', async () => {
    db.prepare("INSERT INTO staff_managers (name, manager_type, role_category, email, active) VALUES ('Fallback AM','account_manager','manager','fb@x.com',1)").run();
    const acct = db.prepare(
      "INSERT INTO accounts (ic_company_name, bc_client_number, record_type, status, archived, metal_keys, account_manager)" +
      " VALUES ('NO IC SITE','01014199998','customer','active',0,2,'Fallback AM')"
    ).run();
    const res = await auth(request(app).get(`/api/assignments/checkout-context?account_id=${Number(acct.lastInsertRowid)}`));
    expect(res.body.suggested_holder).toMatchObject({ name: 'Fallback AM', type: 'employee' });
  });
});

describe('§4 A CHECK-OUT AGAINST AN IC RECORD WORKS END TO END', () => {
  it('keys can be checked out at an IC vendor account, not just a customer', async () => {
    seed(0, 2);
    const ic = obj(db.prepare("SELECT id, ic_company_name FROM accounts WHERE ic_company_name='AFC CLEANING 01'").get());
    // The vendor holds keys of its own — the case the customer-only picker
    // made unreachable from the Check Out screen.
    db.prepare('UPDATE accounts SET metal_keys = 4, contractor_metal = 2 WHERE id = ?').run(ic.id);

    // It is on the picker.
    const opts = await auth(request(app).get('/api/accounts/options?search=AFC CLEANING 01'));
    expect(opts.body.ics.some((r: any) => r.id === ic.id)).toBe(true);

    const out = await auth(request(app).post('/api/assignments/checkout')).send({
      account_id: ic.id, account_name: ic.ic_company_name,
      holder: 'AFC CLEANING 01 — Contact 1', holder_email: 'ic1@example.com',
      holder_type: 'ic', holder_id: ic.id,
      keys: [{ type: 'metal', qty: 1 }],
      sign_mode: 'in_person',
    });
    expect(out.status).toBe(201);
    expect(out.body.key_form).toMatchObject({
      event_type: 'checkout', holder_name: 'AFC CLEANING 01 — Contact 1', total_keys: 1,
    });

    // …and it comes back out of the active list against that account.
    const list = await auth(request(app).get(`/api/assignments?status=checked_out&limit=50`));
    const mine = list.body.assignments.find((a: any) => a.account_id === ic.id);
    expect(mine).toBeTruthy();

    const back = await auth(request(app).post('/api/assignments/checkin'))
      .send({ id: out.body.id, condition_on_return: 'good' });
    expect(back.status).toBe(200);
    expect(back.body.key_form.event_type).toBe('checkin');
  });
});
