// ── One signature closes every record of the transaction ─────────────────────
// Verified on the ZZ TEST fixtures. Whichever link the holder signs — the
// custody receipt link or the Key Form link — the registry row, the Key Form
// and the dashboard counts all read Signed immediately.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'citywide-sigsync-'));
process.env.CITYWIDE_DB_DIR = TEST_DIR;
delete process.env.DB_PATH;
process.env.JWT_SECRET = 'test-secret';
process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
process.env.SEED_PASSWORD = 'demo1234';
process.env.SMTP_USER = 'keys@citywideboston.com';
process.env.SMTP_PASS = 'not-a-real-password';

const sent: any[] = [];
vi.mock('nodemailer', () => ({
  default: { createTransport: () => ({ sendMail: async (m: any) => { sent.push(m); return { messageId: 't' }; } }) },
}));

const DB_FILE = path.join(TEST_DIR, 'citywide.db');
let app: Express;
let token: string;
let db: DatabaseSync;
let fx: typeof import('../src/lib/testFixtures');
let sync: typeof import('../src/lib/signatureSync');

const AM1 = 'ZZ Test AM One';
const MAILBOX = 'keys@citywidekeys.com';
const SIG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const auth = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);
const obj = (r: any) => (r ? Object.assign({}, r) : null);
const row = (id: number) => obj(db.prepare('SELECT * FROM key_assignments WHERE id = ?').get(id));
const form = (id: number) => obj(db.prepare('SELECT * FROM key_form_docs WHERE id = ?').get(id));
const idOf = (bc: string) => Number(obj(db.prepare('SELECT id FROM accounts WHERE bc_client_number = ?').get(bc)).id);
const tokenOf = (link: string) => link.split('/').pop()!;

beforeAll(async () => {
  app = (await import('../src/index')).default;
  (await import('../src/lib/autoSeed')).autoSeedIfEmpty();
  fx = await import('../src/lib/testFixtures');
  sync = await import('../src/lib/signatureSync');
  token = (await request(app).post('/api/auth/login')
    .send({ email: 'cara@citywideboston.com', password: 'demo1234' })).body.token;
  db = new DatabaseSync(DB_FILE);
});

beforeEach(() => {
  for (const t of ['key_assignments', 'custody_sign_links', 'form_clients', 'key_form_docs', 'audit_log', 'access_codes']) {
    db.exec(`DELETE FROM ${t}`);
  }
  db.exec('DELETE FROM accounts WHERE COALESCE(is_test,0)=0');
  db.exec('DELETE FROM staff_managers WHERE COALESCE(is_test,0)=0');
  db.exec("DELETE FROM settings WHERE key = 'signature_backfill_last'");
  fx.seedTestFixtures();
  sent.length = 0;
});

const issue = async (qty = 1) => {
  const res = await auth(request(app).post('/api/assignments/checkout')).send({
    account_id: idOf('09999900001'), holder: AM1, holder_email: MAILBOX, holder_type: 'employee',
    keys: [{ type: 'metal', qty }], sign_mode: 'email',
  });
  expect(res.status).toBe(201);
  return res.body;
};
const signCustody = (tok: string) => request(app).post(`/api/signoff/${tok}/sign`)
  .send({ signature_data: SIG, typed_name: AM1 });
const signForm = (tok: string) => request(app).post(`/api/key-forms/token/${tok}/sign`)
  .send({ signature_data: SIG, typed_name: AM1 });
const formsTab = async (id: number) => {
  const r = await auth(request(app).get('/api/key-forms')).query({ limit: '200' });
  return { f: r.body.forms.find((x: any) => x.id === id), counts: r.body.link_counts };
};
const registryRow = async (id: number, status: string) => {
  const r = await auth(request(app).get('/api/assignments')).query({ status, limit: '200', include_test: '1' });
  return r.body.assignments.find((x: any) => x.id === id);
};

