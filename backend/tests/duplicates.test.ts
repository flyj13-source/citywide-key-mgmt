import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

// ── Possible duplicates — READ ONLY ──────────────────────────────────────────
// The hard constraint is the first thing tested: nothing in this feature may
// modify a record. Everything else is about surfacing the right candidates
// with enough evidence attached to decide.

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'citywide-dupes-'));
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
const obj = (r: any) => (r ? Object.assign({}, r) : null);
const scalar = (sql: string, ...p: any[]) => Object.assign({}, db.prepare(sql).get(...p) as any).c as number;

const staff = (name: string, opts: { email?: string | null; type?: string; role?: string } = {}) => {
  const r = db.prepare(
    'INSERT INTO staff_managers (name, manager_type, role_category, email, active) VALUES (?, ?, ?, ?, 1)'
  ).run(name, opts.type ?? 'account_manager', opts.role ?? 'manager', opts.email ?? null);
  return Number(r.lastInsertRowid);
};

const customer = (name: string, bc: string, opts: { am?: string; metal?: number } = {}) => {
  const r = db.prepare(
    "INSERT INTO accounts (ic_company_name, bc_client_number, record_type, status, archived, metal_keys, account_manager, am_keys)" +
    " VALUES (?,?,'customer','active',0,?,?,?)"
  ).run(name, bc, opts.metal ?? 0, opts.am ?? null, opts.metal ?? 0);
  return Number(r.lastInsertRowid);
};

const vendor = (name: string, num: string, email: string | null = null) => {
  const r = db.prepare(
    "INSERT INTO accounts (ic_company_name, bc_vendor_number, ic_email, record_type, archived) VALUES (?,?,?,'ic',0)"
  ).run(name, num, email);
  return Number(r.lastInsertRowid);
};

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
  db.exec("DELETE FROM accounts WHERE COALESCE(is_test,0)=0");
  db.exec("DELETE FROM staff_managers WHERE COALESCE(is_test,0)=0");
});

const dupes = (q = '') => auth(request(app).get(`/api/data-quality/duplicates${q}`));

describe('§1 THE HARD CONSTRAINT — nothing modifies data', () => {
  it('exposes no write route at all', async () => {
    staff('Ben Pritchard');
    staff('Ben Pritchardq');
    // Every verb other than GET, on every path this feature owns.
    for (const p of ['/api/data-quality/duplicates', '/api/data-quality/missing-email', '/api/data-quality/export']) {
      for (const verb of ['post', 'put', 'patch', 'delete'] as const) {
        const res = await auth((request(app) as any)[verb](p)).send({});
        expect(res.status, `${verb.toUpperCase()} ${p}`).toBe(404);
      }
    }
  });

  it('reading the report leaves every record byte-for-byte unchanged', async () => {
    staff('Ben Pritchard', { email: 'ben@citywideboston.com' });
    staff('Ben Pritchardq', { email: 'ben@citywideboston.com' });
    vendor('AFC CLEANING', '02014100001');
    vendor('AFC CLEANING', '02014100002');
    customer('SITE ONE', '01014100001');
    customer('SITE ONE COPY', '01014100001');

    const snap = () => JSON.stringify([
      db.prepare('SELECT * FROM staff_managers ORDER BY id').all(),
      db.prepare('SELECT * FROM accounts ORDER BY id').all(),
    ]);
    const before = snap();

    await dupes();
    await auth(request(app).get('/api/data-quality/missing-email'));
    await auth(request(app).get('/api/data-quality/export'));
    await auth(request(app).get('/api/data-quality/summary'));

    expect(snap()).toBe(before);
  });

  it('says so in the payload, not just in the UI', async () => {
    const res = await dupes();
    expect(res.body.read_only).toBe(true);
  });

  it('is behind auth', async () => {
    expect((await request(app).get('/api/data-quality/duplicates')).status).toBe(401);
    expect((await request(app).get('/api/data-quality/export')).status).toBe(401);
  });
});

