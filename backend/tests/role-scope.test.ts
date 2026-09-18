// ── Role-scoped key selection ────────────────────────────────────────────────
// Check-in and check-out ask about ONE person's keys at a client. The client
// row splits its keys across four holders (AM, CCM, contractor, Office) and the
// site totals are the SUM across all four — so offering the site total to a
// named holder offers them everybody else's keys.
//
// ZZ TEST CLIENT A is the shape this is verified against:
//   AM         1 metal + 1 card
//   CCM        1 metal
//   Contractor 2 metal + 1 fob
//   Office     1 fob + 1 dispenser
//   ── site    4 metal, 1 card, 2 fob, 1 dispenser (8 keys)

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'citywide-rolescope-'));
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
const CCM1 = 'ZZ Test CCM One';
const CREW = 'ZZ Test No-Email Staff';
const IC = 'ZZ TEST CONTRACTOR — Do Not Use';
const CLIENT_A = 'ZZ TEST CLIENT A — Do Not Use';

const auth = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);

beforeAll(async () => {
  app = (await import('../src/index')).default;
  (await import('../src/lib/autoSeed')).autoSeedIfEmpty();
  fx = await import('../src/lib/testFixtures');
  const login = await request(app).post('/api/auth/login')
    .send({ email: 'cara@citywideboston.com', password: 'demo1234' });
  token = login.body.token;
  db = new DatabaseSync(DB_FILE);
});

beforeEach(() => {
  db.exec('DELETE FROM key_assignments');
  db.exec('DELETE FROM key_form_docs');
  db.exec('DELETE FROM audit_log');
  db.exec('DELETE FROM access_codes');
  db.exec('DELETE FROM accounts WHERE COALESCE(is_test,0)=0');
  db.exec('DELETE FROM staff_managers WHERE COALESCE(is_test,0)=0');
  fx.seedTestFixtures();
});

const clientA = (): number => {
  const raw = db.prepare('SELECT id FROM accounts WHERE bc_client_number = ?')
    .get('09999900001') as any;
  return Number(Object.assign({}, raw).id);
};

/** The key list the picker would show: type → site_total, zero rows dropped. */
const listFor = async (holder: string, type: 'employee' | 'ic' = 'employee') => {
  const res = await auth(request(app).get('/api/assignments/availability')
    .query({ account_id: clientA(), holder, holder_type: type }));
  expect(res.status).toBe(200);
  const shown: Record<string, number> = {};
  for (const t of res.body.types) if (t.site_total > 0) shown[t.type] = t.site_total;
  return { shown, scope: res.body.scope, types: res.body.types };
};

describe('§1 THE KEY LIST IS THE ROLE HOLDER’S, NOT THE SITE TOTAL', () => {
  it('the site total is the sum across all four holders — 8 keys', async () => {
    const res = await auth(request(app).get('/api/assignments/availability')
      .query({ account_id: clientA() }));
    expect(res.status).toBe(200);
    const by = Object.fromEntries(res.body.types.map((t: any) => [t.type, t.site_total]));
    expect(by).toEqual({ metal: 4, card: 1, fob: 2, dispenser: 1 });
  });

  it('the AM sees 1 metal + 1 card — not the 8-key total', async () => {
    const { shown, scope } = await listFor(AM1);
    expect(shown).toEqual({ metal: 1, card: 1 });
    expect(scope).toMatchObject({ holder: AM1, has_role: true, summary: 'AM' });
  });

  it('the contractor sees 2 metal + 1 fob', async () => {
    const { shown, scope } = await listFor(IC, 'ic');
    expect(shown).toEqual({ metal: 2, fob: 1 });
    expect(scope).toMatchObject({ has_role: true, summary: 'IC' });
  });

  it('the CCM sees 1 metal', async () => {
    const { shown, scope } = await listFor(CCM1);
    expect(shown).toEqual({ metal: 1 });
    expect(scope).toMatchObject({ has_role: true, summary: 'CCM' });
  });

  it('Office sees 1 fob + 1 dispenser', async () => {
    const { shown, scope } = await listFor('Office');
    expect(shown).toEqual({ fob: 1, dispenser: 1 });
    expect(scope).toMatchObject({ has_role: true, summary: 'Office' });
  });

  it('a holder with no role on the client gets has_role=false, not the total', async () => {
    const { shown, scope } = await listFor(CREW);
    expect(shown).toEqual({});
    expect(scope).toMatchObject({ holder: CREW, has_role: false, summary: null });
  });

  it('an employee never occupies the contractor slot by sharing its name', async () => {
    const { scope } = await listFor(IC, 'employee');
    expect(scope.has_role).toBe(false);
  });
});

