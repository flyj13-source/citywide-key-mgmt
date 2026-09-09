import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

// ── Fewest possible decisions ────────────────────────────────────────────────
// These pin the promise the simplification makes: a check-out opened from a
// registry row arrives already answered — client, keys, holder, due date — and
// the one-click path posts exactly what the server proposed.

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'citywide-defaults-'));
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
let db: DatabaseSync;

const auth = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);
const obj = (r: any) => (r ? Object.assign({}, r) : null);

const IC_NAME = 'ALVES CLEANING SERVICES INC';
const IC_VENDOR = '02014100020';

let icId: number;
let clientId: number;

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
  // Cleared too: the send-failure assertions below count audit rows, and
  // without this they would count the previous test's failures.
  db.exec('DELETE FROM audit_log');
  db.exec("DELETE FROM settings WHERE key = 'custody_default_due_days'");

  // An IC vendor with an address on file…
  db.prepare(
    `INSERT OR IGNORE INTO accounts (ic_company_name, bc_vendor_number, ic_email, record_type, status, archived)
     VALUES (?, ?, 'ops@alves.test', 'ic', 'active', 0)`
  ).run(IC_NAME, IC_VENDOR);
  db.prepare('UPDATE accounts SET ic_email = ? WHERE bc_vendor_number = ?').run('ops@alves.test', IC_VENDOR);
  icId = obj(db.prepare("SELECT id FROM accounts WHERE bc_vendor_number = ? AND record_type='ic'").get(IC_VENDOR)).id;

  // …and a client site that assigns it, with a mixed key inventory.
  db.exec("DELETE FROM accounts WHERE bc_client_number = '01014299001'");
  const r = db.prepare(`
    INSERT INTO accounts (
      ic_company_name, bc_client_number, record_type, status, archived,
      ic_name, bc_vendor_number, account_manager,
      metal_keys, key_cards, has_fob, dispenser_keys
    ) VALUES ('DEFAULTS TOWER', '01014299001', 'customer', 'active', 0, ?, ?, 'Real AM', 3, 2, 0, 0)
  `).run(IC_NAME, IC_VENDOR);
  clientId = Number(r.lastInsertRowid);
});

// ══════════════════════ §2/§3/§4 — THE FORM ARRIVES ANSWERED ═════════════════
describe('checkout-context — nothing is left blank', () => {
  it('pre-selects the client, its key types at qty 1, the assigned IC, and a due date', async () => {
    const res = await auth(request(app).get(`/api/assignments/checkout-context?account_id=${clientId}`));
    expect(res.status).toBe(200);

    expect(res.body.account).toMatchObject({ id: clientId, name: 'DEFAULTS TOWER' });

    // §2 — every type the site HAS is suggested at 1; types it has none of are 0.
    const byType = Object.fromEntries(res.body.keys.map((k: any) => [k.type, k]));
    expect(byType.metal).toMatchObject({ available: 3, suggested: 1 });
    expect(byType.card).toMatchObject({ available: 2, suggested: 1 });
    expect(byType.fob).toMatchObject({ available: 0, suggested: 0 });
    expect(res.body.suggested_total).toBe(2);

    // §3 — the assigned IC, with its address, not the account manager.
    expect(res.body.suggested_holder).toMatchObject({
      id: icId, name: IC_NAME, type: 'ic', email: 'ops@alves.test',
      reason: 'assigned IC', has_email: true,
    });

    // §4 — a due date exists, 30 days out by default.
    expect(res.body.default_due_days).toBe(30);
    const days = Math.round(
      (new Date(`${res.body.due_at}T00:00:00Z`).getTime() - Date.now()) / 86400000
    );
    expect(days).toBeGreaterThanOrEqual(29);
    expect(days).toBeLessThanOrEqual(30);

    expect(res.body.can_quick_checkout).toBe(true);
  });

  it('falls back to the account manager when no IC is assigned', async () => {
    db.prepare("INSERT INTO staff_managers (name, manager_type, role_category, email, active) VALUES ('Real AM','account_manager','manager','am@citywideboston.com',1)").run();
    db.prepare('UPDATE accounts SET ic_name = NULL, bc_vendor_number = NULL WHERE id = ?').run(clientId);

    const res = await auth(request(app).get(`/api/assignments/checkout-context?account_id=${clientId}`));
    expect(res.body.suggested_holder).toMatchObject({
      name: 'Real AM', type: 'employee', email: 'am@citywideboston.com', reason: 'account manager',
    });
  });

  it('offers no one-click path when the client has nobody assigned', async () => {
    db.prepare('UPDATE accounts SET ic_name = NULL, bc_vendor_number = NULL, account_manager = NULL WHERE id = ?').run(clientId);
    const res = await auth(request(app).get(`/api/assignments/checkout-context?account_id=${clientId}`));
    // Better an empty picker than a confidently wrong holder.
    expect(res.body.suggested_holder).toBeNull();
    expect(res.body.can_quick_checkout).toBe(false);
  });

  it('drops a key type to 0 once the site total is fully checked out', async () => {
    await auth(request(app).post('/api/assignments/checkout')).send({
      account_id: clientId, holder: IC_NAME, holder_email: 'ops@alves.test',
      holder_type: 'ic', keys: [{ type: 'card', qty: 2 }],
    });
    const res = await auth(request(app).get(`/api/assignments/checkout-context?account_id=${clientId}`));
    const byType = Object.fromEntries(res.body.keys.map((k: any) => [k.type, k]));
    expect(byType.card).toMatchObject({ available: 0, suggested: 0 });
    expect(byType.metal.suggested).toBe(1);
  });
});

