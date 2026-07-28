import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

// ── Isolated temp DB — the real citywide.db is NEVER touched ─────────────────
const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'citywide-roster-test-'));
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
const ids: Record<string, number> = {};

function openDb() { return new DatabaseSync(DB_FILE); }
function auth(req: request.Test) { return req.set('Authorization', `Bearer ${token}`); }

// Fixture: 4 clients + a holder grid. Jim is AM on A,B and CCM on D; Field Tech
// is pure crew (open check-outs on A + C); Jim ALSO has an open check-out on B,
// so he must become role_category='both'. One RETURNED check-out proves closed
// custody is excluded.
function seedFixture() {
  const db = openDb();
  const insert = db.prepare(`
    INSERT INTO accounts
      (ic_company_name, bc_client_number, ic_name, account_manager, ccm_manager,
       record_type, status,
       am_metal, am_card, am_fob, am_dispenser,
       ccm_metal, ccm_card, ccm_fob, ccm_dispenser,
       am_keys, ccm_keys, metal_keys, key_cards, has_fob, dispenser_keys)
    VALUES (?, ?, ?, ?, ?, 'customer', 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  // name, bc#, ic, AM, CCM, [am grid m/c/f/d], [ccm grid m/c/f/d], am_keys, ccm_keys, site m/c/f/d
  const rows: any[] = [
    ['SITE A', '01014200001', 'IC ONE', 'Jim Filek', 'Dana Cho', 2, 1, 0, 0, 0, 0, 0, 0, 3, 0, 2, 1, 0, 0],
    ['SITE B', '01014200002', 'IC TWO', 'Jim Filek', 'Pat Roe', 1, 0, 1, 0, 0, 0, 0, 0, 2, 0, 1, 0, 1, 0],
    ['SITE C', '01014200003', 'IC THREE', 'Pat Roe', 'Dana Cho', 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    ['SITE D', '01014200004', 'IC FOUR', 'Pat Roe', 'Jim Filek', 0, 0, 0, 0, 1, 1, 0, 1, 0, 3, 1, 1, 0, 1],
  ];
  for (const r of rows) insert.run(...r);

  const idOf = (name: string) =>
    Object.assign({}, db.prepare('SELECT id FROM accounts WHERE ic_company_name = ?').get(name)).id as number;
  ids.A = idOf('SITE A'); ids.B = idOf('SITE B'); ids.C = idOf('SITE C'); ids.D = idOf('SITE D');

  const asgn = db.prepare(`
    INSERT INTO key_assignments (account_id, account_name, assignee, key_type, status)
    VALUES (?, ?, ?, ?, ?)
  `);
  asgn.run(ids.A, 'SITE A', 'Field Tech', 'card', 'checked_out');
  asgn.run(ids.C, 'SITE C', 'Field Tech', 'fob', 'checked_out');
  asgn.run(ids.B, 'SITE B', 'Jim Filek', 'metal', 'checked_out'); // manager who also holds a field key
  asgn.run(ids.A, 'SITE A', 'Field Tech', 'card', 'returned');    // closed → excluded

  db.close();
}

beforeAll(async () => {
  app = (await import('../src/index')).default;
  const { autoSeedIfEmpty } = await import('../src/lib/autoSeed');
  autoSeedIfEmpty();

  const clean = openDb();
  clean.exec('DELETE FROM accounts; DELETE FROM staff_managers; DELETE FROM key_assignments; DELETE FROM staff_key_holders; DELETE FROM audit_log;');
  clean.close();

  seedFixture();

  const res = await request(app).post('/api/auth/login').send({ email: ADMIN_EMAIL, password: ADMIN_PASS });
  token = res.body.token;
});

describe('CREW BACKFILL', () => {
  it('discovers crew from check-out history and promotes overlapping managers to "both"', async () => {
    const { backfillStaffManagers } = await import('../src/lib/backfillStaffManagers');
    const r = backfillStaffManagers();
    // Managers: Jim (AM+CCM) + Pat (AM+CCM) → both; Dana (CCM only) → ccm.
    expect(r.created).toBe(3);
    expect(r.byType.both).toBe(2);
    expect(r.byType.ccm).toBe(1);
    // Crew: 2 distinct assignees seen (Field Tech, Jim Filek); Field Tech is new;
    // Jim already a manager → promoted to 'both', not created.
    expect(r.crewDistinct).toBe(2);
    expect(r.crewCreated).toBe(1);
    expect(r.crewPromotedToBoth).toBe(1);

    const db = openDb();
    const ft = Object.assign({}, db.prepare('SELECT manager_type, role_category FROM staff_managers WHERE name = ?').get('Field Tech'));
    const jim = Object.assign({}, db.prepare('SELECT manager_type, role_category FROM staff_managers WHERE name = ?').get('Jim Filek'));
    db.close();
    expect(ft.role_category).toBe('crew');
    expect(ft.manager_type).toBe('crew'); // non-null sentinel (column is NOT NULL)
    expect(jim.role_category).toBe('both');
    expect(jim.manager_type).toBe('both');
  });

  it('is idempotent — a second run adds no crew and re-promotes nobody', async () => {
    const { backfillStaffManagers } = await import('../src/lib/backfillStaffManagers');
    const r = backfillStaffManagers();
    expect(r.created).toBe(0);
    expect(r.crewCreated).toBe(0);
    expect(r.crewPromotedToBoth).toBe(0);
  });
});

describe('UNIFIED STAFF API', () => {
  it('requires auth', async () => {
    const res = await request(app).get('/api/staff');
    expect(res.status).toBe(401);
  });

  it('HAND-CHECK: a manager\'s Keys Held equals the sum of their holder-grid cells', async () => {
    const list = await auth(request(app).get('/api/staff?include_inactive=1'));
    expect(list.status).toBe(200);
    const jim = list.body.find((s: any) => s.name === 'Jim Filek');
    expect(jim).toBeTruthy();
    // Manager grid: A am(2+1)=3, B am(1+1)=2, D ccm(1+1+1)=3 → 8 as manager.
    // Plus one open field key on B (metal) → 9 total.
    expect(jim.role_category).toBe('both');
    expect(jim.keys_metal).toBe(5);      // 2(A)+1(B) am + 1(D) ccm + 1(B) crew metal
    expect(jim.keys_card).toBe(2);       // 1(A) am + 1(D) ccm
    expect(jim.keys_fob).toBe(1);        // 1(B) am
    expect(jim.keys_dispenser).toBe(1);  // 1(D) ccm
    expect(jim.total_keys_held).toBe(9);
    // Managed A,B,D + crew on B (dedup) → 3 distinct accounts.
    expect(jim.accounts_assigned).toBe(3);

    // Independent raw truth for the manager-only portion.
    const db = openDb();
    const raw = Object.assign({}, db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN account_manager='Jim Filek' THEN am_metal+am_card+am_fob+am_dispenser ELSE 0 END),0)
      + COALESCE(SUM(CASE WHEN ccm_manager='Jim Filek' THEN ccm_metal+ccm_card+ccm_fob+ccm_dispenser ELSE 0 END),0) AS held
      FROM accounts WHERE record_type='customer'
    `).get()).held;
    db.close();
    expect(raw).toBe(8); // manager grid only; +1 crew = the 9 above
  });

  it('surfaces crew with their open-checkout count and null manager_type', async () => {
    const list = await auth(request(app).get('/api/staff?include_inactive=1'));
    const ft = list.body.find((s: any) => s.name === 'Field Tech');
    expect(ft).toBeTruthy();
    expect(ft.role_category).toBe('crew');
    expect(ft.manager_type).toBeNull();
    expect(ft.total_keys_held).toBe(2);   // 2 open check-outs (returned one excluded)
    expect(ft.keys_card).toBe(1);
    expect(ft.keys_fob).toBe(1);
    expect(ft.accounts_assigned).toBe(2);
  });

  it('filters by category', async () => {
    const mgrs = await auth(request(app).get('/api/staff?category=managers&include_inactive=1'));
    const crew = await auth(request(app).get('/api/staff?category=crew&include_inactive=1'));
    const mgrNames = mgrs.body.map((s: any) => s.name);
    const crewNames = crew.body.map((s: any) => s.name);
    expect(mgrNames).toContain('Jim Filek');   // 'both' shows in managers
    expect(mgrNames).toContain('Dana Cho');
    expect(mgrNames).not.toContain('Field Tech');
    expect(crewNames).toContain('Field Tech');
    expect(crewNames).toContain('Jim Filek');   // 'both' shows in crew too
    expect(crewNames).not.toContain('Dana Cho');
  });

  it('detail returns per-source holdings + de-duplicated accounts', async () => {
    const list = await auth(request(app).get('/api/staff?include_inactive=1'));
    const jimId = list.body.find((s: any) => s.name === 'Jim Filek').id;
    const res = await auth(request(app).get(`/api/staff/${jimId}`));
    expect(res.status).toBe(200);
    const { staff } = res.body;
    const mgr = staff.holdings.filter((h: any) => h.source === 'manager');
    const crew = staff.holdings.filter((h: any) => h.source === 'crew');
    expect(mgr).toHaveLength(3);   // A, B, D
    expect(crew).toHaveLength(1);  // open B check-out
    expect(staff.accounts).toHaveLength(3);
  });

  it('does NOT leak crew into the manager-scoped roster', async () => {
    const res = await auth(request(app).get('/api/staff-managers?include_inactive=1'));
    const names = res.body.managers.map((m: any) => m.name);
    expect(names).toContain('Jim Filek');
    expect(names).not.toContain('Field Tech');
  });

  it('PATCH edits a crew member and audits it; rejects manager_type on crew', async () => {
    const list = await auth(request(app).get('/api/staff?include_inactive=1'));
    const ftId = list.body.find((s: any) => s.name === 'Field Tech').id;

    const patch = await auth(request(app).patch(`/api/staff/${ftId}`)).send({ shift: '2nd', day_night: 'night' });
    expect(patch.status).toBe(200);
    expect(patch.body.staff.shift).toBe('2nd');

    const bad = await auth(request(app).patch(`/api/staff/${ftId}`)).send({ manager_type: 'ccm' });
    expect(bad.status).toBe(400);

    const deact = await auth(request(app).patch(`/api/staff/${ftId}`)).send({ active: false });
    expect(deact.body.staff.active).toBe(0);

    const db = openDb();
    const actions = (db.prepare("SELECT action FROM audit_log WHERE action LIKE 'staff_%'").all() as any[])
      .map((r) => Object.assign({}, r).action);
    db.close();
    expect(actions).toContain('staff_edited');
    expect(actions).toContain('staff_deactivated');
  });
});

