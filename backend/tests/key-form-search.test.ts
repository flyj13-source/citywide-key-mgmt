// ── Key Forms: transaction scope, search, client-by-client, retention ────────
// Verified on the ZZ TEST fixtures.
//
// ZZ TEST CLIENT A (BC 09999900001) and CLIENT B (09999900003) both name
// ZZ Test AM One as AM and ZZ TEST CONTRACTOR (BC Vendor 09999900002) as IC.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'citywide-formsearch-'));
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
let dbmod: typeof import('../src/lib/db');

const AM1 = 'ZZ Test AM One';
const IC = 'ZZ TEST CONTRACTOR — Do Not Use';
const CLIENT_A = 'ZZ TEST CLIENT A — Do Not Use';
const CLIENT_B = 'ZZ TEST CLIENT B — Do Not Use';
const MAILBOX = 'keys@citywidekeys.com';
const auth = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);
const obj = (r: any) => (r ? Object.assign({}, r) : null);
const idOf = (bc: string) => Number(obj(db.prepare('SELECT id FROM accounts WHERE bc_client_number = ?').get(bc)).id);

beforeAll(async () => {
  app = (await import('../src/index')).default;
  (await import('../src/lib/autoSeed')).autoSeedIfEmpty();
  fx = await import('../src/lib/testFixtures');
  dbmod = await import('../src/lib/db');
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
});

const checkIn = (bc: string, keys: any[]) => auth(request(app).post('/api/assignments/checkout')).send({
  account_id: idOf(bc), holder: AM1, holder_email: MAILBOX, holder_type: 'employee', keys,
});
const list = async (q: Record<string, string>) => {
  const res = await auth(request(app).get('/api/key-forms')).query({ limit: '200', ...q });
  expect(res.status).toBe(200);
  return res.body;
};
const ids = (b: any) => b.forms.map((f: any) => f.id).sort();

describe('§1 A TRANSACTION FORM SHOWS ONLY THE TRANSACTION', () => {
  it('AM One checked in 1 metal at client A → one row, client A, 1 key', async () => {
    const res = await checkIn('09999900001', [{ type: 'metal', qty: 1 }]);
    expect(res.status).toBe(201);
    const f = res.body.key_form;
    expect(f).toMatchObject({
      form_coverage: 'transaction', total_keys: 1, clients_covered: 1,
      total_label: 'TOTAL KEYS IN THIS TRANSACTION', ack_variant: 'received',
    });
    expect(f.clients).toEqual([expect.objectContaining({ client: CLIENT_A, metal: 1, card: 0 })]);
    // AM One's standing grid keys at clients A and B are NOT on it.
    expect(f.clients.map((c: any) => c.client)).not.toContain(CLIENT_B);
  });

  it('the Audit form stays the full picture — clients A and B', async () => {
    const res = await auth(request(app).post('/api/key-forms/generate')).send({ holder: AM1, holder_type: 'employee' });
    expect(res.status).toBe(201);
    const f = res.body.forms[0];
    expect(f.form_coverage).toBe('full');
    expect(f.clients.map((c: any) => c.client).sort()).toEqual([CLIENT_A, CLIENT_B].sort());
  });
});