describe('SIGN VIA THE CUSTODY RECEIPT LINK', () => {
  it('check-in (issue) → registry, Key Forms tab and dashboard all read Signed', async () => {
    const out = await issue();
    const links = db.prepare('SELECT * FROM custody_sign_links WHERE form_id = ?').all(out.key_form.id).map(obj);
    expect(links).toEqual([{ form_id: out.key_form.id, assignment_id: out.id, slot: 'checkout' }]);

    const res = await signCustody(tokenOf(out.signoff_link));
    expect(res.status).toBe(200);

    const reg = await registryRow(out.id, 'checked_out');
    expect(reg.signed_at).toBeTruthy();
    expect(reg.signature_status).toBe('signed');
    const { f, counts } = await formsTab(out.key_form.id);
    expect(f.status).toBe('signed');
    expect(f.link_state).toBe('signed');
    expect(counts.signed).toBe(1);
    expect(counts.awaiting).toBe(0);
    expect(form(out.key_form.id).signed_at).toBe(row(out.id).signed_at);
    expect(form(out.key_form.id).token).toBeNull();          // the other link is closed too
    const gaps = await auth(request(app).get('/api/assignments/signature-gaps'));
    expect(gaps.body.total_missing).toBe(0);
  });

  it('check-out (return) → the return receipt Key Form is Signed too', async () => {
    const out = await issue();
    const back = await auth(request(app).post('/api/assignments/checkin')).send({ id: out.id, condition_on_return: 'good', sign_mode: 'email' });
    expect(back.status).toBe(200);
    const res = await signCustody(tokenOf(back.body.signoff_link));
    expect(res.status).toBe(200);
    const returned = back.body.assignment?.id ?? out.id;
    expect((await registryRow(returned, 'returned')).checkin_signed_at).toBeTruthy();
    expect((await formsTab(back.body.key_form.id)).f.link_state).toBe('signed');
  });

  it('a Record Keys Held entry reads Signed on the registry, not just on the form', async () => {
    const res = await auth(request(app).post('/api/assignments/checkin')).send({
      holder: AM1, holder_email: MAILBOX, holder_type: 'employee', account_id: idOf('09999900001'),
      keys: [{ type: 'metal', qty: 1 }], sign_mode: 'email',
    });
    expect(res.status).toBe(201);
    await signCustody(tokenOf(res.body.signoff_link));
    const r = obj(db.prepare("SELECT * FROM key_assignments WHERE origin = 'reconciled' ORDER BY id DESC LIMIT 1").get());
    expect(r.signature_status).toBe('signed');
    expect(form(res.body.key_form.id).status).toBe('signed');
  });

  it('a return that closed TWO open records signs both', async () => {
    const a = await issue(1);
    const b = await issue(1);
    const back = await auth(request(app).post('/api/assignments/checkin')).send({
      holder: AM1, holder_email: MAILBOX, holder_type: 'employee', account_id: idOf('09999900001'),
      keys: [{ type: 'metal', qty: 2 }], sign_mode: 'email',
    });
    expect(back.status).toBe(200);
    await signCustody(tokenOf(back.body.signoff_link));
    expect(row(a.id).checkin_signed_at).toBeTruthy();
    expect(row(b.id).checkin_signed_at).toBeTruthy();
  });
});

describe('SIGN VIA THE KEY FORM LINK', () => {
  it('→ the registry row is Signed too', async () => {
    const out = await issue();
    const res = await signForm(form(out.key_form.id).token);
    expect(res.status).toBe(200);
    expect(row(out.id)).toMatchObject({ signature_status: 'signed', signoff_token: null });
    expect(row(out.id).signed_at).toBe(form(out.key_form.id).signed_at);
    expect(row(out.id).signature_hash).toBe(form(out.key_form.id).signature_hash);
    // The custody link is closed — it cannot collect a second signature.
    expect((await signCustody(tokenOf(out.signoff_link))).status).toBeGreaterThanOrEqual(400);
  });
});

describe('BACKFILL — signed on one record, unsigned on another', () => {
  it('copies the original signature and signed_at across, reports each, sends nothing', async () => {
    const out = await issue();
    // The drift as it exists in production: signed via the custody link
    // before sync existed, and the link table not yet written.
    const at = '2026-09-24T19:58:00.000Z';
    db.prepare(`UPDATE key_assignments SET signed_at = ?, signature_data = ?, signature_hash = 'abc123',
      signature_status = 'signed', signoff_token = NULL WHERE id = ?`).run(at, SIG, out.id);
    db.exec('DELETE FROM custody_sign_links');
    sent.length = 0;

    const r = sync.backfillSignatures();
    expect(r.links_added).toBe(1);
    expect(r.fixed).toEqual([expect.objectContaining({ record: 'key_form', id: out.key_form.id, signed_at: at })]);
    expect(form(out.key_form.id)).toMatchObject({ status: 'signed', signed_at: at, signature_hash: 'abc123' });
    expect(sent).toHaveLength(0);
    const audit = db.prepare("SELECT COUNT(*) AS c FROM audit_log WHERE action = 'signature_status_backfilled'").get();
    expect(obj(audit).c).toBe(1);
    expect(sync.backfillSignatures().fixed).toHaveLength(0);   // idempotent

    const diag = await auth(request(app).get('/api/_diag'));
    expect(diag.body.signature_backfill.count).toBe(1);
  });

  it('the other direction: a signed form fills its custody row', async () => {
    const out = await issue();
    const at = '2026-09-24T19:58:00.000Z';
    db.prepare(`UPDATE key_form_docs SET signed_at = ?, signature_data = ?, signature_hash = 'def456',
      status = 'signed', token = NULL WHERE id = ?`).run(at, SIG, out.key_form.id);
    const r = sync.backfillSignatures();
    expect(r.fixed.map((x) => x.record)).toEqual(['custody']);
    expect(row(out.id)).toMatchObject({ signed_at: at, signature_status: 'signed', signature_hash: 'def456' });
  });

  it('never overwrites a signature that is already there, or a voided form', async () => {
    const out = await issue();
    db.prepare("UPDATE key_form_docs SET status = 'voided' WHERE id = ?").run(out.key_form.id);
    db.prepare(`UPDATE key_assignments SET signed_at = ?, signature_data = ?, signature_hash = 'x' WHERE id = ?`)
      .run('2026-09-24T19:58:00.000Z', SIG, out.id);
    expect(sync.backfillSignatures().fixed).toHaveLength(0);
    expect(form(out.key_form.id).status).toBe('voided');
  });
});