describe('ACCOUNT EDIT — account_edited audit diff', () => {
  it('logs exactly the changed fields and touches nothing else', async () => {
    const before = Object.assign({}, openDb().prepare('SELECT * FROM accounts WHERE id = ?').get(ids.A));

    // Full-object PATCH (as the modal sends) changing only AM + one grid cell.
    const payload: any = {
      ic_company_name: before.ic_company_name,
      bc_client_number: before.bc_client_number,
      bc_vendor_number: before.bc_vendor_number,
      ic_name: before.ic_name,
      account_manager: 'Newton Ames',     // changed
      ccm_manager: before.ccm_manager,    // unchanged
      keys_yn: before.keys_yn, security_app_yn: before.security_app_yn,
      am_metal: 9, am_card: before.am_card, am_fob: before.am_fob, am_dispenser: before.am_dispenser, // am_metal changed 2→9
      ccm_metal: before.ccm_metal, ccm_card: before.ccm_card, ccm_fob: before.ccm_fob, ccm_dispenser: before.ccm_dispenser,
      contractor_metal: before.contractor_metal, contractor_card: before.contractor_card, contractor_fob: before.contractor_fob, contractor_dispenser: before.contractor_dispenser,
      office_metal: before.office_metal, office_card: before.office_card, office_fob: before.office_fob, office_dispenser: before.office_dispenser,
      lockbox_code: before.lockbox_code, notes: before.notes, status: before.status,
    };
    const res = await auth(request(app).patch(`/api/accounts/${ids.A}`)).send(payload);
    expect(res.status).toBe(200);
    expect(res.body.changed).toContain('account_manager');
    expect(res.body.changed).toContain('am_metal');
    expect(res.body.changed).toContain('am_keys');   // column total recomputed (3→10)
    expect(res.body.changed).toContain('metal_keys'); // site row total recomputed
    expect(res.body.changed).not.toContain('ccm_manager');
    expect(res.body.changed).not.toContain('am_card');

    const after = Object.assign({}, openDb().prepare('SELECT * FROM accounts WHERE id = ?').get(ids.A));
    expect(after.account_manager).toBe('Newton Ames');
    expect(after.am_metal).toBe(9);
    expect(after.ccm_manager).toBe(before.ccm_manager); // untouched
    expect(after.am_card).toBe(before.am_card);         // untouched

    const db = openDb();
    const last = Object.assign({}, db.prepare("SELECT action, metadata FROM audit_log WHERE action='account_edited' ORDER BY id DESC LIMIT 1").get());
    db.close();
    expect(last.action).toBe('account_edited');
    const meta = JSON.parse(last.metadata);
    expect(meta.changed).toContain('account_manager');
  });

  it('never logs a secret code value — only which code rotated', async () => {
    const res = await auth(request(app).patch(`/api/accounts/${ids.B}`)).send({
      ic_company_name: 'SITE B', status: 'active', door_code: '4242',
    });
    expect(res.status).toBe(200);
    expect(res.body.changed).toContain('door_code');
    const db = openDb();
    const last = Object.assign({}, db.prepare("SELECT metadata FROM audit_log WHERE action='account_edited' ORDER BY id DESC LIMIT 1").get());
    db.close();
    expect(last.metadata).not.toContain('4242'); // value never stored in the log
  });
});
