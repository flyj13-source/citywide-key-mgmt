// ── Signature links: 5-day TTL, visual expiry states, silent auto-renewal ────
// Verified on the ZZ TEST fixtures. Every step also asserts that NO email was
// sent — the states are in-app flags, and a renewal is silent.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'citywide-siglinks-'));
process.env.CITYWIDE_DB_DIR = TEST_DIR;
delete process.env.DB_PATH;
process.env.JWT_SECRET = 'test-secret';
process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
process.env.SEED_PASSWORD = 'demo1234';
// SMTP configured so any send path WOULD run — the stub below is what proves
// nothing did.
process.env.SMTP_USER = 'keys@citywideboston.com';
process.env.SMTP_PASS = 'not-a-real-password';

const sent: any[] = [];
vi.mock('nodemailer', () => ({
  default: {
    createTransport: () => ({
      sendMail: async (msg: any) => { sent.push(msg); return { messageId: 'test' }; },
    }),
  },
}));

const DB_FILE = path.join(TEST_DIR, 'citywide.db');
let app: Express;
let token: string;
let db: DatabaseSync;
let fx: typeof import('../src/lib/testFixtures');
let links: typeof import('../src/lib/signatureLink');

const AM1 = 'ZZ Test AM One';
const DAY = 24 * 60 * 60 * 1000;
const auth = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);
const obj = (r: any) => (r ? Object.assign({}, r) : null);
const form = (id: number) => obj(db.prepare('SELECT * FROM key_form_docs WHERE id = ?').get(id));
const audits = (action: string) =>
  (db.prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY id').all(action) as any[]).map(obj);
const setExpiry = (id: number, when: Date) =>
  db.prepare('UPDATE key_form_docs SET token_expires_at = ? WHERE id = ?').run(when.toISOString(), id);

/** The Key Forms tab, as it loads — which also runs the on-read sweep. */
const listRow = async (id: number) => {
  const res = await auth(request(app).get('/api/key-forms').query({ limit: '200' }));
  expect(res.status).toBe(200);
  return { row: res.body.forms.find((f: any) => f.id === id), counts: res.body.link_counts };
};

beforeAll(async () => {
  app = (await import('../src/index')).default;
  (await import('../src/lib/autoSeed')).autoSeedIfEmpty();
  fx = await import('../src/lib/testFixtures');
  links = await import('../src/lib/signatureLink');
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
  sent.length = 0;
});

/** A ZZ TEST AM One holdings form, generated without sending. */
const newForm = async (): Promise<number> => {
  const res = await auth(request(app).post('/api/key-forms/generate'))
    .send({ holder: AM1, holder_type: 'employee' });
  expect(res.status).toBeLessThan(300);
  const id = (res.body.created ?? res.body.forms ?? [res.body.form])[0].id;
  sent.length = 0; // whatever generation did, the lifecycle below starts clean
  return id;
};

const near = (iso: string, target: number, slackMs = 60_000) =>
  expect(Math.abs(new Date(iso).getTime() - target)).toBeLessThan(slackMs);

describe('§1 LINK TTL — 5 DAYS EVERYWHERE', () => {
  it('the one constant is 120 hours', () => {
    expect(links.SIGNATURE_TTL_MS).toBe(120 * 60 * 60 * 1000);
  });

  it('a new Key Form link expires in 5 days', async () => {
    const id = await newForm();
    near(form(id).token_expires_at, Date.now() + 5 * DAY);
    const { row } = await listRow(id);
    expect(row.link_state).toBe('awaiting');
  });

  it('a check-out sign-off link expires in 5 days', async () => {
    const acct = obj(db.prepare("SELECT id FROM accounts WHERE bc_client_number='09999900001'").get());
    const res = await auth(request(app).post('/api/assignments/checkout')).send({
      holder: AM1, holder_email: fx.TEST_EMAIL, account_id: acct.id,
      keys: [{ type: 'metal', qty: 1 }], sign_mode: 'in_person',
    });
    expect(res.status).toBe(201);
    const a = obj(db.prepare('SELECT signoff_expires_at FROM key_assignments ORDER BY id DESC LIMIT 1').get());
    near(a.signoff_expires_at, Date.now() + 5 * DAY);
  });
});

describe('§2 VISUAL STATES ONLY — NO EMAIL', () => {
  it('day 4 of 5 → "Expiring soon", counted, filterable, nothing sent', async () => {
    const id = await newForm();
    setExpiry(id, new Date(Date.now() + 12 * 60 * 60 * 1000)); // 12h left
    const { row, counts } = await listRow(id);
    expect(row.link_state).toBe('expiring_soon');
    expect(counts.expiring_soon).toBe(1);

    const filtered = await auth(request(app).get('/api/key-forms').query({ status: 'expiring_soon' }));
    expect(filtered.body.forms.map((f: any) => f.id)).toEqual([id]);
    expect(sent).toHaveLength(0);
  });

  it('25h left is still "Awaiting signature" — the window is the last 24h', async () => {
    const id = await newForm();
    setExpiry(id, new Date(Date.now() + 25 * 60 * 60 * 1000));
    expect((await listRow(id)).row.link_state).toBe('awaiting');
  });

  it('a signed form reads Signed regardless of its link', async () => {
    const id = await newForm();
    db.prepare("UPDATE key_form_docs SET signed_at = ?, status = 'signed' WHERE id = ?")
      .run(new Date().toISOString(), id);
    setExpiry(id, new Date(Date.now() - DAY));
    const { row } = await listRow(id);
    expect(row.link_state).toBe('signed');
    expect(audits('signature_link_auto_renewed')).toHaveLength(0);
  });
});

describe('§3 AUTO-RENEW ON EXPIRY — SILENT, CAPPED AT 2', () => {
  it('expiry → fresh 5-day link, back to Awaiting, audit logged, nothing sent', async () => {
    const id = await newForm();
    const before = form(id);
    setExpiry(id, new Date(Date.now() - 60_000));

    const { row } = await listRow(id); // loading the tab is enough

    const after = form(id);
    expect(after.token).not.toBe(before.token);
    near(after.token_expires_at, Date.now() + 5 * DAY);
    expect(after.link_renewals).toBe(1);
    expect(row.link_state).toBe('awaiting');

    const log = audits('signature_link_auto_renewed');
    expect(log).toHaveLength(1);
    expect(JSON.parse(log[0].metadata)).toMatchObject({
      form_id: id, cycle: 1, max_cycles: 2, emailed: false,
    });
    expect(sent).toHaveLength(0);

    // The old link is dead; the new one opens.
    expect((await request(app).get(`/api/key-forms/token/${before.token}`)).status).toBe(404);
    expect((await request(app).get(`/api/key-forms/token/${after.token}`)).status).toBe(200);
  });

  it('after 2 renewals the form stays Expired, exhausted is logged once, nothing sent', async () => {
    const id = await newForm();
    for (const cycle of [1, 2]) {
      setExpiry(id, new Date(Date.now() - 60_000));
      await listRow(id);
      expect(form(id).link_renewals).toBe(cycle);
    }
    // Third expiry: the cap.
    setExpiry(id, new Date(Date.now() - 60_000));
    const { row, counts } = await listRow(id);
    expect(row.link_state).toBe('expired');
    expect(row.link_exhausted_at).toBeTruthy();
    expect(counts.expired).toBe(1);
    expect(form(id).link_renewals).toBe(2);

    // Further loads neither renew it nor log the stop again.
    await listRow(id);
    await listRow(id);
    expect(audits('signature_link_auto_renewed')).toHaveLength(2);
    expect(audits('signature_link_exhausted')).toHaveLength(1);
    expect(JSON.parse(audits('signature_link_exhausted')[0].metadata)).toMatchObject({
      form_id: id, renewals: 2, emailed: false,
    });
    expect(sent).toHaveLength(0);

    const filtered = await auth(request(app).get('/api/key-forms').query({ status: 'expired' }));
    expect(filtered.body.forms.map((f: any) => f.id)).toEqual([id]);
  });

  it('a manual send on an exhausted form revives it with a live link', async () => {
    const id = await newForm();
    db.prepare('UPDATE key_form_docs SET link_renewals = 2, link_exhausted_at = ? WHERE id = ?')
      .run(new Date().toISOString(), id);
    setExpiry(id, new Date(Date.now() - DAY));
    const dead = form(id).token;

    const res = await auth(request(app).post(`/api/key-forms/${id}/send`)).send({});
    expect(res.status).toBe(200);

    const after = form(id);
    expect(after.token).not.toBe(dead);
    expect(after.link_exhausted_at).toBeNull();
    expect(after.link_renewals).toBe(0);
    near(after.token_expires_at, Date.now() + 5 * DAY);
    expect(audits('signature_link_manually_renewed')).toHaveLength(1);
    // The one email here is the one a person chose to send — with the NEW link.
    expect(sent.length).toBeGreaterThan(0);
    const body = String(sent[0].text ?? '') + String(sent[0].html ?? '');
    expect(body).toContain(after.token);
    expect(body).not.toContain(dead);
  });

  it('a voided form is never renewed', async () => {
    const id = await newForm();
    db.prepare("UPDATE key_form_docs SET status = 'voided', voided_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
    setExpiry(id, new Date(Date.now() - DAY));
    links.sweepSignatureLinks();
    expect(form(id).link_renewals ?? 0).toBe(0);
    expect(audits('signature_link_auto_renewed')).toHaveLength(0);
  });

  it('two overlapping sweeps renew a form once', async () => {
    const id = await newForm();
    setExpiry(id, new Date(Date.now() - 60_000));
    const a = links.sweepSignatureLinks();
    const b = links.sweepSignatureLinks();
    expect(a.renewed).toHaveLength(1);
    expect(b.renewed).toHaveLength(0);
    expect(audits('signature_link_auto_renewed')).toHaveLength(1);
  });
});

describe('§4 SCHEDULING', () => {
  it('the scheduler sweeps on start and reports it on /api/health', async () => {
    const id = await newForm();
    setExpiry(id, new Date(Date.now() - 60_000));
    links.startSignatureLinkScheduler();
    try {
      expect(form(id).link_renewals).toBe(1); // swept immediately on start
      const h = await request(app).get('/api/health');
      expect(h.body.signature_sweep.interval_ms).toBe(15 * 60 * 1000);
      expect(h.body.signature_sweep.last_at).toBeTruthy();
    } finally {
      links.stopSignatureLinkScheduler();
    }
  });
});
