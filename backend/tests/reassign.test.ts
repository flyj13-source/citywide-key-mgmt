import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'citywide-reassign-'));
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
let odvinId: number, fallonId: number, ccmOnlyId: number;
const clientIds: number[] = [];

const openDb = () => new DatabaseSync(DB_FILE);
const auth = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);
const all = (sql: string, ...p: any[]) => {
  const db = openDb();
  const rows = (db.prepare(sql).all(...p) as any[]).map((r) => Object.assign({}, r));
  db.close();
  return rows;
};
const one = (sql: string, ...p: any[]) => all(sql, ...p)[0] ?? null;

beforeAll(async () => {
  app = (await import('../src/index')).default;
  (await import('../src/lib/autoSeed')).autoSeedIfEmpty();

  const login = await request(app).post('/api/auth/login')
    .send({ email: 'cara@citywideboston.com', password: 'demo1234' });
  token = login.body.token;

  const db = openDb();
  db.exec("DELETE FROM staff_managers");
  db.prepare("INSERT INTO staff_managers (name, manager_type, role_category, email, active) VALUES (?,?,?,?,1)")
    .run('Odvin Rivas', 'account_manager', 'manager', 'odvin@citywideboston.com');
  db.prepare("INSERT INTO staff_managers (name, manager_type, role_category, email, active) VALUES (?,?,?,?,1)")
    .run('Fallon Medrano', 'account_manager', 'manager', 'fallon@citywideboston.com');
  db.prepare("INSERT INTO staff_managers (name, manager_type, role_category, email, active) VALUES (?,?,?,?,1)")
    .run('Cece Ccm-Only', 'ccm', 'manager', 'cece@citywideboston.com');
  db.close();

  const roster = all("SELECT id, name FROM staff_managers ORDER BY id");
  odvinId = roster.find((r) => r.name === 'Odvin Rivas').id;
  fallonId = roster.find((r) => r.name === 'Fallon Medrano').id;
  ccmOnlyId = roster.find((r) => r.name === 'Cece Ccm-Only').id;

  // Three clients under Odvin, each with keys in the AM grid cells.
  const fixtures = [
    { name: 'REASSIGN CLIENT ONE',   bc: '01014300001', am_metal: 2, am_card: 1, am_fob: 0, am_dispenser: 0 },
    { name: 'REASSIGN CLIENT TWO',   bc: '01014300002', am_metal: 1, am_card: 0, am_fob: 1, am_dispenser: 0 },
    { name: 'REASSIGN CLIENT THREE', bc: '01014300003', am_metal: 0, am_card: 0, am_fob: 0, am_dispenser: 3 },
  ];
  for (const f of fixtures) {
    const res = await auth(request(app).post('/api/accounts')).send({
      record_type: 'customer', ic_company_name: f.name, bc_client_number: f.bc,
      account_manager: 'Odvin Rivas', ccm_manager: 'Cece Ccm-Only',
      am_metal: f.am_metal, am_card: f.am_card, am_fob: f.am_fob, am_dispenser: f.am_dispenser,
    });
    expect(res.status).toBe(201);
    clientIds.push(res.body.id);
  }
});

describe('REASSIGNABLE PAYLOAD', () => {
  it('lists the source manager clients with the keys held at each', async () => {
    const res = await auth(request(app).get(`/api/managers/${odvinId}/reassignable?role=am`));
    expect(res.status).toBe(200);
    expect(res.body.source.name).toBe('Odvin Rivas');
    expect(res.body.role_label).toBe('Account Manager');
    expect(res.body.clients).toHaveLength(3);
    expect(res.body.summary).toMatchObject({ clients: 3, keys: 8 });

    const one = res.body.clients.find((c: any) => c.name === 'REASSIGN CLIENT ONE');
    expect(one.total_keys).toBe(3);
    expect(one.keys).toEqual([
      { type: 'metal', label: 'Metal Key', qty: 2 },
      { type: 'card', label: 'Key Card', qty: 1 },
    ]);
  });

  it('offers only type-compatible targets — a CCM-only person is not an AM target', async () => {
    const res = await auth(request(app).get(`/api/managers/${odvinId}/reassignable?role=am`));
    const names = res.body.targets.map((t: any) => t.name);
    expect(names).toContain('Fallon Medrano');
    expect(names).not.toContain('Cece Ccm-Only');
  });
});

