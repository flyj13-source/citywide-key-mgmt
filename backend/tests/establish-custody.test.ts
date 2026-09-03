import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'citywide-establish-'));
process.env.CITYWIDE_DB_DIR = TEST_DIR;
delete process.env.DB_PATH;
process.env.JWT_SECRET = 'test-secret';
process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
process.env.SEED_PASSWORD = 'demo1234';

const DB_FILE = path.join(TEST_DIR, 'citywide.db');
let app: Express;
let token: string;
let db: DatabaseSync;

const auth = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);

const addAccount = (o: Record<string, any>) => {
  const cols = Object.keys(o);
  const r = db.prepare(
    `INSERT INTO accounts (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`
  ).run(...cols.map((c) => o[c]));
  return Number(r.lastInsertRowid);
};

/** A site with enough keys on record to establish against. */
const site = (name: string) => addAccount({
  ic_company_name: name, record_type: 'customer', bc_client_number: `0101470${name.length}`,
  metal_keys: 5, key_cards: 3, has_fob: 2, dispenser_keys: 1,
});

const establish = (body: any) => auth(request(app).post('/api/assignments/establish')).send(body);

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
  db.exec('DELETE FROM accounts');
  db.exec('DELETE FROM audit_log');
});

describe('ESTABLISH CUSTODY — opening balances, not transactions', () => {
  it('records what a holder already has', async () => {
    const id = site('ACME TOWER');
    const res = await establish({
      holder: 'Jo Martinez', holder_email: 'jo@cw.test', holder_type: 'employee',
      account_id: id, keys: [{ type: 'metal', qty: 2 }], held_since: '2023-06-01',
      notes: 'Has had these since the Ridgeway handover',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ clients: 1, total_keys: 2 });

    const row = Object.assign({}, db.prepare('SELECT * FROM key_assignments').get() as any);
    expect(row).toMatchObject({
      assignee: 'Jo Martinez', account_name: 'ACME TOWER',
      origin: 'established', held_since: '2023-06-01',
      status: 'checked_out',
    });
    // No SMTP under test, so the send fails and the status correctly reports
    // that rather than claiming a signature is in flight. Either value means a
    // link was minted; 'signature_unavailable' would mean it never was.
    expect(['awaiting_signature', 'signature_send_failed']).toContain(row.signature_status);
    expect(row.signoff_token).toBeTruthy();
    // An opening balance has no due date — nobody agreed to return it by a day.
    expect(row.due_at).toBeNull();
  });

  it("keeps status 'checked_out' so availability and archiving still see it", async () => {
    const id = site('ACME TOWER');
    await establish({
      holder: 'Jo', holder_email: 'jo@cw.test', account_id: id,
      keys: [{ type: 'metal', qty: 2 }],
    });
    // The archive gate counts open custody by status — an established row must
    // be caught by it, or a site could be archived with keys still out.
    const blocked = await auth(request(app).post(`/api/accounts/${id}/archive`)).send({});
    expect(blocked.status).toBe(409);
  });

  it('defaults "held since" to today when not supplied', async () => {
    const id = site('ACME TOWER');
    await establish({ holder: 'Jo', holder_email: 'jo@cw.test', account_id: id, keys: [{ type: 'metal', qty: 1 }] });
    const row = Object.assign({}, db.prepare('SELECT held_since FROM key_assignments').get() as any);
    expect(row.held_since).toBe(new Date().toISOString().slice(0, 10));
  });

  it('cannot claim more keys than the site has on record', async () => {
    const id = site('ACME TOWER');   // 5 metal
    const res = await establish({
      holder: 'Jo', holder_email: 'jo@cw.test', account_id: id, keys: [{ type: 'metal', qty: 99 }],
    });
    expect(res.status).toBe(409);
    expect(db.prepare('SELECT COUNT(*) AS n FROM key_assignments').get()).toMatchObject({ n: 0 });
  });

  it('refuses a holder with no email unless a reason is given', async () => {
    const id = site('ACME TOWER');
    const refused = await establish({ holder: 'No Mail', account_id: id, keys: [{ type: 'metal', qty: 1 }] });
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('HOLDER_EMAIL_MISSING');
    expect(db.prepare('SELECT COUNT(*) AS n FROM key_assignments').get()).toMatchObject({ n: 0 });

    const allowed = await establish({
      holder: 'No Mail', account_id: id, keys: [{ type: 'metal', qty: 1 }],
      no_email_reason: 'Signing in person at the Thursday walkthrough',
    });
    expect(allowed.status).toBe(201);
    expect(Object.assign({}, db.prepare('SELECT * FROM key_assignments').get() as any))
      .toMatchObject({ signature_status: 'signature_unavailable', signoff_token: null });
  });

  it("audits as 'custody_established', never as a check-out", async () => {
    const id = site('ACME TOWER');
    await establish({ holder: 'Jo', holder_email: 'jo@cw.test', account_id: id, keys: [{ type: 'metal', qty: 1 }] });
    const actions = (db.prepare('SELECT action FROM audit_log').all() as any[])
      .map((r) => Object.assign({}, r).action);
    expect(actions).toContain('custody_established');
    expect(actions).not.toContain('key_checked_out');
  });
});

