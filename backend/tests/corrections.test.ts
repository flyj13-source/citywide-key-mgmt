import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

// ── Corrections ──────────────────────────────────────────────────────────────
// Two distinct claims, and the whole value is in not confusing them:
//   voided                  — this record should not exist
//   acknowledged_unsigned   — it should, but no signature is coming
//
// Nothing here may delete, and nothing may render an acknowledgement as a
// signature. Both are asserted directly rather than assumed.

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'citywide-corr-'));
process.env.CITYWIDE_DB_DIR = TEST_DIR;
delete process.env.DB_PATH;
process.env.JWT_SECRET = 'test-secret';
process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
process.env.SEED_PASSWORD = 'demo1234';
process.env.FRONTEND_URL = 'https://keys.example.test';
delete process.env.SMTP_USER;
delete process.env.SMTP_PASS;

const DB_FILE = path.join(TEST_DIR, 'citywide.db');

let app: Express;
let token: string;
let plainToken: string;
let db: DatabaseSync;
let clientId: number;

const auth = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);
const plain = (r: request.Test) => r.set('Authorization', `Bearer ${plainToken}`);
const obj = (r: any) => (r ? Object.assign({}, r) : null);
const scalar = (sql: string, ...p: any[]) =>
  Object.assign({}, db.prepare(sql).get(...p) as any).c as number;

const REASON = 'entered in error — wrong holder selected';

/** A live check-out with a signature link waiting on it. */
const makeCheckout = async (holder = 'Real Holder', overdue = false) => {
  const res = await auth(request(app).post('/api/assignments/checkout')).send({
    account_id: clientId, holder, holder_email: 'holder@example.test',
    holder_type: 'employee', keys: [{ type: 'metal', qty: 1 }],
    due_at: overdue ? '2020-01-01' : '2030-01-01',
  });
  expect(res.status).toBe(201);
  return res.body.id as number;
};

beforeAll(async () => {
  app = (await import('../src/index')).default;
  (await import('../src/lib/autoSeed')).autoSeedIfEmpty();
  const login = await request(app).post('/api/auth/login')
    .send({ email: 'cara@citywideboston.com', password: 'demo1234' });
  token = login.body.token;
  db = new DatabaseSync(DB_FILE);

  // A second manager WITHOUT can_delete, to prove the gate.
  const bcrypt = (await import('bcryptjs')).default;
  db.prepare(
    "INSERT OR IGNORE INTO managers (name, email, password_hash, role, can_delete) " +
    "VALUES ('Plain Manager','plain@citywideboston.com',?, 'manager', 0)"
  ).run(bcrypt.hashSync('demo1234', 10));
  const pl = await request(app).post('/api/auth/login')
    .send({ email: 'plain@citywideboston.com', password: 'demo1234' });
  plainToken = pl.body.token;
});

beforeEach(() => {
  db.exec('DELETE FROM key_assignments');
  db.exec('DELETE FROM key_form_docs');
  db.exec('DELETE FROM audit_log');
  db.exec("DELETE FROM accounts WHERE bc_client_number = '01014277001'");
  const r = db.prepare(`
    INSERT INTO accounts (ic_company_name, bc_client_number, record_type, status, archived, metal_keys)
    VALUES ('CORRECTION SITE', '01014277001', 'customer', 'active', 0, 6)
  `).run();
  clientId = Number(r.lastInsertRowid);
});

