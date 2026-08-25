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

  // ── Typed name confirmation ───────────────────────────────────────────────
  // A drawn mark on its own identifies nobody; the typed name is what ties it
  // to the person the keys are recorded against.
  it('refuses a signature with no typed name', async () => {
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const res = await request(app).post(`/api/signoff/${signoffToken}/sign`).send({ signature_data: png });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('type your full name');
    // Nothing was recorded — the link is still live.
    expect(one('SELECT signed_at FROM key_assignments WHERE id = ?', assignmentId).signed_at).toBeNull();
  });

  it("refuses a typed name that is not the record's holder", async () => {
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const res = await request(app).post(`/api/signoff/${signoffToken}/sign`)
      .send({ signature_data: png, typed_name: 'Somebody Else' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('J. Martinez');
    expect(one('SELECT signed_at FROM key_assignments WHERE id = ?', assignmentId).signed_at).toBeNull();
  });

  it('refuses a typed name without a signature', async () => {
    const res = await request(app).post(`/api/signoff/${signoffToken}/sign`)
      .send({ typed_name: 'J. Martinez' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('signature is required');
  });

  it('signing stores the signature + SHA-256 + typed name, generates the PDF, audits checkout_signed', async () => {
    // 1×1 transparent PNG — a valid image pdf-lib can embed.
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    // Case and extra spaces are tolerated; a different name is not (above).
    const res = await request(app).post(`/api/signoff/${signoffToken}/sign`)
      .send({ signature_data: png, typed_name: '  j. martinez  ' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.pdf_error).toBeNull();
    expect(res.body.pdf).toMatch(/\.pdf$/);

    const row = one('SELECT * FROM key_assignments WHERE id = ?', assignmentId);
    expect(row.signed_at).toBeTruthy();
    expect(row.signature_hash).toBe(crypto.createHash('sha256').update(png).digest('hex'));
    expect(row.signature_data).toBe(png);
    expect(row.signature_typed_name).toBe('j. martinez');
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
    expect(found.signature_typed_name).toBe('j. martinez');
  });

  it('a used link cannot be signed twice', async () => {
    const res = await request(app).post(`/api/signoff/${signoffToken}/sign`).send({ signature_data: 'data:image/png;base64,AAAA' });
    expect(res.status).toBe(404);
  });

  // ── Check-in ──────────────────────────────────────────────────────────────
  it('check-in moves the record to Checked In, emails, and REQUESTS a signature', async () => {
    const res = await auth(request(app).post('/api/assignments/checkin')).send({
      id: assignmentId, condition_on_return: 'good', notes: 'All accounted for',
    });
    expect(res.status).toBe(200);
    expect(res.body.partial).toBe(false);
    expect(res.body.assignment.status).toBe('returned');
    // Every custody EVENT generates a signature form — returns included.
    expect(res.body.signoff_link).toMatch(/^https:\/\/keys\.example\.test\/key-signoff\/[a-f0-9]{64}$/);
    expect(res.body.assignment.checkin_signoff_pending).toBe(true);

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

// ═════════════════════════════ CHECK-IN SIGNATURE ═══════════════════════════
// Every custody EVENT generates a signature form — a return is an event.
describe('CHECK-IN SIGNATURE', () => {
  let outId = 0;
  let checkinToken = '';

  it('a return mints its own 48h token, distinct from the check-out token', async () => {
    const out = await auth(request(app).post('/api/assignments/checkout')).send({
      account_id: clientId, holder: 'Signback Sam', holder_type: 'employee',
      holder_email: 'sam@example.test', keys: [{ type: 'metal', qty: 1 }],
    });
    expect(out.status).toBe(201);
    outId = out.body.id;
    const checkoutToken = one('SELECT signoff_token FROM key_assignments WHERE id = ?', outId).signoff_token;

    const back = await auth(request(app).post('/api/assignments/checkin')).send({
      id: outId, condition_on_return: 'good',
    });
    expect(back.status).toBe(200);

    const row = one('SELECT * FROM key_assignments WHERE id = ?', outId);
    expect(row.checkin_signoff_token).toBeTruthy();
    expect(row.checkin_signoff_token).not.toBe(checkoutToken);
    expect(row.return_reason).toBe('returned');
    checkinToken = row.checkin_signoff_token;

    const expires = new Date(String(row.checkin_signoff_expires_at)).getTime() - Date.now();
    expect(expires).toBeGreaterThan(47 * 3600 * 1000);
    expect(expires).toBeLessThanOrEqual(48 * 3600 * 1000);
  });

  it('the public form loads as a RETURN, not a receipt', async () => {
    const res = await request(app).get(`/api/signoff/${checkinToken}`);
    expect(res.status).toBe(200);
    expect(res.body.action).toBe('checkin');
    expect(res.body.holder).toBe('Signback Sam');
    expect(res.body.keys).toEqual([{ type: 'metal', label: 'Metal Key', qty: 1 }]);
    expect(res.body.condition_on_return).toBe('good');
  });

  it('signing the return stores its OWN signature without touching the check-out one', async () => {
    // Sign the check-out first so both signatures coexist on one record.
    const checkoutToken = one('SELECT signoff_token FROM key_assignments WHERE id = ?', outId).signoff_token;
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const first = await request(app).post(`/api/signoff/${checkoutToken}/sign`).send({ signature_data: png, typed_name: 'Signback Sam' });
    expect(first.status).toBe(200);
    expect(first.body.action).toBe('checkout');

    const second = await request(app).post(`/api/signoff/${checkinToken}/sign`).send({ signature_data: png, typed_name: 'signback  SAM' });
    expect(second.status).toBe(200);
    expect(second.body.action).toBe('checkin');

    const row = one('SELECT * FROM key_assignments WHERE id = ?', outId);
    expect(row.signed_at).toBeTruthy();
    expect(row.checkin_signed_at).toBeTruthy();
    // Each direction keeps its own typed name.
    expect(row.signature_typed_name).toBe('Signback Sam');
    expect(row.checkin_signature_typed_name).toBe('signback  SAM');
    expect(row.signature_hash).toHaveLength(64);
    expect(row.checkin_signature_hash).toHaveLength(64);
    // Both receipts exist as separate documents.
    expect(row.pdf_path).toContain('keycheckout_');
    expect(row.checkin_pdf_path).toContain('keycheckin_');
    // Both tokens are burned.
    expect(row.signoff_token).toBeNull();
    expect(row.checkin_signoff_token).toBeNull();
  });

  it('audits checkin_signed and logs the signed-receipt email attempt', () => {
    const signed = one("SELECT * FROM audit_log WHERE action = 'checkin_signed' ORDER BY id DESC LIMIT 1");
    expect(signed).toBeTruthy();
    expect(JSON.parse(signed.metadata).kind).toBe('checkin');

    const mail = all("SELECT * FROM audit_log WHERE action IN ('custody_email_sent','custody_email_failed')")
      .map((r) => JSON.parse(r.metadata))
      .filter((m) => m.kind === 'signed_receipt');
    expect(mail.length).toBeGreaterThanOrEqual(2);
    expect(mail.some((m) => m.signed_kind === 'checkout')).toBe(true);
    expect(mail.some((m) => m.signed_kind === 'checkin')).toBe(true);
  });

  it('a return cannot be signed twice', async () => {
    const res = await request(app).post(`/api/signoff/${checkinToken}/sign`).send({
      signature_data: 'data:image/png;base64,iVBORw0KGgo=', typed_name: 'Signback Sam',
    });
    // The token was cleared on the first signature, so the link is simply dead.
    expect([404, 409]).toContain(res.status);
  });

  it('serves BOTH receipts, addressed by kind', async () => {
    const out = await auth(request(app).get(`/api/assignments/${outId}/receipt?kind=checkout`));
    expect(out.status).toBe(200);
    expect(out.headers['content-type']).toBe('application/pdf');
    const back = await auth(request(app).get(`/api/assignments/${outId}/receipt?kind=checkin`));
    expect(back.status).toBe(200);
    expect(back.headers['content-type']).toBe('application/pdf');
  });

  it('resend-signoff refuses to re-request a signature that already landed', async () => {
    const res = await auth(request(app).post(`/api/assignments/${outId}/resend-signoff`)).send({ kind: 'checkin' });
    expect(res.status).toBe(409);
  });
});

// ═══════════════════════════ PERSON-TO-PERSON TRANSFER ══════════════════════
describe('KEY TRANSFER', () => {
  // Its own client with untouched inventory — the shared one has been drawn
  // down by the check-out tests above, and a transfer test that fails on
  // availability tells you nothing about transfers.
  let xferClientId = 0;
  let transfer: any = null;

  beforeAll(async () => {
    const created = await auth(request(app).post('/api/accounts')).send({
      record_type: 'customer',
      ic_company_name: 'TRANSFER TEST CLIENT',
      bc_client_number: '01014000777',
      am_metal: 4, am_card: 3, am_fob: 2, am_dispenser: 6,
    });
    expect(created.status).toBe(201);
    xferClientId = created.body.id;
  });

  it('lists who currently holds keys at a client', async () => {
    const out = await auth(request(app).post('/api/assignments/checkout')).send({
      account_id: xferClientId, holder: 'Transfer Tina', holder_type: 'employee',
      holder_email: 'tina@example.test', keys: [{ type: 'metal', qty: 2 }, { type: 'card', qty: 1 }],
    });
    expect(out.status).toBe(201);

    const res = await auth(request(app).get(`/api/assignments/current-holders?account_id=${xferClientId}`));
    expect(res.status).toBe(200);
    const tina = res.body.holders.find((h: any) => h.holder === 'Transfer Tina');
    expect(tina.total_keys).toBe(3);
  });

  it('reports exactly what the FROM holder has out at the client', async () => {
    const res = await auth(request(app).get(
      `/api/assignments/transferable?account_id=${xferClientId}&holder=${encodeURIComponent('Transfer Tina')}`
    ));
    expect(res.status).toBe(200);
    expect(res.body.total_keys).toBe(3);
    expect(res.body.keys.map((k: any) => k.type).sort()).toEqual(['card', 'metal']);
  });

  it('refuses a transfer of more keys than the holder actually has', async () => {
    const res = await auth(request(app).post('/api/assignments/transfer')).send({
      account_id: xferClientId, from_holder: 'Transfer Tina', to_holder: 'Receiving Rick',
      to_holder_type: 'employee', keys: [{ type: 'metal', qty: 5 }],
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('cannot transfer 5');
  });

  it('refuses a transfer to the same person', async () => {
    const res = await auth(request(app).post('/api/assignments/transfer')).send({
      account_id: xferClientId, from_holder: 'Transfer Tina', to_holder: 'transfer tina',
      to_holder_type: 'employee', keys: [{ type: 'metal', qty: 1 }],
    });
    expect(res.status).toBe(400);
  });

  it('moves custody atomically and links both records', async () => {
    const res = await auth(request(app).post('/api/assignments/transfer')).send({
      account_id: xferClientId, from_holder: 'Transfer Tina',
      to_holder: 'Receiving Rick', to_holder_type: 'ic', to_holder_email: 'rick@example.test',
      keys: [{ type: 'metal', qty: 2 }, { type: 'card', qty: 1 }],
    });
    expect(res.status).toBe(201);
    transfer = res.body;

    const fromRow = one('SELECT * FROM key_assignments WHERE id = ?', transfer.from.record_id);
    const toRow = one('SELECT * FROM key_assignments WHERE id = ?', transfer.to.record_id);

    expect(fromRow.status).toBe('returned');
    expect(fromRow.return_reason).toBe('transferred');
    expect(fromRow.transfer_role).toBe('from');
    expect(toRow.status).toBe('checked_out');
    expect(toRow.transfer_role).toBe('to');
    expect(toRow.assignee).toBe('Receiving Rick');
    expect(toRow.holder_type).toBe('ic');

    // Cross-referenced in both directions, under one transfer id.
    expect(fromRow.transfer_id).toBe(toRow.transfer_id);
    expect(fromRow.linked_assignment_id).toBe(toRow.id);
    expect(toRow.linked_assignment_id).toBe(fromRow.id);
  });

  it('never shows the same key held by two people', async () => {
    const out = await auth(request(app).get('/api/assignments?status=checked_out&limit=500'));
    const atClient = out.body.assignments.filter((a: any) => a.account_id === xferClientId);
    expect(atClient.some((a: any) => a.holder === 'Transfer Tina')).toBe(false);
    const rick = atClient.filter((a: any) => a.holder === 'Receiving Rick');
    expect(rick).toHaveLength(1);
    expect(rick[0].total_keys).toBe(3);
  });

  it('generates TWO signature forms — a check-IN for the giver, a check-OUT for the taker', async () => {
    expect(transfer.from.signoff_link).toMatch(/\/key-signoff\/[a-f0-9]{64}$/);
    expect(transfer.to.signoff_link).toMatch(/\/key-signoff\/[a-f0-9]{64}$/);
    expect(transfer.from.signoff_link).not.toBe(transfer.to.signoff_link);

    const fromToken = transfer.from.signoff_link.split('/').pop();
    const toToken = transfer.to.signoff_link.split('/').pop();

    const giving = await request(app).get(`/api/signoff/${fromToken}`);
    expect(giving.body.action).toBe('checkin');
    expect(giving.body.holder).toBe('Transfer Tina');
    expect(giving.body.is_transfer).toBe(true);
    expect(giving.body.transfer_counterparty).toBe('Receiving Rick');
    expect(giving.body.total_keys).toBe(3);

    const taking = await request(app).get(`/api/signoff/${toToken}`);
    expect(taking.body.action).toBe('checkout');
    expect(taking.body.holder).toBe('Receiving Rick');
    expect(taking.body.transfer_counterparty).toBe('Transfer Tina');
    expect(taking.body.total_keys).toBe(3);
  });

  it('stays INCOMPLETE at 1 of 2 until both signatures land', async () => {
    expect(transfer.signatures).toEqual({
      signed: 0, total: 2, complete: false, from_signed: false, to_signed: false,
    });

    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const toToken = transfer.to.signoff_link.split('/').pop();
    const first = await request(app).post(`/api/signoff/${toToken}/sign`).send({ signature_data: png, typed_name: 'Receiving Rick' });
    expect(first.status).toBe(200);
    expect(first.body.transfer_signatures).toMatchObject({ signed: 1, complete: false, to_signed: true });

    const fromToken = transfer.from.signoff_link.split('/').pop();
    const second = await request(app).post(`/api/signoff/${fromToken}/sign`).send({ signature_data: png, typed_name: 'Transfer Tina' });
    expect(second.status).toBe(200);
    expect(second.body.transfer_signatures).toEqual({
      signed: 2, total: 2, complete: true, from_signed: true, to_signed: true,
    });
  });

  it('audits keys_transferred with from, to, client and keys', () => {
    const row = one("SELECT * FROM audit_log WHERE action = 'keys_transferred' ORDER BY id DESC LIMIT 1");
    expect(row).toBeTruthy();
    const meta = JSON.parse(row.metadata);
    expect(meta.from).toBe('Transfer Tina');
    expect(meta.to).toBe('Receiving Rick');
    expect(meta.client).toBe('TRANSFER TEST CLIENT');
    expect(meta.total_keys).toBe(3);
    expect(meta.keys.map((k: any) => k.type).sort()).toEqual(['card', 'metal']);
  });

  it('splits a source check-out when only part of it is transferred', async () => {
    const out = await auth(request(app).post('/api/assignments/checkout')).send({
      account_id: xferClientId, holder: 'Partial Paula', holder_type: 'employee',
      keys: [{ type: 'dispenser', qty: 4 }],
    });
    expect(out.status).toBe(201);

    const res = await auth(request(app).post('/api/assignments/transfer')).send({
      account_id: xferClientId, from_holder: 'Partial Paula', to_holder: 'Half Hank',
      to_holder_type: 'employee', keys: [{ type: 'dispenser', qty: 1 }],
    });
    expect(res.status).toBe(201);

    // Paula keeps the 3 she did not hand over; Hank holds exactly 1.
    const stillOut = one('SELECT * FROM key_assignments WHERE id = ?', out.body.id);
    expect(stillOut.status).toBe('checked_out');
    expect(JSON.parse(stillOut.keys_json)).toEqual([{ type: 'dispenser', label: 'Dispenser Key', qty: 3 }]);

    const hank = one("SELECT * FROM key_assignments WHERE assignee = 'Half Hank'");
    expect(JSON.parse(hank.keys_json)).toEqual([{ type: 'dispenser', label: 'Dispenser Key', qty: 1 }]);

    // The transferred slice became its own closed record, not a lost key.
    const slice = one('SELECT * FROM key_assignments WHERE id = ?', res.body.from.record_id);
    expect(slice.status).toBe('returned');
    expect(slice.return_reason).toBe('transferred');
    expect(JSON.parse(slice.keys_json)).toEqual([{ type: 'dispenser', label: 'Dispenser Key', qty: 1 }]);
  });
});

// ═══════════════════════════════ CUSTODY REPORT ═════════════════════════════
describe('CUSTODY REPORT', () => {
  it('returns rows, a summary bar and the filter description', async () => {
    const res = await auth(request(app).get('/api/exports/custody-report'));
    expect(res.status).toBe(200);
    expect(res.body.rows.length).toBeGreaterThan(0);
    expect(res.body.summary).toMatchObject({
      total: expect.any(Number),
      currently_out: expect.any(Number),
      overdue: expect.any(Number),
      awaiting_signature: expect.any(Number),
    });
    expect(res.body.description).toBe('All custody records');

    const row = res.body.rows[0];
    for (const field of [
      'holder', 'holder_type_label', 'client', 'bc_number', 'keys_summary',
      'checked_out_at', 'due_at', 'returned_at', 'status_label', 'signature_label', 'recorded_by',
    ]) {
      expect(row).toHaveProperty(field);
    }
    // The BC number is resolved from the client record, not stored on the
    // assignment — every row for a numbered client must carry it.
    const onTestClient = res.body.rows.find((r: any) => r.client === 'CUSTODY TEST CLIENT');
    expect(onTestClient.bc_number).toBe('01014000999');
  });

  it('filters by holder, holder type, status and signature state', async () => {
    const byHolder = await auth(request(app).get('/api/exports/custody-report?holder=Receiving'));
    expect(byHolder.body.rows.every((r: any) => r.holder.includes('Receiving'))).toBe(true);

    const ics = await auth(request(app).get('/api/exports/custody-report?holder_type=ic'));
    expect(ics.body.rows.every((r: any) => r.holder_type === 'ic')).toBe(true);

    const active = await auth(request(app).get('/api/exports/custody-report?status=active'));
    expect(active.body.rows.every((r: any) => r.status === 'checked_out')).toBe(true);
    expect(active.body.summary.currently_out).toBe(active.body.summary.total);

    const returned = await auth(request(app).get('/api/exports/custody-report?status=returned'));
    expect(returned.body.rows.every((r: any) => r.status === 'returned')).toBe(true);

    const awaiting = await auth(request(app).get('/api/exports/custody-report?signature=awaiting'));
    expect(awaiting.body.rows.every((r: any) => r.signature_status !== 'signed')).toBe(true);

    const signed = await auth(request(app).get('/api/exports/custody-report?signature=signed'));
    expect(signed.body.rows.every((r: any) => r.signature_status === 'signed')).toBe(true);
    expect(signed.body.summary.awaiting_signature).toBe(0);
  });

  it('filters by client and by date range', async () => {
    const byClient = await auth(request(app).get('/api/exports/custody-report?client=CUSTODY%20TEST'));
    expect(byClient.body.rows.length).toBeGreaterThan(0);

    const today = new Date().toISOString().slice(0, 10);
    const inRange = await auth(request(app).get(`/api/exports/custody-report?date_from=${today}&date_to=${today}`));
    expect(inRange.body.rows.length).toBeGreaterThan(0);
    expect(inRange.body.description).toContain('–');

    const longAgo = await auth(request(app).get('/api/exports/custody-report?date_from=2000-01-01&date_to=2000-12-31'));
    expect(longAgo.body.rows).toHaveLength(0);
    expect(longAgo.body.summary.total).toBe(0);
  });

  it('exports to Excel and to a branded PDF, with no access codes in either', async () => {
    const xlsx = await auth(request(app).get('/api/exports/custody-report/download?format=xlsx'))
      .buffer().parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(xlsx.status).toBe(200);
    expect(xlsx.headers['content-type']).toContain('spreadsheetml');
    expect(xlsx.headers['content-disposition']).toContain('CityWide-CustodyReport-');
    expect(xlsx.body.length).toBeGreaterThan(1000);

    const pdf = await auth(request(app).get('/api/exports/custody-report/download?format=pdf'))
      .buffer().parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.body.subarray(0, 4).toString()).toBe('%PDF');

    // The export is audited, and the audit records that no codes were included.
    const audit = one("SELECT * FROM audit_log WHERE action = 'export_custody_report' ORDER BY id DESC LIMIT 1");
    expect(JSON.parse(audit.metadata).codes_included).toBe(false);
  });

  it('rejects an unsupported export format', async () => {
    const res = await auth(request(app).get('/api/exports/custody-report/download?format=docx'));
    expect(res.status).toBe(400);
  });
});

// ═══════════════════════════ NOTIFICATION RECIPIENT ═════════════════════════
describe('CUSTODY NOTIFICATION SETTING', () => {
  it('reads the stored recipient and what the mailer will actually use', async () => {
    const res = await auth(request(app).get('/api/settings/custody-notification'));
    expect(res.status).toBe(200);
    expect(res.body.effective).toContain('cara@citywideboston.com');
  });

  it('accepts one or more addresses and audits the change', async () => {
    const res = await auth(request(app).put('/api/settings/custody-notification'))
      .send({ value: 'newkeeper@citywideboston.com, backup@citywideboston.com' });
    expect(res.status).toBe(200);
    expect(res.body.effective).toEqual(['newkeeper@citywideboston.com', 'backup@citywideboston.com']);
    expect(res.body.source).toBe('settings');

    const audit = one("SELECT * FROM audit_log WHERE action = 'settings_updated' ORDER BY id DESC LIMIT 1");
    expect(JSON.parse(audit.metadata).key).toBe('custody_notification_email');
  });

  it('the new recipient is used by the very next custody email', async () => {
    const res = await auth(request(app).post('/api/assignments/checkout')).send({
      account_id: clientId, holder: 'Notify Nick', holder_type: 'employee',
      holder_email: 'nick@example.test', keys: [{ type: 'metal', qty: 1 }],
    });
    expect(res.status).toBe(201);
    expect(res.body.email.recipients).toEqual([
      'nick@example.test', 'newkeeper@citywideboston.com', 'backup@citywideboston.com',
    ]);
    expect(res.body.email.cara).toBe('newkeeper@citywideboston.com, backup@citywideboston.com');
  });

  it('rejects a malformed address rather than silently notifying nobody', async () => {
    const res = await auth(request(app).put('/api/settings/custody-notification'))
      .send({ value: 'not-an-address' });
    expect(res.status).toBe(400);
    // The previous, valid recipient is untouched.
    const still = await auth(request(app).get('/api/settings/custody-notification'));
    expect(still.body.effective).toEqual(['newkeeper@citywideboston.com', 'backup@citywideboston.com']);
  });
});
