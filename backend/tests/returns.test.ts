import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

// ── Check In without a record picker ─────────────────────────────────────────
// The modal no longer asks which check-out the keys came from. Everything here
// exercises the inference that replaced it: one open record, several, or none,
// all reached through the same call with the same body shape.

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'citywide-returns-'));
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
const scalar = (sql: string, ...p: any[]) => Object.assign({}, db.prepare(sql).get(...p) as any).c as number;
const rows = (sql: string, ...p: any[]) => (db.prepare(sql).all(...p) as any[]).map(obj);

const HOLDER = 'Return Tester';
const EMAIL = 'return.tester@citywideboston.com';
let accountId: number;

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
  db.exec('DELETE FROM audit_log');
  db.exec("DELETE FROM accounts WHERE bc_client_number = '01014100777'");
  db.exec("DELETE FROM staff_managers WHERE name = 'Return Tester'");
  db.prepare(
    "INSERT INTO staff_managers (name, manager_type, role_category, email, active) VALUES (?, 'account_manager', 'manager', ?, 1)"
  ).run(HOLDER, EMAIL);
  const a = db.prepare(
    "INSERT INTO accounts (ic_company_name, bc_client_number, record_type, status, archived, metal_keys, key_cards, has_fob)" +
    " VALUES ('RETURN SITE','01014100777','customer','active',0,6,4,2)"
  ).run();
  accountId = Number(a.lastInsertRowid);
});

/** An open check-out for the standard holder, with an explicit timestamp. */
const openRecord = (keys: { type: string; label: string; qty: number }[], checkedOutAt: string) => {
  const r = db.prepare(`
    INSERT INTO key_assignments
      (account_id, account_name, assignee, assignee_email, key_type, keys_held, keys_json,
       holder_type, recorded_by, checked_out_at, status)
    VALUES (?, 'RETURN SITE', ?, ?, ?, ?, ?, 'employee', 'Cara Angeloni', ?, 'checked_out')
  `).run(
    accountId, HOLDER, EMAIL, keys[0].type,
    keys.map((k) => `${k.qty} ${k.label}`).join(', '), JSON.stringify(keys), checkedOutAt,
  );
  return Number(r.lastInsertRowid);
};

const METAL = (qty: number) => ({ type: 'metal', label: 'Metal Key', qty });
const CARD = (qty: number) => ({ type: 'card', label: 'Key Card', qty });
const FOB = (qty: number) => ({ type: 'fob', label: 'Key Fob', qty });

const checkIn = (keys: { type: string; qty: number }[]) =>
  auth(request(app).post('/api/assignments/checkin')).send({
    holder: HOLDER, holder_email: EMAIL, holder_type: 'employee',
    account_id: accountId, keys, condition_on_return: 'good', sign_mode: 'in_person',
  });

