import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'citywide-mgr-'));
process.env.CITYWIDE_DB_DIR = TEST_DIR;
delete process.env.DB_PATH;
process.env.JWT_SECRET = 'test-secret';
process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
process.env.SEED_PASSWORD = 'demo1234';

const DB_FILE = path.join(TEST_DIR, 'citywide.db');
let app: Express;
let token: string;

const openDb = () => new DatabaseSync(DB_FILE);
const auth = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);

beforeAll(async () => {
  app = (await import('../src/index')).default;
  (await import('../src/lib/autoSeed')).autoSeedIfEmpty();
  const login = await request(app).post('/api/auth/login')
    .send({ email: 'cara@citywideboston.com', password: 'demo1234' });
  token = login.body.token;

  const db = openDb();
  db.exec('DELETE FROM staff_managers');
  db.exec('DELETE FROM accounts');
  const ins = db.prepare(
    "INSERT INTO staff_managers (name, manager_type, role_category, shift, day_night, email, active) VALUES (?,?,?,?,?,?,?)"
  );
  ins.run('Aggie AM', 'account_manager', 'manager', '1st', 'day', 'aggie@cw.test', 1);
  ins.run('Bea Both', 'both', 'manager', '2nd', 'night', 'bea@cw.test', 1);
  ins.run('Cleo CCM', 'ccm', 'manager', '3rd', 'night', null, 1);
  ins.run('Dorm Dan', 'account_manager', 'manager', '1st', 'day', 'dan@cw.test', 0);
  ins.run('Newbie Nina', 'account_manager', 'manager', '2nd', 'day', 'nina@cw.test', 1);
  db.close();

  // Aggie holds keys at two clients; Bea is AM at one and CCM at another.
  const mk = (body: any) => auth(request(app).post('/api/accounts')).send({ record_type: 'customer', ...body });
  await mk({ ic_company_name: 'CLIENT ONE', bc_client_number: '01014900001',
    account_manager: 'Aggie AM', ccm_manager: 'Cleo CCM',
    am_metal: 3, am_card: 1, ccm_metal: 2, metal_keys: 5, key_cards: 1 });
  await mk({ ic_company_name: 'CLIENT TWO', bc_client_number: '01014900002',
    account_manager: 'Aggie AM', am_fob: 2, am_dispenser: 1 });
  await mk({ ic_company_name: 'CLIENT THREE', bc_client_number: '01014900003',
    account_manager: 'Bea Both', ccm_manager: 'Bea Both', am_card: 4, ccm_fob: 1 });
  // A name that exists ONLY on a client row — no roster record.
  await mk({ ic_company_name: 'ORPHAN CLIENT', bc_client_number: '01014900004',
    account_manager: 'Ghost Gary', am_metal: 7 });
});

