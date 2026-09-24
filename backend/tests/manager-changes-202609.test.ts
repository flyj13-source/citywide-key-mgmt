// ── Sept 2026 manager changes — staged against the production shape ─────────
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'citywide-mgrchg-'));
process.env.CITYWIDE_DB_DIR = TEST_DIR;
delete process.env.DB_PATH;
process.env.JWT_SECRET = 'test-secret';
process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
process.env.SEED_PASSWORD = 'demo1234';

const DB_FILE = path.join(TEST_DIR, 'citywide.db');
let app: Express;
let token: string;
let db: DatabaseSync;
let mod: typeof import('../src/lib/managerChanges202609');
const auth = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);
const obj = (r: any) => (r ? Object.assign({}, r) : null);
const byBc = (bc: string) => obj(db.prepare('SELECT * FROM accounts WHERE bc_client_number = ?').get(bc));
const audits = (a: string) => (db.prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY id').all(a) as any[]).map(obj);

beforeAll(async () => {
  app = (await import('../src/index')).default;
  (await import('../src/lib/autoSeed')).autoSeedIfEmpty();
  mod = await import('../src/lib/managerChanges202609');
  token = (await request(app).post('/api/auth/login')
    .send({ email: 'cara@citywideboston.com', password: 'demo1234' })).body.token;
  db = new DatabaseSync(DB_FILE);
});

const cust = (name: string, bc: string, extra: Record<string, any> = {}) => {
  const cols = ['ic_company_name', 'bc_client_number', 'record_type', 'status', 'archived', ...Object.keys(extra)];
  const vals = [name, bc, 'customer', 'active', 0, ...Object.values(extra)];
  return Number(db.prepare(`INSERT INTO accounts (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
    .run(...vals).lastInsertRowid);
};

beforeEach(() => {
  db.exec("DELETE FROM settings WHERE key LIKE 'mgr_change_2026_09%'");
  db.exec('DELETE FROM key_assignments');
  db.exec('DELETE FROM audit_log');
  db.exec('DELETE FROM access_codes');
  db.exec('DELETE FROM form_clients');
  db.exec('DELETE FROM key_form_docs');
  db.exec('DELETE FROM accounts WHERE COALESCE(is_test,0)=0');
  db.exec("DELETE FROM staff_managers WHERE name IN ('Jeremiah Williams','Julie Lynch','Odvin Rivas','Fallon Medrano')");
  const staff = db.prepare('INSERT INTO staff_managers (name, manager_type, role_category, email, active) VALUES (?,?,?,?,1)');
  staff.run('Jeremiah Williams', 'crew', 'crew', 'jwilliams@gocitywide.com');
  staff.run('Julie Lynch', 'account_manager', 'manager', 'jlynch@gocitywide.com');
  staff.run('Odvin Rivas', 'ccm', 'manager', 'orivas@gocitywide.com');
  staff.run('Fallon Medrano', 'ccm', 'manager', 'fmedrano@gocitywide.com');

  cust('Brooks Pond Apartments', '01014100061', { account_manager: 'Julie Lynch', am_metal: 1,
    pending_handover: 1, pending_handover_role: 'am', pending_handover_from: 'Julie Lynch', pending_handover_to: 'Someone' });
  cust('Brooks Pond II', '01014100050', { account_manager: 'Julie Lynch ' });          // stray space
  cust('Brooks Pond Village', '01014100613', { account_manager: 'Julie Lynch' });
  cust('Other Julie Site', '01014100999', { account_manager: 'Julie Lynch' });        // must NOT move
  cust('Odvin Site A', '01014100701', { ccm_manager: 'Odvin Rivas', ccm_metal: 2, ccm_fob: 1 });
  cust('Odvin Site B', '01014100702', { ccm_manager: 'odvin rivas' });
  cust('Not Odvin', '01014100703', { ccm_manager: 'Demo Manager B' });
  // Jeremiah still has keys out as crew.
  db.prepare(`INSERT INTO key_assignments (account_id, account_name, assignee, key_type, keys_held, keys_json,
    holder_type, checked_out_at, status) VALUES (?, 'Other Julie Site', 'Jeremiah Williams', 'metal', '1 Metal Key',
    '[{"type":"metal","label":"Metal Key","qty":1}]', 'employee', datetime('now'), 'checked_out')`).run(byBc('01014100999').id);
});

describe('SEPT 2026 MANAGER CHANGES', () => {
  it('applies all three, reports before/after, and audits each row', () => {
    const r = mod.applyManagerChanges202609();

    // 1 — Jeremiah: still holds crew keys, so 'both'; email untouched.
    expect(r.jeremiah.status).toBe('applied');
    expect(r.jeremiah.before).toMatchObject({ manager_type: 'crew', role_category: 'crew', email: 'jwilliams@gocitywide.com' });
    expect(r.jeremiah.after).toMatchObject({ manager_type: 'both', role_category: 'manager', email: 'jwilliams@gocitywide.com' });
    expect(Number(obj(db.prepare("SELECT COUNT(*) AS c FROM key_assignments WHERE assignee='Jeremiah Williams' AND status='checked_out'").get()).c)).toBe(1);

    // 2 — Brooks Pond ×3, including the one with a stray space; the other Julie site stays.
    for (const bc of ['01014100061', '01014100050', '01014100613']) expect(byBc(bc).account_manager).toBe('Jeremiah Williams');
    expect(byBc('01014100999').account_manager).toBe('Julie Lynch');
    expect(audits('account_manager_changed')).toHaveLength(3);
    expect(JSON.parse(audits('account_manager_changed')[0].metadata)).toMatchObject({ old: 'Julie Lynch', new: 'Jeremiah Williams' });

    // 3 — every Odvin CCM account, any spelling; the list, count and CCM keys reported.
    expect(r.odvin_to_fallon.count).toBe(2);
    expect(r.odvin_to_fallon.accounts.map((a) => a.name)).toEqual(['Odvin Site A', 'Odvin Site B']);
    expect(byBc('01014100701').ccm_manager).toBe('Fallon Medrano');
    expect(byBc('01014100702').ccm_manager).toBe('Fallon Medrano');
    expect(byBc('01014100703').ccm_manager).toBe('Demo Manager B');
    expect(r.odvin_to_fallon.with_ccm_keys).toEqual([
      expect.objectContaining({ name: 'Odvin Site A', total: 3, keys: { metal: 2, card: 0, fob: 1, dispenser: 0 } }),
    ]);
    expect(audits('ccm_manager_changed')).toHaveLength(2);

    // 4 — handover flag on a changed account cleared as auto-verified.
    expect(byBc('01014100061').pending_handover).toBe(0);
    expect(r.handovers_auto_verified.map((h) => h.name)).toEqual(['Brooks Pond Apartments']);
    expect(audits('handover_auto_verified')).toHaveLength(1);
    expect(audits('manager_changes_2026_09_applied')).toHaveLength(1);
  });

  it('runs once — a later correction in the UI is never overwritten', () => {
    mod.applyManagerChanges202609();
    db.prepare("UPDATE accounts SET account_manager = 'Corrected Later' WHERE bc_client_number = '01014100061'").run();
    const again = mod.applyManagerChanges202609();
    expect(byBc('01014100061').account_manager).toBe('Corrected Later');
    expect(again.brooks_pond.status).toBe('applied');          // the original report, kept
    expect(audits('account_manager_changed')).toHaveLength(3);
  });

  it('waits, rather than guessing, when a person is missing from the roster', () => {
    db.exec("DELETE FROM staff_managers WHERE name = 'Fallon Medrano'");
    const r = mod.applyManagerChanges202609();
    expect(r.odvin_to_fallon.status).toBe('fallon_not_eligible');
    expect(byBc('01014100701').ccm_manager).toBe('Odvin Rivas');
    // Added later → the next boot applies it.
    db.prepare("INSERT INTO staff_managers (name, manager_type, role_category, active) VALUES ('Fallon Medrano','ccm','manager',1)").run();
    const r2 = mod.applyManagerChanges202609();
    expect(r2.odvin_to_fallon.status).toBe('applied');
    expect(byBc('01014100701').ccm_manager).toBe('Fallon Medrano');
    expect(r2.brooks_pond.status).toBe('applied');              // carried forward from the first run
  });

  it('rosters recompute: Jeremiah is an AM with 3 clients, Julie keeps 1, Fallon has 2, Odvin 0', async () => {
    mod.applyManagerChanges202609();
    const am = (await auth(request(app).get('/api/staff-managers/roster?role=am'))).body.managers;
    const ccm = (await auth(request(app).get('/api/staff-managers/roster?role=ccm'))).body.managers;
    const n = (list: any[], name: string) => list.find((m: any) => m.name === name)?.clients_managed ?? 0;
    expect(n(am, 'Jeremiah Williams')).toBe(3);
    expect(n(am, 'Julie Lynch')).toBe(1);
    expect(n(ccm, 'Fallon Medrano')).toBe(2);
    expect(n(ccm, 'Odvin Rivas')).toBe(0);
    const diag = await auth(request(app).get('/api/_diag'));
    expect(diag.body.manager_changes_2026_09.odvin_to_fallon.count).toBe(2);
  });
});
