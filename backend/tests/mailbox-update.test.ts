import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

// ── Cara's mailbox move ──────────────────────────────────────────────────────
// Two addresses changed and one deliberately did NOT. The value of this file is
// mostly in the third: her login must survive a deploy untouched, because
// changing it changes how she signs in.

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'citywide-mailbox-'));
process.env.CITYWIDE_DB_DIR = TEST_DIR;
delete process.env.DB_PATH;
process.env.JWT_SECRET = 'test-secret';
process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
process.env.SEED_PASSWORD = 'demo1234';
delete process.env.SMTP_USER;
delete process.env.SMTP_PASS;
delete process.env.CARA_EMAIL;

const DB_FILE = path.join(TEST_DIR, 'citywide.db');
const OLD = 'cara@citywideboston.com';
const NEW = 'cangeloni@gocitywide.com';

let app: Express;
let token: string;
let db: DatabaseSync;
let autoSeed: typeof import('../src/lib/autoSeed');
let settings: typeof import('../src/lib/settings');
let mailbox: typeof import('../src/lib/mailboxUpdates');

const auth = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);
const obj = (r: any) => (r ? Object.assign({}, r) : null);
const one = (sql: string, ...p: any[]) => obj(db.prepare(sql).get(...p));

beforeAll(async () => {
  app = (await import('../src/index')).default;
  autoSeed = await import('../src/lib/autoSeed');
  settings = await import('../src/lib/settings');
  mailbox = await import('../src/lib/mailboxUpdates');
  autoSeed.autoSeedIfEmpty();
  // She still signs in with the OLD address — that is the point.
  const login = await request(app).post('/api/auth/login').send({ email: OLD, password: 'demo1234' });
  token = login.body.token;
  db = new DatabaseSync(DB_FILE);
});

/** Put the database back the way it looked before the move. */
const rewind = () => {
  db.exec("DELETE FROM settings WHERE key IN ('mailbox_update_cangeloni_v1', 'custody_notification_email')");
  db.exec("DELETE FROM staff_managers WHERE name = 'Cara Angeloni'");
  db.prepare(
    "INSERT INTO staff_managers (name, manager_type, role_category, email, active) VALUES ('Cara Angeloni','both','manager',?,1)"
  ).run(OLD);
};

beforeEach(() => { rewind(); });

describe('§1 WHAT MOVED', () => {
  it('changes her roster address', () => {
    const r = mailbox.applyMailboxUpdates('test');
    expect(r.applied).toBe(true);
    expect(r.staff_rows_updated).toBe(1);
    expect(one("SELECT email FROM staff_managers WHERE name='Cara Angeloni'").email).toBe(NEW);
  });

  it('changes the custody notification recipient', () => {
    mailbox.applyMailboxUpdates('test');
    expect(settings.getSetting(settings.CUSTODY_NOTIFY_KEY)).toBe(NEW);
    // …and that is the address the mailer will actually copy.
    expect(settings.custodyNotifyRecipients()).toEqual([NEW]);
  });

  it('records the BEFORE values in the audit trail', () => {
    mailbox.applyMailboxUpdates('test');
    const meta = JSON.parse(one(
      "SELECT metadata FROM audit_log WHERE action='mailbox_updated' ORDER BY id DESC LIMIT 1"
    ).metadata);
    // "What was it previously" is the first question when mail stops arriving.
    expect(meta.staff_matched[0].was).toBe(OLD);
    expect(meta.new_email).toBe(NEW);
    expect(meta.login_unchanged).toBe(OLD);
  });
});

describe('§2 WHAT DID NOT MOVE — the login', () => {
  it('leaves the managers row exactly as it was', async () => {
    const before = one('SELECT * FROM managers WHERE email = ?', OLD);
    expect(before).toBeTruthy();
    mailbox.applyMailboxUpdates('test');
    expect(one('SELECT * FROM managers WHERE email = ?', OLD)).toEqual(before);
    expect(one('SELECT id FROM managers WHERE email = ?', NEW)).toBeNull();
  });

  it('she can still sign in with the old address, and not with the new one', async () => {
    mailbox.applyMailboxUpdates('test');
    const ok = await request(app).post('/api/auth/login').send({ email: OLD, password: 'demo1234' });
    expect(ok.status).toBe(200);
    const no = await request(app).post('/api/auth/login').send({ email: NEW, password: 'demo1234' });
    expect(no.status).toBe(401);
  });

  it('a whole boot leaves the login alone', async () => {
    autoSeed.autoSeedIfEmpty();
    expect(one('SELECT email FROM managers WHERE name = ?', 'Cara Angeloni').email).toBe(OLD);
  });
});