describe('§2 STAFF DETECTION', () => {
  it('surfaces the near-match the request named: Pritchard / Pritchardq', async () => {
    staff('Ben Pritchard');
    staff('Ben Pritchardq');
    const res = await dupes('?population=staff');
    const pair = res.body.pairs.find((p: any) =>
      [p.a.name, p.b.name].sort().join('|') === 'Ben Pritchard|Ben Pritchardq');
    expect(pair).toBeTruthy();
    expect(pair.confidence).toBe('near');
    expect(pair.reason).toMatch(/differ by 1 character$/);
  });

  it('normalizes case, spacing and punctuation into an EXACT match', async () => {
    staff('Mary-Jane  O’Brien');
    staff('mary jane obrien');
    const res = await dupes('?population=staff');
    const pair = res.body.pairs.find((p: any) => /O’Brien/.test(p.a.name) || /O’Brien/.test(p.b.name));
    expect(pair).toBeTruthy();
    expect(pair.confidence).toBe('exact');
  });

  it('treats an accent as the same person', async () => {
    staff('Tomás Ortiz');
    staff('Tomas Ortiz');
    const res = await dupes('?population=staff');
    expect(res.body.pairs.some((p: any) =>
      [p.a.name, p.b.name].sort().join('|') === 'Tomas Ortiz|Tomás Ortiz')).toBe(true);
  });

  it('pairs two different names sharing one address', async () => {
    staff('Dana Reyes', { email: 'shared@citywideboston.com' });
    staff('Marcus Hall', { email: 'shared@citywideboston.com' });
    const res = await dupes('?population=staff');
    const pair = res.body.pairs.find((p: any) => p.kind === 'staff_email');
    expect(pair).toBeTruthy();
    expect(pair.reason).toContain('shared@citywideboston.com');
  });

  it('does NOT pair short names one or two characters apart', async () => {
    staff('Dan');
    staff('Ben');
    staff('Jon');
    const res = await dupes('?population=staff');
    // At three characters a distance of 2 is most of the word; a list full of
    // false pairs is a list nobody reads.
    expect(res.body.pairs.some((p: any) =>
      ['Dan', 'Ben', 'Jon'].includes(p.a.name) && ['Dan', 'Ben', 'Jon'].includes(p.b.name))).toBe(false);
  });

  it('does NOT pair two genuinely different people', async () => {
    staff('Priya Nair');
    staff('Marcus Hall');
    const res = await dupes('?population=staff');
    expect(res.body.pairs.some((p: any) =>
      [p.a.name, p.b.name].sort().join('|') === 'Marcus Hall|Priya Nair')).toBe(false);
  });

  it('reports each pair once, however many rules match it', async () => {
    staff('Ben Pritchard', { email: 'ben@citywideboston.com' });
    staff('Ben  Pritchard', { email: 'ben@citywideboston.com' });
    const res = await dupes('?population=staff');
    const matches = res.body.pairs.filter((p: any) => /Pritchard/.test(p.a.name) && /Pritchard/.test(p.b.name));
    expect(matches).toHaveLength(1);
  });
});

