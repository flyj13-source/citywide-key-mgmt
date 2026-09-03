import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'citywide-bulk-'));
process.env.CITYWIDE_DB_DIR = TEST_DIR;
delete process.env.DB_PATH;
process.env.JWT_SECRET = 'test-secret';
process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
process.env.SEED_PASSWORD = 'demo1234';

const DB_FILE = path.join(TEST_DIR, 'citywide.db');
let app: Express;
let token: string;
let db: DatabaseSync;

const auth = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);

const addAccount = (o: Record<string, any>) => {
  const cols = Object.keys(o);
  const r = db.prepare(
    `INSERT INTO accounts (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`
  ).run(...cols.map((c) => o[c]));
  return Number(r.lastInsertRowid);
};

beforeAll(async () => {
  app = (await import('../src/index')).default;
  (await import('../src/lib/autoSeed')).autoSeedIfEmpty();
  const login = await request(app).post('/api/auth/login')
    .send({ email: 'cara@citywideboston.com', password: 'demo1234' });
  token = login.body.token;
  db = new DatabaseSync(DB_FILE);
});

beforeEach(() => {
  // Assignments first — they carry a foreign key onto accounts.
  db.exec('DELETE FROM key_assignments');
  db.exec('DELETE FROM accounts');
  // Audit entries accumulate across tests otherwise, and several assertions
  // here are precisely about how many entries a bulk action writes.
  db.exec('DELETE FROM audit_log');
});

describe('GET /accounts/ids — select all matching', () => {
  it('returns every id for the filter, not just one page', () => {
    for (let i = 0; i < 120; i++) {
      addAccount({ ic_company_name: `SITE ${String(i).padStart(3, '0')}`, record_type: 'customer' });
    }
    return auth(request(app).get('/api/accounts/ids?type=customer')).then((res) => {
      expect(res.status).toBe(200);
      expect(res.body.ids).toHaveLength(120);
      expect(res.body.total).toBe(120);
    });
  });

  it('resolves EXACTLY the same set the list endpoint is showing', async () => {
    for (let i = 0; i < 60; i++) {
      addAccount({ ic_company_name: `ALPHA ${i}`, record_type: 'customer' });
    }
    for (let i = 0; i < 40; i++) {
      addAccount({ ic_company_name: `BETA ${i}`, record_type: 'customer' });
    }
    const q = 'type=customer&search=ALPHA';
    const ids = await auth(request(app).get(`/api/accounts/ids?${q}`));
    // Walk the paginated list and collect every id it would ever show.
    const seen: number[] = [];
    for (let page = 1; page <= 3; page++) {
      const p = await auth(request(app).get(`/api/accounts?${q}&page=${page}&limit=25`));
      p.body.accounts.forEach((a: any) => seen.push(a.id));
    }
    expect(ids.body.ids.slice().sort()).toEqual(seen.slice().sort());
    expect(ids.body.total).toBe(60);
  });

  it('honours the search filter — never returns hidden rows', async () => {
    addAccount({ ic_company_name: 'VISIBLE ONE', record_type: 'customer' });
    addAccount({ ic_company_name: 'VISIBLE TWO', record_type: 'customer' });
    addAccount({ ic_company_name: 'HIDDEN', record_type: 'customer' });
    const res = await auth(request(app).get('/api/accounts/ids?type=customer&search=VISIBLE'));
    expect(res.body.total).toBe(2);
    expect(res.body.items.map((i: any) => i.ic_company_name).sort())
      .toEqual(['VISIBLE ONE', 'VISIBLE TWO']);
  });

  it('honours the archived filter in both directions', async () => {
    addAccount({ ic_company_name: 'LIVE', record_type: 'customer', archived: 0 });
    addAccount({ ic_company_name: 'GONE', record_type: 'customer', archived: 1 });
    const live = await auth(request(app).get('/api/accounts/ids?type=customer'));
    expect(live.body.items.map((i: any) => i.ic_company_name)).toEqual(['LIVE']);
    const arch = await auth(request(app).get('/api/accounts/ids?type=all&archived=1'));
    expect(arch.body.items.map((i: any) => i.ic_company_name)).toEqual(['GONE']);
  });

  it('honours the manager drill-down filter', async () => {
    addAccount({ ic_company_name: 'AGGIE ONE', record_type: 'customer', account_manager: 'Aggie AM' });
    addAccount({ ic_company_name: 'BEA ONE', record_type: 'customer', account_manager: 'Bea Both' });
    const res = await auth(request(app).get('/api/accounts/ids?type=customer&account_manager=Aggie%20AM'));
    expect(res.body.items.map((i: any) => i.ic_company_name)).toEqual(['AGGIE ONE']);
  });

  it('carries the capability fields the toolbar needs and NO codes', async () => {
    addAccount({
      ic_company_name: 'ONE', record_type: 'customer', account_manager: 'Aggie AM',
      ccm_manager: 'Cleo CCM', lockbox_code: 'SECRET-123',
    });
    const res = await auth(request(app).get('/api/accounts/ids?type=customer'));
    const item = res.body.items[0];
    expect(item).toMatchObject({
      ic_company_name: 'ONE', record_type: 'customer',
      account_manager: 'Aggie AM', ccm_manager: 'Cleo CCM', archived: 0,
    });
    // The selection payload must never carry secrets or the full row.
    expect(item).not.toHaveProperty('lockbox_code');
    expect(item).not.toHaveProperty('door_code_encrypted');
    expect(item).not.toHaveProperty('notes');
  });

  it('requires auth', async () => {
    expect((await request(app).get('/api/accounts/ids')).status).toBe(401);
  });

  it('is not shadowed by GET /accounts/:id', async () => {
    const res = await auth(request(app).get('/api/accounts/ids'));
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('ids');
  });
});