describe('§2 CHECK-IN accepts an established assignment', () => {
  it('the established keys appear in Checked Out and check in normally', async () => {
    const id = site('ACME TOWER');
    const est = await establish({
      holder: 'Jo Martinez', holder_email: 'jo@cw.test', account_id: id,
      keys: [{ type: 'metal', qty: 2 }, { type: 'card', qty: 1 }],
    });
    const assignmentId = est.body.created[0].id;

    // Visible in the Checked Out tab.
    const out = await auth(request(app).get('/api/assignments?status=checked_out'));
    expect(out.body.assignments.map((a: any) => a.id)).toContain(assignmentId);

    // And it checks in — the whole point of the feature.
    const back = await auth(request(app).post('/api/assignments/checkin'))
      .send({ id: assignmentId, condition_on_return: 'good' });
    expect(back.status).toBe(200);
    expect(Object.assign({}, db.prepare('SELECT status, origin FROM key_assignments WHERE id = ?').get(assignmentId) as any))
      .toMatchObject({ status: 'returned', origin: 'established' });
  });

  it('a partial return off an established row still works', async () => {
    const id = site('ACME TOWER');
    const est = await establish({
      holder: 'Jo', holder_email: 'jo@cw.test', account_id: id,
      keys: [{ type: 'metal', qty: 3 }],
    });
    const assignmentId = est.body.created[0].id;
    const back = await auth(request(app).post('/api/assignments/checkin'))
      .send({ id: assignmentId, keys: [{ type: 'metal', qty: 1 }] });
    expect(back.status).toBe(200);
    const still = Object.assign({}, db.prepare(
      "SELECT keys_json FROM key_assignments WHERE status='checked_out'"
    ).get() as any);
    expect(JSON.parse(still.keys_json)).toEqual([expect.objectContaining({ type: 'metal', qty: 2 })]);
  });
});

describe('§3 BULK ESTABLISH — one holder, many clients, ONE acknowledgement', () => {
  const three = () => [site('SITE ONE'), site('SITE TWO'), site('SITE THREE')];

  it('creates one record per client but a single signature form', async () => {
    const [a, b, c] = three();
    const res = await establish({
      holder: 'Pat Vendor', holder_email: 'pat@ic.test', holder_type: 'ic',
      clients: [
        { account_id: a, keys: [{ type: 'metal', qty: 2 }] },
        { account_id: b, keys: [{ type: 'card', qty: 1 }] },
        { account_id: c, keys: [{ type: 'fob', qty: 1 }, { type: 'metal', qty: 1 }] },
      ],
      held_since: '2024-01-15',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ clients: 3, total_keys: 5 });

    const rows = (db.prepare('SELECT * FROM key_assignments ORDER BY id').all() as any[])
      .map((r) => Object.assign({}, r));
    expect(rows).toHaveLength(3);
    // Three records…
    expect(rows.map((r) => r.account_name)).toEqual(['SITE ONE', 'SITE TWO', 'SITE THREE']);
    // …one group, one token.
    expect(new Set(rows.map((r) => r.establish_group_id)).size).toBe(1);
    expect(new Set(rows.map((r) => r.signoff_token)).size).toBe(1);
    expect(rows[0].signoff_token).toBeTruthy();
  });

  it('writes one audit entry per client plus a bulk summary', async () => {
    const [a, b] = three();
    await establish({
      holder: 'Pat', holder_email: 'pat@ic.test',
      clients: [
        { account_id: a, keys: [{ type: 'metal', qty: 1 }] },
        { account_id: b, keys: [{ type: 'metal', qty: 1 }] },
      ],
    });
    const per = (db.prepare("SELECT account_name FROM audit_log WHERE action='custody_established' ORDER BY id").all() as any[])
      .map((r) => Object.assign({}, r).account_name);
    expect(per).toEqual(['SITE ONE', 'SITE TWO']);
    const summary = Object.assign({}, db.prepare(
      "SELECT metadata FROM audit_log WHERE action='custody_established_bulk'"
    ).get() as any);
    expect(JSON.parse(summary.metadata)).toMatchObject({ clients: 2, holder: 'Pat' });
  });

  it('rolls back ALL clients if one of them is invalid', async () => {
    const [a] = three();
    const res = await establish({
      holder: 'Pat', holder_email: 'pat@ic.test',
      clients: [
        { account_id: a, keys: [{ type: 'metal', qty: 1 }] },
        { account_id: 999999, keys: [{ type: 'metal', qty: 1 }] },
      ],
    });
    expect(res.status).toBe(404);
    expect(db.prepare('SELECT COUNT(*) AS n FROM key_assignments').get()).toMatchObject({ n: 0 });
  });

  it('each client checks in independently afterwards', async () => {
    const [a, b] = three();
    const est = await establish({
      holder: 'Pat', holder_email: 'pat@ic.test',
      clients: [
        { account_id: a, keys: [{ type: 'metal', qty: 1 }] },
        { account_id: b, keys: [{ type: 'metal', qty: 1 }] },
      ],
    });
    const first = est.body.created[0].id;
    await auth(request(app).post('/api/assignments/checkin')).send({ id: first });
    expect(db.prepare("SELECT COUNT(*) AS n FROM key_assignments WHERE status='checked_out'").get())
      .toMatchObject({ n: 1 });
  });
});

