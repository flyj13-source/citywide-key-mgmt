import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'citywide-sig-'));
process.env.CITYWIDE_DB_DIR = TEST_DIR;
delete process.env.DB_PATH;
process.env.JWT_SECRET = 'test-secret';
process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
process.env.SEED_PASSWORD = 'demo1234';
process.env.FRONTEND_URL = 'https://keys.example.test';
delete process.env.SMTP_USER;
delete process.env.SMTP_PASS;

const DB_FILE = path.join(TEST_DIR, 'citywide.db');
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let app: Express;
let token: string;
let clientId: number;
let noEmailStaffId: number;

const openDb = () => new DatabaseSync(DB_FILE);
const auth = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);
const all = (sql: string, ...p: any[]) => {
  const db = openDb();
  const rows = (db.prepare(sql).all(...p) as any[]).map((r) => Object.assign({}, r));
  db.close();
  return rows;
};
const one = (sql: string, ...p: any[]) => all(sql, ...p)[0] ?? null;

beforeAll(async () => {
  app = (await import('../src/index')).default;
  (await import('../src/lib/autoSeed')).autoSeedIfEmpty();
  const login = await request(app).post('/api/auth/login')
    .send({ email: 'cara@citywideboston.com', password: 'demo1234' });
  token = login.body.token;

  const db = openDb();
  db.exec('DELETE FROM staff_managers');
  db.prepare("INSERT INTO staff_managers (name, manager_type, role_category, email, active) VALUES (?,?,?,?,1)")
    .run('Emailless Eddie', 'account_manager', 'manager', null);
  db.prepare("INSERT INTO staff_managers (name, manager_type, role_category, email, active) VALUES (?,?,?,?,1)")
    .run('Wired Wanda', 'account_manager', 'manager', 'wanda@citywideboston.com');
  db.close();
  noEmailStaffId = all("SELECT id FROM staff_managers WHERE name = 'Emailless Eddie'")[0].id;

  const created = await auth(request(app).post('/api/accounts')).send({
    record_type: 'customer', ic_company_name: 'SIGNATURE TEST CLIENT',
    bc_client_number: '01014600001', am_metal: 5, am_card: 5,
  });
  clientId = created.body.id;
});

