// ── Manager name changes that actually apply ─────────────────────────────────
// Verified on the ZZ TEST fixtures: clients A and B name ZZ Test AM One as AM,
// client C names ZZ Test AM Two.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'citywide-bulkmgr-'));
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
const CCM2 = 'ZZ Test CCM Two';
const auth = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);
const obj = (r: any) => (r ? Object.assign({}, r) : null);
const acct = (id: number) => obj(db.prepare('SELECT * FROM accounts WHERE id = ?').get(id));
const idOf = (bc: string) => Number(obj(db.prepare('SELECT id FROM accounts WHERE bc_client_number = ?').get(bc)).id);
const staffId = (name: string) => Number(obj(db.prepare('SELECT id FROM staff_managers WHERE name = ?').get(name)).id);
const audits = (action: string) =>
  (db.prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY id').all(action) as any[]).map(obj);

beforeAll(async () => {
  app = (await import('../src/index')).default;
  (await import('../src/lib/autoSeed')).autoSeedIfEmpty();
  fx = await import('../src/lib/testFixtures');
  token = (await request(app).post('/api/auth/login')
    .send({ email: 'cara@citywideboston.com', password: 'demo1234' })).body.token;
  db = new DatabaseSync(DB_FILE);
});

beforeEach(() => {
  db.exec('DELETE FROM key_assignments');
  db.exec('DELETE FROM form_clients');
  db.exec('DELETE FROM key_form_docs');
  db.exec('DELETE FROM audit_log');
  db.exec('DELETE FROM access_codes');
  db.exec('DELETE FROM accounts WHERE COALESCE(is_test,0)=0');
  db.exec('DELETE FROM staff_managers WHERE COALESCE(is_test,0)=0');
  fx.seedTestFixtures();
  db.exec('UPDATE accounts SET pending_handover = 0');
});

describe('THE CAUSE — a name that only LOOKS the same', () => {
  it('reassign now moves a client whose stored name has a trailing / non-breaking space or other case', async () => {
    const a = idOf('09999900001'); const b = idOf('09999900003');
    // What an import leaves behind: invisible in the registry, not equal in SQL.
    db.prepare('UPDATE accounts SET account_manager = ? WHERE id = ?').run(`${AM1} `, a);
    db.prepare('UPDATE accounts SET account_manager = ? WHERE id = ?').run(`zz test am one `, b);

    const list = await auth(request(app).get(`/api/managers/${staffId(AM1)}/reassignable?role=am`));
    expect(list.body.clients.map((c: any) => c.id).sort()).toEqual([a, b].sort());

    const res = await auth(request(app).post('/api/managers/reassign')).send({
      fromId: staffId(AM1), toId: staffId(AM2), role: 'am', clientIds: [a, b], sendHandover: false,
    });
    expect(res.status).toBe(200);
    // Applied immediately — not deferred to any handover confirmation.
    expect(acct(a).account_manager).toBe(AM2);
    expect(acct(b).account_manager).toBe(AM2);
  });

  it('the handover flag never gates the name change', async () => {
    const a = idOf('09999900001');
    await auth(request(app).post('/api/managers/reassign')).send({
      fromId: staffId(AM1), toId: staffId(AM2), role: 'am', clientIds: [a], sendHandover: true,
    });
    expect(acct(a)).toMatchObject({ account_manager: AM2, pending_handover: 1 });
  });
});

describe('DIRECT BULK EDIT — Change Account Manager / Change CCM', () => {
  it('sets the AM on every selected client, across different current managers, audited per client', async () => {
    const a = idOf('09999900001'); const c = idOf('09999900004');   // AM One and AM Two
    const res = await auth(request(app).post('/api/managers/bulk-set'))
      .send({ role: 'am', staffId: staffId(AM2), accountIds: [a, c] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ changed: 1, unchanged: 1, to: AM2 });   // C already had AM Two
    expect(acct(a).account_manager).toBe(AM2);
    const log = audits('account_manager_changed');
    expect(log).toHaveLength(1);
    expect(JSON.parse(log[0].metadata)).toMatchObject({ old: AM1, new: AM2, field: 'account_manager' });
    expect(log[0].account_id).toBe(a);
  });

  it('sets the CCM, with its own audit action', async () => {
    const a = idOf('09999900001');
    const res = await auth(request(app).post('/api/managers/bulk-set'))
      .send({ role: 'ccm', staffId: staffId(CCM2), accountIds: [a] });
    expect(res.status).toBe(200);
    expect(acct(a).ccm_manager).toBe(CCM2);
    expect(JSON.parse(audits('ccm_manager_changed')[0].metadata)).toMatchObject({ new: CCM2, field: 'ccm_manager' });
  });

  it('works with no keys involved, and flags no handover', async () => {
    const zero = Number(db.prepare(`INSERT INTO accounts (ic_company_name, bc_client_number, record_type, status, archived, account_manager)
      VALUES ('ZZ NO-KEY CLIENT', '01014199902', 'customer', 'active', 0, 'Julie Lynch')`).run().lastInsertRowid);
    const res = await auth(request(app).post('/api/managers/bulk-set'))
      .send({ role: 'am', staffId: staffId(AM2), accountIds: [zero] });
    expect(res.status).toBe(200);
    expect(acct(zero)).toMatchObject({ account_manager: AM2, pending_handover: 0 });
  });

  it('refuses a person the roster says cannot hold the role — and changes nothing', async () => {
    const a = idOf('09999900001');
    const res = await auth(request(app).post('/api/managers/bulk-set'))
      .send({ role: 'am', staffId: staffId(CCM2), accountIds: [a] });
    expect(res.status).toBe(400);
    expect(acct(a).account_manager).toBe(AM1);
    expect(audits('account_manager_changed')).toHaveLength(0);
  });

  it('refuses IC vendor records', async () => {
    const ic = Number(obj(db.prepare("SELECT id FROM accounts WHERE record_type = 'ic' LIMIT 1").get()).id);
    const res = await auth(request(app).post('/api/managers/bulk-set'))
      .send({ role: 'am', staffId: staffId(AM2), accountIds: [ic] });
    expect(res.status).toBe(400);
  });
});