describe('§2 SEARCHABLE BY HOLDER AND ACCOUNT', () => {
  it('writes form_clients for every form', async () => {
    const res = await checkIn('09999900001', [{ type: 'metal', qty: 1 }]);
    const links = db.prepare('SELECT account_id FROM form_clients WHERE form_id = ?').all(res.body.key_form.id).map(obj);
    expect(links).toEqual([{ account_id: idOf('09999900001') }]);
  });

  it('one box matches form #, holder, IC company, client, BC Client # and BC Vendor #', async () => {
    const a = (await checkIn('09999900001', [{ type: 'metal', qty: 1 }])).body.key_form;
    const b = (await checkIn('09999900003', [{ type: 'metal', qty: 1 }])).body.key_form;
    const both = [a.id, b.id].sort();

    expect(ids(await list({ search: a.form_no }))).toEqual([a.id]);
    expect(ids(await list({ search: 'ZZ Test AM' }))).toEqual(both);
    expect(ids(await list({ search: 'ZZ TEST CONTRACTOR' }))).toEqual(both);   // the IC on both clients
    expect(ids(await list({ search: 'ZZ TEST CLIENT A' }))).toEqual([a.id]);
    expect(ids(await list({ search: '09999900003' }))).toEqual([b.id]);          // BC Client #
    expect(ids(await list({ search: '09999900002' }))).toEqual(both);            // BC Vendor #
    expect(ids(await list({ search: 'nothing like this' }))).toEqual([]);
  });

  it('combines search + Client filter + status', async () => {
    const a = (await checkIn('09999900001', [{ type: 'metal', qty: 1 }])).body.key_form;
    const a2 = (await checkIn('09999900001', [{ type: 'card', qty: 1 }])).body.key_form;
    await checkIn('09999900003', [{ type: 'metal', qty: 1 }]);
    db.prepare("UPDATE key_form_docs SET status = 'signed', signed_at = ? WHERE id = ?").run(new Date().toISOString(), a.id);

    const r = await list({ search: 'ZZ TEST CONTRACTOR', account_id: String(idOf('09999900001')), status: 'signed' });
    expect(ids(r)).toEqual([a.id]);
    const unsigned = await list({ search: 'ZZ TEST CONTRACTOR', account_id: String(idOf('09999900001')), status: 'awaiting' });
    expect(ids(unsigned)).toEqual([a2.id]);
  });

  it('backfills form_clients for existing forms — by account id, and by client name', async () => {
    const acctA = idOf('09999900001');
    const ins = (lines: any[]) => Number(db.prepare(
      "INSERT INTO key_form_docs (event_type, holder_name, scope_json, status) VALUES ('audit', ?, ?, 'draft')",
    ).run(AM1, JSON.stringify({ lines })).lastInsertRowid);
    const byId = ins([{ account_id: acctA, client: 'whatever', subtotal: 1 }]);
    const byName = ins([{ client: CLIENT_B, subtotal: 1 }]);
    const r = dbmod.backfillFormClients();
    expect(r.links).toBe(2);
    expect(obj(db.prepare('SELECT account_id FROM form_clients WHERE form_id = ?').get(byId)).account_id).toBe(acctA);
    expect(obj(db.prepare('SELECT account_id FROM form_clients WHERE form_id = ?').get(byName)).account_id).toBe(idOf('09999900003'));
    expect(dbmod.backfillFormClients().links).toBe(0);   // idempotent
  });

  it('exports the filtered results to Excel', async () => {
    await checkIn('09999900001', [{ type: 'metal', qty: 1 }]);
    await checkIn('09999900003', [{ type: 'metal', qty: 1 }]);
    const res = await auth(request(app).get('/api/key-forms/export'))
      .query({ account_id: String(idOf('09999900001')) })
      .buffer(true).parse((r, cb) => { const c: Buffer[] = []; r.on('data', (d: Buffer) => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body as Buffer);
    const ws = wb.getWorksheet('Key Forms')!;
    expect(ws.rowCount).toBe(2);                       // header + client A only
    expect(String(ws.getRow(2).getCell(8).value)).toBe(CLIENT_A);
  });
});

describe('§3 AUDIT: CLIENT BY CLIENT', () => {
  it('lists the clients the holder has keys at', async () => {
    const res = await auth(request(app).get('/api/key-forms/holder-clients')).query({ holder: AM1 });
    expect(res.body.clients.map((c: any) => c.client).sort()).toEqual([CLIENT_A, CLIENT_B].sort());
  });

  it('one form per selected client, each separately signable, each found under its client', async () => {
    const a = idOf('09999900001'); const b = idOf('09999900003');
    const res = await auth(request(app).post('/api/key-forms/generate'))
      .send({ holder: AM1, holder_type: 'employee', coverage: 'client', account_ids: [a, b] });
    expect(res.status).toBe(201);
    expect(res.body.count).toBe(2);
    const [f1, f2] = res.body.forms;
    for (const f of [f1, f2]) {
      expect(f.form_coverage).toBe('client');
      expect(f.clients).toHaveLength(1);
      expect(f.link_state).toBe('awaiting');
    }
    const tokens = db.prepare('SELECT token FROM key_form_docs WHERE id IN (?, ?)').all(f1.id, f2.id).map((r: any) => obj(r).token);
    expect(new Set(tokens).size).toBe(2);                // two separate signature links
    expect(ids(await list({ account_id: String(a), event_type: 'audit' }))).toEqual(
      [res.body.forms.find((f: any) => f.clients[0].client === CLIENT_A).id],
    );
  });

  it('refuses client-by-client with no client chosen', async () => {
    const res = await auth(request(app).post('/api/key-forms/generate'))
      .send({ holder: AM1, holder_type: 'employee', coverage: 'client', account_ids: [] });
    expect(res.status).toBe(400);
  });
});

describe('§4 12-MONTH RETENTION', () => {
  const age = (id: number, months: number) => db.prepare(
    `UPDATE key_form_docs SET created_at = datetime('now', '-${months} months') WHERE id = ?`,
  ).run(id);

  it('an old form leaves the default view for Archived — never deleted', async () => {
    const out = (await checkIn('09999900001', [{ type: 'metal', qty: 1 }])).body;
    // Return the keys, so the form is not tied to open custody.
    const back = await auth(request(app).post('/api/assignments/checkin')).send({ id: out.id, condition_on_return: 'good' });
    expect(back.status).toBe(200);
    age(out.key_form.id, 13);
    const before = Number(obj(db.prepare('SELECT COUNT(*) AS c FROM key_form_docs').get()).c);

    const active = await list({});
    expect(ids(active)).not.toContain(out.key_form.id);
    expect(active.archived_count).toBe(1);
    const archived = await list({ status: 'archived' });
    expect(ids(archived)).toEqual([out.key_form.id]);
    expect(archived.forms[0].archived).toBe(true);
    // Still searchable inside the Archived filter, still downloadable.
    expect(ids(await list({ status: 'archived', search: 'ZZ TEST CLIENT A' }))).toEqual([out.key_form.id]);
    expect((await auth(request(app).get(`/api/key-forms/${out.key_form.id}/pdf`))).status).toBe(200);
    // A client's own page shows its whole history.
    expect(ids(await list({ account_id: String(idOf('09999900001')), archived: 'all' }))).toContain(out.key_form.id);

    expect(Number(obj(db.prepare('SELECT COUNT(*) AS c FROM key_form_docs').get()).c)).toBe(before);
  });

  it('a form tied to custody still open stays active at any age', async () => {
    const out = (await checkIn('09999900001', [{ type: 'metal', qty: 1 }])).body;   // keys still out
    age(out.key_form.id, 30);
    expect(ids(await list({}))).toContain(out.key_form.id);
    expect(ids(await list({ status: 'archived' }))).not.toContain(out.key_form.id);
  });

  it('an 11-month-old form is still active', async () => {
    const out = (await checkIn('09999900001', [{ type: 'metal', qty: 1 }])).body;
    await auth(request(app).post('/api/assignments/checkin')).send({ id: out.id, condition_on_return: 'good' });
    age(out.key_form.id, 11);
    expect(ids(await list({}))).toContain(out.key_form.id);
  });

  it('backups count both form tables', async () => {
    const { COUNTED_TABLES } = await import('../src/lib/backup/snapshot');
    expect(COUNTED_TABLES).toEqual(expect.arrayContaining(['key_form_docs', 'form_clients']));
  });
});