// ═══════════════════════════════════ BLOCK AT ENTRY ═════════════════════════
describe('BLOCK AT ENTRY — no email on file', () => {
  it('refuses the check-out with a machine-readable code and both remedies', async () => {
    const res = await auth(request(app).post('/api/assignments/checkout')).send({
      account_id: clientId, holder: 'Emailless Eddie', holder_type: 'employee',
      holder_id: noEmailStaffId, keys: [{ type: 'metal', qty: 1 }],
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('HOLDER_EMAIL_MISSING');
    expect(res.body.error).toMatch(/has no email on file/);
    expect(res.body.remedies).toEqual(['add_email', 'continue_without_signature']);
    // Nothing was written — the block is real, not cosmetic.
    expect(all("SELECT * FROM key_assignments WHERE assignee = 'Emailless Eddie'")).toHaveLength(0);
  });

  it('REMEDY A — adding an email saves to the staff record permanently', async () => {
    const res = await auth(request(app).post('/api/assignments/holder-email')).send({
      holder_type: 'employee', holder_id: noEmailStaffId, email: 'eddie@citywideboston.com',
    });
    expect(res.status).toBe(200);
    expect(one('SELECT email FROM staff_managers WHERE id = ?', noEmailStaffId).email)
      .toBe('eddie@citywideboston.com');
    expect(all("SELECT * FROM audit_log WHERE action = 'holder_email_added'")).toHaveLength(1);

    // The holder picker now reports them as reachable.
    const holders = await auth(request(app).get('/api/assignments/holders'));
    const eddie = holders.body.employees.find((e: any) => e.name === 'Emailless Eddie');
    expect(eddie.has_email).toBe(true);
  });

  it('rejects a malformed email rather than saving junk', async () => {
    const res = await auth(request(app).post('/api/assignments/holder-email'))
      .send({ holder_type: 'employee', holder_id: noEmailStaffId, email: 'not-an-email' });
    expect(res.status).toBe(400);
  });
});

// ═══════════════════════ UNSIGNED BY NECESSITY ══════════════════════════════
describe('UNSIGNED BY NECESSITY', () => {
  let unsignedId: number;

  it('REMEDY B — continuing without a signature requires a typed reason', async () => {
    const res = await auth(request(app).post('/api/assignments/checkout')).send({
      account_id: clientId, holder: 'Ghost Contractor', holder_type: 'ic',
      keys: [{ type: 'metal', qty: 1 }],
      no_email_reason: 'Subcontractor on site, no address on file yet',
    });
    expect(res.status).toBe(201);
    unsignedId = res.body.id;
    expect(res.body.signature_status).toBe('signature_unavailable');
    expect(res.body.signoff_link).toBeNull();
  });

  it('the record is signature_unavailable — NOT awaiting_signature', () => {
    const row = one('SELECT * FROM key_assignments WHERE id = ?', unsignedId);
    expect(row.signature_status).toBe('signature_unavailable');
    expect(row.signature_status).not.toBe('awaiting_signature');
    expect(row.no_email_reason).toBe('Subcontractor on site, no address on file yet');
    // No token: a link nobody can receive would make it look pending.
    expect(row.signoff_token).toBeNull();
  });

  it('audits the release of keys without a signature', () => {
    const row = one("SELECT * FROM audit_log WHERE action = 'signature_unavailable' ORDER BY id DESC LIMIT 1");
    const meta = JSON.parse(row.metadata);
    expect(meta.holder).toBe('Ghost Contractor');
    expect(meta.reason).toBe('Subcontractor on site, no address on file yet');
  });

  it('NOTIFIES CARA REGARDLESS — she is still the recipient with no holder email', () => {
    const row = one("SELECT * FROM audit_log WHERE action IN ('custody_email_sent','custody_email_failed') ORDER BY id DESC LIMIT 1");
    const meta = JSON.parse(row.metadata);
    expect(meta.recipients).toEqual(['cara@citywideboston.com']);
  });

  it('IN-PERSON FALLBACK — a wet signature resolves it, recording the witness', async () => {
    const res = await auth(request(app).post(`/api/assignments/${unsignedId}/sign-in-person`))
      .send({ signature_data: PNG });
    expect(res.status).toBe(200);
    expect(res.body.witnessed_by).toBe('Cara Angeloni');
    expect(res.body.pdf_error).toBeNull();
    expect(res.body.assignment.signature_status).toBe('signed');

    const row = one('SELECT * FROM key_assignments WHERE id = ?', unsignedId);
    expect(row.signature_status).toBe('signed');
    expect(row.signed_in_person_by).toBe('Cara Angeloni');
    expect(row.signature_hash).toBe(crypto.createHash('sha256').update(PNG).digest('hex'));
    expect(fs.existsSync(row.pdf_path)).toBe(true);
    expect(fs.readFileSync(row.pdf_path).subarray(0, 4).toString()).toBe('%PDF');

    expect(all("SELECT * FROM audit_log WHERE action = 'checkout_signed_in_person'")).toHaveLength(1);
  });

  it('cannot be signed twice', async () => {
    const res = await auth(request(app).post(`/api/assignments/${unsignedId}/sign-in-person`))
      .send({ signature_data: PNG });
    expect(res.status).toBe(409);
  });
});

// ═══════════════════════ SEND FAILURE ═══════════════════════════════════════
describe('SMTP SEND FAILURE', () => {
  it('an email that exists but cannot be sent lands in signature_send_failed, not amber', async () => {
    // SMTP is unconfigured in tests, so every send reports failure.
    const res = await auth(request(app).post('/api/assignments/checkout')).send({
      account_id: clientId, holder: 'Wired Wanda', holder_type: 'employee',
      holder_email: 'wanda@citywideboston.com', keys: [{ type: 'card', qty: 1 }],
    });
    expect(res.status).toBe(201);
    expect(res.body.signature_status).toBe('signature_send_failed');
    expect(res.body.email.ok).toBe(false);

    const row = one('SELECT * FROM key_assignments WHERE id = ?', res.body.id);
    expect(row.signature_status).toBe('signature_send_failed');
    expect(row.signature_send_error).toBeTruthy();
    expect(all("SELECT * FROM audit_log WHERE action = 'signature_send_failed'").length).toBeGreaterThan(0);
  });
});

// ═══════════════════════ SIGNED RECEIPT DELIVERY ════════════════════════════
describe('SIGNED RECEIPT — three recipients', () => {
  it('goes to signer, Cara, and the counterparty on a transfer', async () => {
    const res = await auth(request(app).post('/api/assignments/checkout')).send({
      account_id: clientId, holder: 'Wired Wanda', holder_type: 'employee',
      holder_email: 'wanda@citywideboston.com', keys: [{ type: 'metal', qty: 1 }],
      counterparty_name: 'Odvin Rivas', counterparty_email: 'odvin@citywideboston.com',
    });
    const id = res.body.id;

    const signRes = await auth(request(app).post(`/api/assignments/${id}/sign-in-person`))
      .send({ signature_data: PNG });
    expect(signRes.status).toBe(200);
    expect(signRes.body.email.recipients).toEqual([
      'wanda@citywideboston.com',      // 1. the signer
      'cara@citywideboston.com',       // 2. Cara
      'odvin@citywideboston.com',      // 3. the other party
    ]);
    expect(all("SELECT * FROM audit_log WHERE action IN ('signed_receipt_sent','signed_receipt_failed')").length)
      .toBeGreaterThan(0);
  });
});

// ═══════════════════════ SYSTEMIC SURFACING ═════════════════════════════════
describe('SURFACING THE GAP', () => {
  it('signature-gaps reports the counts the dashboard card renders', async () => {
    const res = await auth(request(app).get('/api/assignments/signature-gaps'));
    expect(res.status).toBe(200);
    // One send_failed record remains open and unsigned from the test above.
    expect(res.body.send_failed).toBeGreaterThanOrEqual(1);
    expect(res.body.needs_attention).toBe(res.body.no_email + res.body.send_failed);
    expect(res.body.total_missing).toBe(res.body.no_email + res.body.send_failed + res.body.awaiting);
    expect(typeof res.body.staff_without_email).toBe('number');
  });

  it('?signature=missing filters the custody list to what needs chasing', async () => {
    const all_ = await auth(request(app).get('/api/assignments?status=checked_out&limit=100'));
    const missing = await auth(request(app).get('/api/assignments?status=checked_out&signature=missing&limit=100'));
    expect(missing.body.total).toBeLessThanOrEqual(all_.body.total);
    for (const a of missing.body.assignments) {
      expect(['signature_unavailable', 'signature_send_failed', 'awaiting_signature'])
        .toContain(a.signature_status);
    }
  });

  it('?signature=unresolvable excludes records that are merely awaiting', async () => {
    const res = await auth(request(app).get('/api/assignments?status=checked_out&signature=unresolvable&limit=100'));
    for (const a of res.body.assignments) {
      expect(['signature_unavailable', 'signature_send_failed']).toContain(a.signature_status);
    }
  });
});
