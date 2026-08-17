import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

// ── Isolated temp DB — the real citywide.db is NEVER touched ─────────────────
const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'citywide-custody-'));
process.env.CITYWIDE_DB_DIR = TEST_DIR;
delete process.env.DB_PATH;
process.env.JWT_SECRET = 'test-secret';
process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
process.env.SEED_PASSWORD = 'demo1234';
process.env.FRONTEND_URL = 'https://keys.example.test';
// SMTP intentionally unconfigured: every send must report a clean, logged
// failure rather than hanging on a socket or silently succeeding.
delete process.env.SMTP_USER;
delete process.env.SMTP_PASS;

const DB_FILE = path.join(TEST_DIR, 'citywide.db');
const ADMIN_EMAIL = 'cara@citywideboston.com';
const ADMIN_PASS = 'demo1234';

let app: Express;
let token: string;
let clientId: number;

const openDb = () => new DatabaseSync(DB_FILE);
const auth = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);
const one = (sql: string, ...p: any[]) => {
  const db = openDb();
  const row: any = db.prepare(sql).get(...p);
  db.close();
  return row ? Object.assign({}, row) : null;
};
const all = (sql: string, ...p: any[]) => {
  const db = openDb();
  const rows = (db.prepare(sql).all(...p) as any[]).map((r) => Object.assign({}, r));
  db.close();
  return rows;
};

beforeAll(async () => {
  app = (await import('../src/index')).default;
  const { autoSeedIfEmpty } = await import('../src/lib/autoSeed');
  autoSeedIfEmpty();

  const login = await request(app).post('/api/auth/login').send({ email: ADMIN_EMAIL, password: ADMIN_PASS });
  expect(login.status).toBe(200);
  token = login.body.token;

  // A client whose Role Key Counts grid gives it 3 metal, 2 cards, 1 fob, 4
  // dispenser — the exact inventory the multi-key dropdown must reflect.
  const created = await auth(request(app).post('/api/accounts')).send({
    record_type: 'customer',
    ic_company_name: 'CUSTODY TEST CLIENT',
    bc_client_number: '01014000999',
    am_metal: 2, am_card: 1, am_fob: 1, am_dispenser: 2,
    ccm_metal: 1, ccm_card: 1, ccm_fob: 0, ccm_dispenser: 2,
  });
  expect(created.status).toBe(201);
  clientId = created.body.id;
});

// ═══════════════════════════════════════ AVAILABILITY ═══════════════════════
describe('AVAILABILITY', () => {
  it('reports the client-site total per type before anything is out', async () => {
    const res = await auth(request(app).get(`/api/assignments/availability?account_id=${clientId}`));
    expect(res.status).toBe(200);
    const by = Object.fromEntries(res.body.types.map((t: any) => [t.type, t]));
    expect(by.metal).toMatchObject({ label: 'Metal Key', site_total: 3, checked_out: 0, available: 3 });
    expect(by.card).toMatchObject({ site_total: 2, available: 2 });
    expect(by.fob).toMatchObject({ site_total: 1, available: 1 });
    expect(by.dispenser).toMatchObject({ site_total: 4, available: 4 });
  });
});

