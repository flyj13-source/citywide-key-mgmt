import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { DatabaseSync } from 'node:sqlite';
import * as XLSX from 'xlsx';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'citywide-eiroute-'));
process.env.CITYWIDE_DB_DIR = TEST_DIR;
delete process.env.DB_PATH;
process.env.JWT_SECRET = 'test-secret';
process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
process.env.SEED_PASSWORD = 'demo1234';

const DB_FILE = path.join(TEST_DIR, 'citywide.db');
let app: Express;
let token: string;
let db: DatabaseSync;

const auth = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);

/** Build a real .xlsx buffer so the route exercises actual sheet parsing. */
function xlsx(sheets: Record<string, any[][]>): Buffer {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

const upload = (buf: Buffer, filename: string) =>
  auth(request(app).post('/api/accounts/import')).attach('file', buf, filename);

beforeAll(async () => {
  app = (await import('../src/index')).default;
  (await import('../src/lib/autoSeed')).autoSeedIfEmpty();
  const login = await request(app).post('/api/auth/login')
    .send({ email: 'cara@citywideboston.com', password: 'demo1234' });
  token = login.body.token;
  db = new DatabaseSync(DB_FILE);
});

beforeEach(() => {
  db.exec('DELETE FROM staff_managers');
  db.exec('DELETE FROM accounts');
});

describe('REGISTRY UPLOAD — recognises the employee sheet', () => {
  const book = () => xlsx({
    'Current Employees': [
      ['First Name', 'Last Name', 'Email Address'],
      ['Daniel ', 'Bordenave ', 'daniel.bordenave@gocitywide.com '],
      ['New', 'Person', 'new.person@gocitywide.com'],
    ],
  });

  it('previews as a dry run and writes nothing', async () => {
    db.prepare("INSERT INTO staff_managers (name, manager_type, role_category, active) VALUES ('Daniel Bordenave','account_manager','manager',1)").run();
    const res = await upload(book(), 'Cinch_-_KM_List.xlsx');
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe('staff-emails');
    expect(res.body.sheet).toBe('Current Employees');
    expect(res.body.preview.matchedUpdated).toHaveLength(1);
    expect(res.body.preview.created).toHaveLength(1);
    // Dry run: still no email on the matched row.
    expect(db.prepare('SELECT email FROM staff_managers').get()).toMatchObject({ email: null });
  });

  it('confirm applies it, and a second confirm is a no-op', async () => {
    db.prepare("INSERT INTO staff_managers (name, manager_type, role_category, active) VALUES ('Daniel Bordenave','account_manager','manager',1)").run();
    const prev = await upload(book(), 'Cinch_-_KM_List.xlsx');

    const first = await auth(request(app).post('/api/accounts/import/emails/confirm'))
      .send({ kind: 'staff-emails', rows: prev.body.rows });
    expect(first.status).toBe(200);
    expect(first.body.report.matchedUpdated).toHaveLength(1);
    expect(first.body.report.created).toHaveLength(1);
    expect(db.prepare("SELECT email FROM staff_managers WHERE name = 'Daniel Bordenave'").get())
      .toMatchObject({ email: 'daniel.bordenave@gocitywide.com' });

    const second = await auth(request(app).post('/api/accounts/import/emails/confirm'))
      .send({ kind: 'staff-emails', rows: prev.body.rows });
    expect(second.body.report.matchedUpdated).toHaveLength(0);
    expect(second.body.report.created).toHaveLength(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM staff_managers').get()).toMatchObject({ n: 2 });
  });
});

describe('REGISTRY UPLOAD — recognises the IC sheet and skips hiddenSheet', () => {
  const book = () => xlsx({
    // Deliberately FIRST, to prove the picker does not take SheetNames[0].
    hiddenSheet: [['junk'], ['do not read me']],
    'Active Independent Contractors': [
      ['(Do Not Modify) Account', '(Do Not Modify) Row Checksum', 'DBA Name', 'BC Vendor No', 'Primary Contact', 'Email (Primary Contact) (Contact)'],
      ['', '', 'ACME CLEANING', '02014100437', 'Pat Lee ', 'pat@acme.test '],
      ['', '', 'NO EMAIL CO', '02014100438', 'Sam Ray', ''],
      ['', '', 'NO VENDOR CO', '', 'Kim Fox', 'kim@novendor.test'],
    ],
  });

  it('previews from the right sheet and flags the two bad rows', async () => {
    const res = await upload(book(), 'Active_Independent_Contractors.xlsx');
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe('ic-emails');
    expect(res.body.sheet).toBe('Active Independent Contractors');
    expect(res.body.preview.missingEmail.map((m: any) => m.dba)).toEqual(['NO EMAIL CO']);
    expect(res.body.preview.missingVendorNo.map((m: any) => m.dba)).toEqual(['NO VENDOR CO']);
    expect(db.prepare('SELECT COUNT(*) AS n FROM accounts').get()).toMatchObject({ n: 0 });
  });

  it('confirm imports, preserves the leading zero, and reports resolution', async () => {
    db.prepare("INSERT INTO accounts (ic_company_name, bc_vendor_number, record_type) VALUES ('A SITE','02014100437','customer')").run();
    const prev = await upload(book(), 'Active_Independent_Contractors.xlsx');
    const res = await auth(request(app).post('/api/accounts/import/emails/confirm'))
      .send({ kind: 'ic-emails', rows: prev.body.rows });

    expect(res.status).toBe(200);
    expect(res.body.report.created).toHaveLength(3);
    const acme = db.prepare("SELECT * FROM accounts WHERE ic_company_name = 'ACME CLEANING'").get() as any;
    expect(Object.assign({}, acme)).toMatchObject({
      bc_vendor_number: '02014100437', ic_primary_contact: 'Pat Lee', ic_email: 'pat@acme.test',
      record_type: 'ic',
    });
    // The one customer site now resolves to a reachable human.
    expect(res.body.resolution).toMatchObject({ totalCustomers: 1, resolved: 1 });
  });
});

describe('REGISTRY UPLOAD — the customer registry sheet still imports as before', () => {
  it('is not mistaken for an email sheet', async () => {
    const buf = xlsx({
      'Key Inventory': [
        ['Client Name', 'BC Client Number', 'BC Vendor Number', 'Account Manager', 'Metal Keys'],
        ['A CLIENT', '01014700001', '02014100437', 'Aggie AM', 3],
      ],
    });
    const res = await upload(buf, 'registry.xlsx');
    expect(res.status).toBe(200);
    expect(res.body.kind).toBeUndefined();
    expect(res.body.valid).toHaveLength(1);
    expect(res.body.valid[0]).toMatchObject({ ic_company_name: 'A CLIENT', metal_keys: 3 });
  });
});

describe('REGISTRY UPLOAD — auth and bad input', () => {
  it('rejects an unauthenticated upload', async () => {
    const res = await request(app).post('/api/accounts/import')
      .attach('file', xlsx({ S: [['First Name', 'Last Name', 'Email Address']] }), 'x.xlsx');
    expect(res.status).toBe(401);
  });

  it('rejects an unknown confirm kind without writing', async () => {
    const res = await auth(request(app).post('/api/accounts/import/emails/confirm'))
      .send({ kind: 'nonsense', rows: [{ name: 'X', email: 'x@y.test' }] });
    expect(res.status).toBe(400);
    expect(db.prepare('SELECT COUNT(*) AS n FROM staff_managers').get()).toMatchObject({ n: 0 });
  });
});

describe('CSV UPLOAD — the clean two-file replacement, through the app', () => {
  const staffCsv = [
    'Full Name,First Name,Last Name,Email',
    'Daniel Bordenave,Daniel,Bordenave,daniel.bordenave@gocitywide.com',
    'Brand New,Brand,New,brand.new@gocitywide.com',
  ].join('\n');

  const icCsv = [
    'IC Company Name,BC Vendor Number,Primary Contact,Email',
    'CONTRACTOR 001 LLC,02014100400,Pat Lee,pat@one.test',
    'All season,,Malik Okonkwo,allseason@ic.test',
    'KleenRite Services,,Sean Whitfield,kleenrite@ic.test',
  ].join('\n');

  const uploadCsv = (text: string, name: string) =>
    auth(request(app).post('/api/accounts/import'))
      .attach('file', Buffer.from(text, 'utf8'), { filename: name, contentType: 'text/csv' });

  it('recognises the staff CSV and previews without writing', async () => {
    db.prepare("INSERT INTO staff_managers (name, manager_type, role_category, active) VALUES ('Daniel Bordenave','account_manager','manager',1)").run();
    const res = await uploadCsv(staffCsv, 'CW_Staff_Emails.csv');
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe('staff-emails');
    expect(res.body.headers.unrecognized).toEqual([]);
    expect(res.body.preview.matchedUpdated).toHaveLength(1);
    expect(res.body.preview.created).toHaveLength(1);
    expect(res.body.preview.fieldFills['staff_managers.email']).toBe(2);
    expect(db.prepare('SELECT email FROM staff_managers').get()).toMatchObject({ email: null });
  });

  it('applies the staff CSV on confirm', async () => {
    db.prepare("INSERT INTO staff_managers (name, manager_type, role_category, active) VALUES ('Daniel Bordenave','account_manager','manager',1)").run();
    const prev = await uploadCsv(staffCsv, 'CW_Staff_Emails.csv');
    const res = await auth(request(app).post('/api/accounts/import/emails/confirm'))
      .send({ kind: 'staff-emails', rows: prev.body.rows });
    expect(res.status).toBe(200);
    expect(db.prepare("SELECT email FROM staff_managers WHERE name = 'Daniel Bordenave'").get())
      .toMatchObject({ email: 'daniel.bordenave@gocitywide.com' });
  });

  it('CSV vendor numbers keep their leading zero end to end', async () => {
    const prev = await uploadCsv(icCsv, 'IC_Emails.csv');
    expect(prev.body.kind).toBe('ic-emails');
    expect(prev.body.headers.unrecognized).toEqual([]);
    // Nothing was padded — the CSV text arrived intact.
    expect(prev.body.preview.vendorPadded).toEqual([]);

    await auth(request(app).post('/api/accounts/import/emails/confirm'))
      .send({ kind: 'ic-emails', rows: prev.body.rows });

    const row = Object.assign({}, db.prepare(
      "SELECT bc_vendor_number FROM accounts WHERE ic_company_name = 'CONTRACTOR 001 LLC'"
    ).get() as any);
    expect(row.bc_vendor_number).toBe('02014100400');
    expect(String(row.bc_vendor_number)).toHaveLength(11);
  });

  it('flags the two blank-vendor ICs by name and still imports them', async () => {
    const prev = await uploadCsv(icCsv, 'IC_Emails.csv');
    expect(prev.body.preview.missingVendorNo.map((m: any) => m.dba))
      .toEqual(['All season', 'KleenRite Services']);
    await auth(request(app).post('/api/accounts/import/emails/confirm'))
      .send({ kind: 'ic-emails', rows: prev.body.rows });
    expect(db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE record_type='ic'").get())
      .toMatchObject({ n: 3 });
  });

  it('reports the resolution figure that decides whether forms can be sent', async () => {
    db.prepare("INSERT INTO accounts (ic_company_name, bc_vendor_number, record_type) VALUES ('A SITE','02014100400','customer')").run();
    const prev = await uploadCsv(icCsv, 'IC_Emails.csv');
    expect(prev.body.resolutionBefore).toMatchObject({ totalCustomers: 1, resolved: 0 });
    const res = await auth(request(app).post('/api/accounts/import/emails/confirm'))
      .send({ kind: 'ic-emails', rows: prev.body.rows });
    expect(res.body.resolution).toMatchObject({ totalCustomers: 1, resolved: 1 });
  });
});
