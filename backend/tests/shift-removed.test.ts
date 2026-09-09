import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

// ── Shift is gone from the surface, not from the table ───────────────────────
// The columns stay: dropping them risks data loss and they cost nothing unused.
// What must be true is that nothing READS them, nothing WRITES them, and a row
// that still carries a stored value behaves exactly like one that does not.

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'citywide-shift-'));
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

/** Every string in an arbitrarily nested payload. */
const strings = (v: any, out: string[] = []): string[] => {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => strings(x, out));
  return out;
};

let legacyId: number;

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
  db.exec("DELETE FROM staff_managers WHERE name LIKE 'Legacy %'");

  // A row exactly as it exists in production today: shift values stored from
  // before the field was retired.
  const r = db.prepare(`
    INSERT INTO staff_managers (name, manager_type, role_category, shift, day_night, email, active)
    VALUES ('Legacy Shift Person', 'account_manager', 'manager', '3rd', 'night', 'legacy@citywideboston.com', 1)
  `).run();
  legacyId = Number(r.lastInsertRowid);
});

describe('the columns survive', () => {
  it('shift and day_night still exist on the table', () => {
    const cols = (db.prepare('PRAGMA table_info(staff_managers)').all() as any[])
      .map((c) => obj(c).name);
    expect(cols).toContain('shift');
    expect(cols).toContain('day_night');
  });

  it('a stored value is left exactly as it was', async () => {
    await auth(request(app).patch(`/api/staff-managers/${legacyId}`)).send({ email: 'new@citywideboston.com' });
    const row = obj(db.prepare('SELECT shift, day_night FROM staff_managers WHERE id = ?').get(legacyId));
    // Untouched by an unrelated edit — not blanked, not migrated.
    expect(row).toMatchObject({ shift: '3rd', day_night: 'night' });
  });
});

describe('the API never hands them to the frontend', () => {
  it('is absent from the staff roster', async () => {
    const res = await auth(request(app).get('/api/staff?include_inactive=1'));
    const person = res.body.find((s: any) => s.name === 'Legacy Shift Person');
    expect(person).toBeTruthy();
    expect(person).not.toHaveProperty('shift');
    expect(person).not.toHaveProperty('day_night');
  });

  it('is absent from the manager list and detail', async () => {
    const list = await auth(request(app).get('/api/staff-managers?include_inactive=1'));
    for (const m of list.body.managers) {
      expect(m).not.toHaveProperty('shift');
      expect(m).not.toHaveProperty('day_night');
    }
    const detail = await auth(request(app).get(`/api/staff-managers/${legacyId}`));
    expect(detail.body.manager).not.toHaveProperty('shift');
    expect(detail.body.manager).not.toHaveProperty('day_night');
  });

  it('is absent from the AM and CCM roster tabs', async () => {
    for (const role of ['am', 'ccm']) {
      const res = await auth(request(app).get(`/api/staff-managers/roster?role=${role}`));
      for (const m of res.body.managers) {
        expect(m).not.toHaveProperty('shift');
        expect(m).not.toHaveProperty('day_night');
      }
    }
  });
});

describe('nothing writes them any more', () => {
  it('creating a manager leaves both NULL even when the body supplies them', async () => {
    const res = await auth(request(app).post('/api/staff-managers')).send({
      name: 'Fresh Manager', manager_type: 'ccm', shift: '1st', day_night: 'day',
    });
    expect(res.status).toBe(201);
    const row = obj(db.prepare('SELECT shift, day_night FROM staff_managers WHERE id = ?').get(res.body.manager.id));
    expect(row).toMatchObject({ shift: null, day_night: null });
  });

  it('patching them changes nothing and is not an error', async () => {
    const res = await auth(request(app).patch(`/api/staff-managers/${legacyId}`))
      .send({ shift: '1st', day_night: 'day' });
    // A stale tab posting a retired field gets a no-op, never a 400.
    expect(res.status).toBe(200);
    expect(res.body.ignored).toEqual(['shift', 'day_night']);
    const row = obj(db.prepare('SELECT shift, day_night FROM staff_managers WHERE id = ?').get(legacyId));
    expect(row).toMatchObject({ shift: '3rd', day_night: 'night' });
  });

  it('a genuinely empty patch is still refused', async () => {
    const res = await auth(request(app).patch(`/api/staff-managers/${legacyId}`)).send({});
    expect(res.status).toBe(400);
  });
});

describe('key forms carry no shift', () => {
  it('a form generated for someone with a stored shift does not expose it', async () => {
    const acct = db.prepare(`
      INSERT INTO accounts (ic_company_name, bc_client_number, record_type, status, archived, metal_keys)
      VALUES ('SHIFT TEST SITE', '01014288001', 'customer', 'active', 0, 3)
    `).run();

    const out = await auth(request(app).post('/api/assignments/checkout')).send({
      account_id: Number(acct.lastInsertRowid),
      holder: 'Legacy Shift Person',
      holder_email: 'legacy@citywideboston.com',
      holder_type: 'employee',
      keys: [{ type: 'metal', qty: 1 }],
      sign_mode: 'in_person',
    });
    expect(out.status).toBe(201);
    expect(out.body.key_form).not.toHaveProperty('holder_shift');

    // Not written to the row either, so the PDF has nothing to render.
    const stored = obj(db.prepare('SELECT holder_shift FROM key_form_docs ORDER BY id DESC LIMIT 1').get());
    expect(stored.holder_shift).toBeNull();

    const list = await auth(request(app).get('/api/key-forms'));
    for (const f of list.body.forms) expect(f).not.toHaveProperty('holder_shift');
  });
});

describe('exports carry no shift', () => {
  it('the CW Employees sheet has no Shift or Day/Night column', async () => {
    const res = await auth(request(app).post('/api/exports/registry'))
      .send({ scope: 'current', tab: 'cwemployees', format: 'csv' });
    expect(res.status).toBe(200);
    const text = res.text ?? res.body.toString();
    // Header row only: a person's NAME may legitimately contain the word.
    const header = text.split(/\r?\n/)[0];
    expect(header).not.toMatch(/Day\/Night/i);
    expect(header).not.toMatch(/\bShift\b/i);
    expect(header).toContain('Name');
  });

  it('the per-employee export model has no shift fields', async () => {
    const { buildEmployeeModel } = await import('../src/lib/employeeExport');
    const m = buildEmployeeModel({
      name: 'Legacy Shift Person', role_label: 'Account Manager (AM)',
      shift: '3rd', day_night: 'night',        // supplied, and ignored
      email: 'legacy@citywideboston.com', phone: null,
      holdings: [], accounts: [],
    });
    expect(m).not.toHaveProperty('shift');
    expect(m).not.toHaveProperty('day_night');
    expect(strings(m).join(' ')).not.toMatch(/3rd|night/i);
  });
});
