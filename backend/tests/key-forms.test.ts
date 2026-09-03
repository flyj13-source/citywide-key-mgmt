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
    expect(res.body.key_form.holder_shift).toContain('1st');
  });

  it('check-in produces one', async () => {
    const id = site('RIDGEWAY PLAZA');
    const res = await checkin({
      holder: 'Jo', holder_email: 'j@cw.test', account_id: id, keys: [{ type: 'metal', qty: 1 }],
    });
    expect(res.body.key_form).toMatchObject({ event_type: 'checkin', holder_name: 'Jo' });
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
    expect(res.body.key_forms.from).toMatchObject({
      event_type: 'transfer', holder_name: 'From Person', counterparty_name: 'To Person',
    });
    expect(res.body.key_forms.to).toMatchObject({
      event_type: 'transfer', holder_name: 'To Person', counterparty_name: 'From Person',
    });
    // The outgoing party keeps the 1 they did not hand over.
    expect(res.body.key_forms.from.total_keys).toBe(1);
    expect(res.body.key_forms.to.total_keys).toBe(2);
  });

  it('manager reassignment produces a form for both managers', async () => {
    addStaff('Old Manager', 'old@cw.test');
    addStaff('New Manager', 'new@cw.test');
    site('CLIENT A', { account_manager: 'Old Manager' });
    const ids = (db.prepare('SELECT id FROM accounts').all() as any[]).map((r) => Object.assign({}, r).id);
    const from = Object.assign({}, db.prepare("SELECT id FROM staff_managers WHERE name='Old Manager'").get() as any).id;
    const to = Object.assign({}, db.prepare("SELECT id FROM staff_managers WHERE name='New Manager'").get() as any).id;

    const res = await auth(request(app).post('/api/managers/reassign')).send({
      fromId: from, toId: to, role: 'am', clientIds: ids, sendHandover: false,
    });
    expect(res.status).toBe(200);
    expect(res.body.key_forms.from).toMatchObject({ event_type: 'reassignment', holder_name: 'Old Manager' });
    expect(res.body.key_forms.to).toMatchObject({ event_type: 'reassignment', holder_name: 'New Manager' });
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
    // Current state: only the first actually holds anything.
    expect(res.body.forms[0].total_keys).toBe(1);
    expect(res.body.forms[1].total_keys).toBe(0);
    // No email on file is flagged, not hidden.
    expect(res.body.forms[2].no_email).toBe(true);
    expect(res.body.forms.every((f: any) => f.event_type === 'audit')).toBe(true);
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
    site('RIDGEWAY PLAZA');
    addStaff('No Mail', null);
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
      db.exec('DELETE FROM key_assignments'); db.exec('DELETE FROM accounts');
      db.exec('DELETE FROM staff_managers'); db.exec('DELETE FROM key_form_docs');
      const id = await setup();
      const res = await transfer({
        account_id: id, mode, from_holder: 'From Person', to_holder: 'To Person',
        to_holder_email: 'to@cw.test', account_role: 'am',
        keys: mode === 'accounts' ? [] : [{ type: 'metal', qty: 2 }],
      });
      expect(res.status, `mode ${mode}`).toBe(201);
      expect(res.body.key_forms.from, `mode ${mode} from-form`).toBeTruthy();
      expect(res.body.key_forms.to, `mode ${mode} to-form`).toBeTruthy();
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