describe('§2 THE CEILING FOLLOWS THE ROLE', () => {
  it("another holder's open check-out does not reduce this holder's ceiling", async () => {
    // The contractor takes both of their metal keys out.
    const out = await auth(request(app).post('/api/assignments/checkout').send({
      holder: IC, holder_type: 'ic', account_id: clientA(),
      keys: [{ type: 'metal', qty: 2 }],
      no_email_reason: 'Fixture contractor has no address on file',
    }));
    expect(out.status).toBe(201);

    const ic = await listFor(IC, 'ic');
    expect(ic.types.find((t: any) => t.type === 'metal')).toMatchObject({
      site_total: 2, checked_out: 2, available: 0,
    });
    // The AM's own metal key is untouched by it.
    const am = await listFor(AM1);
    expect(am.types.find((t: any) => t.type === 'metal')).toMatchObject({
      site_total: 1, checked_out: 0, available: 1,
    });
  });

  it('a first-time check-in cannot return more than the role holds', async () => {
    const res = await auth(request(app).post('/api/assignments/checkin').send({
      holder: IC, holder_type: 'ic', account_id: clientA(),
      keys: [{ type: 'metal', qty: 6 }],
    }));
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/holds 2 Metal Keys/);
  });

  it('a first-time check-in within the role is accepted', async () => {
    const res = await auth(request(app).post('/api/assignments/checkin').send({
      holder: IC, holder_type: 'ic', account_id: clientA(),
      keys: [{ type: 'metal', qty: 2 }, { type: 'fob', qty: 1 }],
    }));
    expect(res.status).toBe(201);
  });

  it('a first-time check-in for a key the role does not hold is refused', async () => {
    const res = await auth(request(app).post('/api/assignments/checkin').send({
      holder: AM1, account_id: clientA(), keys: [{ type: 'dispenser', qty: 1 }],
    }));
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/holds 0 Dispenser Keys/);
  });

  it('a holder with no role on the client cannot record a first-time return', async () => {
    const res = await auth(request(app).post('/api/assignments/checkin').send({
      holder: CREW, account_id: clientA(), keys: [{ type: 'metal', qty: 1 }],
    }));
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/No keys on record for/);
  });

  it('closing a real check-out is capped by the check-out, not the grid', async () => {
    // Crew hold no grid role, but keys genuinely issued to them come back.
    const out = await auth(request(app).post('/api/assignments/checkout').send({
      holder: CREW, account_id: clientA(), keys: [{ type: 'metal', qty: 1 }],
      no_email_reason: 'Crew member has no address on file',
    }));
    expect(out.status).toBe(201);
    const back = await auth(request(app).post('/api/assignments/checkin').send({
      holder: CREW, account_id: clientA(), keys: [{ type: 'metal', qty: 1 }],
    }));
    expect(back.status).toBe(200);
  });
});

describe('§3 CHECK-OUT IS CAPPED BY THE SITE, NOT THE GRID ROLE', () => {
  // Deliberate: the grid is a STANDING ATTRIBUTION of who is responsible for a
  // client's keys. A check-out is a TRANSACTION — crew, a temp or a covering
  // manager can legitimately be handed a key at a client they are not the AM,
  // CCM or contractor of. Capping check-out to the grid would refuse all of it.
  it('a holder with no grid role can still be issued a key that exists on site', async () => {
    const res = await auth(request(app).post('/api/assignments/checkout').send({
      holder: CREW, account_id: clientA(), keys: [{ type: 'metal', qty: 1 }],
      no_email_reason: 'Crew member has no address on file',
    }));
    expect(res.status).toBe(201);
  });

  it('but never more keys than physically exist at the client', async () => {
    const res = await auth(request(app).post('/api/assignments/checkout').send({
      holder: CREW, account_id: clientA(), keys: [{ type: 'metal', qty: 9 }],
      no_email_reason: 'Crew member has no address on file',
    }));
    expect(res.status).toBe(409);
  });
});

describe('§4 THE FORM AND THE TRANSACTION READ THE SAME SOURCE', () => {
  // The custody form sums the grid by role for its holdings view. If the key
  // picker read anything else, the document and the transaction that produced
  // it would state different holdings for the same person on the same day.
  const formLineForA = async (holder: string, type: 'employee' | 'ic' = 'employee') => {
    const { snapshotHolder } = await import('../src/lib/keyForm');
    return snapshotHolder(holder, type).find((l: any) => l.client === CLIENT_A) ?? null;
  };

  it.each([
    [AM1, 'employee', { metal: 1, card: 1, fob: 0, dispenser: 0 }],
    [CCM1, 'employee', { metal: 1, card: 0, fob: 0, dispenser: 0 }],
    [IC, 'ic', { metal: 2, card: 0, fob: 1, dispenser: 0 }],
  ] as const)('%s — the form line equals the picker list', async (holder, type, want) => {
    const line: any = await formLineForA(holder, type as any);
    expect(line).toMatchObject(want);

    const { types } = await listFor(holder, type as any);
    const picker = Object.fromEntries(types.map((t: any) => [t.type, t.site_total]));
    expect(picker).toEqual(want);
  });
});