describe('THE ACKNOWLEDGEMENT — "I currently hold", never "I am receiving"', () => {
  const openForm = async () => {
    const id = site('ACME TOWER');
    await establish({
      holder: 'Jo Martinez', holder_email: 'jo@cw.test', account_id: id,
      keys: [{ type: 'metal', qty: 2 }], held_since: '2023-06-01',
    });
    const row = Object.assign({}, db.prepare('SELECT signoff_token FROM key_assignments').get() as any);
    return row.signoff_token as string;
  };

  it('the public form reports the established direction, not a check-out', async () => {
    const tok = await openForm();
    const res = await request(app).get(`/api/signoff/${tok}`);
    expect(res.status).toBe(200);
    expect(res.body.action).toBe('established');
    expect(res.body.held_since).toBe('2023-06-01');
  });

  it('a bulk acknowledgement lists every client it covers', async () => {
    const [a, b, c] = [site('SITE ONE'), site('SITE TWO'), site('SITE THREE')];
    await establish({
      holder: 'Pat', holder_email: 'pat@ic.test',
      clients: [
        { account_id: a, keys: [{ type: 'metal', qty: 1 }] },
        { account_id: b, keys: [{ type: 'card', qty: 1 }] },
        { account_id: c, keys: [{ type: 'fob', qty: 1 }] },
      ],
    });
    const row = Object.assign({}, db.prepare('SELECT signoff_token FROM key_assignments LIMIT 1').get() as any);
    const res = await request(app).get(`/api/signoff/${row.signoff_token}`);
    expect(res.body.sites).toHaveLength(3);
    expect(res.body.sites.map((x: any) => x.client)).toEqual(['SITE ONE', 'SITE TWO', 'SITE THREE']);
  });

  it('signing ONE bulk form closes EVERY client it covers', async () => {
    const [a, b, c] = [site('SITE ONE'), site('SITE TWO'), site('SITE THREE')];
    await establish({
      holder: 'Pat Vendor', holder_email: 'pat@ic.test',
      clients: [
        { account_id: a, keys: [{ type: 'metal', qty: 1 }] },
        { account_id: b, keys: [{ type: 'card', qty: 1 }] },
        { account_id: c, keys: [{ type: 'fob', qty: 1 }] },
      ],
    });
    const row = Object.assign({}, db.prepare('SELECT signoff_token FROM key_assignments LIMIT 1').get() as any);
    const res = await request(app).post(`/api/signoff/${row.signoff_token}/sign`).send({
      signature_data: 'data:image/png;base64,iVBORw0KGgo=',
      typed_name: 'Pat Vendor',
    });
    expect(res.status).toBe(200);
    expect(res.body.action).toBe('established');

    // All three signed — a signature covering three sites that closed one would
    // leave two looking permanently unsigned.
    const signed = (db.prepare('SELECT signed_at, signature_status FROM key_assignments').all() as any[])
      .map((r) => Object.assign({}, r));
    expect(signed).toHaveLength(3);
    expect(signed.every((r) => !!r.signed_at)).toBe(true);
    expect(signed.every((r) => r.signature_status === 'signed')).toBe(true);

    // One audit entry per covered client.
    expect(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action='custody_established_signed'").get())
      .toMatchObject({ n: 3 });
  });

  it('a signed acknowledgement is not filed as a check-out signature', async () => {
    const tok = await openForm();
    await request(app).post(`/api/signoff/${tok}/sign`).send({
      signature_data: 'data:image/png;base64,iVBORw0KGgo=',
      typed_name: 'Jo Martinez',
    });
    const actions = (db.prepare('SELECT action FROM audit_log').all() as any[])
      .map((r) => Object.assign({}, r).action);
    expect(actions).toContain('custody_established_signed');
    expect(actions).not.toContain('checkout_signed');
  });
});
