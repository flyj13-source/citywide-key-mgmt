// Repairing a check-in form written BEFORE return receipts existed.
//
// Those forms stored the holder's position AFTER the return, so a full return
// left them with zero line items — a "you hold no keys" statement nobody can
// sign. KF-00011 in production is one of these. Regenerate rebuilds them from
// the custody record they name, which is where the keys that actually moved
// still live.
import { it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs'; import os from 'os'; import path from 'path'; import crypto from 'crypto';

const D = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-'));
process.env.CITYWIDE_DB_DIR = D; delete process.env.DB_PATH;
process.env.JWT_SECRET = 't';
process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
process.env.SEED_PASSWORD = 'demo1234';

let app: any; let token = ''; let db: DatabaseSync;
const auth = (r: any) => r.set('Authorization', `Bearer ${token}`);
const obj = (r: any) => Object.assign({}, r);

beforeAll(async () => {
  app = (await import('../src/index')).default;
  (await import('../src/lib/autoSeed')).autoSeedIfEmpty();
  const l = await request(app).post('/api/auth/login')
    .send({ email: 'cara@citywideboston.com', password: 'demo1234' });
  token = l.body.token;
  db = new DatabaseSync(path.join(D, 'citywide.db'));
});

beforeEach(() => {
  // Children before parents: key_assignments references accounts.
  db.exec('DELETE FROM key_assignments; DELETE FROM accounts; DELETE FROM key_form_docs');
});

/** A closed check-in record plus the zero-line form the old code wrote for it. */
function legacyPair(holder: string, email: string, keys: any[]) {
  const acc = Number(db.prepare(
    `INSERT INTO accounts (ic_company_name, record_type, bc_client_number, metal_keys)
     VALUES ('WILLOWBROOK CENTER', 'customer', '01014200311', 6)`
  ).run().lastInsertRowid);

  const asg = Number(db.prepare(
    `INSERT INTO key_assignments
       (account_id, account_name, assignee, assignee_email, key_type, keys_held, keys_json,
        holder_type, status, returned_at, condition_on_return)
     VALUES (?, 'WILLOWBROOK CENTER', ?, ?, 'metal', ?, ?, 'employee', 'returned',
             '2026-09-13T14:00:00.000Z', 'good')`
  ).run(acc, holder, email, '1 Metal Key', JSON.stringify(keys)).lastInsertRowid);

  // The form as the OLD code wrote it: event_type checkin, no doc_kind, and a
  // scope holding the post-return position — which was empty.
  const form = Number(db.prepare(
    `INSERT INTO key_form_docs
       (form_no, event_type, holder_name, holder_type, holder_role, holder_email,
        scope_json, clients_covered, total_keys, status, token, token_expires_at,
        generated_by, source_kind, source_ref)
     VALUES ('KF-00011', 'checkin', ?, 'employee', 'AM', ?,
             ?, 0, 0, 'unsigned', ?, '2099-01-01T00:00:00.000Z',
             'Cara Angeloni', 'assignment', ?)`
  ).run(holder, email, JSON.stringify({ lines: [], event_note: null }),
        crypto.randomBytes(8).toString('hex'), String(asg)).lastInsertRowid);

  return { acc, asg, form };
}

it('a legacy zero-line check-in form regenerates into a signable return receipt', async () => {
  const { form } = legacyPair('Jeremiah Williams', 'Jeremiah.williams@gocitywide.com',
    [{ type: 'metal', label: 'Metal Key', qty: 1 }]);

  // It reads as a receipt already (event mapping fallback) but has nothing on it.
  const before = await auth(request(app).get(`/api/key-forms/${form}`));
  expect(before.body.form.doc_kind).toBe('return_receipt');
  expect(before.body.form.clients).toEqual([]);
  expect(before.body.form.total_keys).toBe(0);

  const res = await auth(request(app).post(`/api/key-forms/${form}/regenerate`));
  expect(res.status).toBe(201);

  const fresh = res.body.form;
  expect(fresh.doc_kind).toBe('return_receipt');
  expect(fresh.doc_title).toBe('Key Return Receipt');
  // Rebuilt from the custody record: the 1 metal key that actually came back.
  expect(fresh.total_keys).toBe(1);
  expect(fresh.returned_keys).toBe(1);
  expect(fresh.clients).toHaveLength(1);
  expect(fresh.clients[0]).toMatchObject({
    client: 'WILLOWBROOK CENTER', bc_client_number: '01014200311', metal: 1, subtotal: 1,
  });
  expect(fresh.supersedes).toBe(form);

  // The original is kept and marked, never edited or deleted.
  const old = obj(db.prepare('SELECT status, superseded_by FROM key_form_docs WHERE id = ?').get(form) as any);
  expect(old.status).toBe('superseded');
  expect(old.superseded_by).toBe(fresh.id);

  // And it is sendable to a named address.
  const sent = await auth(request(app).post(`/api/key-forms/${fresh.id}/send`))
    .send({ to: 'Jeremiah.williams@gocitywide.com' });
  expect(sent.status).toBe(200);
  expect(sent.body.recipients).toContain('Jeremiah.williams@gocitywide.com');
});

it('refuses rather than inventing line items when the custody record is gone', async () => {
  const { asg, form } = legacyPair('Ghost Holder', 'ghost@cw.test',
    [{ type: 'metal', label: 'Metal Key', qty: 1 }]);
  db.prepare('DELETE FROM key_assignments WHERE id = ?').run(asg);

  const res = await auth(request(app).post(`/api/key-forms/${form}/regenerate`));
  expect(res.status).toBe(409);
  expect(res.body.code).toBe('RECEIPT_SOURCE_MISSING');
  // The original is left exactly as it stands.
  const old = obj(db.prepare('SELECT status, superseded_by FROM key_form_docs WHERE id = ?').get(form) as any);
  expect(old.status).toBe('unsigned');
  expect(old.superseded_by).toBeNull();
});