// ══════════════════════ §5 — THE ONE-CLICK PATH ACTUALLY WORKS ═══════════════
describe('the quick action posts exactly what the context proposed', () => {
  it('a context read plus one checkout call produces a complete record', async () => {
    const ctx = (await auth(request(app).get(`/api/assignments/checkout-context?account_id=${clientId}`))).body;

    const res = await auth(request(app).post('/api/assignments/checkout')).send({
      account_id: ctx.account.id,
      account_name: ctx.account.name,
      holder: ctx.suggested_holder.name,
      holder_email: ctx.suggested_holder.email,
      holder_type: ctx.suggested_holder.type,
      holder_id: ctx.suggested_holder.id,
      keys: ctx.keys.filter((k: any) => k.suggested > 0).map((k: any) => ({ type: k.type, qty: k.suggested })),
      due_at: ctx.due_at,
      sign_mode: 'in_person',
    });

    expect(res.status).toBe(201);
    const a = res.body.assignment;
    expect(a.holder).toBe(IC_NAME);
    expect(a.total_keys).toBe(2);
    expect(a.due_at).toBeTruthy();
  });
});

// ══════════════════════ §1 — SIGN NOW IS THE DEFAULT ════════════════════════
describe('sign_mode', () => {
  it('in_person does not send the "please sign" email', async () => {
    const res = await auth(request(app).post('/api/assignments/checkout')).send({
      account_id: clientId, holder: IC_NAME, holder_email: 'ops@alves.test',
      holder_type: 'ic', keys: [{ type: 'metal', qty: 1 }], sign_mode: 'in_person',
    });
    expect(res.status).toBe(201);
    // Skipped, not attempted and not failed — an unsent notice here is correct
    // behaviour, so it must never be logged as a send failure.
    expect(res.body.email).toMatchObject({ skipped: true });
    expect(res.body.signature_status).toBe('awaiting_signature');
    const failures = db.prepare(
      "SELECT COUNT(*) AS c FROM audit_log WHERE action IN ('signature_send_failed','custody_email_failed')"
    ).get() as any;
    expect(obj(failures).c).toBe(0);
  });

  it('the default still emails the sign-off link', async () => {
    const res = await auth(request(app).post('/api/assignments/checkout')).send({
      account_id: clientId, holder: IC_NAME, holder_email: 'ops@alves.test',
      holder_type: 'ic', keys: [{ type: 'metal', qty: 1 }],
    });
    expect(res.status).toBe(201);
    expect(res.body.signoff_link).toBeTruthy();
  });

  it('an abandoned in-person signature still leaves a signable record', async () => {
    const res = await auth(request(app).post('/api/assignments/checkout')).send({
      account_id: clientId, holder: IC_NAME, holder_email: 'ops@alves.test',
      holder_type: 'ic', keys: [{ type: 'metal', qty: 1 }], sign_mode: 'in_person',
    });
    // The token is minted even when no email went out, so closing the pad
    // without signing is recoverable through the ordinary link.
    expect(res.body.signoff_link).toBeTruthy();
    const row = obj(db.prepare('SELECT signoff_token, signature_status FROM key_assignments WHERE id = ?').get(res.body.id));
    expect(row.signoff_token).toBeTruthy();
    expect(row.signature_status).toBe('awaiting_signature');
  });

  it('signing on the device produces a signed record with a recorded witness', async () => {
    const out = await auth(request(app).post('/api/assignments/checkout')).send({
      account_id: clientId, holder: IC_NAME, holder_email: 'ops@alves.test',
      holder_type: 'ic', keys: [{ type: 'metal', qty: 1 }], sign_mode: 'in_person',
    });
    const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const sig = await auth(request(app).post(`/api/assignments/${out.body.id}/sign-in-person`))
      .send({ signature_data: PNG, kind: 'checkout' });
    expect(sig.status).toBe(200);

    const row = obj(db.prepare('SELECT signature_status, signed_at, signed_in_person_by FROM key_assignments WHERE id = ?').get(out.body.id));
    expect(row.signature_status).toBe('signed');
    expect(row.signed_at).toBeTruthy();
    expect(row.signed_in_person_by).toBe('Cara Angeloni');
  });
});