describe('BULK TRANSFER', () => {
  let auditId: number;

  it('blocks a cross-type target', async () => {
    const res = await auth(request(app).post('/api/managers/reassign'))
      .send({ fromId: odvinId, toId: ccmOnlyId, role: 'am', clientIds });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cannot take Account Manager clients/);
  });

  it('rejects clients not held by the source', async () => {
    const res = await auth(request(app).post('/api/managers/reassign'))
      .send({ fromId: odvinId, toId: fallonId, role: 'am', clientIds: [999999] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not currently assigned/);
  });

  it('PARTIAL transfer — unchecking one client moves only the other two', async () => {
    const subset = clientIds.slice(0, 2);
    const res = await auth(request(app).post('/api/managers/reassign'))
      .send({ fromId: odvinId, toId: fallonId, role: 'am', clientIds: subset, sendHandover: false });
    expect(res.status).toBe(200);
    expect(res.body.totalClients).toBe(2);

    const rows = all(
      `SELECT ic_company_name, account_manager FROM accounts WHERE id IN (${clientIds.join(',')}) ORDER BY id`
    );
    expect(rows[0].account_manager).toBe('Fallon Medrano');
    expect(rows[1].account_manager).toBe('Fallon Medrano');
    expect(rows[2].account_manager).toBe('Odvin Rivas'); // untouched
  });

  it('key counts are PRESERVED, not zeroed — the grid stays with the role', () => {
    const rows = all(
      `SELECT am_metal, am_card, am_fob, am_dispenser FROM accounts WHERE id IN (${clientIds.join(',')}) ORDER BY id`
    );
    expect(rows[0]).toMatchObject({ am_metal: 2, am_card: 1, am_fob: 0, am_dispenser: 0 });
    expect(rows[1]).toMatchObject({ am_metal: 1, am_card: 0, am_fob: 1, am_dispenser: 0 });
    expect(rows[2]).toMatchObject({ am_metal: 0, am_card: 0, am_fob: 0, am_dispenser: 3 });
  });

  it('writes one audit entry per client plus one summary', () => {
    const per = all("SELECT * FROM audit_log WHERE action = 'manager_reassigned' ORDER BY id");
    expect(per).toHaveLength(2);
    const m = JSON.parse(per[0].metadata);
    expect(m).toMatchObject({ from: 'Odvin Rivas', to: 'Fallon Medrano', role: 'am', keys_transferred: 3 });
    expect(m.client).toBe('REASSIGN CLIENT ONE');

    const summary = all("SELECT * FROM audit_log WHERE action = 'bulk_manager_reassignment' ORDER BY id");
    expect(summary).toHaveLength(1);
    const s = JSON.parse(summary[0].metadata);
    expect(s).toMatchObject({ from: 'Odvin Rivas', to: 'Fallon Medrano', total_clients: 2, total_keys: 5 });
    expect(s.actor).toBe('Cara Angeloni');
    auditId = summary[0].id;
  });

  it('roster tabs recompute for BOTH managers', async () => {
    const res = await auth(request(app).get('/api/managers/account-managers'));
    const byName = Object.fromEntries(res.body.managers.map((m: any) => [m.person, m]));
    expect(byName['Fallon Medrano'].clients_managed).toBe(2);
    expect(byName['Fallon Medrano'].personal_metal).toBe(3); // 2 + 1
    expect(byName['Odvin Rivas'].clients_managed).toBe(1);
    expect(byName['Odvin Rivas'].personal_dispenser).toBe(3);
  });

  it('UNDO restores every moved client', async () => {
    const res = await auth(request(app).post(`/api/managers/reassign/${auditId}/undo`));
    expect(res.status).toBe(200);
    expect(res.body.restored).toBe(2);
    expect(res.body.skipped).toBe(0);

    const rows = all(`SELECT account_manager FROM accounts WHERE id IN (${clientIds.join(',')})`);
    expect(rows.every((r) => r.account_manager === 'Odvin Rivas')).toBe(true);

    expect(all("SELECT * FROM audit_log WHERE action = 'reassignment_undone'")).toHaveLength(1);
  });

  it('the same reassignment cannot be undone twice', async () => {
    const res = await auth(request(app).post(`/api/managers/reassign/${auditId}/undo`));
    expect(res.status).toBe(409);
  });
});