describe('§1 THE ALLOCATION RULE', () => {
  it('consumes the OLDEST record first', async () => {
    const older = openRecord([METAL(1)], '2026-01-10T09:00:00.000Z');
    const newer = openRecord([METAL(1)], '2026-06-01T09:00:00.000Z');

    const res = await checkIn([{ type: 'metal', qty: 1 }]);
    expect(res.status).toBe(200);

    // The stale record is the one somebody is chasing — it closes first.
    expect(obj(db.prepare('SELECT status FROM key_assignments WHERE id=?').get(older)).status).toBe('returned');
    expect(obj(db.prepare('SELECT status FROM key_assignments WHERE id=?').get(newer)).status).toBe('checked_out');
  });

  it('closes several records when the return covers them all', async () => {
    const a = openRecord([METAL(1)], '2026-01-10T09:00:00.000Z');
    const b = openRecord([CARD(1)], '2026-02-10T09:00:00.000Z');
    const c = openRecord([FOB(1)], '2026-03-10T09:00:00.000Z');

    const res = await checkIn([
      { type: 'metal', qty: 1 }, { type: 'card', qty: 1 }, { type: 'fob', qty: 1 },
    ]);
    expect(res.status).toBe(200);
    expect(res.body.closed_records.sort()).toEqual([a, b, c].sort());
    expect(scalar("SELECT COUNT(*) AS c FROM key_assignments WHERE status='checked_out'")).toBe(0);
  });

  it('splits at most ONE record, leaving the remainder out', async () => {
    const a = openRecord([METAL(2)], '2026-01-10T09:00:00.000Z');
    const b = openRecord([METAL(2)], '2026-02-10T09:00:00.000Z');

    // Three of four metal keys come back: A closes, B is split 1/1.
    const res = await checkIn([{ type: 'metal', qty: 3 }]);
    expect(res.status).toBe(200);
    expect(res.body.partial).toBe(true);
    expect(obj(db.prepare('SELECT status FROM key_assignments WHERE id=?').get(a)).status).toBe('returned');

    const remainder = obj(db.prepare('SELECT status, keys_json FROM key_assignments WHERE id=?').get(b));
    expect(remainder.status).toBe('checked_out');
    expect(JSON.parse(remainder.keys_json)).toEqual([expect.objectContaining({ type: 'metal', qty: 1 })]);

    // …and the returned half of B exists as its own closed row.
    const returned = rows("SELECT * FROM key_assignments WHERE status='returned'");
    expect(returned).toHaveLength(2);
    expect(returned.reduce((n, r) => n + JSON.parse(r.keys_json).reduce((m: number, k: any) => m + k.qty, 0), 0))
      .toBe(3);
  });

  it('leaves records the return never reached completely alone', async () => {
    openRecord([METAL(1)], '2026-01-10T09:00:00.000Z');
    const untouched = openRecord([FOB(1)], '2026-02-10T09:00:00.000Z');

    await checkIn([{ type: 'metal', qty: 1 }]);
    const row = obj(db.prepare('SELECT status, keys_json, returned_at FROM key_assignments WHERE id=?').get(untouched));
    expect(row.status).toBe('checked_out');
    expect(row.returned_at).toBeNull();
    expect(JSON.parse(row.keys_json)).toEqual([expect.objectContaining({ type: 'fob', qty: 1 })]);
  });

  it('records keys no open record accounts for rather than refusing them', async () => {
    openRecord([METAL(1)], '2026-01-10T09:00:00.000Z');
    openRecord([CARD(1)], '2026-02-10T09:00:00.000Z');

    // A fob nobody ever checked out comes back with the rest.
    const res = await checkIn([
      { type: 'metal', qty: 1 }, { type: 'card', qty: 1 }, { type: 'fob', qty: 1 },
    ]);
    expect(res.status).toBe(200);
    expect(res.body.reconciled).toBe(true);

    const extra = obj(db.prepare(
      "SELECT * FROM key_assignments WHERE origin='reconciled' ORDER BY id DESC LIMIT 1"
    ).get());
    expect(JSON.parse(extra.keys_json)).toEqual([expect.objectContaining({ type: 'fob', qty: 1 })]);
    expect(extra.status).toBe('returned');
  });

  it('returns everything out when no key list is given', async () => {
    openRecord([METAL(1)], '2026-01-10T09:00:00.000Z');
    openRecord([CARD(2)], '2026-02-10T09:00:00.000Z');

    const res = await auth(request(app).post('/api/assignments/checkin')).send({
      holder: HOLDER, holder_email: EMAIL, holder_type: 'employee',
      account_id: accountId, condition_on_return: 'good', sign_mode: 'in_person',
    });
    expect(res.status).toBe(200);
    expect(scalar("SELECT COUNT(*) AS c FROM key_assignments WHERE status='checked_out'")).toBe(0);
  });

  it('writes which records the one return touched into the audit trail', async () => {
    const a = openRecord([METAL(1)], '2026-01-10T09:00:00.000Z');
    const b = openRecord([METAL(2)], '2026-02-10T09:00:00.000Z');
    await checkIn([{ type: 'metal', qty: 2 }]);

    const meta = JSON.parse(obj(db.prepare(
      "SELECT metadata FROM audit_log WHERE action='key_checked_in' ORDER BY id DESC LIMIT 1"
    ).get()).metadata);
    expect(meta.spanned_records.sort()).toEqual([a, b].sort());
    expect(meta.closed_records).toEqual([a]);
    expect(meta.split_record).toBe(b);
    expect(meta.resolution).toMatch(/closed 1 record; split/);
  });
});