describe('§3 IT RUNS ONCE', () => {
  it('a second call is a no-op', () => {
    expect(mailbox.applyMailboxUpdates('test').applied).toBe(true);
    const again = mailbox.applyMailboxUpdates('test');
    expect(again.applied).toBe(false);
    expect(again.reason).toBe('already applied');
  });

  it('NEVER overwrites an address corrected afterwards', () => {
    mailbox.applyMailboxUpdates('test');
    // Somebody fixes a typo, or hands the mailbox to a replacement.
    db.prepare("UPDATE staff_managers SET email = 'someone.else@gocitywide.com' WHERE name = 'Cara Angeloni'").run();
    settings.setSetting(settings.CUSTODY_NOTIFY_KEY, 'ops@gocitywide.com', 'Cara');

    // Every later deploy re-runs the seed. It must not undo that.
    autoSeed.autoSeedIfEmpty();

    expect(one("SELECT email FROM staff_managers WHERE name='Cara Angeloni'").email)
      .toBe('someone.else@gocitywide.com');
    expect(settings.getSetting(settings.CUSTODY_NOTIFY_KEY)).toBe('ops@gocitywide.com');
  });

  it('reports honestly when her roster row is named something else', () => {
    db.exec("DELETE FROM staff_managers WHERE name = 'Cara Angeloni'");
    db.prepare(
      "INSERT INTO staff_managers (name, manager_type, role_category, email, active) VALUES ('Cara A. Angeloni','both','manager',?,1)"
    ).run(OLD);
    const r = mailbox.applyMailboxUpdates('test');
    // Silence here would be the dangerous outcome: the notification recipient
    // moves, her holder-side address does not, and nothing says so.
    expect(r.staff_matched).toEqual([]);
    expect(r.staff_rows_updated).toBe(0);
    expect(r.notify_after).toBe(NEW);
    db.exec("DELETE FROM staff_managers WHERE name = 'Cara A. Angeloni'");
  });
});

describe('§4 MAIL ACTUALLY GOES THERE', () => {
  it('custody notifications resolve to the new address', () => {
    mailbox.applyMailboxUpdates('test');
    expect(settings.custodyNotifyDisplay()).toBe(NEW);
  });

  it('the stored setting beats every env fallback', () => {
    mailbox.applyMailboxUpdates('test');
    // Even with the old address still sitting in the environment.
    process.env.CARA_EMAIL = OLD;
    process.env.SMTP_USER = OLD;
    try {
      expect(settings.custodyNotifyRecipients()).toEqual([NEW]);
    } finally {
      delete process.env.CARA_EMAIL;
      delete process.env.SMTP_USER;
    }
  });

  it('a key form for Cara carries the roster address, not the login one', async () => {
    mailbox.applyMailboxUpdates('test');
    const { holderProfile } = await import('../src/lib/keyForm');
    expect(holderProfile('Cara Angeloni', 'employee').email).toBe(NEW);
  });
});

describe('§5 /api/staff/me — the roster address wins for "Myself"', () => {
  it('returns the roster address, and names both', async () => {
    mailbox.applyMailboxUpdates('test');
    const res = await auth(request(app).get('/api/staff/me'));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      on_roster: true,
      name: 'Cara Angeloni',
      email: NEW,           // what a "Myself" check-out should use
      roster_email: NEW,
      login_email: OLD,     // still how she signs in
    });
  });

  it('falls back to the login address when the roster has none', async () => {
    db.prepare("UPDATE staff_managers SET email = NULL WHERE name = 'Cara Angeloni'").run();
    const res = await auth(request(app).get('/api/staff/me'));
    // A blank roster row must never be worse than no roster row at all.
    expect(res.body).toMatchObject({ on_roster: true, email: OLD, roster_email: null });
  });

  it('says so when the signed-in person is not on the roster', async () => {
    db.exec("DELETE FROM staff_managers WHERE name = 'Cara Angeloni'");
    const res = await auth(request(app).get('/api/staff/me'));
    expect(res.body).toMatchObject({ on_roster: false, email: OLD });
  });

  it('prefers an explicit login link over a name match', async () => {
    const mgr = one('SELECT id FROM managers WHERE email = ?', OLD);
    db.prepare(
      "INSERT INTO staff_managers (name, manager_type, role_category, email, active, login_manager_id) " +
      "VALUES ('Different Spelling','both','manager','linked@gocitywide.com',1,?)"
    ).run(mgr.id);
    const res = await auth(request(app).get('/api/staff/me'));
    // An explicit association is a stronger statement than a matching name.
    expect(res.body.email).toBe('linked@gocitywide.com');
    db.exec("DELETE FROM staff_managers WHERE name = 'Different Spelling'");
  });

  it('is behind auth', async () => {
    expect((await request(app).get('/api/staff/me')).status).toBe(401);
  });
});

describe('§6 /api/_diag REPORTS THE DEPLOYED STATE', () => {
  it('shows both addresses and whether the update ran', async () => {
    mailbox.applyMailboxUpdates('test');
    const res = await auth(request(app).get('/api/_diag'));
    expect(res.status).toBe(200);
    expect(res.body.mailbox).toMatchObject({
      custody_notify_setting: NEW,
      login_email_still: OLD,
    });
    expect(res.body.mailbox.applied_at).toBeTruthy();
    expect(res.body.mailbox.roster[0].email).toBe(NEW);
  });
});
