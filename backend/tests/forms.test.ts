import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'citywide-forms-test-'));
process.env.CITYWIDE_DB_DIR = TEST_DIR;
delete process.env.DB_PATH;
process.env.JWT_SECRET = 'test-secret';
process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
process.env.SEED_PASSWORD = 'demo1234';

const DB_FILE = path.join(TEST_DIR, 'citywide.db');
const ADMIN_EMAIL = 'cara@citywideboston.com';
const ADMIN_PASS = 'demo1234';

// A tiny but valid 1×1 PNG data URL — passes the data:image/png guard.
const SIG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

let app: Express;
let token: string;
function openDb() { return new DatabaseSync(DB_FILE); }
function auth(req: request.Test) { return req.set('Authorization', `Bearer ${token}`); }

beforeAll(async () => {
  app = (await import('../src/index')).default;
  const { autoSeedIfEmpty } = await import('../src/lib/autoSeed');
  autoSeedIfEmpty();
  const res = await request(app).post('/api/auth/login').send({ email: ADMIN_EMAIL, password: ADMIN_PASS });
  token = res.body.token;
});

describe('KEY FORMS API', () => {
  it('requires auth', async () => {
    const res = await request(app).get('/api/forms');
    expect(res.status).toBe(401);
  });

  it('rejects an invalid party_type / action / missing signature', async () => {
    expect((await auth(request(app).post('/api/forms')).send({ party_type: 'boss', action: 'receive', person_name: 'X', signature_data: SIG })).status).toBe(400);
    expect((await auth(request(app).post('/api/forms')).send({ party_type: 'employee', action: 'lose', person_name: 'X', signature_data: SIG })).status).toBe(400);
    expect((await auth(request(app).post('/api/forms')).send({ party_type: 'employee', action: 'receive', person_name: 'X' })).status).toBe(400);
    expect((await auth(request(app).post('/api/forms')).send({ party_type: 'employee', action: 'receive', person_name: '', signature_data: SIG })).status).toBe(400);
    // Non-image signature payload is rejected.
    expect((await auth(request(app).post('/api/forms')).send({ party_type: 'employee', action: 'receive', person_name: 'X', signature_data: 'nope' })).status).toBe(400);
  });

  it('creates an employee receive form and hashes the signature', async () => {
    const res = await auth(request(app).post('/api/forms')).send({
      party_type: 'employee', action: 'receive', person_name: 'Field Tech',
      person_email: 'ft@citywideboston.com',
      account_names: ['SITE A', 'SITE B'], key_details: '2 metal, 1 fob',
      notes: 'lobby + basement', signature_data: SIG,
    });
    expect(res.status).toBe(201);
    const f = res.body.form;
    expect(f.party_type).toBe('employee');
    expect(f.action).toBe('receive');
    expect(f.account_names).toEqual(['SITE A', 'SITE B']);
    expect(f.collected_by).toBe('Cara Angeloni');
    expect(f.signature_hash).toHaveLength(64);
    // List shape never leaks the signature blob.
    expect(f.signature_data).toBeUndefined();
  });

  it('accepts newline/comma-separated account text and trims blanks', async () => {
    const res = await auth(request(app).post('/api/forms')).send({
      party_type: 'contractor', action: 'return', person_name: 'ACME Cleaning',
      account_names: 'SITE C\n , SITE D\n\n', signature_data: SIG,
    });
    expect(res.status).toBe(201);
    expect(res.body.form.account_names).toEqual(['SITE C', 'SITE D']);
  });

  it('lists the log (newest first) without signature blobs, and filters', async () => {
    const all = await auth(request(app).get('/api/forms'));
    expect(all.status).toBe(200);
    expect(all.body.forms.length).toBeGreaterThanOrEqual(2);
    expect(all.body.forms[0].signature_data).toBeUndefined();

    const emps = await auth(request(app).get('/api/forms?party_type=employee'));
    expect(emps.body.forms.every((f: any) => f.party_type === 'employee')).toBe(true);

    const returns = await auth(request(app).get('/api/forms?action=return'));
    expect(returns.body.forms.every((f: any) => f.action === 'return')).toBe(true);

    const search = await auth(request(app).get('/api/forms?search=ACME'));
    expect(search.body.forms.some((f: any) => f.person_name === 'ACME Cleaning')).toBe(true);
  });

  it('returns the signature blob only on the detail endpoint', async () => {
    const list = await auth(request(app).get('/api/forms?party_type=employee'));
    const id = list.body.forms[0].id;
    const detail = await auth(request(app).get(`/api/forms/${id}`));
    expect(detail.status).toBe(200);
    expect(detail.body.form.signature_data).toBe(SIG);
  });

  it('writes a key_form_signed audit entry', async () => {
    const db = openDb();
    const actions = (db.prepare("SELECT action FROM audit_log WHERE action='key_form_signed'").all() as any[])
      .map((r) => Object.assign({}, r).action);
    db.close();
    expect(actions.length).toBeGreaterThanOrEqual(1);
  });
});