describe('POST /accounts/bulk-archive', () => {
  it('archives every selected record in one call', async () => {
    const ids = [1, 2, 3].map((n) => addAccount({ ic_company_name: `SITE ${n}`, record_type: 'customer' }));
    const res = await auth(request(app).post('/api/accounts/bulk-archive')).send({ ids });
    expect(res.status).toBe(200);
    expect(res.body.archived).toBe(3);
    expect(db.prepare('SELECT COUNT(*) AS n FROM accounts WHERE archived = 1').get())
      .toMatchObject({ n: 3 });
  });

  it('writes one audit entry PER record plus a summary entry', async () => {
    const ids = [1, 2].map((n) => addAccount({ ic_company_name: `AUDITED ${n}`, record_type: 'customer' }));
    await auth(request(app).post('/api/accounts/bulk-archive')).send({ ids });

    const perRecord = (db.prepare(
      "SELECT account_name, metadata FROM audit_log WHERE action = 'account_archived' ORDER BY id"
    ).all() as any[]).map((r) => Object.assign({}, r));
    expect(perRecord.map((r) => r.account_name)).toEqual(['AUDITED 1', 'AUDITED 2']);
    expect(JSON.parse(perRecord[0].metadata).bulk).toBe(true);

    const summary = Object.assign({}, db.prepare(
      "SELECT metadata FROM audit_log WHERE action = 'accounts_bulk_archived'"
    ).get() as any);
    const meta = JSON.parse(summary.metadata);
    expect(meta).toMatchObject({ requested: 2, archived: 2 });
    expect(meta.archived_names).toEqual(['AUDITED 1', 'AUDITED 2']);
  });

  it('REFUSES a record still holding checked-out keys, and names it', async () => {
    const ok = addAccount({ ic_company_name: 'FREE SITE', record_type: 'customer' });
    const held = addAccount({ ic_company_name: 'KEYS OUT SITE', record_type: 'customer' });
    db.prepare(
      "INSERT INTO key_assignments (account_id, account_name, assignee, status) VALUES (?, 'KEYS OUT SITE', 'Someone', 'checked_out')"
    ).run(held);

    const res = await auth(request(app).post('/api/accounts/bulk-archive')).send({ ids: [ok, held] });
    expect(res.body.archived).toBe(1);
    expect(res.body.blocked).toEqual([{ id: held, name: 'KEYS OUT SITE', reason: 'checked_out' }]);
    // The blocked one is genuinely still live, not quietly archived.
    expect(Object.assign({}, db.prepare('SELECT archived FROM accounts WHERE id = ?').get(held) as any))
      .toMatchObject({ archived: 0 });
  });

  it('leaves already-archived records alone and reports them', async () => {
    const live = addAccount({ ic_company_name: 'LIVE', record_type: 'customer', archived: 0 });
    const gone = addAccount({ ic_company_name: 'GONE', record_type: 'customer', archived: 1 });
    const res = await auth(request(app).post('/api/accounts/bulk-archive')).send({ ids: [live, gone] });
    expect(res.body).toMatchObject({ archived: 1, alreadyArchived: 1 });
  });

  it('reports ids that do not exist rather than failing the batch', async () => {
    const real = addAccount({ ic_company_name: 'REAL', record_type: 'customer' });
    const res = await auth(request(app).post('/api/accounts/bulk-archive')).send({ ids: [real, 999999] });
    expect(res.body).toMatchObject({ archived: 1, notFound: 1 });
  });

  it('de-duplicates repeated ids', async () => {
    const id = addAccount({ ic_company_name: 'ONCE', record_type: 'customer' });
    const res = await auth(request(app).post('/api/accounts/bulk-archive')).send({ ids: [id, id, id] });
    expect(res.body.archived).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'account_archived'").get())
      .toMatchObject({ n: 1 });
  });

  it('rejects an empty selection and an oversized one', async () => {
    expect((await auth(request(app).post('/api/accounts/bulk-archive')).send({ ids: [] })).status).toBe(400);
    const huge = Array.from({ length: 1001 }, (_, i) => i + 1);
    expect((await auth(request(app).post('/api/accounts/bulk-archive')).send({ ids: huge })).status).toBe(400);
  });

  it('requires auth', async () => {
    expect((await request(app).post('/api/accounts/bulk-archive').send({ ids: [1] })).status).toBe(401);
  });

  it('is gated on can_delete', async () => {
    // A manager without delete rights must be refused outright.
    db.prepare("UPDATE managers SET can_delete = 0 WHERE email = 'cara@citywideboston.com'").run();
    const login = await request(app).post('/api/auth/login')
      .send({ email: 'cara@citywideboston.com', password: 'demo1234' });
    const id = addAccount({ ic_company_name: 'PROTECTED', record_type: 'customer' });
    const res = await request(app).post('/api/accounts/bulk-archive')
      .set('Authorization', `Bearer ${login.body.token}`).send({ ids: [id] });
    expect(res.status).toBe(403);
    expect(Object.assign({}, db.prepare('SELECT archived FROM accounts WHERE id = ?').get(id) as any))
      .toMatchObject({ archived: 0 });
    db.prepare("UPDATE managers SET can_delete = 1 WHERE email = 'cara@citywideboston.com'").run();
  });
});