// ══════════════════════════ §2 VOID ═════════════════════════════════════════
describe('§2 voiding a record entered in error', () => {
  it('never deletes — the row stays with who, when and why', async () => {
    const id = await makeCheckout();
    const before = scalar('SELECT COUNT(*) AS c FROM key_assignments');

    const res = await auth(request(app).post(`/api/assignments/${id}/void`)).send({ reason: REASON });
    expect(res.status).toBe(200);

    expect(scalar('SELECT COUNT(*) AS c FROM key_assignments')).toBe(before);
    const row = obj(db.prepare('SELECT * FROM key_assignments WHERE id = ?').get(id));
    expect(row).toMatchObject({
      status: 'voided',
      status_before_void: 'checked_out',
      void_reason: REASON,
      voided_by: 'Cara Angeloni',
    });
    expect(row.voided_at).toBeTruthy();
  });

  it('leaves active custody, overdue, and the site availability', async () => {
    const id = await makeCheckout('Real Holder', true);
    expect((await auth(request(app).get('/api/assignments?status=checked_out&limit=1'))).body.total).toBe(1);
    expect((await auth(request(app).get('/api/reports/overdue'))).body).toHaveLength(1);
    const availBefore = (await auth(request(app).get(`/api/assignments/availability?account_id=${clientId}`)))
      .body.types.find((t: any) => t.type === 'metal');
    expect(availBefore.available).toBe(5);

    await auth(request(app).post(`/api/assignments/${id}/void`)).send({ reason: REASON });

    expect((await auth(request(app).get('/api/assignments?status=checked_out&limit=1'))).body.total).toBe(0);
    expect((await auth(request(app).get('/api/reports/overdue'))).body).toHaveLength(0);
    // The key is back on the shelf — it was never really out.
    const availAfter = (await auth(request(app).get(`/api/assignments/availability?account_id=${clientId}`)))
      .body.types.find((t: any) => t.type === 'metal');
    expect(availAfter.available).toBe(6);
  });

  it('drops out of the holder Key Form totals', async () => {
    const id = await makeCheckout('Snapshot Person');
    const { snapshotHolder } = await import('../src/lib/keyForm');
    expect(snapshotHolder('Snapshot Person')).toHaveLength(1);

    await auth(request(app).post(`/api/assignments/${id}/void`)).send({ reason: REASON });
    expect(snapshotHolder('Snapshot Person')).toHaveLength(0);
  });

  it('kills the magic link — the recipient gets nothing to sign', async () => {
    const id = await makeCheckout();
    const link = obj(db.prepare('SELECT signoff_token FROM key_assignments WHERE id = ?').get(id)).signoff_token;
    expect(link).toBeTruthy();
    // Live before.
    expect((await request(app).get(`/api/signoff/${link}`)).status).toBe(200);

    const res = await auth(request(app).post(`/api/assignments/${id}/void`)).send({ reason: REASON });
    expect(res.body.link_invalidated).toBe(true);

    // Dead after — and dead because the token is gone, not merely hidden.
    expect((await request(app).get(`/api/signoff/${link}`)).status).toBe(404);
    expect(obj(db.prepare('SELECT signoff_token FROM key_assignments WHERE id = ?').get(id)).signoff_token).toBeNull();
  });

  it('is hidden from ordinary views but reachable by asking for it', async () => {
    const id = await makeCheckout();
    await auth(request(app).post(`/api/assignments/${id}/void`)).send({ reason: REASON });

    expect((await auth(request(app).get('/api/assignments?limit=50'))).body.total).toBe(0);
    const voided = await auth(request(app).get('/api/assignments?view=voided&limit=50'));
    expect(voided.body.total).toBe(1);
    expect(voided.body.assignments[0]).toMatchObject({
      voided: true, void_reason: REASON, voided_by: 'Cara Angeloni', status_before_void: 'checked_out',
    });
  });

  it('writes the correction to the audit log', async () => {
    const id = await makeCheckout();
    await auth(request(app).post(`/api/assignments/${id}/void`)).send({ reason: REASON });
    const log = obj(db.prepare("SELECT * FROM audit_log WHERE action='custody_voided' ORDER BY id DESC LIMIT 1").get());
    expect(log).toBeTruthy();
    const meta = JSON.parse(log.metadata);
    expect(meta).toMatchObject({ assignment_id: id, reason: REASON, voided_by: 'Cara Angeloni' });
  });

  it('demands a reason with something in it', async () => {
    const id = await makeCheckout();
    for (const reason of [undefined, '', '   ', 'oops', 'typo']) {
      const res = await auth(request(app).post(`/api/assignments/${id}/void`)).send({ reason });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('REASON_REQUIRED');
    }
    // Still live — none of those did anything.
    expect(obj(db.prepare('SELECT status FROM key_assignments WHERE id = ?').get(id)).status).toBe('checked_out');
  });

  it('is gated to can_delete', async () => {
    const id = await makeCheckout();
    const res = await plain(request(app).post(`/api/assignments/${id}/void`)).send({ reason: REASON });
    expect(res.status).toBe(403);
    expect(obj(db.prepare('SELECT status FROM key_assignments WHERE id = ?').get(id)).status).toBe('checked_out');
  });

  it('refuses to void twice, so the first reason is never overwritten', async () => {
    const id = await makeCheckout();
    await auth(request(app).post(`/api/assignments/${id}/void`)).send({ reason: REASON });
    const second = await auth(request(app).post(`/api/assignments/${id}/void`))
      .send({ reason: 'a completely different reason' });
    expect(second.status).toBe(409);
    expect(obj(db.prepare('SELECT void_reason FROM key_assignments WHERE id = ?').get(id)).void_reason).toBe(REASON);
  });
});