// ══════════════════════ §2 — CHECK-IN ARRIVES ANSWERED TOO ══════════════════
describe('checkin-context', () => {
  it('pre-selects the single open check-out and its full key set', async () => {
    await auth(request(app).post('/api/assignments/checkout')).send({
      account_id: clientId, holder: IC_NAME, holder_email: 'ops@alves.test',
      holder_type: 'ic', keys: [{ type: 'metal', qty: 2 }, { type: 'card', qty: 1 }],
      sign_mode: 'in_person',
    });

    const res = await auth(request(app).get(`/api/assignments/checkin-context?account_id=${clientId}`));
    expect(res.status).toBe(200);
    expect(res.body.open).toHaveLength(1);
    expect(res.body.suggested_assignment_id).toBe(res.body.open[0].id);
    // A full return is the norm; a partial one is the edit.
    expect(res.body.suggested_keys.map((k: any) => [k.type, k.qty]).sort())
      .toEqual([['card', 1], ['metal', 2]]);
    expect(res.body.condition).toBe('good');
    expect(res.body.can_quick_checkin).toBe(true);
  });

  it('does not guess when more than one check-out is open', async () => {
    for (const holder of ['ops one', 'ops two']) {
      await auth(request(app).post('/api/assignments/checkout')).send({
        account_id: clientId, holder, holder_email: 'x@example.test',
        holder_type: 'employee', keys: [{ type: 'metal', qty: 1 }], sign_mode: 'in_person',
      });
    }
    const res = await auth(request(app).get(`/api/assignments/checkin-context?account_id=${clientId}`));
    expect(res.body.open).toHaveLength(2);
    expect(res.body.suggested_assignment_id).toBeNull();
    expect(res.body.can_quick_checkin).toBe(false);
  });
});

// ══════════════════════ §7 — RECENT HOLDERS, NOT ALPHABETICAL ═══════════════
describe('recent-holders', () => {
  it('lists most-recently-used first', async () => {
    const order = ['First Person', 'Second Person', 'Third Person'];
    for (const holder of order) {
      await auth(request(app).post('/api/assignments/checkout')).send({
        account_id: clientId, holder, holder_email: 'x@example.test',
        holder_type: 'employee', keys: [{ type: 'metal', qty: 1 }], sign_mode: 'in_person',
      });
      // checked_out_at has second resolution, so order it explicitly rather
      // than relying on three inserts landing in different seconds.
      db.prepare("UPDATE key_assignments SET checked_out_at = ? WHERE assignee = ?")
        .run(`2026-01-0${order.indexOf(holder) + 1}T10:00:00.000Z`, holder);
    }
    const res = await auth(request(app).get('/api/assignments/recent-holders?limit=5'));
    expect(res.body.holders.map((h: any) => h.name).slice(0, 3))
      .toEqual(['Third Person', 'Second Person', 'First Person']);
  });

  it('returns an empty list rather than failing on a fresh database', async () => {
    const res = await auth(request(app).get('/api/assignments/recent-holders'));
    expect(res.status).toBe(200);
    expect(res.body.holders).toEqual([]);
  });
});

// ══════════════════════ §4 — THE DUE WINDOW IS CONFIGURABLE ═════════════════
describe('custody due-date default', () => {
  it('starts at 30 days and reports itself as the built-in default', async () => {
    const res = await auth(request(app).get('/api/settings/custody-defaults'));
    expect(res.body).toMatchObject({ due_days: 30, is_default: true, fallback_due_days: 30 });
  });

  it('a changed window is what a new check-out proposes', async () => {
    const put = await auth(request(app).put('/api/settings/custody-defaults')).send({ due_days: 14 });
    expect(put.status).toBe(200);

    const ctx = await auth(request(app).get(`/api/assignments/checkout-context?account_id=${clientId}`));
    expect(ctx.body.default_due_days).toBe(14);
    const days = Math.round((new Date(`${ctx.body.due_at}T00:00:00Z`).getTime() - Date.now()) / 86400000);
    expect(days).toBeGreaterThanOrEqual(13);
    expect(days).toBeLessThanOrEqual(14);
  });

  it('refuses a nonsense window instead of silently ignoring it', async () => {
    for (const bad of [0, -5, 4000, 'soon', 2.5]) {
      const res = await auth(request(app).put('/api/settings/custody-defaults')).send({ due_days: bad });
      expect(res.status).toBe(400);
    }
    // …and the stored value is untouched by the refusals.
    const res = await auth(request(app).get('/api/settings/custody-defaults'));
    expect(res.body.due_days).toBe(30);
  });
});
