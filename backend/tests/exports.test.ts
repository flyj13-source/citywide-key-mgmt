import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import * as XLSX from 'xlsx';

// ── Isolated temp DB — the real citywide.db is NEVER touched ─────────────────
const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'citywide-exports-test-'));
process.env.CITYWIDE_DB_DIR = TEST_DIR;
delete process.env.DB_PATH;
process.env.JWT_SECRET = 'test-secret';
process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
process.env.SEED_PASSWORD = 'demo1234';

const DB_FILE = path.join(TEST_DIR, 'citywide.db');
const ADMIN_EMAIL = 'cara@citywideboston.com';
const ADMIN_PASS = 'demo1234';

// Distinctive ciphertext markers — if either ever appears in an export, the
// "no decrypted / no secret code columns" guarantee is broken.
const DOOR_CIPHER = 'DOORCIPHER_ALPHA_ZZZ';
const ALARM_CIPHER = 'ALARMCIPHER_BETA_ZZZ';

let app: Express;
let token: string;
const ids: Record<string, number> = {};

function openDb() { return new DatabaseSync(DB_FILE); }
function auth(req: request.Test) { return req.set('Authorization', `Bearer ${token}`); }

function seedFixture() {
  const db = openDb();
  const insert = db.prepare(`
    INSERT INTO accounts
      (ic_company_name, bc_client_number, bc_vendor_number, ic_name,
       account_manager, ccm_manager, record_type, status,
       keys_yn, security_app_yn,
       am_metal, am_card, am_fob, am_dispenser,
       am_keys, metal_keys, key_cards, has_fob, dispenser_keys,
       door_code_encrypted, door_code_iv, alarm_code_encrypted, alarm_code_iv,
       lockbox_code, notes)
    VALUES (?, ?, ?, ?, ?, ?, 'customer', 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  // ALPHA: Alice AM, keys_yn=1, am grid metal2/card1 → am_keys 3, has a DOOR code.
  insert.run('ALPHA CO', '01014000001', '02014000001', 'IC ALPHA', 'Alice Manager', null,
    1, 1, 2, 1, 0, 0, 3, 2, 1, 0, 0, DOOR_CIPHER, 'iv1', null, null, 'LB-100', 'note alpha');
  // BETA: Alice AM, keys_yn=0, security NULL, am grid fob1/disp2 → am_keys 3, has an ALARM code.
  insert.run('BETA CO', '01014000002', '02014000002', 'IC BETA', 'Alice Manager', null,
    0, null, 0, 0, 1, 2, 3, 0, 0, 1, 2, null, null, ALARM_CIPHER, 'iv2', 'LB-200', 'note beta');
  // GAMMA: managed by someone else, keys_yn=NULL (the "unset" state).
  insert.run('GAMMA CO', '01014000003', '02014000003', 'IC GAMMA', 'Other Mgr', null,
    null, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, null, null, null, null, null, null);

  // One true IC-vendor record (record_type = 'ic').
  db.prepare(`INSERT INTO accounts (ic_company_name, bc_vendor_number, record_type, status, keys_yn) VALUES (?, ?, 'ic', 'active', 1)`)
    .run('IC VENDOR X', '02014999999');

  ids.ALPHA = Object.assign({}, db.prepare("SELECT id FROM accounts WHERE ic_company_name='ALPHA CO'").get()).id;

  // Staff manager: Alice (Account Manager). Matches accounts.account_manager by name.
  db.prepare(`INSERT INTO staff_managers (name, manager_type, role_category, shift, day_night, email, phone, active)
              VALUES ('Alice Manager', 'account_manager', 'manager', '1st', 'day', 'alice@citywideboston.com', '617-555-0100', 1)`).run();
  ids.ALICE = Object.assign({}, db.prepare("SELECT id FROM staff_managers WHERE name='Alice Manager'").get()).id;

  db.close();
}

beforeAll(async () => {
  app = (await import('../src/index')).default;
  const { autoSeedIfEmpty } = await import('../src/lib/autoSeed');
  autoSeedIfEmpty();

  const clean = openDb();
  clean.exec('DELETE FROM accounts; DELETE FROM staff_managers; DELETE FROM key_assignments; DELETE FROM audit_log;');
  clean.close();

  seedFixture();

  const res = await request(app).post('/api/auth/login').send({ email: ADMIN_EMAIL, password: ADMIN_PASS });
  token = res.body.token;
});

// Parse every sheet of an xlsx buffer into { [sheetName]: rows[][] }.
function parseWorkbook(buf: Buffer): Record<string, any[][]> {
  const wb = XLSX.read(buf, { type: 'buffer' });
  const out: Record<string, any[][]> = {};
  for (const name of wb.SheetNames) {
    out[name] = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, blankrows: false }) as any[][];
  }
  return out;
}

describe('PER-EMPLOYEE EXPORT', () => {
  it('exports an employee to xlsx with totals that reconcile with the roster', async () => {
    const res = await auth(request(app).get(`/api/staff/${ids.ALICE}/export?format=xlsx`)).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    expect(res.headers['content-disposition']).toContain('CityWide-Employee-');

    const sheets = parseWorkbook(res.body as Buffer);
    const rows = sheets['Employee'];
    const flat = JSON.stringify(rows);

    // Header block carries name + role + contact.
    expect(flat).toContain('Alice Manager');
    expect(flat).toContain('alice@citywideboston.com');
    // Summary: 2 clients, 6 keys total (3 + 3).
    const clientsRow = rows.find((r) => r[0] === 'Total Clients Managed');
    const keysRow = rows.find((r) => r[0] === 'Total Keys Held');
    expect(clientsRow?.[1]).toBe(2);
    expect(keysRow?.[1]).toBe(6);
    // TOTAL row: metal 2, card 1, fob 1, dispenser 2, total 6.
    const totalRow = rows.find((r) => r[0] === 'TOTAL');
    expect(totalRow?.slice(4, 9)).toEqual([2, 1, 1, 2, 6]);
    // Both managed clients appear with their per-client keys.
    expect(flat).toContain('ALPHA CO');
    expect(flat).toContain('BETA CO');
    // No secret codes anywhere.
    expect(flat).not.toContain(DOOR_CIPHER);
    expect(flat).not.toContain(ALARM_CIPHER);
  });

  it('exports an employee to a branded PDF', async () => {
    const res = await auth(request(app).get(`/api/staff/${ids.ALICE}/export?format=pdf`)).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    const buf = res.body as Buffer;
    expect(buf.slice(0, 5).toString()).toBe('%PDF-');
    // Never leak codes into the PDF stream.
    expect(buf.toString('latin1')).not.toContain(DOOR_CIPHER);
  });

  it('logs export_employee to the audit log', async () => {
    const db = openDb();
    const row = Object.assign({}, db.prepare(
      "SELECT * FROM audit_log WHERE action='export_employee' ORDER BY id DESC LIMIT 1"
    ).get());
    db.close();
    expect(row.action).toBe('export_employee');
    expect(row.account_name).toBe('Alice Manager');
  });

  it('rejects an unknown format', async () => {
    const res = await auth(request(app).get(`/api/staff/${ids.ALICE}/export?format=docx`));
    expect(res.status).toBe(400);
  });
});

describe('FULL REGISTRY EXPORT', () => {
  it('exports the entire registry as xlsx — one sheet per tab, no codes', async () => {
    const res = await auth(request(app).post('/api/exports/registry').send({ scope: 'all', format: 'xlsx' })).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/CityWide-KeyRegistry-Full-\d{4}-\d{2}-\d{2}\.xlsx/);

    const sheets = parseWorkbook(res.body as Buffer);
    // Every registry tab, one sheet each, in on-screen order.
    expect(Object.keys(sheets)).toEqual([
      'Customers', 'IC Vendors', 'Account Managers', 'CCM', 'Office', 'CW Employees',
      'Checked Out', 'Checked In',
    ]);

    // Customers: 3 rows + header. Column order mirrors the screen.
    const cust = sheets['Customers'];
    expect(cust[0].slice(0, 8)).toEqual([
      'Client Name', 'BC Client #', 'Independent Contractor', 'BC Vendor #',
      'Account Manager', 'Contract Compliance Manager', 'Keys Y/N', 'Security App Y/N',
    ]);
    expect(cust.length - 1).toBe(3);
    expect(cust[0]).toContain('Has Door Code');
    expect(cust[0]).toContain('Has Alarm Code');
    expect(cust[0]).not.toContain('Door Code');   // only the "Has …" variant, never the code
    expect(cust[0]).not.toContain('Alarm Code');

    // null keys_yn (GAMMA) → blank; 1 → Yes; 0 → No.
    const keyCol = cust[0].indexOf('Keys Y/N');
    const byName = (n: string) => cust.find((r) => r[0] === n)!;
    expect(byName('ALPHA CO')[keyCol]).toBe('Yes');
    expect(byName('BETA CO')[keyCol]).toBe('No');
    const gamma = byName('GAMMA CO');
    expect(gamma[keyCol] === '' || gamma[keyCol] === undefined).toBe(true);
    // Has Door Code Yes/No derived from ciphertext presence.
    const doorCol = cust[0].indexOf('Has Door Code');
    expect(byName('ALPHA CO')[doorCol]).toBe('Yes');
    expect(byName('BETA CO')[doorCol]).toBe('No');

    // IC Vendors: the one true IC record.
    expect(sheets['IC Vendors'].length - 1).toBe(1);
    // Account Managers: Alice + Other Mgr = 2.
    expect(sheets['Account Managers'].length - 1).toBe(2);
    // Office: customers with office keys held (none in fixture) = 0.
    expect(sheets['Office'].length - 1).toBe(0);
    // CW Employees: Alice.
    expect(sheets['CW Employees'].length - 1).toBe(1);

    // No secret codes anywhere across every sheet.
    const everything = JSON.stringify(sheets);
    expect(everything).not.toContain(DOOR_CIPHER);
    expect(everything).not.toContain(ALARM_CIPHER);
  });

  it('current-tab CSV export honors search and column order', async () => {
    const res = await auth(request(app).post('/api/exports/registry').send({ scope: 'current', tab: 'customer', format: 'csv', search: 'ALPHA' }));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    const text = res.text || res.body.toString();
    const lines = text.trim().split(/\r?\n/);
    // Header + exactly the one matching row (search = "ALPHA").
    expect(lines[0].startsWith('Client Name,BC Client #,Independent Contractor')).toBe(true);
    expect(lines.length).toBe(2);
    expect(lines[1]).toContain('ALPHA CO');
    expect(text).not.toContain(DOOR_CIPHER);
  });

  it('excludes archived by default and includes them when opted in', async () => {
    // Archive BETA.
    const db = openDb();
    db.prepare("UPDATE accounts SET archived=1, archived_at=CURRENT_TIMESTAMP, archived_by='tester' WHERE ic_company_name='BETA CO'").run();
    db.close();

    const base = { scope: 'current', tab: 'customer', format: 'csv' as const };
    const excl = await auth(request(app).post('/api/exports/registry').send(base));
    expect((excl.text.trim().split(/\r?\n/).length) - 1).toBe(2); // ALPHA + GAMMA

    const incl = await auth(request(app).post('/api/exports/registry').send({ ...base, includeArchived: true }));
    expect((incl.text.trim().split(/\r?\n/).length) - 1).toBe(3); // + BETA

    // restore for any later assertions
    const db2 = openDb();
    db2.prepare("UPDATE accounts SET archived=0 WHERE ic_company_name='BETA CO'").run();
    db2.close();
  });

  it('logs export_registry with scope + row count', async () => {
    const db = openDb();
    const row = Object.assign({}, db.prepare(
      "SELECT * FROM audit_log WHERE action='export_registry' ORDER BY id DESC LIMIT 1"
    ).get());
    db.close();
    expect(row.action).toBe('export_registry');
    const meta = JSON.parse(row.metadata);
    expect(meta.row_count).toBeGreaterThanOrEqual(2);
    expect(['current', 'all']).toContain(meta.scope);
  });
});