// ══════════════════════════ §3 ACKNOWLEDGE ══════════════════════════════════
describe('§3 clearing a stuck signature', () => {
  const ACK = 'holder left the company, signature will never arrive';

  it('records the acknowledgement without ever claiming a signature', async () => {
    const id = await makeCheckout();
    const res = await auth(request(app).post(`/api/assignments/${id}/acknowledge`)).send({ reason: ACK });
    expect(res.status).toBe(200);

    const row = obj(db.prepare('SELECT * FROM key_assignments WHERE id = ?').get(id));
    expect(row.signature_status).toBe('acknowledged_unsigned');
    expect(row.acknowledged_by).toBe('Cara Angeloni');
    expect(row.acknowledge_reason).toBe(ACK);
    // The three things that would constitute a fabricated signature.
    expect(row.signed_at).toBeNull();
    expect(row.signature_data).toBeNull();
    expect(row.signature_hash).toBeNull();
  });

  it('never reads as signed, anywhere', async () => {
    const id = await makeCheckout();
    await auth(request(app).post(`/api/assignments/${id}/acknowledge`)).send({ reason: ACK });

    const list = await auth(request(app).get('/api/assignments?status=checked_out&limit=10'));
    const row = list.body.assignments.find((a: any) => a.id === id);
    expect(row.signature_status).toBe('acknowledged_unsigned');
    expect(row.signature_status).not.toBe('signed');
    expect(row.signed_at).toBeFalsy();
    // Nothing is still expected of the holder.
    expect(row.signoff_pending).toBe(false);

    const log = obj(db.prepare("SELECT * FROM audit_log WHERE action='signature_acknowledged_unsigned' ORDER BY id DESC LIMIT 1").get());
    expect(JSON.parse(log.metadata).signature_collected).toBe(false);
  });

  it('stops the reminders — no token is left to chase', async () => {
    const id = await makeCheckout();
    await auth(request(app).post(`/api/assignments/${id}/acknowledge`)).send({ reason: ACK });
    const row = obj(db.prepare('SELECT signoff_token, checkin_signoff_token FROM key_assignments WHERE id = ?').get(id));
    expect(row.signoff_token).toBeNull();
    expect(row.checkin_signoff_token).toBeNull();

    // And it is out of the signature-gap queue that drives the chasing.
    const gaps = await auth(request(app).get('/api/assignments/signature-gaps'));
    expect(gaps.body.awaiting).toBe(0);
    expect(gaps.body.total_missing).toBe(0);
  });

  it('the keys stay out — this settles the paperwork, not the custody', async () => {
    const id = await makeCheckout();
    await auth(request(app).post(`/api/assignments/${id}/acknowledge`)).send({ reason: ACK });
    // Still checked out, still counted, still on the site's availability.
    expect(obj(db.prepare('SELECT status FROM key_assignments WHERE id = ?').get(id)).status).toBe('checked_out');
    expect((await auth(request(app).get('/api/assignments?status=checked_out&limit=1'))).body.total).toBe(1);
  });

  it('refuses to overwrite a real signature', async () => {
    const id = await makeCheckout();
    const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    await auth(request(app).post(`/api/assignments/${id}/sign-in-person`)).send({ signature_data: PNG, kind: 'checkout' });

    const res = await auth(request(app).post(`/api/assignments/${id}/acknowledge`)).send({ reason: ACK });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already signed/i);
    expect(obj(db.prepare('SELECT signature_status FROM key_assignments WHERE id = ?').get(id)).signature_status)
      .toBe('signed');
  });

  it('demands a reason, and is gated to can_delete', async () => {
    const id = await makeCheckout();
    expect((await auth(request(app).post(`/api/assignments/${id}/acknowledge`)).send({ reason: 'nope' })).status).toBe(400);
    expect((await plain(request(app).post(`/api/assignments/${id}/acknowledge`)).send({ reason: ACK })).status).toBe(403);
  });
});