describe('FULL TRANSFER + HANDOVER FLAG', () => {
  it('transfers all 3 and flags them pending_handover', async () => {
    const res = await auth(request(app).post('/api/managers/reassign'))
      .send({ fromId: odvinId, toId: fallonId, role: 'am', clientIds, sendHandover: true });
    expect(res.status).toBe(200);
    expect(res.body.totalClients).toBe(3);
    expect(res.body.totalKeys).toBe(8);
    expect(res.body.keyTypesAffected.sort()).toEqual(['Dispenser Key', 'Key Card', 'Key Fob', 'Metal Key']);
    // SMTP is unconfigured in tests — the failure is reported, never silent.
    expect(res.body.email.ok).toBe(false);
    expect(res.body.email.recipients).toEqual([
      'odvin@citywideboston.com', 'fallon@citywideboston.com', 'cara@citywideboston.com',
    ]);

    const pend = all('SELECT pending_handover, pending_handover_from, pending_handover_to FROM accounts WHERE id = ?', clientIds[0])[0];
    expect(pend).toMatchObject({
      pending_handover: 1, pending_handover_from: 'Odvin Rivas', pending_handover_to: 'Fallon Medrano',
    });
  });

  it('pending list surfaces them, confirm clears the flag + audits', async () => {
    const list = await auth(request(app).get('/api/managers/handover/pending'));
    expect(list.body.count).toBe(3);

    const res = await auth(request(app).post('/api/managers/handover/confirm')).send({ clientIds });
    expect(res.status).toBe(200);
    expect(res.body.confirmed).toBe(3);

    const after = await auth(request(app).get('/api/managers/handover/pending'));
    expect(after.body.count).toBe(0);
    expect(all("SELECT * FROM audit_log WHERE action = 'handover_confirmed'")).toHaveLength(3);
  });
});

describe('PERMISSIONS', () => {
  it('rejects a caller without can_delete', async () => {
    const db = openDb();
    db.prepare("INSERT INTO managers (name, email, password_hash, role, can_delete) VALUES (?,?,?,?,0)")
      .run('Plain User', 'plain@citywideboston.com',
           require('bcryptjs').hashSync('plain1234', 10), 'manager');
    db.close();
    const login = await request(app).post('/api/auth/login')
      .send({ email: 'plain@citywideboston.com', password: 'plain1234' });
    const res = await request(app).post('/api/managers/reassign')
      .set('Authorization', `Bearer ${login.body.token}`)
      .send({ fromId: odvinId, toId: fallonId, role: 'am', clientIds });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/delete permission/);
  });
});

describe('DIAGNOSTICS', () => {
  it('/api/_diag reports schema truth and is admin-gated', async () => {
    const res = await auth(request(app).get('/api/_diag'));
    expect(res.status).toBe(200);
    expect(res.body.holder_grid).toMatchObject({ expected: 16, present: 16, complete: true, missing: [] });
    expect(res.body.staff_managers.table_exists).toBe(true);
    expect(res.body.staff_managers.has_role_category).toBe(true);
    expect(res.body.features).toMatchObject({
      custody_multi_key: true, custody_signoff: true, pending_handover: true,
    });
    expect(typeof res.body.database.path).toBe('string');
    expect(res.body.database.on_mount).toBe(false); // temp dir, not /data
  });

  it('backfill endpoint is idempotent and reports counts', async () => {
    const first = await auth(request(app).post('/api/_diag/backfill-staff'));
    expect(first.status).toBe(200);
    const second = await auth(request(app).post('/api/_diag/backfill-staff'));
    expect(second.status).toBe(200);
    // Running it twice creates nothing new — the definition of idempotent.
    expect(second.body.managers_created).toBe(0);
    expect(second.body.row_count_after).toBe(second.body.row_count_before);
  });
});
