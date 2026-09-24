// ── Handover pending: only when there are keys to hand over ─────────────────
// Verified on the ZZ TEST fixtures. AM One is the AM of client A (1 metal +
// 1 card on the AM cells) and client B (1 metal). A third client with NO AM
// keys is added for the zero-keys case.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'citywide-handover-'));
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
let reassign: typeof import('../src/lib/reassign');

const AM1 = 'ZZ Test AM One';
const AM2 = 'ZZ Test AM Two';
const auth = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);
const obj = (r: any) => (r ? Object.assign({}, r) : null);
const acct = (id: number) => obj(db.prepare('SELECT * FROM accounts WHERE id = ?').get(id));
const idOf = (bc: string) => Number(obj(db.prepare('SELECT id FROM accounts WHERE bc_client_number = ?').get(bc)).id);
const staffId = (name: string) => Number(obj(db.prepare('SELECT id FROM staff_managers WHERE name = ?').get(name)).id);
const audits = (action: string) =>
  (db.prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY id').all(action) as any[]).map(obj);

let zeroKeys: number;

beforeAll(async () => {
  app = (await import('../src/index')).default;
  (await import('../src/lib/autoSeed')).autoSeedIfEmpty();
  fx = await import('../src/lib/testFixtures');
  reassign = await import('../src/lib/reassign');
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
  // Fixture rows persist between tests; their handover state must not.
  db.exec(`UPDATE accounts SET pending_handover = 0, pending_handover_from = NULL, pending_handover_to = NULL,
    pending_handover_role = NULL, pending_handover_at = NULL`);
  // A client AM One manages whose AM cells are all zero.
  zeroKeys = Number(db.prepare(`
    INSERT INTO accounts (ic_company_name, bc_client_number, record_type, status, archived, is_test,
                          account_manager, metal_keys, contractor_metal)
    VALUES ('ZZ HANDOVER ZERO-KEY CLIENT', '01014199901', 'customer', 'active', 0, 0, ?, 1, 1)
  `).run(AM1).lastInsertRowid);
});

const doReassign = (clientIds: number[]) => auth(request(app).post('/api/managers/reassign')).send({
  fromId: staffId(AM1), toId: staffId(AM2), role: 'am', clientIds, sendHandover: true,
});

describe('1 — NO FLAG WHEN THERE IS NOTHING TO HAND OVER', () => {
  it('flags the client where the AM holds keys, not the one where they hold none', async () => {
    const a = idOf('09999900001');
    const res = await doReassign([a, zeroKeys]);
    expect(res.status).toBe(200);
    expect(acct(a)).toMatchObject({ account_manager: AM2, pending_handover: 1, pending_handover_from: AM1 });
    expect(acct(zeroKeys)).toMatchObject({ account_manager: AM2, pending_handover: 0 });
    expect(res.body.handoverFlagged).toEqual([a]);
    const summary = JSON.parse(audits('bulk_manager_reassignment')[0].metadata);
    expect(summary.handover_skipped_no_keys).toEqual([zeroKeys]);
  });

  it('a reassignment of only zero-key clients reports no pending handover', async () => {
    const res = await doReassign([zeroKeys]);
    expect(res.body.pending_handover).toBe(false);
  });
});

describe('2 — CLEAN UP EXISTING NOISE', () => {
  it('clears flags where the role holds nothing, audits each, keeps real ones', async () => {
    const a = idOf('09999900001');
    const flag = db.prepare(`UPDATE accounts SET pending_handover = 1, pending_handover_role = ?,
      pending_handover_from = ?, pending_handover_to = ? WHERE id = ?`);
    flag.run('am', AM1, AM2, zeroKeys);   // noise: AM cells are zero
    flag.run('am', AM1, AM2, a);          // real: AM holds 1 metal + 1 card
    const cleared = reassign.clearNoKeyHandovers();
    expect(cleared.map((c) => c.id)).toEqual([zeroKeys]);
    expect(acct(zeroKeys).pending_handover).toBe(0);
    expect(acct(a).pending_handover).toBe(1);
    const log = audits('handover_cleared_no_keys');
    expect(log).toHaveLength(1);
    expect(log[0].account_id).toBe(zeroKeys);
    expect(reassign.clearNoKeyHandovers()).toHaveLength(0);   // idempotent
  });

  it('a flag with no recorded role is cleared only when BOTH manager roles hold nothing', async () => {
    const b = idOf('09999900003');   // AM 1 metal, CCM 1 card
    db.prepare('UPDATE accounts SET pending_handover = 1, pending_handover_role = NULL WHERE id IN (?, ?)').run(b, zeroKeys);
    expect(reassign.clearNoKeyHandovers().map((c) => c.id)).toEqual([zeroKeys]);
    expect(acct(b).pending_handover).toBe(1);
  });

  it('the endpoint reports the count', async () => {
    db.prepare("UPDATE accounts SET pending_handover = 1, pending_handover_role = 'am' WHERE id = ?").run(zeroKeys);
    const res = await auth(request(app).post('/api/managers/handover/clear-no-keys')).send({});
    expect(res.status).toBe(200);
    expect(res.body.cleared).toBe(1);
  });
});

describe('3 + 4 — BULK CONFIRM, AND THE FILTER', () => {
  it('filters to every open handover, confirms several at once, audits per client', async () => {
    const a = idOf('09999900001'); const b = idOf('09999900003');
    await doReassign([a, b, zeroKeys]);

    const list = await auth(request(app).get('/api/accounts'))
      .query({ type: 'customer', handover_pending: '1', include_test: '1', limit: '50' });
    expect(list.body.accounts.map((x: any) => x.id).sort()).toEqual([a, b].sort());

    const res = await auth(request(app).post('/api/managers/handover/confirm')).send({ clientIds: [a, b] });
    expect(res.body.confirmed).toBe(2);
    expect(audits('handover_confirmed').map((x: any) => x.account_id).sort()).toEqual([a, b].sort());
    const after = await auth(request(app).get('/api/accounts'))
      .query({ type: 'customer', handover_pending: '1', include_test: '1' });
    expect(after.body.total).toBe(0);
  });
});