describe('§2 THE THREE PATHS, ONE REQUEST SHAPE', () => {
  it('NO prior check-out — accepted and closed, no warning to dismiss', async () => {
    const res = await checkIn([{ type: 'metal', qty: 1 }]);
    expect(res.status).toBe(201);
    expect(res.body.reconciled).toBe(true);
    const row = obj(db.prepare('SELECT * FROM key_assignments ORDER BY id DESC LIMIT 1').get());
    expect(row).toMatchObject({ status: 'returned', origin: 'reconciled', assignee: HOLDER });
  });

  it('ONE prior check-out — that record closes', async () => {
    const id = openRecord([METAL(1), CARD(1)], '2026-01-10T09:00:00.000Z');
    const res = await checkIn([{ type: 'metal', qty: 1 }, { type: 'card', qty: 1 }]);
    expect(res.status).toBe(200);
    expect(obj(db.prepare('SELECT status FROM key_assignments WHERE id=?').get(id)).status).toBe('returned');
    // Not a reconciling entry — the real record was found and used.
    expect(scalar("SELECT COUNT(*) AS c FROM key_assignments WHERE origin='reconciled'")).toBe(0);
  });

  it('TWO prior check-outs — both close, and nothing was picked', async () => {
    const a = openRecord([METAL(1)], '2026-01-10T09:00:00.000Z');
    const b = openRecord([CARD(1)], '2026-02-10T09:00:00.000Z');
    // The request carries no assignment id at all: the UI has none to send.
    const res = await checkIn([{ type: 'metal', qty: 1 }, { type: 'card', qty: 1 }]);
    expect(res.status).toBe(200);
    expect(res.body.spanned_records).toBe(2);
    for (const id of [a, b]) {
      expect(obj(db.prepare('SELECT status FROM key_assignments WHERE id=?').get(id)).status).toBe('returned');
    }
  });

  it('a return still produces a signature form and a sign-off link', async () => {
    openRecord([METAL(1)], '2026-01-10T09:00:00.000Z');
    openRecord([CARD(1)], '2026-02-10T09:00:00.000Z');
    const res = await checkIn([{ type: 'metal', qty: 1 }, { type: 'card', qty: 1 }]);
    expect(res.body.signoff_link).toBeTruthy();
    expect(res.body.key_form).toMatchObject({ event_type: 'checkin', holder_name: HOLDER });
  });
});

describe('§3 THE CONTEXT LINE', () => {
  it('reports the earliest open check-out, so the line has a date', async () => {
    openRecord([METAL(1)], '2026-03-10T09:00:00.000Z');
    openRecord([CARD(1)], '2026-01-05T09:00:00.000Z');

    const res = await auth(request(app).get(
      `/api/assignments/return-context?account_id=${accountId}&holder=${encodeURIComponent(HOLDER)}`
    ));
    expect(res.status).toBe(200);
    expect(res.body.open_count).toBe(2);
    expect(res.body.since).toBe('2026-01-05T09:00:00.000Z');
  });

  it('returns the UNION of the keys, so the form pre-fills with everything out', async () => {
    openRecord([METAL(1), CARD(1)], '2026-01-10T09:00:00.000Z');
    openRecord([METAL(2)], '2026-02-10T09:00:00.000Z');

    const res = await auth(request(app).get(
      `/api/assignments/return-context?account_id=${accountId}&holder=${encodeURIComponent(HOLDER)}`
    ));
    const byType = Object.fromEntries(res.body.keys.map((k: any) => [k.type, k.qty]));
    expect(byType).toEqual({ metal: 3, card: 1 });
  });

  it('says nothing when there is nothing — no count, no date', async () => {
    const res = await auth(request(app).get(
      `/api/assignments/return-context?account_id=${accountId}&holder=${encodeURIComponent(HOLDER)}`
    ));
    expect(res.body).toMatchObject({ open_count: 0, since: null });
    expect(res.body.keys).toEqual([]);
  });

  it('matches a holder whose name is spelled with different spacing or case', async () => {
    openRecord([METAL(1)], '2026-01-10T09:00:00.000Z');
    const res = await auth(request(app).get(
      `/api/assignments/return-context?account_id=${accountId}&holder=${encodeURIComponent('  return TESTER ')}`
    ));
    expect(res.body.open_count).toBe(1);
  });

  it('does NOT match a different person with a similar name', async () => {
    openRecord([METAL(1)], '2026-01-10T09:00:00.000Z');
    // Fuzzy matching here would move real custody onto the wrong record.
    const res = await auth(request(app).get(
      `/api/assignments/return-context?account_id=${accountId}&holder=${encodeURIComponent('Return Testerq')}`
    ));
    expect(res.body.open_count).toBe(0);
  });
});