describe('§3 THE EVIDENCE — which record has real history', () => {
  it('counts clients, keys and open custody per side', async () => {
    staff('Ben Pritchard');
    staff('Ben Pritchardq');
    customer('SITE A', '01014100010', { am: 'Ben Pritchardq', metal: 3 });
    customer('SITE B', '01014100011', { am: 'Ben Pritchardq', metal: 2 });
    db.prepare(
      "INSERT INTO key_assignments (account_id, account_name, assignee, status, key_type, keys_held)" +
      " VALUES ((SELECT id FROM accounts WHERE bc_client_number='01014100010'), 'SITE A', 'Ben Pritchardq', 'checked_out', 'metal', '1 Metal Key')"
    ).run();

    const res = await dupes('?population=staff');
    const pair = res.body.pairs.find((p: any) => /Pritchard/.test(p.a.name) && /Pritchard/.test(p.b.name));
    const real = [pair.a, pair.b].find((s: any) => s.name === 'Ben Pritchardq');
    const empty = [pair.a, pair.b].find((s: any) => s.name === 'Ben Pritchard');

    // The whole point: the record that LOOKS wrong is the one holding the work.
    expect(real).toMatchObject({ clients_linked: 2, keys_held: 5, active_custody: 1 });
    expect(empty).toMatchObject({ clients_linked: 0, keys_held: 0, active_custody: 0 });
  });

  it('carries the columns the comparison needs on every side', async () => {
    staff('Ben Pritchard', { email: 'ben@citywideboston.com', type: 'ccm' });
    staff('Ben Pritchardq', { email: null });
    const res = await dupes('?population=staff');
    const pair = res.body.pairs.find((p: any) => /Pritchard/.test(p.a.name));
    for (const side of [pair.a, pair.b]) {
      expect(Object.keys(side).sort()).toEqual([
        'active', 'active_custody', 'clients_linked', 'created_at', 'email',
        'id', 'is_test', 'keys_held', 'name', 'number', 'role',
      ]);
    }
    expect([pair.a, pair.b].find((s: any) => s.name === 'Ben Pritchard').role).toBe('CCM');
  });
});

describe('§4 IC AND CUSTOMER DETECTION', () => {
  it('flags a duplicated vendor number', async () => {
    vendor('AFC CLEANING', '02014100055');
    vendor('AFC CLEANING SERVICES', '02014100055');
    const res = await dupes('?population=ic');
    const pair = res.body.pairs.find((p: any) => p.kind === 'ic_vendor_number');
    expect(pair).toBeTruthy();
    expect(pair.confidence).toBe('exact');
    expect(pair.reason).toContain('02014100055');
  });

  it('flags near-identical company names on DIFFERENT vendor numbers', async () => {
    vendor('ALVES CLEANING SERVICES', '02014100061');
    vendor('ALVES CLEANING SERVICE', '02014100062');
    const res = await dupes('?population=ic');
    const pair = res.body.pairs.find((p: any) => p.kind === 'ic_name');
    expect(pair).toBeTruthy();
    expect(pair.a.number).not.toBe(pair.b.number);
  });

  it('does not report the same IC pair under both rules', async () => {
    vendor('SHARP CLEANING', '02014100070');
    vendor('SHARP CLEANING', '02014100070');
    const res = await dupes('?population=ic');
    const matches = res.body.pairs.filter((p: any) => /SHARP/.test(p.a.name) && /SHARP/.test(p.b.name));
    expect(matches).toHaveLength(1);
    expect(matches[0].kind).toBe('ic_vendor_number');
  });

  it('flags a duplicated BC client number', async () => {
    customer('BEACON HILL MEDICAL', '01014100099');
    customer('BEACON HILL MEDICAL CENTER', '01014100099');
    const res = await dupes('?population=customer');
    const pair = res.body.pairs.find((p: any) => p.kind === 'customer_number');
    expect(pair).toBeTruthy();
    expect(pair.reason).toContain('01014100099');
  });

  it('filters by population without changing the totals', async () => {
    staff('Ben Pritchard'); staff('Ben Pritchardq');
    vendor('AFC CLEANING', '02014100081'); vendor('AFC CLEANING', '02014100081');

    const all = await dupes();
    const staffOnly = await dupes('?population=staff');
    expect(staffOnly.body.pairs.every((p: any) => p.population === 'staff')).toBe(true);
    expect(staffOnly.body.total).toBeLessThan(all.body.total);
    // The summary reports the whole picture regardless of the filter.
    expect(staffOnly.body.summary.pairs).toBe(all.body.total);
  });

  it('leaves the test fixtures out unless asked for', async () => {
    const off = await dupes();
    expect(off.body.pairs.some((p: any) => p.a.is_test === 1 || p.b.is_test === 1)).toBe(false);
  });
});