describe('ROSTER-DRIVEN MANAGER TABS', () => {
  it('lists staff_managers RECORDS with their attributes, not names off client rows', async () => {
    const res = await auth(request(app).get('/api/staff-managers/roster?role=am'));
    expect(res.status).toBe(200);
    const byName = Object.fromEntries(res.body.managers.map((m: any) => [m.name, m]));

    // Attributes that only exist on the roster record come through.
    expect(byName['Aggie AM']).toMatchObject({
      manager_type: 'account_manager', shift: '1st', day_night: 'day',
      email: 'aggie@cw.test', active: 1,
    });
    // Inactive people are still listed (the Active column has to mean something).
    expect(byName['Dorm Dan'].active).toBe(0);
    // A CCM-only person is NOT on the AM tab.
    expect(byName['Cleo CCM']).toBeUndefined();
    // 'both' appears on this tab.
    expect(byName['Bea Both']).toBeTruthy();
  });

  it('includes a roster hire with ZERO clients — invisible under the old grouping', async () => {
    const res = await auth(request(app).get('/api/staff-managers/roster?role=am'));
    const nina = res.body.managers.find((m: any) => m.name === 'Newbie Nina');
    expect(nina).toBeTruthy();
    expect(nina.clients_managed).toBe(0);
    expect(nina.total_held).toBe(0);

    // The OLD aggregate endpoint cannot see her at all — the bug being fixed.
    const old = await auth(request(app).get('/api/managers/account-managers'));
    expect(old.body.managers.find((m: any) => m.person === 'Newbie Nina')).toBeUndefined();
  });

  it('surfaces client-row names with no roster record instead of dropping them', async () => {
    const res = await auth(request(app).get('/api/staff-managers/roster?role=am'));
    // Not masquerading as a manager…
    expect(res.body.managers.find((m: any) => m.name === 'Ghost Gary')).toBeUndefined();
    // …but not silently lost either — they hold 7 real keys.
    const ghost = res.body.unmatched.find((u: any) => u.person === 'Ghost Gary');
    expect(ghost).toMatchObject({ clients_managed: 1, total_held: 7 });
  });

  it('aggregates match a hand count of the client rows', async () => {
    const res = await auth(request(app).get('/api/staff-managers/roster?role=am'));
    const aggie = res.body.managers.find((m: any) => m.name === 'Aggie AM');
    // CLIENT ONE: 3 metal + 1 card.  CLIENT TWO: 2 fob + 1 dispenser.
    expect(aggie).toMatchObject({
      clients_managed: 2,
      personal_metal: 3, personal_cards: 1, personal_fobs: 2, personal_dispenser: 1,
      total_held: 7,
    });
    // Managed inventory = every key at those clients, not just Aggie's own:
    // CLIENT ONE 5 metal + 1 card = 6, CLIENT TWO 2 fob + 1 dispenser = 3.
    expect(aggie.total_client_keys).toBe(9);
  });

  it('splits a "both" manager per role — AM keys on the AM tab, CCM keys on the CCM tab', async () => {
    const am = await auth(request(app).get('/api/staff-managers/roster?role=am'));
    const ccm = await auth(request(app).get('/api/staff-managers/roster?role=ccm'));
    const beaAm = am.body.managers.find((m: any) => m.name === 'Bea Both');
    const beaCcm = ccm.body.managers.find((m: any) => m.name === 'Bea Both');
    expect(beaAm).toMatchObject({ personal_cards: 4, personal_fobs: 0, total_held: 4 });
    expect(beaCcm).toMatchObject({ personal_fobs: 1, personal_cards: 0, total_held: 1 });
  });

  it('the CCM tab is roster-driven too', async () => {
    const res = await auth(request(app).get('/api/staff-managers/roster?role=ccm'));
    const names = res.body.managers.map((m: any) => m.name).sort();
    expect(names).toEqual(['Bea Both', 'Cleo CCM']);
    const cleo = res.body.managers.find((m: any) => m.name === 'Cleo CCM');
    expect(cleo).toMatchObject({ shift: '3rd', day_night: 'night', email: null, personal_metal: 2 });
  });

  it('detail carries per-client role and keys held there BY TYPE', async () => {
    const roster = await auth(request(app).get('/api/staff-managers/roster?role=am'));
    const aggieId = roster.body.managers.find((m: any) => m.name === 'Aggie AM').id;
    const res = await auth(request(app).get(`/api/staff-managers/${aggieId}`));
    expect(res.status).toBe(200);
    const one = res.body.clients.find((c: any) => c.ic_company_name === 'CLIENT ONE');
    expect(one.role).toBe('AM');
    expect(one.keys_by_type).toEqual([
      { type: 'metal', label: 'Metal Key', qty: 3 },
      { type: 'card', label: 'Key Card', qty: 1 },
    ]);
  });

  // `role` is ONE string, not an array — the detail panel splits it on ' + ' to
  // render a badge per role, so the shape here is load-bearing for the UI.
  it('a manager who is both AM and CCM at a client gets a combined role string', async () => {
    const roster = await auth(request(app).get('/api/staff-managers/roster?role=am'));
    const beaId = roster.body.managers.find((m: any) => m.name === 'Bea Both').id;
    const res = await auth(request(app).get(`/api/staff-managers/${beaId}`));
    const three = res.body.clients.find((c: any) => c.ic_company_name === 'CLIENT THREE');
    expect(typeof three.role).toBe('string');
    expect(three.role).toBe('AM + CCM');
    expect(three.role.split(' + ')).toEqual(['AM', 'CCM']);
  });
});