// ═══════════════════════════════════════ MULTI-KEY CHECK-OUT ════════════════
describe('MULTI-KEY CHECK-OUT', () => {
  let assignmentId: number;
  let signoffToken: string;

  it('records two key types in one transaction and decrements availability', async () => {
    const res = await auth(request(app).post('/api/assignments/checkout')).send({
      account_id: clientId,
      holder: 'J. Martinez',
      holder_email: 'jmartinez@example.test',
      holder_type: 'employee',
      keys: [{ type: 'metal', qty: 2 }, { type: 'fob', qty: 1 }],
      due_at: '2099-01-15',
      on_behalf: true,
    });
    expect(res.status).toBe(201);
    assignmentId = res.body.id;

    // Both types are on the ONE record, with quantities.
    expect(res.body.assignment.keys).toEqual([
      { type: 'metal', label: 'Metal Key', qty: 2 },
      { type: 'fob', label: 'Key Fob', qty: 1 },
    ]);
    expect(res.body.assignment.total_keys).toBe(3);
    expect(res.body.assignment.status).toBe('checked_out');

    const avail = await auth(request(app).get(`/api/assignments/availability?account_id=${clientId}`));
    const by = Object.fromEntries(avail.body.types.map((t: any) => [t.type, t]));
    expect(by.metal).toMatchObject({ site_total: 3, checked_out: 2, available: 1 });
    expect(by.fob).toMatchObject({ site_total: 1, checked_out: 1, available: 0 });
    expect(by.card).toMatchObject({ checked_out: 0, available: 2 });
  });

  it('appears in the Checked Out tab feed', async () => {
    const res = await auth(request(app).get('/api/assignments?status=checked_out&limit=100'));
    const found = res.body.assignments.find((a: any) => a.id === assignmentId);
    expect(found).toBeTruthy();
    expect(found.holder).toBe('J. Martinez');
    expect(found.holder_type).toBe('employee');
    expect(found.keys_summary).toBe('2 × Metal Key · 1 × Key Fob');
    expect(found.signoff_pending).toBe(true);
    expect(found.signed_at).toBeNull();
  });

  it('blocks over-checkout — cannot take 3 when 1 is left', async () => {
    const res = await auth(request(app).post('/api/assignments/checkout')).send({
      account_id: clientId,
      holder: 'Second Tech',
      holder_type: 'employee',
      keys: [{ type: 'metal', qty: 3 }],
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/Only 1 Metal Key available/);

    // Nothing was written.
    const rows = all("SELECT * FROM key_assignments WHERE assignee = 'Second Tech'");
    expect(rows).toHaveLength(0);
  });

  it('blocks a type with zero left', async () => {
    const res = await auth(request(app).post('/api/assignments/checkout')).send({
      account_id: clientId, holder: 'Third Tech', holder_type: 'ic',
      keys: [{ type: 'fob', qty: 1 }],
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/Only 0 Key Fobs available/);
  });

  it('rejects an empty or malformed key set', async () => {
    const empty = await auth(request(app).post('/api/assignments/checkout')).send({
      account_id: clientId, holder: 'X', holder_type: 'employee', keys: [],
    });
    expect(empty.status).toBe(400);

    const bad = await auth(request(app).post('/api/assignments/checkout')).send({
      account_id: clientId, holder: 'X', holder_type: 'employee', keys: [{ type: 'skeleton', qty: 1 }],
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/Unknown key type/);
  });

  it('audits BOTH the actor and the holder for on-behalf recording', () => {
    const row = one(
      "SELECT * FROM audit_log WHERE action = 'key_checked_out' ORDER BY id DESC LIMIT 1"
    );
    expect(row.manager).toBe('Cara Angeloni');
    const meta = JSON.parse(row.metadata);
    expect(meta.actor).toBe('Cara Angeloni');
    expect(meta.holder).toBe('J. Martinez');
    expect(meta.on_behalf).toBe(true);
    expect(meta.summary).toBe('Cara Angeloni recorded checkout for J. Martinez');
    expect(meta.total_keys).toBe(3);
  });

  it('logs the email attempt — never fails silently', async () => {
    const row = one(
      "SELECT * FROM audit_log WHERE action IN ('custody_email_sent','custody_email_failed') ORDER BY id DESC LIMIT 1"
    );
    // SMTP is unconfigured in tests, so the send is reported as a logged failure
    // addressed to the holder AND Cara — the two recipients the spec requires.
    expect(row.action).toBe('custody_email_failed');
    const meta = JSON.parse(row.metadata);
    expect(meta.kind).toBe('checkout');
    expect(meta.recipients).toEqual(['jmartinez@example.test', 'cara@citywideboston.com']);
    expect(meta.error).toBeTruthy();
  });

  // ── Sign-off ──────────────────────────────────────────────────────────────
  it('mints a 48h sign-off link the checkout response exposes', () => {
    const row = one('SELECT * FROM key_assignments WHERE id = ?', assignmentId);
    signoffToken = row.signoff_token;
    expect(signoffToken).toMatch(/^[0-9a-f]{64}$/);
    const ttlHours = (new Date(row.signoff_expires_at).getTime() - Date.now()) / 3_600_000;
    expect(ttlHours).toBeGreaterThan(47.5);
    expect(ttlHours).toBeLessThan(48.5);
  });

  it('the public sign-off page loads without a login and shows the key set', async () => {
    const res = await request(app).get(`/api/signoff/${signoffToken}`);
    expect(res.status).toBe(200);
    expect(res.body.holder).toBe('J. Martinez');
    expect(res.body.client).toBe('CUSTODY TEST CLIENT');
    expect(res.body.total_keys).toBe(3);
    expect(res.body.keys).toHaveLength(2);
  });

  it('rejects a bad token', async () => {
    const res = await request(app).get('/api/signoff/deadbeef');
    expect(res.status).toBe(404);
  });

  it('signing stores the signature + SHA-256, generates the PDF, audits checkout_signed', async () => {
    // 1×1 transparent PNG — a valid image pdf-lib can embed.
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const res = await request(app).post(`/api/signoff/${signoffToken}/sign`).send({ signature_data: png });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.pdf_error).toBeNull();
    expect(res.body.pdf).toMatch(/\.pdf$/);

    const row = one('SELECT * FROM key_assignments WHERE id = ?', assignmentId);
    expect(row.signed_at).toBeTruthy();
    expect(row.signature_hash).toBe(crypto.createHash('sha256').update(png).digest('hex'));
    expect(row.signature_data).toBe(png);
    expect(fs.existsSync(row.pdf_path)).toBe(true);
    expect(fs.readFileSync(row.pdf_path).subarray(0, 4).toString()).toBe('%PDF');
    // The token is burned on use so the link cannot be replayed.
    expect(row.signoff_token).toBeNull();

    const audit = one("SELECT * FROM audit_log WHERE action = 'checkout_signed' ORDER BY id DESC LIMIT 1");
    expect(audit.manager).toBe('J. Martinez');
    expect(JSON.parse(audit.metadata).assignment_id).toBe(assignmentId);
  });

  it('the signature pill flips to Signed', async () => {
    const res = await auth(request(app).get('/api/assignments?status=checked_out&limit=100'));
    const found = res.body.assignments.find((a: any) => a.id === assignmentId);
    expect(found.signoff_pending).toBe(false);
    expect(found.signed_at).toBeTruthy();
    expect(found.has_pdf).toBe(true);
  });

  it('a used link cannot be signed twice', async () => {
    const res = await request(app).post(`/api/signoff/${signoffToken}/sign`).send({ signature_data: 'data:image/png;base64,AAAA' });
    expect(res.status).toBe(404);
  });

  // ── Check-in ──────────────────────────────────────────────────────────────
  it('check-in moves the record to Checked In, emails, and demands no signature', async () => {
    const res = await auth(request(app).post('/api/assignments/checkin')).send({
      id: assignmentId, condition_on_return: 'good', notes: 'All accounted for',
    });
    expect(res.status).toBe(200);
    expect(res.body.partial).toBe(false);
    expect(res.body.assignment.status).toBe('returned');
    // No signature was requested for the return.
    expect(res.body).not.toHaveProperty('signoff_link');

    const out = await auth(request(app).get('/api/assignments?status=checked_out&limit=100'));
    expect(out.body.assignments.find((a: any) => a.id === assignmentId)).toBeUndefined();

    const back = await auth(request(app).get('/api/assignments?status=returned&limit=100'));
    const found = back.body.assignments.find((a: any) => a.id === assignmentId);
    expect(found.condition_on_return).toBe('good');
    expect(found.checkin_recorded_by).toBe('Cara Angeloni');
    expect(found.keys_summary).toBe('2 × Metal Key · 1 × Key Fob');

    // Availability is restored.
    const avail = await auth(request(app).get(`/api/assignments/availability?account_id=${clientId}`));
    const by = Object.fromEntries(avail.body.types.map((t: any) => [t.type, t]));
    expect(by.metal.available).toBe(3);
    expect(by.fob.available).toBe(1);

    const audit = one("SELECT * FROM audit_log WHERE action = 'key_checked_in' ORDER BY id DESC LIMIT 1");
    const meta = JSON.parse(audit.metadata);
    expect(meta.actor).toBe('Cara Angeloni');
    expect(meta.holder).toBe('J. Martinez');
    expect(meta.summary).toBe('Cara Angeloni recorded checkin for J. Martinez');

    const mailLog = one("SELECT * FROM audit_log WHERE action IN ('custody_email_sent','custody_email_failed') ORDER BY id DESC LIMIT 1");
    expect(JSON.parse(mailLog.metadata).kind).toBe('checkin');
  });

  it('a returned record cannot be checked in again', async () => {
    const res = await auth(request(app).post('/api/assignments/checkin')).send({ id: assignmentId });
    expect(res.status).toBe(409);
  });
});

// ═══════════════════════════════════════ PARTIAL RETURN ═════════════════════
describe('PARTIAL RETURN', () => {
  it('splits the transaction — returned subset moves, the rest stays out', async () => {
    const out = await auth(request(app).post('/api/assignments/checkout')).send({
      account_id: clientId, holder: 'Partial Pat', holder_type: 'ic',
      keys: [{ type: 'dispenser', qty: 3 }, { type: 'card', qty: 2 }],
    });
    expect(out.status).toBe(201);
    const id = out.body.id;

    const back = await auth(request(app).post('/api/assignments/checkin')).send({
      id, keys: [{ type: 'dispenser', qty: 1 }], condition_on_return: 'good',
    });
    expect(back.status).toBe(200);
    expect(back.body.partial).toBe(true);
    expect(back.body.assignment.keys).toEqual([{ type: 'dispenser', label: 'Dispenser Key', qty: 1 }]);

    const original = one('SELECT * FROM key_assignments WHERE id = ?', id);
    expect(original.status).toBe('checked_out');
    expect(JSON.parse(original.keys_json)).toEqual([
      { type: 'dispenser', label: 'Dispenser Key', qty: 2 },
      { type: 'card', label: 'Key Card', qty: 2 },
    ]);

    // 4 dispensers on site, 2 still out → 2 available.
    const avail = await auth(request(app).get(`/api/assignments/availability?account_id=${clientId}`));
    const by = Object.fromEntries(avail.body.types.map((t: any) => [t.type, t]));
    expect(by.dispenser).toMatchObject({ site_total: 4, checked_out: 2, available: 2 });
    expect(by.card).toMatchObject({ site_total: 2, checked_out: 2, available: 0 });
  });

  it('rejects returning more than is out', async () => {
    const row = one("SELECT * FROM key_assignments WHERE assignee = 'Partial Pat' AND status = 'checked_out'");
    const res = await auth(request(app).post('/api/assignments/checkin')).send({
      id: row.id, keys: [{ type: 'card', qty: 5 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Only 2 Key Cards are checked out/);
  });
});

// ═══════════════════════════════════════ HOLDER PICKER ══════════════════════
describe('HOLDER PICKER', () => {
  it('offers the staff roster and the IC list in one payload', async () => {
    const res = await auth(request(app).get('/api/assignments/holders'));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.employees)).toBe(true);
    expect(Array.isArray(res.body.ics)).toBe(true);
    for (const e of res.body.employees) expect(e.type).toBe('employee');
    for (const i of res.body.ics) expect(i.type).toBe('ic');
  });
});

// ═══════════════════════════════════════ EXPORTS ════════════════════════════
describe('CUSTODY EXPORTS', () => {
  it('exports the Checked Out tab as csv with key chips flattened', async () => {
    const res = await auth(request(app).post('/api/exports/registry'))
      .send({ scope: 'current', tab: 'checkedout', format: 'csv' });
    expect(res.status).toBe(200);
    const csv = res.text || res.body.toString();
    expect(csv.split('\r\n')[0]).toBe(
      'Holder,Type,Client,Keys,Total Keys,Checked Out,Due,Status,Signature,Recorded By'
    );
    expect(csv).toContain('Partial Pat');
    expect(csv).toContain('2 × Dispenser Key · 2 × Key Card');
  });

  it('exports the Checked In tab as csv', async () => {
    const res = await auth(request(app).post('/api/exports/registry'))
      .send({ scope: 'current', tab: 'checkedin', format: 'csv' });
    expect(res.status).toBe(200);
    const csv = res.text || res.body.toString();
    expect(csv.split('\r\n')[0]).toBe(
      'Holder,Type,Client,Keys,Total Keys,Checked Out,Returned,Condition,Recorded By'
    );
    expect(csv).toContain('J. Martinez');
  });
});

// ═══════════════════════════════════════ LEGACY ROWS ════════════════════════
describe('LEGACY SINGLE-KEY ROWS', () => {
  it('still check out and read back through the old key_type/keys_held shape', async () => {
    const res = await auth(request(app).post('/api/assignments/checkout')).send({
      account_id: clientId, account_name: 'CUSTODY TEST CLIENT',
      assignee: 'Legacy Larry', key_type: 'physical', keys_held: 'Front door + closet',
    });
    expect(res.status).toBe(201);
    const row = one('SELECT * FROM key_assignments WHERE id = ?', res.body.id);
    // Free text is preserved verbatim; keys_json stays NULL.
    expect(row.keys_held).toBe('Front door + closet');
    expect(row.keys_json).toBeNull();
    expect(row.key_type).toBe('physical');
    // …and is surfaced as one best-effort key so nothing vanishes from the tab.
    expect(res.body.assignment.keys).toEqual([{ type: 'metal', label: 'Metal Key', qty: 1 }]);
  });
});