describe('§5 NO EMAIL ON FILE', () => {
  it('lists staff and IC vendors together, with the denominator', async () => {
    staff('Has Email', { email: 'has@citywideboston.com' });
    staff('No Email One');
    staff('No Email Two');
    vendor('SILENT VENDOR', '02014100090', null);
    vendor('LOUD VENDOR', '02014100091', 'loud@example.com');

    const res = await auth(request(app).get('/api/data-quality/missing-email'));
    const names = res.body.records.map((r: any) => r.name);
    expect(names).toEqual(expect.arrayContaining(['No Email One', 'No Email Two', 'SILENT VENDOR']));
    expect(names).not.toContain('Has Email');
    expect(names).not.toContain('LOUD VENDOR');
    // "12 of 506" — the denominator is what makes the number mean anything.
    expect(res.body.of_total).toBeGreaterThan(res.body.total);
  });

  it('carries the same evidence columns, so a blank record is obvious', async () => {
    staff('No Email One');
    customer('THEIR SITE', '01014100120', { am: 'No Email One', metal: 4 });
    const res = await auth(request(app).get('/api/data-quality/missing-email'));
    const row = res.body.records.find((r: any) => r.name === 'No Email One');
    expect(row).toMatchObject({ clients_linked: 1, keys_held: 4, population: 'staff', role: 'AM' });
  });

  it('treats a whitespace-only address as missing', async () => {
    staff('Blank Email', { email: '   ' });
    const res = await auth(request(app).get('/api/data-quality/missing-email'));
    expect(res.body.records.some((r: any) => r.name === 'Blank Email')).toBe(true);
  });
});

describe('§6 THE EXCEL EXPORT', () => {
  it('is a real workbook with a sheet per question', async () => {
    staff('Ben Pritchard'); staff('Ben Pritchardq'); staff('No Email At All');
    const res = await auth(request(app).get('/api/data-quality/export'))
      .buffer(true).parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    expect(res.headers['content-disposition']).toMatch(/possible-duplicates-\d{4}-\d{2}-\d{2}\.xlsx/);

    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body);
    expect(wb.worksheets.map((w) => w.name))
      .toEqual(['Read Me', 'Possible Duplicates', 'No Email On File']);

    const ws = wb.getWorksheet('Possible Duplicates')!;
    const header = (ws.getRow(1).values as any[]).filter(Boolean).map(String);
    // Both sides side by side, with the evidence columns that decide the call.
    for (const col of ['A — Name', 'B — Name', 'A — Clients', 'B — Active custody', 'Cara’s note']) {
      expect(header).toContain(col);
    }
    // The pair is actually in there, not just the header.
    const names = ws.getColumn('D').values.map((v) => String(v ?? ''));
    expect(names.some((v) => v.includes('Pritchard'))).toBe(true);
  });

  it('states in the workbook that nothing was changed', async () => {
    staff('Ben Pritchard'); staff('Ben Pritchardq');
    const res = await auth(request(app).get('/api/data-quality/export'))
      .buffer(true).parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body);
    const readme = wb.getWorksheet('Read Me')!;
    const text: string[] = [];
    readme.eachRow((row) => text.push(String((row.values as any[])[1] ?? '')));
    expect(text.join(' ')).toMatch(/Nothing has been merged, archived, edited or deleted/);
  });
});

describe('§7 THE DISTANCE FUNCTION', () => {
  it('measures what it claims to', async () => {
    const { levenshtein, normalizeName } = await import('../src/lib/duplicates');
    expect(levenshtein('benpritchard', 'benpritchardq')).toBe(1);
    expect(levenshtein('abc', 'abc')).toBe(0);
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    // The cap short-circuits rather than reporting a real distance.
    expect(levenshtein('abcdefgh', 'zzzzzzzz', 2)).toBeGreaterThan(2);
    expect(normalizeName("  Mary-Jane  O’Brien ")).toBe('maryjaneobrien');
    expect(normalizeName('Tomás')).toBe(normalizeName('Tomas'));
  });
});