// ══════════════════════════ §4 BULK ═════════════════════════════════════════
describe('§4 bulk cleanup', () => {
  it('voids a selection, auditing each one separately', async () => {
    const ids = [await makeCheckout('A'), await makeCheckout('B'), await makeCheckout('C')];
    const res = await auth(request(app).post('/api/assignments/bulk-correct'))
      .send({ action: 'void', ids, reason: 'duplicate batch entered twice' });
    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(3);
    expect(scalar("SELECT COUNT(*) AS c FROM key_assignments WHERE status='voided'")).toBe(3);
    // One audit row per record, not one for the batch.
    expect(scalar("SELECT COUNT(*) AS c FROM audit_log WHERE action='custody_voided'")).toBe(3);
  });

  it('acknowledges a selection', async () => {
    const ids = [await makeCheckout('D'), await makeCheckout('E')];
    const res = await auth(request(app).post('/api/assignments/bulk-correct'))
      .send({ action: 'acknowledge', ids, reason: 'signatures will never arrive' });
    expect(res.body.applied).toBe(2);
    expect(scalar("SELECT COUNT(*) AS c FROM key_assignments WHERE signature_status='acknowledged_unsigned'")).toBe(2);
    expect(scalar("SELECT COUNT(*) AS c FROM key_assignments WHERE signed_at IS NOT NULL")).toBe(0);
  });

  it('reports what it skipped rather than failing the batch', async () => {
    const good = await makeCheckout('F');
    const already = await makeCheckout('G');
    await auth(request(app).post(`/api/assignments/${already}/void`)).send({ reason: REASON });

    const res = await auth(request(app).post('/api/assignments/bulk-correct'))
      .send({ action: 'void', ids: [good, already, 999999], reason: 'cleaning up a bad import' });
    expect(res.body.applied).toBe(1);
    expect(res.body.skipped).toHaveLength(2);
  });

  it('needs a reason and the permission, same as the single action', async () => {
    const id = await makeCheckout();
    expect((await auth(request(app).post('/api/assignments/bulk-correct'))
      .send({ action: 'void', ids: [id], reason: 'no' })).status).toBe(400);
    expect((await plain(request(app).post('/api/assignments/bulk-correct'))
      .send({ action: 'void', ids: [id], reason: REASON })).status).toBe(403);
  });
});

// ══════════════════════════ KEY FORMS ═══════════════════════════════════════
describe('key forms take the same two corrections', () => {
  const formId = async () => {
    await makeCheckout('Form Person');
    return obj(db.prepare('SELECT id FROM key_form_docs ORDER BY id DESC LIMIT 1').get()).id as number;
  };

  it('voids a form, hides it by default, and keeps it reachable', async () => {
    const id = await formId();
    const res = await auth(request(app).post(`/api/key-forms/${id}/void`)).send({ reason: REASON });
    expect(res.status).toBe(200);
    expect(res.body.form.status).toBe('voided');

    expect((await auth(request(app).get('/api/key-forms'))).body.forms.find((f: any) => f.id === id)).toBeFalsy();
    const asked = await auth(request(app).get('/api/key-forms?status=voided'));
    expect(asked.body.forms.find((f: any) => f.id === id)).toBeTruthy();
    expect(asked.body.voided).toBe(1);
  });

  it('acknowledges a form without marking it signed', async () => {
    const id = await formId();
    const res = await auth(request(app).post(`/api/key-forms/${id}/acknowledge`))
      .send({ reason: 'contractor will not sign, keys confirmed by phone' });
    expect(res.status).toBe(200);
    expect(res.body.form.status).toBe('acknowledged_unsigned');
    expect(res.body.form.status).not.toBe('signed');
    expect(res.body.form.signed_at).toBeFalsy();

    const log = obj(db.prepare("SELECT * FROM audit_log WHERE action='key_form_acknowledged_unsigned' ORDER BY id DESC LIMIT 1").get());
    expect(JSON.parse(log.metadata).signature_collected).toBe(false);
  });

  it('bulk-corrects forms too', async () => {
    const a = await formId();
    const b = await formId();
    const res = await auth(request(app).post('/api/key-forms/bulk-correct'))
      .send({ action: 'void', ids: [a, b], reason: 'generated against the wrong holder' });
    expect(res.body.applied).toBe(2);
    expect(scalar("SELECT COUNT(*) AS c FROM key_form_docs WHERE status='voided'")).toBe(2);
  });
});

// ══════════════════════════ §5 CHIP COUNTS ══════════════════════════════════
describe('§5 the chips count what they say', () => {
  it('moves a record between overdue, acknowledged and voided', async () => {
    const overdueId = await makeCheckout('Late Person', true);
    await makeCheckout('Waiting Person');

    let counts = (await auth(request(app).get('/api/assignments/correction-counts'))).body;
    expect(counts).toMatchObject({ overdue: 1, awaiting_signature: 2, voided: 0, acknowledged_unsigned: 0 });

    await auth(request(app).post(`/api/assignments/${overdueId}/acknowledge`)).send({ reason: 'settled by phone call' });
    counts = (await auth(request(app).get('/api/assignments/correction-counts'))).body;
    // Out of overdue and out of awaiting, into acknowledged.
    expect(counts).toMatchObject({ overdue: 0, awaiting_signature: 1, acknowledged_unsigned: 1 });

    await auth(request(app).post(`/api/assignments/${overdueId}/void`)).send({ reason: REASON });
    counts = (await auth(request(app).get('/api/assignments/correction-counts'))).body;
    expect(counts).toMatchObject({ voided: 1, acknowledged_unsigned: 0 });
  });
});
