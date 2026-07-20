import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

// ── Isolated temp DB — the real citywide.db is NEVER touched ─────────────────
const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'citywide-sm-test-'));
process.env.CITYWIDE_DB_DIR = TEST_DIR;
delete process.env.DB_PATH;
process.env.JWT_SECRET = 'test-secret';
process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
process.env.SEED_PASSWORD = 'demo1234';

const DB_FILE = path.join(TEST_DIR, 'citywide.db');
const ADMIN_EMAIL = 'cara@citywideboston.com';
const ADMIN_PASS = 'demo1234';

let app: Express;
let token: string;

function openDb() { return new DatabaseSync(DB_FILE); }
function auth(req: request.Test) { return req.set('Authorization', `Bearer ${token}`); }

// A tiny fixed client fixture: Jim Filek is AM on 3, CCM on 1; Dana is CCM on 2;
// "both" case (Pat) appears in BOTH columns; a 999-sentinel row is excluded.
function seedClients() {
  const db = openDb();
  const insert = db.prepare(`
    INSERT INTO accounts
      (ic_company_name, bc_client_number, ic_name, account_manager, ccm_manager,
       record_type, status,
       am_keys, ccm_keys, metal_keys, key_cards, has_fob, dispenser_keys)
    VALUES (?, ?, ?, ?, ?, 'customer', 'active', ?, ?, ?, ?, ?, ?)
  `);
  // ic_company, bc#, ic_name, AM, CCM, am_keys, ccm_keys, metal, card, fob, disp
  const rows: any[] = [
    ['SITE A', '01014200001', 'IC ONE INC', 'Jim Filek', 'Dana Cho', 2, 1, 1, 1, 1, 0],
    ['SITE B', '01014200002', 'IC TWO INC', 'Jim Filek', 'Pat Roe', 1, 0, 2, 0, 0, 0],
    ['SITE C', '01014200003', 'IC THREE INC', 'Jim Filek', 'Dana Cho', 3, 2, 1, 1, 0, 1],
    ['SITE D', '01014200004', 'IC FOUR INC', 'Pat Roe', 'Jim Filek', 4, 5, 3, 2, 1, 0],
    ['SITE E', '01014200005', 'IC FIVE INC', 'Pat Roe', 'Pat Roe', 1, 1, 1, 0, 0, 0],
    ['SENTINEL', '99900000001', 'IC TEST', 'Jim Filek', 'Dana Cho', 9, 9, 9, 9, 9, 9],
  ];
  for (const r of rows) insert.run(r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8], r[9], r[10]);
  db.close();
}

beforeAll(async () => {
  app = (await import('../src/index')).default;
  const { autoSeedIfEmpty } = await import('../src/lib/autoSeed');
  autoSeedIfEmpty(); // creates the login manager (also inserts demo data + backfills)

  // Wipe the demo data autoSeed created so this suite owns a clean fixture. The
  // login-account table (managers) is left intact so we can authenticate.
  const clean = openDb();
  clean.exec('DELETE FROM accounts; DELETE FROM staff_managers; DELETE FROM audit_log;');
  clean.close();

  seedClients();

  const res = await request(app).post('/api/auth/login').send({ email: ADMIN_EMAIL, password: ADMIN_PASS });
  token = res.body.token;
});

describe('BACKFILL', () => {
  it('seeds one row per distinct name, inferring "both" from cross-column names', async () => {
    const { backfillStaffManagers } = await import('../src/lib/backfillStaffManagers');
    const r = backfillStaffManagers();
    // Distinct real names (sentinel excluded): Jim Filek, Dana Cho, Pat Roe
    expect(r.created).toBe(3);
    // Jim (AM+CCM) and Pat (AM+CCM) → both; Dana (CCM only) → ccm
    expect(r.byType.both).toBe(2);
    expect(r.byType.ccm).toBe(1);
    expect(r.byType.account_manager).toBe(0);

    const db = openDb();
    const jim = db.prepare('SELECT manager_type FROM staff_managers WHERE name = ?').get('Jim Filek') as any;
    const dana = db.prepare('SELECT manager_type FROM staff_managers WHERE name = ?').get('Dana Cho') as any;
    db.close();
    expect(Object.assign({}, jim).manager_type).toBe('both');
    expect(Object.assign({}, dana).manager_type).toBe('ccm');
  });

  it('is idempotent — a second run creates nothing', async () => {
    const { backfillStaffManagers } = await import('../src/lib/backfillStaffManagers');
    const r = backfillStaffManagers();
    expect(r.created).toBe(0);
    expect(r.alreadyPresent).toBe(3);
  });

  it('never mutates the client rows or the login-account table', async () => {
    const db = openDb();
    const clientCount = Object.assign({}, db.prepare("SELECT COUNT(*) c FROM accounts WHERE record_type='customer'").get()).c;
    const logins = Object.assign({}, db.prepare('SELECT COUNT(*) c FROM managers').get()).c;
    // account_manager text columns untouched
    const jimRows = Object.assign({}, db.prepare("SELECT COUNT(*) c FROM accounts WHERE account_manager='Jim Filek'").get()).c;
    db.close();
    expect(clientCount).toBe(6);        // 5 real + 1 sentinel, all intact
    expect(logins).toBe(1);             // only the seeded login account
    expect(jimRows).toBe(4);            // 3 real AM rows + 1 sentinel, untouched
  });
});