describe('§4 THE UNIT — allocation in isolation', () => {
  it('never splits more than one record', async () => {
    const { allocateReturn } = await import('../src/lib/returns');
    const rec = (id: number, qty: number) => ({
      id, checked_out_at: `2026-0${id}-01T00:00:00Z`, keys: [METAL(qty)], row: {},
    });
    const a = allocateReturn([rec(1, 2), rec(2, 2), rec(3, 2)], [{ type: 'metal', label: 'Metal Key', qty: 3 }]);
    expect(a.close.map((r) => r.id)).toEqual([1]);
    expect(a.split?.record.id).toBe(2);
    expect(a.untouched.map((r) => r.id)).toEqual([3]);
    expect(a.unmatched).toEqual([]);
  });

  it('reports the overflow rather than silently dropping it', async () => {
    const { allocateReturn } = await import('../src/lib/returns');
    const a = allocateReturn(
      [{ id: 1, checked_out_at: null, keys: [METAL(1)], row: {} }],
      [{ type: 'metal', label: 'Metal Key', qty: 3 }],
    );
    expect(a.close.map((r) => r.id)).toEqual([1]);
    expect(a.unmatched).toEqual([expect.objectContaining({ type: 'metal', qty: 2 })]);
  });

  it('an empty return touches nothing', async () => {
    const { allocateReturn } = await import('../src/lib/returns');
    const a = allocateReturn([{ id: 1, checked_out_at: null, keys: [METAL(1)], row: {} }], []);
    expect(a.close).toEqual([]);
    expect(a.split).toBeNull();
    expect(a.untouched.map((r) => r.id)).toEqual([1]);
  });
});

describe('§5 TRANSFER RESOLVES ITS SOURCE SILENTLY TOO', () => {
  it('lists who holds keys, with the clients they hold them at', async () => {
    openRecord([METAL(1), CARD(1)], '2026-01-10T09:00:00.000Z');
    openRecord([METAL(1)], '2026-02-10T09:00:00.000Z');

    const res = await auth(request(app).get('/api/assignments/holders-with-custody'));
    expect(res.status).toBe(200);
    const mine = res.body.holders.find((h: any) => h.holder === HOLDER);
    expect(mine).toBeTruthy();
    // One site, keys aggregated across BOTH open records — the caller never
    // sees the records themselves.
    expect(mine.client_count).toBe(1);
    expect(mine.total_keys).toBe(3);
    expect(mine.sites[0]).toMatchObject({ account_id: accountId, account_name: 'RETURN SITE', records: 2 });
    expect(mine.sites[0].since).toBe('2026-01-10T09:00:00.000Z');
  });

  it('a transfer closes the source records without being told which', async () => {
    const a = openRecord([METAL(1)], '2026-01-10T09:00:00.000Z');
    const b = openRecord([METAL(1)], '2026-02-10T09:00:00.000Z');
    db.prepare("INSERT INTO staff_managers (name, manager_type, role_category, email, active) VALUES ('Transfer Target','ccm','manager','tt@citywideboston.com',1)").run();

    const res = await auth(request(app).post('/api/assignments/transfer')).send({
      account_id: accountId, mode: 'keys',
      from_holder: HOLDER, to_holder: 'Transfer Target',
      to_holder_type: 'employee', to_holder_email: 'tt@citywideboston.com',
      keys: [{ type: 'metal', qty: 2 }],
      sign_mode: 'in_person',
    });
    expect(res.status).toBe(201);
    for (const id of [a, b]) {
      expect(obj(db.prepare('SELECT status, return_reason FROM key_assignments WHERE id=?').get(id)))
        .toMatchObject({ status: 'returned', return_reason: 'transferred' });
    }
    expect(scalar("SELECT COUNT(*) AS c FROM key_assignments WHERE status='checked_out' AND assignee='Transfer Target'"))
      .toBe(1);
  });

  it('signing in person suppresses the RECEIVER’s email, never the sender’s', async () => {
    openRecord([METAL(1)], '2026-01-10T09:00:00.000Z');
    db.prepare("INSERT INTO staff_managers (name, manager_type, role_category, email, active) VALUES ('Transfer Target','ccm','manager','tt@citywideboston.com',1)").run();

    const res = await auth(request(app).post('/api/assignments/transfer')).send({
      account_id: accountId, mode: 'keys',
      from_holder: HOLDER, to_holder: 'Transfer Target',
      to_holder_type: 'employee', to_holder_email: 'tt@citywideboston.com',
      keys: [{ type: 'metal', qty: 1 }],
      sign_mode: 'in_person',
    });
    expect(res.status).toBe(201);
    // The receiver is standing there and about to sign on the device.
    expect(res.body.email.to.suppressed).toBe(true);
    // The sender may already have walked off — a send is always ATTEMPTED for
    // them. (It does not succeed here: the test env has no mail provider, and
    // that is reported as skipped-with-an-error, never as suppressed.)
    expect(res.body.email.from.suppressed).toBe(false);
  });
});
