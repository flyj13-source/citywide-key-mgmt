// Multi-code support: a client has MANY labeled codes.
//
// The load-bearing assertions here are the security ones — ciphertext must
// leave the database by exactly one audited route — and the migration, which
// copies existing ciphertext rather than re-encrypting it.
import { it, expect, describe, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs'; import os from 'os'; import path from 'path'; import crypto from 'crypto';

const D = fs.mkdtempSync(path.join(os.tmpdir(), 'codes-'));
process.env.CITYWIDE_DB_DIR = D; delete process.env.DB_PATH;
process.env.JWT_SECRET = 't';
process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
process.env.SEED_PASSWORD = 'demo1234';

let app: any; let token = ''; let plainToken = ''; let db: DatabaseSync;
const auth = (r: any) => r.set('Authorization', `Bearer ${token}`);
const asPlain = (r: any) => r.set('Authorization', `Bearer ${plainToken}`);
const obj = (r: any) => Object.assign({}, r);

const client = (name: string, bc: string, extra: Record<string, any> = {}) => {
  const o = { ic_company_name: name, record_type: 'customer', bc_client_number: bc, ...extra };
  const cols = Object.keys(o);
  return Number(db.prepare(
    `INSERT INTO accounts (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`
  ).run(...cols.map((c) => (o as any)[c])).lastInsertRowid);
};

beforeAll(async () => {
  app = (await import('../src/index')).default;
  (await import('../src/lib/autoSeed')).autoSeedIfEmpty();
  const l = await request(app).post('/api/auth/login')
    .send({ email: 'cara@citywideboston.com', password: 'demo1234' });
  token = l.body.token;
  db = new DatabaseSync(path.join(D, 'citywide.db'));

  // A manager WITHOUT can_delete, to prove the gate.
  const bcrypt = (await import('bcryptjs')).default;
  db.prepare('INSERT INTO managers (name, email, password_hash, role, can_delete) VALUES (?,?,?,?,0)')
    .run('Plain Manager', 'plain@cw.test', bcrypt.hashSync('plain1234', 10), 'manager');
  const p = await request(app).post('/api/auth/login')
    .send({ email: 'plain@cw.test', password: 'plain1234' });
  plainToken = p.body.token;
});

beforeEach(() => {
  db.exec('DELETE FROM access_codes');
  db.exec('DELETE FROM access_codes');
  db.exec('DELETE FROM key_assignments; DELETE FROM accounts');
  db.exec("DELETE FROM audit_log");
});

const add = (accountId: number, body: Record<string, any>) =>
  auth(request(app).post('/api/access-codes')).send({ account_id: accountId, ...body });

describe('§1 SCHEMA + MIGRATION', () => {
  it('the table exists with the specified columns', () => {
    const cols = (db.prepare('PRAGMA table_info(access_codes)').all() as any[]).map((c) => obj(c).name);
    for (const c of [
      'id', 'account_id', 'code_type', 'custom_label', 'code_encrypted', 'code_iv',
      'notes', 'created_by', 'created_at', 'updated_by', 'updated_at', 'is_test', 'archived',
    ]) expect(cols, `missing ${c}`).toContain(c);
  });

  it('migrates door and alarm codes, copying the ciphertext verbatim', async () => {
    const { encrypt } = await import('../src/lib/crypto');
    const { migrateAccountCodesToAccessCodes } = await import('../src/lib/accessCodeMigration');

    const door = encrypt('1234');
    const alarm = encrypt('9999');
    const id = client('MIGRATION CLIENT', '01014200500');
    db.prepare(
      'UPDATE accounts SET door_code_encrypted=?, door_code_iv=?, alarm_code_encrypted=?, alarm_code_iv=? WHERE id=?'
    ).run(door.encrypted, door.iv, alarm.encrypted, alarm.iv, id);

    // Clear the guard so the migration runs against this fixture.
    db.prepare("DELETE FROM settings WHERE key = 'access_codes.migrated_from_accounts_at'").run();
    const r = migrateAccountCodesToAccessCodes('Test');
    expect(r.applied).toBe(true);
    expect(r.door).toBe(1);
    expect(r.alarm).toBe(1);
    expect(r.total).toBe(2);

    const rows = (db.prepare('SELECT * FROM access_codes WHERE account_id = ? ORDER BY code_type').all(id) as any[])
      .map(obj);
    expect(rows.map((x) => x.code_type)).toEqual(['alarm', 'front_door']);

    // VERBATIM: byte-for-byte the same ciphertext and iv, not a re-encryption.
    const migratedDoor = rows.find((x) => x.code_type === 'front_door')!;
    expect(migratedDoor.code_encrypted).toBe(door.encrypted);
    expect(migratedDoor.code_iv).toBe(door.iv);

    // …and it still reveals the ORIGINAL value.
    const rev = await auth(request(app).post(`/api/access-codes/${migratedDoor.id}/reveal`));
    expect(rev.status).toBe(200);
    expect(rev.body.code).toBe('1234');

    const migratedAlarm = rows.find((x) => x.code_type === 'alarm')!;
    const rev2 = await auth(request(app).post(`/api/access-codes/${migratedAlarm.id}/reveal`));
    expect(rev2.body.code).toBe('9999');
  });

  it('runs once — a second pass does not duplicate rows', async () => {
    const { encrypt } = await import('../src/lib/crypto');
    const { migrateAccountCodesToAccessCodes } = await import('../src/lib/accessCodeMigration');
    const e = encrypt('5555');
    const id = client('ONCE CLIENT', '01014200501');
    db.prepare('UPDATE accounts SET door_code_encrypted=?, door_code_iv=? WHERE id=?').run(e.encrypted, e.iv, id);

    db.prepare("DELETE FROM settings WHERE key = 'access_codes.migrated_from_accounts_at'").run();
    expect(migrateAccountCodesToAccessCodes('Test').total).toBe(1);
    const second = migrateAccountCodesToAccessCodes('Test');
    expect(second.applied).toBe(false);
    expect(second.reason).toBe('already applied');
    expect(obj(db.prepare('SELECT COUNT(*) c FROM access_codes WHERE account_id=?').get(id) as any).c).toBe(1);
  });

  it('skips ciphertext with no IV rather than creating an unreadable row', async () => {
    const { migrateAccountCodesToAccessCodes } = await import('../src/lib/accessCodeMigration');
    const id = client('BROKEN CLIENT', '01014200502');
    db.prepare('UPDATE accounts SET door_code_encrypted=?, door_code_iv=NULL WHERE id=?').run('deadbeef', id);
    db.prepare("DELETE FROM settings WHERE key = 'access_codes.migrated_from_accounts_at'").run();
    const r = migrateAccountCodesToAccessCodes('Test');
    expect(r.incomplete).toBe(1);
    expect(r.total).toBe(0);
    expect(obj(db.prepare('SELECT COUNT(*) c FROM access_codes WHERE account_id=?').get(id) as any).c).toBe(0);
  });

  it('leaves the original accounts columns in place', async () => {
    const { encrypt } = await import('../src/lib/crypto');
    const { migrateAccountCodesToAccessCodes } = await import('../src/lib/accessCodeMigration');
    const e = encrypt('7777');
    const id = client('KEEP CLIENT', '01014200503');
    db.prepare('UPDATE accounts SET door_code_encrypted=?, door_code_iv=? WHERE id=?').run(e.encrypted, e.iv, id);
    db.prepare("DELETE FROM settings WHERE key = 'access_codes.migrated_from_accounts_at'").run();
    migrateAccountCodesToAccessCodes('Test');
    const a = obj(db.prepare('SELECT door_code_encrypted FROM accounts WHERE id=?').get(id) as any);
    expect(a.door_code_encrypted).toBe(e.encrypted);
  });
});

describe('§4 SECURITY — ciphertext leaves by exactly one route', () => {
  let codeId = 0;
  beforeEach(async () => {
    const id = client('SECURE SITE', '01014200600');
    const r = await add(id, { code_type: 'front_door', code: 'SECRET-1234' });
    codeId = r.body.code.id;
  });

  it('the list response carries no ciphertext, iv or plaintext', async () => {
    const res = await auth(request(app).get('/api/access-codes'));
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('SECRET-1234');
    expect(body).not.toMatch(/code_encrypted/);
    expect(body).not.toMatch(/code_iv/);
    // The stored ciphertext string itself must not appear either.
    const stored = obj(db.prepare('SELECT code_encrypted FROM access_codes WHERE id=?').get(codeId) as any);
    expect(body).not.toContain(stored.code_encrypted);
  });

  it('neither does the per-client list, nor a create or edit response', async () => {
    const stored = obj(db.prepare('SELECT code_encrypted FROM access_codes WHERE id=?').get(codeId) as any);
    const byClient = await auth(request(app).get('/api/access-codes?account_id=' +
      obj(db.prepare('SELECT account_id a FROM access_codes WHERE id=?').get(codeId) as any).a));
    const edited = await auth(request(app).patch(`/api/access-codes/${codeId}`)).send({ notes: 'x' });
    for (const res of [byClient, edited]) {
      const body = JSON.stringify(res.body);
      expect(body).not.toContain('SECRET-1234');
      expect(body).not.toContain(stored.code_encrypted);
      expect(body).not.toMatch(/code_encrypted|code_iv/);
    }
  });

  it('reveal returns the plaintext and audit-logs WHO read WHICH code', async () => {
    const res = await auth(request(app).post(`/api/access-codes/${codeId}/reveal`));
    expect(res.status).toBe(200);
    expect(res.body.code).toBe('SECRET-1234');

    const log = obj(db.prepare(
      "SELECT * FROM audit_log WHERE action='access_code_revealed' ORDER BY id DESC LIMIT 1"
    ).get() as any);
    expect(log.manager).toBe('Cara Angeloni');
    expect(log.account_name).toBe('SECURE SITE');
    const meta = JSON.parse(log.metadata);
    expect(meta.access_code_id).toBe(codeId);
    expect(meta.code_type).toBe('front_door');
    // The code itself must never be written to the audit trail.
    expect(log.metadata).not.toContain('SECRET-1234');
  });

  it('the audit trail never records a code value on add or edit either', async () => {
    const id = client('AUDIT SITE', '01014200601');
    await add(id, { code_type: 'gate', code: 'GATE-9876', notes: 'side entrance' });
    const rows = (db.prepare('SELECT metadata FROM audit_log').all() as any[]).map(obj);
    for (const r of rows) expect(r.metadata ?? '').not.toContain('GATE-9876');
  });

  it('a code that cannot be decrypted says so instead of returning garbage', async () => {
    db.prepare("UPDATE access_codes SET code_encrypted='00'||code_encrypted WHERE id=?").run(codeId);
    const res = await auth(request(app).post(`/api/access-codes/${codeId}/reveal`));
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('DECRYPT_FAILED');
  });
});

describe('§3 + §4 PERMISSIONS', () => {
  let siteA = 0; let siteB = 0; let codeId = 0;
  beforeEach(async () => {
    siteA = client('GATED SITE A', '01014200700');
    siteB = client('GATED SITE B', '01014200701');
    const r = await add(siteA, { code_type: 'alarm', code: '0000' });
    codeId = r.body.code.id;
  });

  it('a manager without can_delete CAN list and reveal', async () => {
    expect((await asPlain(request(app).get('/api/access-codes'))).status).toBe(200);
    const rev = await asPlain(request(app).post(`/api/access-codes/${codeId}/reveal`));
    expect(rev.status).toBe(200);
    expect(rev.body.code).toBe('0000');
  });

  it('…but CANNOT add, edit, move, archive or restore', async () => {
    const calls = [
      asPlain(request(app).post('/api/access-codes')).send({ account_id: siteA, code_type: 'gate', code: '1' }),
      asPlain(request(app).patch(`/api/access-codes/${codeId}`)).send({ notes: 'nope' }),
      asPlain(request(app).post(`/api/access-codes/${codeId}/move`)).send({ account_id: siteB }),
      asPlain(request(app).post(`/api/access-codes/${codeId}/archive`)),
      asPlain(request(app).post(`/api/access-codes/${codeId}/restore`)),
    ];
    for (const c of calls) {
      const res = await c;
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('PERMISSION_DENIED');
    }
    // …and nothing changed.
    const row = obj(db.prepare('SELECT * FROM access_codes WHERE id=?').get(codeId) as any);
    expect(row.account_id).toBe(siteA);
    expect(row.archived).toBe(0);
    expect(obj(db.prepare('SELECT COUNT(*) c FROM access_codes').get() as any).c).toBe(1);
  });
});

describe('§3 ADD / EDIT / MOVE / ARCHIVE', () => {
  it("type 'other' requires a label, and displays it", async () => {
    const id = client('OTHER SITE', '01014200800');
    const bad = await add(id, { code_type: 'other', code: '4242' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/label is required/i);

    const ok = await add(id, { code_type: 'other', custom_label: 'Roof Hatch', code: '4242' });
    expect(ok.status).toBe(201);
    expect(ok.body.code).toMatchObject({
      code_type: 'other', custom_label: 'Roof Hatch', label: 'Roof Hatch',
    });
    const rev = await auth(request(app).post(`/api/access-codes/${ok.body.code.id}/reveal`));
    expect(rev.body.code).toBe('4242');
  });

  it('a known type takes its own name as the label', async () => {
    const id = client('LABEL SITE', '01014200801');
    const r = await add(id, { code_type: 'supply_closet', code: '1' });
    expect(r.body.code.label).toBe('Supply Closet');
    expect(r.body.code.custom_label).toBeNull();
  });

  it('rejects an unknown type', async () => {
    const id = client('BAD TYPE', '01014200802');
    const r = await add(id, { code_type: 'skylight', code: '1' });
    expect(r.status).toBe(400);
  });

  it('editing without a code leaves the secret alone', async () => {
    const id = client('EDIT SITE', '01014200803');
    const created = await add(id, { code_type: 'gate', code: 'ORIGINAL' });
    const cid = created.body.code.id;
    const res = await auth(request(app).patch(`/api/access-codes/${cid}`)).send({ notes: 'updated note' });
    expect(res.status).toBe(200);
    expect(res.body.changed).toContain('notes');
    expect(res.body.changed).not.toContain('code');
    const rev = await auth(request(app).post(`/api/access-codes/${cid}/reveal`));
    expect(rev.body.code).toBe('ORIGINAL');
  });

  it('editing WITH a code replaces it', async () => {
    const id = client('ROTATE SITE', '01014200804');
    const created = await add(id, { code_type: 'gate', code: 'OLD' });
    const cid = created.body.code.id;
    const res = await auth(request(app).patch(`/api/access-codes/${cid}`)).send({ code: 'NEW' });
    expect(res.body.changed).toContain('code');
    const rev = await auth(request(app).post(`/api/access-codes/${cid}/reveal`));
    expect(rev.body.code).toBe('NEW');
  });

  it('moving to another client writes code_reassigned naming both', async () => {
    const from = client('ZZ TEST MOVE FROM', '01014200900', { is_test: 1 });
    const to = client('ZZ TEST MOVE TO', '01014200901', { is_test: 1 });
    const created = await add(from, { code_type: 'back_door', code: 'MOVE-ME' });
    const cid = created.body.code.id;

    const res = await auth(request(app).post(`/api/access-codes/${cid}/move`)).send({ account_id: to });
    expect(res.status).toBe(200);
    expect(res.body.from).toBe('ZZ TEST MOVE FROM');
    expect(res.body.to).toBe('ZZ TEST MOVE TO');

    const log = obj(db.prepare(
      "SELECT * FROM audit_log WHERE action='code_reassigned' ORDER BY id DESC LIMIT 1"
    ).get() as any);
    const meta = JSON.parse(log.metadata);
    expect(meta).toMatchObject({
      access_code_id: cid, code_type: 'back_door',
      from_account_id: from, from_client: 'ZZ TEST MOVE FROM',
      to_account_id: to, to_client: 'ZZ TEST MOVE TO',
    });

    // It now lists under the NEW client, and still reveals the same value.
    const list = await auth(request(app).get('/api/access-codes?include_test=1'));
    const row = list.body.codes.find((c: any) => c.id === cid);
    expect(row.client).toBe('ZZ TEST MOVE TO');
    expect(row.account_id).toBe(to);
    const rev = await auth(request(app).post(`/api/access-codes/${cid}/reveal`));
    expect(rev.body.code).toBe('MOVE-ME');
  });

  it('refuses a move to the client it is already on', async () => {
    const id = client('SAME SITE', '01014200902');
    const created = await add(id, { code_type: 'gate', code: '1' });
    const res = await auth(request(app).post(`/api/access-codes/${created.body.code.id}/move`))
      .send({ account_id: id });
    expect(res.status).toBe(400);
  });

  it('delete ARCHIVES — the row and its history survive', async () => {
    const id = client('ARCHIVE SITE', '01014200903');
    const created = await add(id, { code_type: 'lockbox', code: 'KEEP' });
    const cid = created.body.code.id;

    expect((await auth(request(app).post(`/api/access-codes/${cid}/archive`))).status).toBe(200);
    // Gone from the default list…
    const list = await auth(request(app).get('/api/access-codes'));
    expect(list.body.codes.find((c: any) => c.id === cid)).toBeUndefined();
    // …present on the archived one, and the row still exists.
    const arch = await auth(request(app).get('/api/access-codes?archived=1'));
    expect(arch.body.codes.find((c: any) => c.id === cid)).toBeTruthy();
    expect(obj(db.prepare('SELECT COUNT(*) c FROM access_codes WHERE id=?').get(cid) as any).c).toBe(1);

    expect((await auth(request(app).post(`/api/access-codes/${cid}/restore`))).status).toBe(200);
    const back = await auth(request(app).get('/api/access-codes'));
    expect(back.body.codes.find((c: any) => c.id === cid)).toBeTruthy();
  });
});

describe('§2 THE TAB FEED', () => {
  beforeEach(async () => {
    const a = client('ALPHA TOWER', '01014201000');
    const b = client('BETA PLAZA', '01014201001');
    await add(a, { code_type: 'front_door', code: '1' });
    await add(a, { code_type: 'alarm', code: '2' });
    await add(b, { code_type: 'gate', code: '3' });
  });

  it('lists every code with its client and BC number', async () => {
    const res = await auth(request(app).get('/api/access-codes'));
    expect(res.body.codes).toHaveLength(3);
    const alpha = res.body.codes.filter((c: any) => c.client === 'ALPHA TOWER');
    expect(alpha).toHaveLength(2);
    expect(alpha[0].bc_client_number).toBe('01014201000');
  });

  it('searches by client name, BC number and code type', async () => {
    const byName = await auth(request(app).get('/api/access-codes?search=BETA'));
    expect(byName.body.codes).toHaveLength(1);
    const byBc = await auth(request(app).get('/api/access-codes?search=01014201000'));
    expect(byBc.body.codes).toHaveLength(2);
    const byType = await auth(request(app).get('/api/access-codes?search=alarm'));
    expect(byType.body.codes).toHaveLength(1);
  });

  it('filters by code_type and reports chip counts', async () => {
    const res = await auth(request(app).get('/api/access-codes?code_type=alarm'));
    expect(res.body.codes).toHaveLength(1);
    // Chip counts span the unfiltered-by-type set, so a chip says what it shows.
    expect(res.body.counts.by_type).toMatchObject({ front_door: 1, alarm: 1, gate: 1 });
    expect(res.body.counts.total).toBe(3);
  });

  it('excludes fixture codes unless asked', async () => {
    const t = client('ZZ TEST SITE', '01014201002', { is_test: 1 });
    await add(t, { code_type: 'gate', code: 'x' });
    expect((await auth(request(app).get('/api/access-codes'))).body.codes).toHaveLength(3);
    expect((await auth(request(app).get('/api/access-codes?include_test=1'))).body.codes).toHaveLength(4);
  });
});

describe('PURGING A CLIENT TAKES ITS CODES WITH IT', () => {
  it('a hard purge deletes the codes and records how many', async () => {
    const id = client('PURGE SITE', '01014201100');
    await add(id, { code_type: 'front_door', code: 'A' });
    await add(id, { code_type: 'gate', code: 'B' });
    expect(obj(db.prepare('SELECT COUNT(*) c FROM access_codes WHERE account_id=?').get(id) as any).c).toBe(2);

    // Archive first — purge refuses a live record.
    await auth(request(app).post(`/api/accounts/${id}/archive`));
    const res = await auth(request(app).delete(`/api/accounts/${id}`)).send({ confirm: 'DELETE' });
    expect(res.status).toBe(200);

    // The foreign key would have blocked this before the route cleared codes.
    expect(obj(db.prepare('SELECT COUNT(*) c FROM accounts WHERE id=?').get(id) as any).c).toBe(0);
    expect(obj(db.prepare('SELECT COUNT(*) c FROM access_codes WHERE account_id=?').get(id) as any).c).toBe(0);

    const log = obj(db.prepare(
      "SELECT metadata FROM audit_log WHERE action='account_purged' ORDER BY id DESC LIMIT 1"
    ).get() as any);
    expect(JSON.parse(log.metadata).access_codes_deleted).toBe(2);
  });
});

describe('EXPORTS CARRY NO CODE VALUES', () => {
  it('the registry export reports only WHETHER a code exists', async () => {
    const id = client('EXPORT SITE', '01014201200');
    await add(id, { code_type: 'front_door', code: 'EXPORT-SECRET' });
    const res = await auth(request(app).get('/api/exports/registry?format=csv&scope=all'))
      .buffer(true)
      .parse((r: any, cb: any) => {
        let d = ''; r.on('data', (c: any) => { d += c; }); r.on('end', () => cb(null, d));
      });
    if (res.status === 200) {
      const body = typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
      expect(body).not.toContain('EXPORT-SECRET');
      const stored = obj(db.prepare(
        "SELECT code_encrypted e FROM access_codes WHERE account_id=?"
      ).get(id) as any);
      expect(body).not.toContain(stored.e);
    }
  });
});