describe('EXPORT — "Export selected" narrows to exactly the ticked rows', () => {
  it('exports only the given ids', async () => {
    const a = addAccount({ ic_company_name: 'PICKED ONE', record_type: 'customer' });
    const b = addAccount({ ic_company_name: 'PICKED TWO', record_type: 'customer' });
    addAccount({ ic_company_name: 'NOT PICKED', record_type: 'customer' });

    const res = await auth(request(app).post('/api/exports/registry'))
      .send({ scope: 'current', tab: 'customer', format: 'csv', ids: [a, b] });
    expect(res.status).toBe(200);
    const csv = res.text ?? res.body.toString();
    expect(csv).toContain('PICKED ONE');
    expect(csv).toContain('PICKED TWO');
    expect(csv).not.toContain('NOT PICKED');
  });

  it('without ids it still exports the whole tab', async () => {
    addAccount({ ic_company_name: 'EVERYONE', record_type: 'customer' });
    const res = await auth(request(app).post('/api/exports/registry'))
      .send({ scope: 'current', tab: 'customer', format: 'csv' });
    expect((res.text ?? res.body.toString())).toContain('EVERYONE');
  });

  it('records the selected count in the audit entry', async () => {
    const a = addAccount({ ic_company_name: 'AUDIT ME', record_type: 'customer' });
    await auth(request(app).post('/api/exports/registry'))
      .send({ scope: 'current', tab: 'customer', format: 'csv', ids: [a] });
    const row = Object.assign({}, db.prepare(
      "SELECT metadata FROM audit_log WHERE action = 'export_registry' ORDER BY id DESC LIMIT 1"
    ).get() as any);
    expect(JSON.parse(row.metadata).selected_ids).toBe(1);
  });
});

describe('PERFORMANCE — 577 rows', () => {
  it('resolves all 577 ids well inside a click', async () => {
    for (let i = 0; i < 577; i++) {
      addAccount({ ic_company_name: `PERF SITE ${String(i).padStart(3, '0')}`, record_type: 'customer' });
    }
    const t0 = Date.now();
    const res = await auth(request(app).get('/api/accounts/ids?type=customer'));
    const ms = Date.now() - t0;
    expect(res.body.ids).toHaveLength(577);
    expect(ms).toBeLessThan(1000);
  });

  it('archives 577 records in one transaction', async () => {
    const ids: number[] = [];
    for (let i = 0; i < 577; i++) {
      ids.push(addAccount({ ic_company_name: `MASS ${String(i).padStart(3, '0')}`, record_type: 'customer' }));
    }
    const t0 = Date.now();
    const res = await auth(request(app).post('/api/accounts/bulk-archive')).send({ ids });
    const ms = Date.now() - t0;
    expect(res.body.archived).toBe(577);
    expect(ms).toBeLessThan(5000);
    expect(db.prepare('SELECT COUNT(*) AS n FROM accounts WHERE archived = 1').get())
      .toMatchObject({ n: 577 });
    // 577 per-record entries + 1 summary.
    expect(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'account_archived'").get())
      .toMatchObject({ n: 577 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'accounts_bulk_archived'").get())
      .toMatchObject({ n: 1 });
  });
});
