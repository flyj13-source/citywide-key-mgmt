// ── Backwards-entry audit — read-only report ─────────────────────────────────
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'citywide-backwards-'));
process.env.CITYWIDE_DB_DIR = TEST_DIR;
delete process.env.DB_PATH;
process.env.JWT_SECRET = 'test-secret';
process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
process.env.SEED_PASSWORD = 'demo1234';

const DB_FILE = path.join(TEST_DIR, 'citywide.db');
let app: Express;
let token: string;
let db: DatabaseSync;
let fx: typeof import('../src/lib/testFixtures');
const AM1 = 'ZZ Test AM One';
const auth = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);

beforeAll(async () => {
  app = (await import('../src/index')).default;
  (await import('../src/lib/autoSeed')).autoSeedIfEmpty();
  fx = await import('../src/lib/testFixtures');
  token = (await request(app).post('/api/auth/login')
    .send({ email: 'cara@citywideboston.com', password: 'demo1234' })).body.token;
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
});

const clientA = () => Number(Object.assign({}, db.prepare(
  "SELECT id FROM accounts WHERE bc_client_number='09999900001'").get() as any).id);

const rec = (o: {
  holder?: string; keys: { type: string; label: string; qty: number }[]; at: string;
  status?: string; returned_at?: string | null; origin?: string; by?: string;
}) => Number(db.prepare(`
  INSERT INTO key_assignments (account_id, account_name, assignee, key_type, keys_held, keys_json,
    holder_type, recorded_by, checkin_recorded_by, checked_out_at, returned_at, status, origin)
  VALUES (?, 'ZZ TEST CLIENT A — Do Not Use', ?, 'metal', '', ?, 'employee', ?, ?, ?, ?, ?, ?)
`).run(clientA(), o.holder ?? AM1, JSON.stringify(o.keys), o.by ?? 'Cara', o.by ?? 'Cara',
  o.at, o.returned_at ?? null, o.status ?? 'checked_out', o.origin ?? 'checked_out').lastInsertRowid);

const METAL = (qty: number) => ({ type: 'metal', label: 'Metal Key', qty });
const CARD = (qty: number) => ({ type: 'card', label: 'Key Card', qty });

const report = async (includeTest = true) => {
  const res = await auth(request(app).get('/api/assignments/backwards-audit')
    .query(includeTest ? { include_test: '1' } : {}));
  expect(res.status).toBe(200);
  return res.body;
};

describe('BACKWARDS-ENTRY AUDIT', () => {
  it('flags an issue recorded while the holder already had the same keys open', async () => {
    const first = rec({ keys: [METAL(1), CARD(1)], at: '2026-09-01T14:00:00.000Z' });
    const second = rec({ keys: [METAL(1)], at: '2026-09-10T15:00:00.000Z', by: 'Front Desk' });
    const r = await report();
    expect(r.returns_logged_as_issues).toEqual([expect.objectContaining({
      record_id: second, holder: AM1, keys: '1 Metal Key', date: '2026-09-10T15:00:00.000Z',
      recorded_by: 'Front Desk', already_open: expect.objectContaining({ record_id: first }),
    })]);
  });

  it('does not flag a re-issue after the earlier record was closed', async () => {
    rec({ keys: [METAL(1)], at: '2026-09-01T14:00:00.000Z', status: 'returned', returned_at: '2026-09-05T10:00:00.000Z' });
    rec({ keys: [METAL(1)], at: '2026-09-10T15:00:00.000Z' });
    expect((await report()).returns_logged_as_issues).toHaveLength(0);
  });

  it('does not flag different key types', async () => {
    rec({ keys: [METAL(1)], at: '2026-09-01T14:00:00.000Z' });
    rec({ keys: [CARD(1)], at: '2026-09-10T15:00:00.000Z' });
    expect((await report()).returns_logged_as_issues).toHaveLength(0);
  });

  it('flags open custody above the role grid (AM holds 1 metal + 1 card)', async () => {
    rec({ keys: [METAL(3)], at: '2026-09-01T14:00:00.000Z' });
    const r = await report();
    expect(r.holdings_likely_returned).toEqual([expect.objectContaining({
      holder: AM1, open_keys: '3 Metal Keys', role_keys: '1 Metal Key · 1 Key Card', excess: '2 Metal Keys',
    })]);
  });

  it('lists first-time records separately, for context', async () => {
    const id = rec({ keys: [METAL(1)], at: '2026-09-02T09:00:00.000Z', status: 'returned',
      returned_at: '2026-09-02T09:00:00.000Z', origin: 'reconciled' });
    const r = await report();
    expect(r.first_time_records.map((x: any) => x.record_id)).toEqual([id]);
    expect(r.returns_logged_as_issues).toHaveLength(0);
  });

  it('leaves ZZ TEST out unless asked, and changes nothing', async () => {
    rec({ keys: [METAL(1)], at: '2026-09-01T14:00:00.000Z' });
    rec({ keys: [METAL(1)], at: '2026-09-10T15:00:00.000Z' });
    const snapshot = JSON.stringify(db.prepare('SELECT * FROM key_assignments ORDER BY id').all());
    const r = await report(false);
    expect(r.returns_logged_as_issues).toHaveLength(0);
    expect(r.holdings_likely_returned).toHaveLength(0);
    expect(JSON.stringify(db.prepare('SELECT * FROM key_assignments ORDER BY id').all())).toBe(snapshot);
  });
});