describe('STAFF-MANAGERS API', () => {
  it('requires auth', async () => {
    const res = await request(app).get('/api/staff-managers');
    expect(res.status).toBe(401);
  });

  it('HAND-CHECK: Jim Filek clients_managed == raw count of client rows he manages', async () => {
    const list = await auth(request(app).get('/api/staff-managers'));
    expect(list.status).toBe(200);
    const jim = list.body.managers.find((m: any) => m.name === 'Jim Filek');
    expect(jim).toBeTruthy();

    // Raw truth: distinct non-sentinel customer rows where Jim is AM or CCM.
    const db = openDb();
    const raw = Object.assign({}, db.prepare(`
      SELECT COUNT(*) c FROM accounts
      WHERE record_type='customer' AND COALESCE(archived,0)=0
        AND (bc_client_number IS NULL OR bc_client_number NOT LIKE '999%')
        AND (account_manager='Jim Filek' OR ccm_manager='Jim Filek')
    `).get()).c;
    db.close();

    // Jim: AM on A,B,C + CCM on D = 4 distinct clients (sentinel excluded)
    expect(jim.clients_managed).toBe(4);
    expect(jim.clients_managed).toBe(raw);
    // Keys personally held = am_keys where AM (2+1+3) + ccm_keys where CCM (5) = 11
    expect(jim.keys_personally_held).toBe(11);
    // Total managed inventory = site row totals across his 4 clients
    // A(3)+B(2)+C(3)+D(6) = 14
    expect(jim.total_managed_inventory).toBe(14);
  });

  it('detail returns the client book with per-client role + keys', async () => {
    const list = await auth(request(app).get('/api/staff-managers'));
    const jimId = list.body.managers.find((m: any) => m.name === 'Jim Filek').id;
    const res = await auth(request(app).get(`/api/staff-managers/${jimId}`));
    expect(res.status).toBe(200);
    expect(res.body.clients).toHaveLength(4);
    const siteA = res.body.clients.find((c: any) => c.ic_company_name === 'SITE A');
    expect(siteA.role).toBe('AM');
    const siteD = res.body.clients.find((c: any) => c.ic_company_name === 'SITE D');
    expect(siteD.role).toBe('CCM');
    // Sentinel client must not appear
    expect(res.body.clients.find((c: any) => c.ic_company_name === 'SENTINEL')).toBeFalsy();
  });

  it('creates, updates, and soft-deactivates (never hard-deletes)', async () => {
    const create = await auth(request(app).post('/api/staff-managers')).send({
      name: 'New Person', manager_type: 'account_manager', shift: '2nd', day_night: 'day', email: 'np@x.com',
    });
    expect(create.status).toBe(201);
    const id = create.body.manager.id;
    expect(create.body.manager.shift).toBe('2nd');

    const patch = await auth(request(app).patch(`/api/staff-managers/${id}`)).send({ shift: '3rd', active: false });
    expect(patch.status).toBe(200);
    expect(patch.body.manager.shift).toBe('3rd');
    expect(patch.body.manager.active).toBe(0);

    // Soft-deactivated → gone from default list, present with include_inactive.
    const active = await auth(request(app).get('/api/staff-managers'));
    expect(active.body.managers.find((m: any) => m.id === id)).toBeFalsy();
    const all = await auth(request(app).get('/api/staff-managers?include_inactive=1'));
    expect(all.body.managers.find((m: any) => m.id === id)).toBeTruthy();

    // Row still physically exists (audit integrity).
    const db = openDb();
    const still = db.prepare('SELECT active FROM staff_managers WHERE id = ?').get(id) as any;
    db.close();
    expect(Object.assign({}, still).active).toBe(0);
  });

  it('rejects an invalid manager_type', async () => {
    const res = await auth(request(app).post('/api/staff-managers')).send({ name: 'Bad', manager_type: 'boss' });
    expect(res.status).toBe(400);
  });

  it('writes audit entries for create + deactivate', async () => {
    const db = openDb();
    const actions = (db.prepare("SELECT action FROM audit_log WHERE action LIKE 'staff_manager%'").all() as any[])
      .map((r) => Object.assign({}, r).action);
    db.close();
    expect(actions).toContain('staff_manager_created');
    expect(actions).toContain('staff_manager_deactivated');
  });
});
