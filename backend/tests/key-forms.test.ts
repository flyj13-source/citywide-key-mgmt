import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'citywide-forms-doc-'));
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
const site = (name: string, extra: Record<string, any> = {}) => addAccount({
  ic_company_name: name, record_type: 'customer', bc_client_number: `010147${name.length}0`,
  metal_keys: 6, key_cards: 4, has_fob: 3, dispenser_keys: 2, ...extra,
});
const addStaff = (name: string, email: string | null, type = 'account_manager', role = 'manager', shift: string | null = null) =>
  db.prepare(
    'INSERT INTO staff_managers (name, manager_type, role_category, email, shift, day_night, active) VALUES (?,?,?,?,?,?,1)'
  ).run(name, type, role, email, shift, shift ? 'day' : null);

const checkout = (b: any) => auth(request(app).post('/api/assignments/checkout')).send(b);
const checkin = (b: any) => auth(request(app).post('/api/assignments/checkin')).send(b);

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
  db.exec('DELETE FROM access_codes');
  db.exec('DELETE FROM accounts');
  db.exec('DELETE FROM staff_managers');
  db.exec('DELETE FROM key_form_docs');
  db.exec('DELETE FROM audit_log');
});

// ─────────────────────────────────────────────────────────────────────────────

describe('§1 CHECK-IN with NO prior check-out', () => {
  it('accepts the entry and closes it in one step', async () => {
    const id = site('RIDGEWAY PLAZA');
    const res = await checkin({
      holder: 'Jo Martinez', holder_email: 'jo@cw.test', holder_type: 'employee',
      account_id: id, keys: [{ type: 'metal', qty: 2 }, { type: 'card', qty: 1 }],
      condition_on_return: 'good', notes: 'Handed back at the Thursday walkthrough',
    });
    expect(res.status).toBe(201);
    expect(res.body.reconciled).toBe(true);

    const row = Object.assign({}, db.prepare('SELECT * FROM key_assignments').get() as any);
    expect(row).toMatchObject({
      assignee: 'Jo Martinez', account_name: 'RIDGEWAY PLAZA',
      status: 'returned', origin: 'reconciled', condition_on_return: 'good',
    });
  });

  it('never blocks with "no keys checked out"', async () => {
    const id = site('RIDGEWAY PLAZA');
    const res = await checkin({
      holder: 'Nobody Onrecord', holder_email: 'n@cw.test',
      account_id: id, keys: [{ type: 'metal', qty: 1 }],
    });
    expect(res.status).toBe(201);
    expect(JSON.stringify(res.body)).not.toMatch(/no keys checked out/i);
  });

  it('closes an EXISTING open record rather than inventing a second one', async () => {
    const id = site('RIDGEWAY PLAZA');
    await checkout({
      account_id: id, holder: 'Jo Martinez', holder_email: 'jo@cw.test',
      holder_type: 'employee', keys: [{ type: 'metal', qty: 2 }],
    });
    // No id supplied — the holder+client pair resolves the open record.
    const res = await checkin({
      holder: 'Jo Martinez', account_id: id, keys: [{ type: 'metal', qty: 2 }],
    });
    expect(res.status).toBe(200);
    expect(res.body.reconciled).toBeUndefined();
    // One row, closed — not two.
    expect(db.prepare('SELECT COUNT(*) AS n FROM key_assignments').get()).toMatchObject({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM key_assignments WHERE status='checked_out'").get())
      .toMatchObject({ n: 0 });
  });

  it('requires a holder, a client and at least one key', async () => {
    const id = site('RIDGEWAY PLAZA');
    expect((await checkin({ account_id: id, keys: [{ type: 'metal', qty: 1 }] })).status).toBe(400);
    expect((await checkin({ holder: 'Jo', keys: [{ type: 'metal', qty: 1 }] })).status).toBe(400);
    expect((await checkin({ holder: 'Jo', account_id: id, keys: [] })).status).toBe(400);
  });

  it('audits the reconciling entry as such', async () => {
    const id = site('RIDGEWAY PLAZA');
    await checkin({ holder: 'Jo', holder_email: 'j@cw.test', account_id: id, keys: [{ type: 'metal', qty: 1 }] });
    const meta = JSON.parse(Object.assign({}, db.prepare(
      "SELECT metadata FROM audit_log WHERE action='key_checked_in'"
    ).get() as any).metadata);
    expect(meta.origin).toBe('reconciled');
  });
});

describe('§2 A KEY FORM IS GENERATED ON EVERY CUSTODY EVENT', () => {
  it('check-out produces one', async () => {
    const id = site('RIDGEWAY PLAZA');
    addStaff('Jo Martinez', 'jo@cw.test', 'account_manager', 'manager', '1st');
    const res = await checkout({
      account_id: id, holder: 'Jo Martinez', holder_email: 'jo@cw.test',
      holder_type: 'employee', keys: [{ type: 'metal', qty: 2 }],
    });
    expect(res.body.key_form).toMatchObject({
      event_type: 'checkout', holder_name: 'Jo Martinez', total_keys: 2, clients_covered: 1,
    });
    // The header carries the roster identity.
    expect(res.body.key_form.holder_role).toBe('AM');
    // The roster row still stores '1st'; the form neither reads nor exposes it.
    expect(res.body.key_form).not.toHaveProperty('holder_shift');
  });

  it('check-in produces one', async () => {
    const id = site('RIDGEWAY PLAZA');
    const res = await checkin({
      holder: 'Jo', holder_email: 'j@cw.test', account_id: id, keys: [{ type: 'metal', qty: 1 }],
    });
    expect(res.body.key_form).toMatchObject({ event_type: 'checkin', holder_name: 'Jo' });
  });

  it('a check-in form is a RETURN RECEIPT — signable even when nothing is left', async () => {
    const id = site('RIDGEWAY PLAZA');
    await checkout({
      account_id: id, holder: 'Jo Martinez', holder_email: 'jo@cw.test',
      holder_type: 'employee', keys: [{ type: 'metal', qty: 2 }],
    });
    // Everything comes back — the position afterwards is empty.
    const res = await checkin({
      holder: 'Jo Martinez', account_id: id, keys: [{ type: 'metal', qty: 2 }],
    });
    expect(res.status).toBe(200);
    const form = res.body.key_form;
    expect(form.doc_kind).toBe('return_receipt');
    expect(form.doc_title).toBe('Key Return Receipt');
    expect(form.table_heading).toBe('Keys returned');
    // The receipt's lines ARE the keys returned — and nothing else. No claim
    // about the position afterwards appears on it at all.
    expect(form.clients).toHaveLength(1);
    expect(form.clients[0]).toMatchObject({ client: 'RIDGEWAY PLAZA', metal: 2, subtotal: 2 });
    expect(form.clients[0].bc_client_number).toBeTruthy();
    expect(form.total_keys).toBe(2);
    expect(form.returned_keys).toBe(2);
  });

  it('a PARTIAL return lists what went back and what remains', async () => {
    const id = site('RIDGEWAY PLAZA');
    await checkout({
      account_id: id, holder: 'Jo Martinez', holder_email: 'jo@cw.test',
      holder_type: 'employee', keys: [{ type: 'metal', qty: 3 }],
    });
    const res = await checkin({
      holder: 'Jo Martinez', account_id: id, keys: [{ type: 'metal', qty: 1 }],
    });
    const form = res.body.key_form;
    // The receipt covers the 1 that came back — not the 2 still out.
    expect(form.doc_kind).toBe('return_receipt');
    expect(form.returned_keys).toBe(1);
    expect(form.total_keys).toBe(1);
    expect(form.clients).toHaveLength(1);
    expect(form.clients[0].metal).toBe(1);
    expect(form.event_note).toContain('Returned at RIDGEWAY PLAZA');
    expect(form.event_note).toContain('1 Metal Key');
  });

  it('a reconciling check-in reads as a RECORD of keys held, not a return', async () => {
    const id = site('RIDGEWAY PLAZA');
    const res = await checkin({
      holder: 'Walk In', holder_email: 'w@cw.test', account_id: id,
      keys: [{ type: 'metal', qty: 1 }],
    });
    expect(res.status).toBe(201);
    // Nothing came back, so this states what the holder HAS.
    expect(res.body.key_form.doc_kind).toBe('holdings');
    expect(res.body.key_form.total_keys).toBe(1);
    expect(res.body.key_form.event_note)
      .toBe('Recorded at RIDGEWAY PLAZA: 1 Metal Key on record as held');
    // Still plain language, and still no bookkeeping jargon on the document.
    expect(res.body.key_form.event_note).not.toMatch(/reconcil/i);
    expect(res.body.key_form.event_note).not.toMatch(/returned/i);
    expect(res.body.key_form.event_note).not.toContain('×');
  });

  it('the public sign-off link carries the return as its subject', async () => {
    const id = site('RIDGEWAY PLAZA');
    await checkout({
      account_id: id, holder: 'Jo Martinez', holder_email: 'jo@cw.test',
      holder_type: 'employee', keys: [{ type: 'card', qty: 1 }],
    });
    await checkin({ holder: 'Jo Martinez', account_id: id, keys: [{ type: 'card', qty: 1 }] });
    const row = Object.assign({}, db.prepare(
      "SELECT token FROM key_form_docs WHERE event_type='checkin' ORDER BY id DESC LIMIT 1"
    ).get() as any);
    const res = await request(app).get(`/api/key-forms/token/${row.token}`);
    expect(res.status).toBe(200);
    expect(res.body.doc_kind).toBe('return_receipt');
    expect(res.body.doc_title).toBe('Key Return Receipt');
    expect(res.body.table_heading).toBe('Keys returned');
    expect(res.body.clients).toHaveLength(1);
    expect(res.body.clients[0].card).toBe(1);
  });

  it('transfer produces a form for BOTH parties, each naming the other', async () => {
    const id = site('RIDGEWAY PLAZA');
    await checkout({
      account_id: id, holder: 'From Person', holder_email: 'from@cw.test',
      holder_type: 'employee', keys: [{ type: 'metal', qty: 3 }],
    });
    const res = await auth(request(app).post('/api/assignments/transfer')).send({
      account_id: id, from_holder: 'From Person', to_holder: 'To Person',
      to_holder_email: 'to@cw.test', to_holder_type: 'employee',
      keys: [{ type: 'metal', qty: 2 }],
    });
    expect(res.status).toBe(201);
    // OUTGOING side signs a RECEIPT for exactly what they handed over.
    expect(res.body.key_forms.from).toMatchObject({
      event_type: 'transfer', holder_name: 'From Person', counterparty_name: 'To Person',
      doc_kind: 'return_receipt', doc_title: 'Key Return Receipt',
    });
    expect(res.body.key_forms.from.total_keys).toBe(2);
    expect(res.body.key_forms.from.clients[0].metal).toBe(2);
    expect(res.body.key_forms.from.clients[0].via).toBe('Transferred to To Person');

    // INCOMING side signs a HOLDINGS statement covering what they now have,
    // the 2 just received included.
    expect(res.body.key_forms.to).toMatchObject({
      event_type: 'transfer', holder_name: 'To Person', counterparty_name: 'From Person',
      doc_kind: 'holdings', doc_title: 'Key Form',
    });
    expect(res.body.key_forms.to.total_keys).toBe(2);
  });

  it('manager reassignment produces a form for both managers', async () => {
    addStaff('Old Manager', 'old@cw.test');
    addStaff('New Manager', 'new@cw.test');
    // Grid-attributed keys: without them neither manager holds anything and a
    // holdings statement would have nothing on it to sign.
    site('CLIENT A', { account_manager: 'Old Manager', am_metal: 2, am_keys: 2 });
    const ids = (db.prepare('SELECT id FROM accounts').all() as any[]).map((r) => Object.assign({}, r).id);
    const from = Object.assign({}, db.prepare("SELECT id FROM staff_managers WHERE name='Old Manager'").get() as any).id;
    const to = Object.assign({}, db.prepare("SELECT id FROM staff_managers WHERE name='New Manager'").get() as any).id;

    const res = await auth(request(app).post('/api/managers/reassign')).send({
      fromId: from, toId: to, role: 'am', clientIds: ids, sendHandover: false,
    });
    expect(res.status).toBe(200);
    // Both sides state a position — a reassignment moves responsibility, it is
    // not a handover of keys, so neither party signs a receipt.
    expect(res.body.key_forms.to).toMatchObject({
      event_type: 'reassignment', holder_name: 'New Manager', doc_kind: 'holdings',
    });
    expect(res.body.key_forms.to.total_keys).toBe(2);
    // The outgoing manager no longer holds these keys, so their holdings form
    // has nothing on it and is skipped rather than issued blank.
    expect(res.body.key_forms.from).toBeNull();
  });

  it('a reassignment still issues a form to a manager who holds keys elsewhere', async () => {
    addStaff('Old Manager', 'old@cw.test');
    addStaff('New Manager', 'new@cw.test');
    const moved = site('CLIENT A', { account_manager: 'Old Manager', am_metal: 2, am_keys: 2 });
    // A second client stays with Old Manager, so they still hold something.
    site('CLIENT B', { account_manager: 'Old Manager', am_metal: 1, am_keys: 1 });
    const from = Object.assign({}, db.prepare("SELECT id FROM staff_managers WHERE name='Old Manager'").get() as any).id;
    const to = Object.assign({}, db.prepare("SELECT id FROM staff_managers WHERE name='New Manager'").get() as any).id;

    const res = await auth(request(app).post('/api/managers/reassign')).send({
      fromId: from, toId: to, role: 'am', clientIds: [moved], sendHandover: false,
    });
    expect(res.status).toBe(200);
    expect(res.body.key_forms.from).toMatchObject({
      holder_name: 'Old Manager', doc_kind: 'holdings',
    });
    expect(res.body.key_forms.from.total_keys).toBe(1);   // CLIENT B only
  });

  it('a form lists EVERY client the holder has keys at, not just the event', async () => {
    const a = site('SITE A');
    const b = site('SITE B');
    addStaff('Multi Holder', 'multi@cw.test');
    await checkout({ account_id: a, holder: 'Multi Holder', holder_email: 'multi@cw.test', holder_type: 'employee', keys: [{ type: 'metal', qty: 2 }] });
    const res = await checkout({ account_id: b, holder: 'Multi Holder', holder_email: 'multi@cw.test', holder_type: 'employee', keys: [{ type: 'card', qty: 1 }] });
    expect(res.body.key_form.clients_covered).toBe(2);
    expect(res.body.key_form.total_keys).toBe(3);
    expect(res.body.key_form.clients.map((c: any) => c.client).sort()).toEqual(['SITE A', 'SITE B']);
  });

  it('NEVER carries a door or alarm code', async () => {
    const id = site('CODED SITE', { lockbox_code: 'LOCK-9999' });
    db.prepare("UPDATE accounts SET door_code_encrypted='xx', alarm_code_encrypted='yy' WHERE id=?").run(id);
    const res = await checkout({
      account_id: id, holder: 'Jo', holder_email: 'j@cw.test', holder_type: 'employee',
      keys: [{ type: 'metal', qty: 1 }],
    });
    const blob = JSON.stringify(res.body.key_form);
    expect(blob).not.toMatch(/LOCK-9999/);
    expect(blob).not.toMatch(/door_code/i);
    expect(blob).not.toMatch(/alarm/i);
    const stored = Object.assign({}, db.prepare('SELECT scope_json FROM key_form_docs').get() as any);
    expect(stored.scope_json).not.toMatch(/LOCK-9999/);
  });
});

describe('§3 FORMS TAB — list, search, generate, send', () => {
  const seedForms = async () => {
    const id = site('RIDGEWAY PLAZA');
    addStaff('Alpha Holder', 'alpha@cw.test');
    addStaff('Beta Holder', 'beta@cw.test');
    await checkout({ account_id: id, holder: 'Alpha Holder', holder_email: 'alpha@cw.test', holder_type: 'employee', keys: [{ type: 'metal', qty: 1 }] });
    await checkin({ holder: 'Beta Holder', holder_email: 'beta@cw.test', account_id: id, keys: [{ type: 'card', qty: 1 }] });
    return id;
  };

  it('lists forms with their event type and counts', async () => {
    await seedForms();
    const res = await auth(request(app).get('/api/key-forms'));
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.forms.map((f: any) => f.event_type).sort()).toEqual(['checkin', 'checkout']);
    expect(res.body.forms[0].form_no).toMatch(/^KF-\d{5}$/);
  });

  it('searches by holder AND by client', async () => {
    await seedForms();
    const byHolder = await auth(request(app).get('/api/key-forms?search=Alpha'));
    expect(byHolder.body.total).toBe(1);
    const byClient = await auth(request(app).get('/api/key-forms?search=RIDGEWAY'));
    expect(byClient.body.total).toBe(2);
  });

  it('filters by event type and by status', async () => {
    await seedForms();
    expect((await auth(request(app).get('/api/key-forms?event_type=checkout'))).body.total).toBe(1);
    expect((await auth(request(app).get('/api/key-forms?status=draft'))).body.total).toBe(2);
    expect((await auth(request(app).get('/api/key-forms?status=signed'))).body.total).toBe(0);
  });

  it('generates a form per holder for a MULTI-holder selection', async () => {
    const id = site('RIDGEWAY PLAZA');
    addStaff('One Person', 'one@cw.test');
    addStaff('Two Person', 'two@cw.test');
    addStaff('Three Person', null);
    await checkout({ account_id: id, holder: 'One Person', holder_email: 'one@cw.test', holder_type: 'employee', keys: [{ type: 'metal', qty: 1 }] });
    await checkout({ account_id: id, holder: 'Two Person', holder_email: 'two@cw.test', holder_type: 'employee', keys: [{ type: 'card', qty: 2 }] });
    await checkout({ account_id: id, holder: 'Three Person', holder_type: 'employee', keys: [{ type: 'fob', qty: 1 }], no_email_reason: 'No address on file' });
    db.exec('DELETE FROM key_form_docs');

    const res = await auth(request(app).post('/api/key-forms/generate')).send({
      holders: [
        { name: 'One Person', type: 'employee' },
        { name: 'Two Person', type: 'employee' },
        { name: 'Three Person', type: 'employee' },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body.count).toBe(3);
    expect(res.body.forms.map((f: any) => f.holder_name))
      .toEqual(['One Person', 'Two Person', 'Three Person']);
    expect(res.body.forms[0].total_keys).toBe(1);
    expect(res.body.forms[1].total_keys).toBe(2);
    // No email on file is flagged, not hidden.
    expect(res.body.forms[2].no_email).toBe(true);
    expect(res.body.forms.every((f: any) => f.event_type === 'audit')).toBe(true);
  });

  it('REFUSES a holdings form for a holder with no keys, and names the alternative', async () => {
    addStaff('Empty Handed', 'empty@cw.test');
    const res = await auth(request(app).post('/api/key-forms/generate'))
      .send({ holders: [{ name: 'Empty Handed', type: 'employee' }] });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NO_KEYS_ON_RECORD');
    expect(res.body.error).toContain('return receipt');
    // Nothing was written — a refused form must not leave a stub behind.
    const n = Object.assign({}, db.prepare(
      "SELECT COUNT(*) AS c FROM key_form_docs WHERE holder_name = 'Empty Handed'"
    ).get() as any).c;
    expect(n).toBe(0);
  });

  it('a mixed selection generates the holders who have keys and names those skipped', async () => {
    const id = site('MIXED TOWER');
    addStaff('Has Keys', 'has@cw.test');
    addStaff('Has None', 'none@cw.test');
    await checkout({ account_id: id, holder: 'Has Keys', holder_email: 'has@cw.test', holder_type: 'employee', keys: [{ type: 'metal', qty: 1 }] });

    const res = await auth(request(app).post('/api/key-forms/generate')).send({
      holders: [
        { name: 'Has Keys', type: 'employee' },
        { name: 'Has None', type: 'employee' },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body.count).toBe(1);
    expect(res.body.forms[0].holder_name).toBe('Has Keys');
    expect(res.body.skipped).toEqual(['Has None']);
  });

  it('send logs recipient, timestamp and sender — and resend is allowed', async () => {
    await seedForms();
    const formId = Object.assign({}, db.prepare('SELECT id FROM key_form_docs LIMIT 1').get() as any).id;

    const first = await auth(request(app).post(`/api/key-forms/${formId}/send`)).send({});
    expect(first.status).toBe(200);
    const second = await auth(request(app).post(`/api/key-forms/${formId}/send`)).send({});
    expect(second.status).toBe(200);

    const row = Object.assign({}, db.prepare('SELECT send_count FROM key_form_docs WHERE id=?').get(formId) as any);
    expect(row.send_count).toBe(2);

    const entries = (db.prepare(
      "SELECT metadata FROM audit_log WHERE action IN ('key_form_sent','key_form_send_failed')"
    ).all() as any[]).map((r) => JSON.parse(Object.assign({}, r).metadata));
    expect(entries).toHaveLength(2);
    expect(entries[0]).toHaveProperty('sent_by');
    expect(entries[0]).toHaveProperty('at');
    expect(entries[0]).toHaveProperty('recipients');
  });

  it('sends to a CUSTOM address so a form can be routed during an audit', async () => {
    await seedForms();
    const formId = Object.assign({}, db.prepare('SELECT id FROM key_form_docs LIMIT 1').get() as any).id;
    const res = await auth(request(app).post(`/api/key-forms/${formId}/send`))
      .send({ to: 'auditor@external.test' });
    expect(res.status).toBe(200);
    expect(res.body.recipients).toContain('auditor@external.test');
  });

  it('rejects a malformed custom address rather than dropping it silently', async () => {
    await seedForms();
    const formId = Object.assign({}, db.prepare('SELECT id FROM key_form_docs LIMIT 1').get() as any).id;
    const res = await auth(request(app).post(`/api/key-forms/${formId}/send`)).send({ to: 'not-an-email' });
    expect(res.status).toBe(400);
  });

  it('bulk-sends a selection and reports per-form results', async () => {
    await seedForms();
    const ids = (db.prepare('SELECT id FROM key_form_docs').all() as any[]).map((r) => Object.assign({}, r).id);
    const res = await auth(request(app).post('/api/key-forms/bulk-send')).send({ ids });
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(ids.length);
    expect(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action='key_forms_bulk_sent'").get())
      .toMatchObject({ n: 1 });
  });

  it('downloads a PDF', async () => {
    await seedForms();
    const formId = Object.assign({}, db.prepare('SELECT id FROM key_form_docs LIMIT 1').get() as any).id;
    const res = await auth(request(app).get(`/api/key-forms/${formId}/pdf`));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.body.length).toBeGreaterThan(1000);
  });

  it('requires auth for every management endpoint', async () => {
    expect((await request(app).get('/api/key-forms')).status).toBe(401);
    expect((await request(app).post('/api/key-forms/generate').send({ holder: 'X' })).status).toBe(401);
  });
});

describe('§5 SIGNATURE + DELIVERY', () => {
  const openForm = async () => {
    const id = site('RIDGEWAY PLAZA');
    addStaff('Sign Me', 'sign@cw.test');
    await checkout({ account_id: id, holder: 'Sign Me', holder_email: 'sign@cw.test', holder_type: 'employee', keys: [{ type: 'metal', qty: 2 }] });
    return Object.assign({}, db.prepare('SELECT id, token FROM key_form_docs LIMIT 1').get() as any);
  };

  it('the magic link opens the form without a login', async () => {
    const f = await openForm();
    const res = await request(app).get(`/api/key-forms/token/${f.token}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ holder: 'Sign Me', total_keys: 2 });
    expect(res.body.clients[0].client).toBe('RIDGEWAY PLAZA');
  });

  it('signing marks it signed and stores the hash', async () => {
    const f = await openForm();
    const res = await request(app).post(`/api/key-forms/token/${f.token}/sign`).send({
      signature_data: 'data:image/png;base64,iVBORw0KGgo=', typed_name: 'Sign Me',
    });
    expect(res.status).toBe(200);
    const row = Object.assign({}, db.prepare('SELECT * FROM key_form_docs WHERE id=?').get(f.id) as any);
    expect(row.status).toBe('signed');
    expect(row.signed_at).toBeTruthy();
    expect(row.signature_hash).toHaveLength(64);
    // The token is spent.
    expect(row.token).toBeNull();
  });

  it('refuses a typed name that is not the holder', async () => {
    const f = await openForm();
    const res = await request(app).post(`/api/key-forms/token/${f.token}/sign`).send({
      signature_data: 'data:image/png;base64,iVBORw0KGgo=', typed_name: 'Someone Else',
    });
    expect(res.status).toBe(400);
  });

  it('refuses a second signature on the same form', async () => {
    const f = await openForm();
    const body = { signature_data: 'data:image/png;base64,iVBORw0KGgo=', typed_name: 'Sign Me' };
    await request(app).post(`/api/key-forms/token/${f.token}/sign`).send(body);
    const again = await request(app).post(`/api/key-forms/token/${f.token}/sign`).send(body);
    expect([404, 409]).toContain(again.status);
  });

  it('a holder with NO email gets a draft flagged red, still downloadable', async () => {
    const id = site('RIDGEWAY PLAZA');
    addStaff('No Mail', null);
    // They must hold something: this is about the missing ADDRESS, and a
    // holder with no keys is refused before the email question is reached.
    await checkout({ account_id: id, holder: 'No Mail', holder_type: 'employee', keys: [{ type: 'metal', qty: 1 }], no_email_reason: 'No address on file' });
    const res = await auth(request(app).post('/api/key-forms/generate'))
      .send({ holders: [{ name: 'No Mail', type: 'employee' }] });
    const form = res.body.forms[0];
    expect(form.no_email).toBe(true);
    expect(form.status).toBe('draft');
    // No token — an unusable link would make it look like it is waiting.
    const row = Object.assign({}, db.prepare('SELECT token FROM key_form_docs WHERE id=?').get(form.id) as any);
    expect(row.token).toBeNull();
    // …but the PDF is still there to print or route.
    const pdf = await auth(request(app).get(`/api/key-forms/${form.id}/pdf`));
    expect(pdf.status).toBe(200);
  });

  it('a no-email form can still be sent to a custom address', async () => {
    const id = site('RIDGEWAY PLAZA');
    addStaff('No Mail', null);
    await checkout({ account_id: id, holder: 'No Mail', holder_type: 'employee', keys: [{ type: 'metal', qty: 1 }], no_email_reason: 'No address on file' });
    const gen = await auth(request(app).post('/api/key-forms/generate'))
      .send({ holders: [{ name: 'No Mail', type: 'employee' }] });
    const res = await auth(request(app).post(`/api/key-forms/${gen.body.forms[0].id}/send`))
      .send({ to: 'auditor@external.test' });
    expect(res.body.recipients).toContain('auditor@external.test');
  });
});

describe('§4 TRANSFER MODES', () => {
  const setup = async () => {
    const id = site('RIDGEWAY PLAZA', { account_manager: 'From Person' });
    addStaff('From Person', 'from@cw.test');
    addStaff('To Person', 'to@cw.test');
    await checkout({
      account_id: id, holder: 'From Person', holder_email: 'from@cw.test',
      holder_type: 'employee', keys: [{ type: 'metal', qty: 3 }],
    });
    return id;
  };
  const transfer = (b: any) => auth(request(app).post('/api/assignments/transfer')).send(b);

  it('keys only — keys move, the manager column does not', async () => {
    const id = await setup();
    const res = await transfer({
      account_id: id, mode: 'keys', from_holder: 'From Person', to_holder: 'To Person',
      to_holder_email: 'to@cw.test', keys: [{ type: 'metal', qty: 2 }],
    });
    expect(res.status).toBe(201);
    expect(res.body.mode).toBe('keys');
    expect(res.body.account_moved).toBeNull();
    expect(Object.assign({}, db.prepare('SELECT account_manager FROM accounts WHERE id=?').get(id) as any))
      .toMatchObject({ account_manager: 'From Person' });
  });

  it('accounts only — the manager moves, the keys stay put', async () => {
    const id = await setup();
    const res = await transfer({
      account_id: id, mode: 'accounts', from_holder: 'From Person', to_holder: 'To Person',
      to_holder_email: 'to@cw.test', account_role: 'am', keys: [],
    });
    expect(res.status).toBe(201);
    expect(res.body.account_moved).toMatchObject({ role: 'am', from: 'From Person', to: 'To Person' });
    expect(Object.assign({}, db.prepare('SELECT account_manager, pending_handover FROM accounts WHERE id=?').get(id) as any))
      .toMatchObject({ account_manager: 'To Person', pending_handover: 1 });
    // The original custody is untouched — the keys did not move.
    expect(Object.assign({}, db.prepare("SELECT assignee FROM key_assignments WHERE status='checked_out'").get() as any))
      .toMatchObject({ assignee: 'From Person' });
  });

  it('keys and accounts — both move together', async () => {
    const id = await setup();
    const res = await transfer({
      account_id: id, mode: 'both', from_holder: 'From Person', to_holder: 'To Person',
      to_holder_email: 'to@cw.test', account_role: 'am', keys: [{ type: 'metal', qty: 3 }],
    });
    expect(res.status).toBe(201);
    expect(res.body.account_moved).toMatchObject({ to: 'To Person' });
    expect(Object.assign({}, db.prepare('SELECT account_manager FROM accounts WHERE id=?').get(id) as any))
      .toMatchObject({ account_manager: 'To Person' });
    expect(Object.assign({}, db.prepare("SELECT assignee FROM key_assignments WHERE status='checked_out'").get() as any))
      .toMatchObject({ assignee: 'To Person' });
    // Keys moved with it, so there is nothing physical left pending.
    expect(Object.assign({}, db.prepare('SELECT pending_handover FROM accounts WHERE id=?').get(id) as any))
      .toMatchObject({ pending_handover: 0 });
  });

  it('accounts-only does NOT require the holder to have keys on record', async () => {
    const id = site('NO KEYS SITE', { account_manager: 'From Person' });
    addStaff('From Person', 'from@cw.test');
    addStaff('To Person', 'to@cw.test');
    const res = await transfer({
      account_id: id, mode: 'accounts', from_holder: 'From Person', to_holder: 'To Person',
      to_holder_email: 'to@cw.test', account_role: 'am', keys: [],
    });
    expect(res.status).toBe(201);
  });

  it('keys mode still refuses when nothing is on record, and says what to do', async () => {
    const id = site('NO KEYS SITE');
    addStaff('From Person', 'from@cw.test');
    const res = await transfer({
      account_id: id, mode: 'keys', from_holder: 'From Person', to_holder: 'To Person',
      to_holder_email: 'to@cw.test', keys: [{ type: 'metal', qty: 1 }],
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/record a check-in first|Accounts only/i);
  });

  it('all three modes produce paired forms', async () => {
    for (const mode of ['keys', 'accounts', 'both'] as const) {
      db.exec('DELETE FROM access_codes');
      db.exec('DELETE FROM key_assignments'); db.exec('DELETE FROM accounts');
      db.exec('DELETE FROM staff_managers'); db.exec('DELETE FROM key_form_docs');
      const id = await setup();
      const res = await transfer({
        account_id: id, mode, from_holder: 'From Person', to_holder: 'To Person',
        to_holder_email: 'to@cw.test', account_role: 'am',
        keys: mode === 'accounts' ? [] : [{ type: 'metal', qty: 2 }],
      });
      expect(res.status, `mode ${mode}`).toBe(201);
      if (mode === 'accounts') {
        // No keys moved, so there is nothing for the outgoing side to sign a
        // RECEIPT for: they get a holdings statement instead, still covering
        // the 3 keys the account move did not touch.
        expect(res.body.key_forms.from, `mode ${mode} from-form`).toBeTruthy();
        expect(res.body.key_forms.from.doc_kind, `mode ${mode}`).toBe('holdings');
        expect(res.body.key_forms.from.total_keys, `mode ${mode}`).toBe(3);
        // The incoming side received no keys and holds none, so their form
        // would be blank — skipped rather than issued. The transfer succeeded.
        expect(res.body.key_forms.to, `mode ${mode} to-form`).toBeNull();
      } else {
        expect(res.body.key_forms.from, `mode ${mode} from-form`).toBeTruthy();
        expect(res.body.key_forms.from.doc_kind, `mode ${mode}`).toBe('return_receipt');
        expect(res.body.key_forms.to, `mode ${mode} to-form`).toBeTruthy();
        expect(res.body.key_forms.to.doc_kind, `mode ${mode}`).toBe('holdings');
      }
    }
  });
});

describe('ESTABLISH CUSTODY IS GONE', () => {
  it('the endpoint no longer exists', async () => {
    const res = await auth(request(app).post('/api/assignments/establish'))
      .send({ holder: 'X', account_id: 1, keys: [{ type: 'metal', qty: 1 }] });
    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('EVENT → DOCUMENT MAPPING', () => {
  it('maps every event to the document it should produce', async () => {
    const { DOC_KIND_BY_EVENT, docKindOf } = await import('../src/lib/keyForm');

    // The table itself. Transfer's entry is the DEFAULT only — the transfer
    // route overrides it per party, which is asserted in §4.
    expect(DOC_KIND_BY_EVENT).toMatchObject({
      checkout: 'holdings',
      checkin: 'return_receipt',
      reassignment: 'holdings',
      audit: 'holdings',
    });

    // A stored kind always wins, so one transfer can carry both.
    expect(docKindOf({ event_type: 'transfer', doc_kind: 'return_receipt' })).toBe('return_receipt');
    expect(docKindOf({ event_type: 'transfer', doc_kind: 'holdings' })).toBe('holdings');
    // Rows written before doc_kind existed fall back to the event mapping, so
    // an old check-in form still reads as the receipt it was meant to be.
    expect(docKindOf({ event_type: 'checkin', doc_kind: null })).toBe('return_receipt');
    expect(docKindOf({ event_type: 'audit', doc_kind: null })).toBe('holdings');
  });

  it('check-out produces a HOLDINGS statement', async () => {
    const id = site('RIDGEWAY PLAZA');
    const res = await checkout({
      account_id: id, holder: 'Jo Martinez', holder_email: 'jo@cw.test',
      holder_type: 'employee', keys: [{ type: 'metal', qty: 2 }],
    });
    expect(res.body.key_form).toMatchObject({
      doc_kind: 'holdings', doc_title: 'Key Form', table_heading: 'Keys held',
    });
    expect(res.body.key_form.returned_keys).toBe(0);
  });
});

describe('ADD IC / ADD CUSTOMER SENDS NOTHING', () => {
  it('creating an IC fires no email and writes no invitation', async () => {
    const before = Object.assign({}, db.prepare(
      "SELECT COUNT(*) AS c FROM audit_log WHERE action LIKE '%email%' OR action LIKE '%invit%'"
    ).get() as any).c as number;

    const res = await auth(request(app).post('/api/accounts')).send({
      ic_company_name: 'BRAND NEW IC LLC',
      bc_vendor_number: '02014199999',
      record_type: 'ic',
      ic_email: 'newic@vendor.test',
      ic_primary_contact: 'Pat Vendor',
    });
    expect(res.status).toBe(201);

    const after = Object.assign({}, db.prepare(
      "SELECT COUNT(*) AS c FROM audit_log WHERE action LIKE '%email%' OR action LIKE '%invit%'"
    ).get() as any).c as number;
    // Every send in this system writes an audit row, so no new row means no
    // send was attempted — not merely that a send failed quietly.
    expect(after).toBe(before);

    // And no contractor invitation/token was minted on record creation.
    const invites = Object.assign({}, db.prepare(
      "SELECT COUNT(*) AS c FROM contractors WHERE name = 'BRAND NEW IC LLC' OR email = 'newic@vendor.test'"
    ).get() as any).c as number;
    expect(invites).toBe(0);
  });

  it('creating a customer fires no email either', async () => {
    const before = Object.assign({}, db.prepare(
      "SELECT COUNT(*) AS c FROM audit_log WHERE action LIKE '%email%'"
    ).get() as any).c as number;
    const res = await auth(request(app).post('/api/accounts')).send({
      ic_company_name: 'BRAND NEW CLIENT', bc_client_number: '01014199999',
      record_type: 'customer', account_manager: 'Someone',
    });
    expect(res.status).toBe(201);
    const after = Object.assign({}, db.prepare(
      "SELECT COUNT(*) AS c FROM audit_log WHERE action LIKE '%email%'"
    ).get() as any).c as number;
    expect(after).toBe(before);
  });
});

// ═════════ A RECONCILED ENTRY IS A HOLDINGS RECORD, NOT A RECEIPT ═════════
describe('FIRST-TIME CUSTODY RECORD vs GENUINE RETURN', () => {
  it('a reconciled check-in produces a HOLDINGS assertion', async () => {
    const id = site('ATENEA SERVICES');
    const res = await checkin({
      holder: 'Jo Martinez', holder_email: 'jo@cw.test', holder_type: 'employee',
      account_id: id, keys: [{ type: 'metal', qty: 1 }],
    });
    expect(res.status).toBe(201);
    expect(res.body.reconciled).toBe(true);

    const form = res.body.key_form;
    // "I confirm I have returned the keys listed above" is FALSE here, so the
    // document must not be the kind that says it.
    expect(form.doc_kind).toBe('holdings');
    expect(form.doc_title).toBe('Key Form');
    expect(form.table_heading).toBe('Keys held');
    expect(form.total_label).toBe('TOTAL KEYS HELD');
    expect(form.total_keys).toBe(1);
    expect(form.clients[0]).toMatchObject({ client: 'ATENEA SERVICES', metal: 1 });
    expect(form.clients[0].via).toBe('Recorded as held');
    expect(form.event_note).toBe('Recorded at ATENEA SERVICES: 1 Metal Key on record as held');
    expect(form.event_note).not.toMatch(/returned/i);
  });

  it('a genuine return after a check-out still produces a RETURN RECEIPT', async () => {
    const id = site('ATENEA SERVICES');
    await checkout({
      account_id: id, holder: 'Jo Martinez', holder_email: 'jo@cw.test',
      holder_type: 'employee', keys: [{ type: 'metal', qty: 1 }],
    });
    const res = await checkin({
      holder: 'Jo Martinez', account_id: id, keys: [{ type: 'metal', qty: 1 }],
    });
    expect(res.status).toBe(200);
    expect(res.body.reconciled).toBeUndefined();

    const form = res.body.key_form;
    expect(form.doc_kind).toBe('return_receipt');
    expect(form.doc_title).toBe('Key Return Receipt');
    expect(form.table_heading).toBe('Keys returned');
    expect(form.event_note).toContain('Returned at ATENEA SERVICES');
  });

  it('the reconciled PDF never says the holder returned anything', async () => {
    const id = site('ATENEA SERVICES');
    const res = await checkin({
      holder: 'Jo Martinez', holder_email: 'jo@cw.test', holder_type: 'employee',
      account_id: id, keys: [{ type: 'metal', qty: 2 }],
    });
    const pdf = await auth(request(app).get(`/api/key-forms/${res.body.key_form.id}/pdf`));
    expect(pdf.status).toBe(200);
    const text = pdfText(pdf.body as Buffer);

    expect(text).toContain('Key Form');
    expect(text).toContain('KEYS HELD');
    expect(text).toContain('currently in my possession');
    // The false sentence must never be generated for this record.
    expect(text).not.toMatch(/I have returned the keys listed above/i);
    expect(text).not.toMatch(/Key Return Receipt/);
  });

  it('the genuine-return PDF still carries the return acknowledgement', async () => {
    const id = site('ATENEA SERVICES');
    await checkout({
      account_id: id, holder: 'Jo Martinez', holder_email: 'jo@cw.test',
      holder_type: 'employee', keys: [{ type: 'metal', qty: 2 }],
    });
    const res = await checkin({
      holder: 'Jo Martinez', account_id: id, keys: [{ type: 'metal', qty: 2 }],
    });
    const pdf = await auth(request(app).get(`/api/key-forms/${res.body.key_form.id}/pdf`));
    const text = pdfText(pdf.body as Buffer);
    expect(text).toContain('Key Return Receipt');
    expect(text).toContain('I confirm I have returned the keys listed above');
  });
});

/** Drawn text from a pdf-lib document (hex-encoded Tj operands). */
function pdfText(buf: Buffer): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const zlib = require('zlib');
  let raw = '';
  const s = buf.toString('latin1');
  const re = /stream\r?\n([\s\S]*?)endstream/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    try { raw += zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1'); } catch { /* not deflate */ }
  }
  const out: string[] = [];
  const tj = /<([0-9A-Fa-f]+)>\s*Tj/g;
  let t: RegExpExecArray | null;
  while ((t = tj.exec(raw)) !== null) out.push(Buffer.from(t[1], 'hex').toString('latin1'));
  return out.join('\n');
}
