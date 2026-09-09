import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

// ── The mail path ────────────────────────────────────────────────────────────
// Office 365 on 587 fails in ways that all look like "it didn't send": implicit
// TLS on a STARTTLS port, a pinned legacy cipher list, a From address the
// tenant will not send as, a host set in the environment and ignored. Each of
// those is pinned here, because none of them is visible from the outside until
// a real send fails.

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'citywide-mailcfg-'));
process.env.CITYWIDE_DB_DIR = TEST_DIR;
delete process.env.DB_PATH;
process.env.JWT_SECRET = 'test-secret';
process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
process.env.SEED_PASSWORD = 'demo1234';
process.env.FRONTEND_URL = 'https://keys.example.test';

const DB_FILE = path.join(TEST_DIR, 'citywide.db');

// The transport is stubbed: nothing leaves the machine, but every option
// nodemailer would have been handed is captured for inspection.
const created: any[] = [];
const sent: any[] = [];
let sendBehaviour: (msg: any) => any = () => ({ messageId: '<abc@citywide>', response: '250 2.0.0 OK' });

vi.mock('nodemailer', () => ({
  default: {
    createTransport: (opts: any) => {
      created.push(opts);
      return { sendMail: async (msg: any) => { sent.push(msg); return sendBehaviour(msg); } };
    },
  },
}));

// Resend's path is HTTPS, not SMTP — stub fetch the same way the transport is
// stubbed, capturing every request so the body can be inspected.
const posted: { url: string; headers: any; body: any }[] = [];
let resendBehaviour: () => { status: number; body: any } =
  () => ({ status: 200, body: { id: '9f2b1c44-0000-4000-8000-abcdefabcdef' } });
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init: any) => {
  const u = String(url);
  if (!u.startsWith('https://api.resend.com')) return realFetch(url, init);
  posted.push({ url: u, headers: init?.headers ?? {}, body: JSON.parse(init?.body ?? '{}') });
  const r = resendBehaviour();
  return new Response(JSON.stringify(r.body), {
    status: r.status,
    headers: { 'Content-Type': 'application/json' },
  });
}) as any;

let app: Express;
let token: string;
let db: DatabaseSync;
let mailer: typeof import('../src/lib/mailer');

const auth = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);
const obj = (r: any) => (r ? Object.assign({}, r) : null);

const ENV_KEYS = [
  'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS',
  'MAIL_FROM_ADDRESS', 'MAIL_FROM_NAME', 'MAIL_REPLY_TO',
  'MAIL_PROVIDER', 'RESEND_API_KEY',
];
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  app = (await import('../src/index')).default;
  mailer = await import('../src/lib/mailer');
  (await import('../src/lib/autoSeed')).autoSeedIfEmpty();
  const login = await request(app).post('/api/auth/login')
    .send({ email: 'cara@citywideboston.com', password: 'demo1234' });
  token = login.body.token;
  db = new DatabaseSync(DB_FILE);
});

beforeEach(() => {
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  created.length = 0;
  sent.length = 0;
  posted.length = 0;
  resendBehaviour = () => ({ status: 200, body: { id: '9f2b1c44-0000-4000-8000-abcdefabcdef' } });
  sendBehaviour = () => ({ messageId: '<abc@citywide>', response: '250 2.0.0 OK' });
  db.exec('DELETE FROM audit_log');
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
});

// ══════════════════════════ §1 TRANSPORT ════════════════════════════════════
describe('SMTP transport construction', () => {
  it('builds Office 365 :587 as STARTTLS — secure:false WITH requireTLS:true', () => {
    process.env.SMTP_USER = 'keys@citywideboston.com';
    process.env.SMTP_PASS = 'secret';
    mailer.createTransport();

    expect(created[0]).toMatchObject({
      host: 'smtp.office365.com',
      port: 587,
      // secure:false alone would allow a silent plaintext session; requireTLS
      // is what actually demands the STARTTLS upgrade before AUTH.
      secure: false,
      requireTLS: true,
    });
  });

  it('does NOT pin the legacy SSLv3 cipher list', () => {
    process.env.SMTP_USER = 'keys@citywideboston.com';
    process.env.SMTP_PASS = 'secret';
    mailer.createTransport();
    // This string is the single most copied cause of an Office 365 handshake
    // failure on current Node — it narrows the cipher list to something the
    // server will not negotiate, and it fails before AUTH is ever reached.
    expect(created[0].tls?.ciphers).toBeUndefined();
    expect(created[0].tls).toMatchObject({ minVersion: 'TLSv1.2' });
  });

  it('reads SMTP_HOST and SMTP_PORT from the environment', () => {
    process.env.SMTP_HOST = 'smtp.example.test';
    process.env.SMTP_PORT = '2525';
    process.env.SMTP_USER = 'u'; process.env.SMTP_PASS = 'p';
    mailer.createTransport();
    expect(created[0]).toMatchObject({ host: 'smtp.example.test', port: 2525, secure: false, requireTLS: true });
    expect(mailer.smtpConfig()).toMatchObject({ hostSource: 'env', portSource: 'env' });
  });

  it('uses implicit TLS on 465, and only there', () => {
    process.env.SMTP_PORT = '465';
    process.env.SMTP_USER = 'u'; process.env.SMTP_PASS = 'p';
    expect(mailer.smtpConfig()).toMatchObject({ port: 465, secure: true, requireTLS: false });

    process.env.SMTP_PORT = '587';
    expect(mailer.smtpConfig()).toMatchObject({ port: 587, secure: false, requireTLS: true });
  });

  it('falls back to office365:587 when the environment says nothing', () => {
    expect(mailer.smtpConfig()).toMatchObject({
      host: 'smtp.office365.com', port: 587, secure: false, requireTLS: true,
      hostSource: 'default', portSource: 'default',
    });
  });

  it('ignores a nonsense port rather than passing it through', () => {
    process.env.SMTP_PORT = 'not-a-port';
    expect(mailer.smtpConfig()).toMatchObject({ port: 587, portSource: 'default' });
  });
});

// ══════════════════════════ §2 FROM ADDRESS ═════════════════════════════════
describe('From / Reply-To', () => {
  it('defaults the From address to the authenticated mailbox', () => {
    process.env.SMTP_USER = 'keys@citywideboston.com';
    expect(mailer.fromConfig()).toMatchObject({
      name: 'City Wide Key Management',
      address: 'keys@citywideboston.com',
      header: 'City Wide Key Management <keys@citywideboston.com>',
      replyTo: null,
      addressSource: 'SMTP_USER',
      nameSource: 'default',
      mismatch: false,
    });
  });

  it('honours MAIL_FROM_NAME / MAIL_FROM_ADDRESS / MAIL_REPLY_TO', () => {
    process.env.SMTP_USER = 'keys@citywideboston.com';
    process.env.MAIL_FROM_NAME = 'City Wide Boston Keys';
    process.env.MAIL_FROM_ADDRESS = 'keys@citywideboston.com';
    process.env.MAIL_REPLY_TO = 'cara@citywideboston.com';
    expect(mailer.fromHeader()).toBe('City Wide Boston Keys <keys@citywideboston.com>');
    expect(mailer.fromConfig().replyTo).toBe('cara@citywideboston.com');
  });

  it('flags a From address that is not the authenticated mailbox', () => {
    process.env.SMTP_USER = 'keys@citywideboston.com';
    process.env.MAIL_FROM_ADDRESS = 'noreply@somewhere-else.test';
    // Office 365 answers this with 5.7.60 SendAsDenied, so it is reported
    // rather than quietly sent and quietly rejected.
    expect(mailer.fromConfig().mismatch).toBe(true);
  });

  it('puts that From header on the actual message', async () => {
    process.env.SMTP_USER = 'keys@citywideboston.com';
    process.env.SMTP_PASS = 'secret';
    process.env.MAIL_REPLY_TO = 'cara@citywideboston.com';
    const mail = await import('../src/lib/custodyMail');
    const r = await mail.sendBranded('Subject', '<p>hi</p>', 'hi', ['someone@example.test']);
    expect(r.ok).toBe(true);
    expect(sent[0].from).toBe('City Wide Key Management <keys@citywideboston.com>');
    expect(sent[0].replyTo).toBe('cara@citywideboston.com');
  });
});

// ══════════════════════════ §3 CONFIG READOUT ═══════════════════════════════
describe('GET /api/settings/email', () => {
  it('reports the transport in words, not just booleans', async () => {
    process.env.SMTP_USER = 'keys@citywideboston.com';
    process.env.SMTP_PASS = 'secret';
    const res = await auth(request(app).get('/api/settings/email'));
    expect(res.status).toBe(200);
    expect(res.body.smtp).toMatchObject({
      host: 'smtp.office365.com', port: 587, secure: false, require_tls: true, configured: true,
    });
    expect(res.body.smtp.tls_mode).toMatch(/STARTTLS/);
    expect(res.body.from.header).toBe('City Wide Key Management <keys@citywideboston.com>');
    expect(res.body.warnings).toEqual([]);
  });

  it('never returns the password', async () => {
    process.env.SMTP_USER = 'keys@citywideboston.com';
    process.env.SMTP_PASS = 'super-secret-value';
    const res = await auth(request(app).get('/api/settings/email'));
    expect(JSON.stringify(res.body)).not.toContain('super-secret-value');
    expect(res.body.smtp.password_set).toBe(true);
  });

  it('names the misconfigurations instead of leaving them to a failed send', async () => {
    process.env.SMTP_USER = 'keys@citywideboston.com';
    process.env.SMTP_PASS = 'secret';
    process.env.MAIL_FROM_ADDRESS = 'noreply@elsewhere.test';
    const res = await auth(request(app).get('/api/settings/email'));
    expect(res.body.warnings.join(' ')).toMatch(/5\.7\.60|SendAsDenied/);

    delete process.env.SMTP_PASS;
    const res2 = await auth(request(app).get('/api/settings/email'));
    expect(res2.body.warnings.join(' ')).toMatch(/SMTP_PASS is not set/);
  });

  it('warns when the port and the TLS mode disagree', async () => {
    process.env.SMTP_USER = 'u'; process.env.SMTP_PASS = 'p';
    process.env.SMTP_PORT = '587';
    process.env.SMTP_SECURE = 'true';
    const res = await auth(request(app).get('/api/settings/email'));
    expect(res.body.warnings.join(' ')).toMatch(/587 is a STARTTLS port/);
  });
});

// ══════════════════════════ §3 TEST SEND ════════════════════════════════════
describe('POST /api/settings/email/test', () => {
  beforeEach(() => {
    process.env.SMTP_USER = 'keys@citywideboston.com';
    process.env.SMTP_PASS = 'secret';
  });

  it('is admin only', async () => {
    const bcrypt = (await import('bcryptjs')).default;
    db.prepare("INSERT OR IGNORE INTO managers (name, email, password_hash, role) VALUES ('Viewer','viewer@citywideboston.com',?, 'manager')")
      .run(bcrypt.hashSync('demo1234', 10));
    const login = await request(app).post('/api/auth/login')
      .send({ email: 'viewer@citywideboston.com', password: 'demo1234' });
    const res = await request(app).post('/api/settings/email/test')
      .set('Authorization', `Bearer ${login.body.token}`).send({});
    expect(res.status).toBe(403);
  });

  it('reports the message ID on acceptance and logs it', async () => {
    sendBehaviour = () => ({ messageId: '<msg-123@citywideboston.com>', response: '250 2.6.0 Queued' });
    const res = await auth(request(app).post('/api/settings/email/test')).send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, message_id: '<msg-123@citywideboston.com>' });
    expect(res.body.recipients.length).toBeGreaterThan(0);

    const log = obj(db.prepare("SELECT * FROM audit_log WHERE action='test_email_sent' ORDER BY id DESC LIMIT 1").get());
    expect(log).toBeTruthy();
    expect(JSON.parse(log.metadata).message_id).toBe('<msg-123@citywideboston.com>');
  });

  it('sends to an override address when one is given', async () => {
    const res = await auth(request(app).post('/api/settings/email/test'))
      .send({ to: 'someone.else@external.test' });
    expect(res.status).toBe(200);
    expect(res.body.recipients).toEqual(['someone.else@external.test']);
    expect(sent[0].to).toBe('someone.else@external.test');
  });

  it('rejects a malformed override rather than sending nowhere', async () => {
    const res = await auth(request(app).post('/api/settings/email/test')).send({ to: 'not-an-email' });
    expect(res.status).toBe(400);
    expect(sent).toHaveLength(0);
  });

  it('returns the WHOLE SMTP error, not a generic failure', async () => {
    // A realistic Office 365 send-as rejection: the meaning is in the pieces
    // that a bare `err.message` throws away.
    sendBehaviour = () => {
      const e: any = new Error('Invalid login: 550 5.7.60 SMTP; Client does not have permissions to send as this sender');
      e.code = 'EENVELOPE';
      e.responseCode = 550;
      e.command = 'MAIL FROM';
      e.response = '550 5.7.60 SMTP; Client does not have permissions to send as this sender';
      throw e;
    };
    const res = await auth(request(app).post('/api/settings/email/test')).send({});
    expect(res.status).toBe(502);
    expect(res.body.ok).toBe(false);
    // Every diagnostic fragment survives to the UI.
    expect(res.body.error).toMatch(/5\.7\.60/);
    expect(res.body.error).toMatch(/EENVELOPE/);
    expect(res.body.error).toMatch(/responseCode=550/);
    expect(res.body.error).toMatch(/command=MAIL FROM/);

    const log = obj(db.prepare("SELECT * FROM audit_log WHERE action='test_email_failed' ORDER BY id DESC LIMIT 1").get());
    expect(log).toBeTruthy();
    expect(JSON.parse(log.metadata).error).toMatch(/5\.7\.60/);
  });

  it('does not retry a diagnostic send three times', async () => {
    sendBehaviour = () => { throw new Error('nope'); };
    const res = await auth(request(app).post('/api/settings/email/test')).send({});
    expect(res.body.attempts).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it('says plainly when SMTP is not configured at all', async () => {
    delete process.env.SMTP_PASS;
    const res = await auth(request(app).post('/api/settings/email/test')).send({});
    expect(res.status).toBe(502);
    expect(res.body.skipped).toBe(true);
    expect(res.body.error).toMatch(/SMTP is not configured/);
  });

  it('surfaces the last test send on the config readout', async () => {
    await auth(request(app).post('/api/settings/email/test')).send({});
    const res = await auth(request(app).get('/api/settings/email'));
    expect(res.body.last_test).toMatchObject({ ok: true, by: 'Cara Angeloni' });
    expect(res.body.last_test.message_id).toBeTruthy();
  });
});

// ══════════════════════════ §4 FAILED FORMS ═════════════════════════════════
describe('Forms — failed-send filter and retry', () => {
  const seedForm = (holder: string) => {
    const r = db.prepare(`
      INSERT INTO key_form_docs
        (event_type, holder_name, holder_type, holder_email, scope_json,
         clients_covered, total_keys, status, generated_by)
      VALUES ('checkout', ?, 'employee', 'h@example.test', '{"lines":[]}', 0, 0, 'draft', 'Test')
    `).run(holder);
    const id = Number(r.lastInsertRowid);
    db.prepare('UPDATE key_form_docs SET form_no = ? WHERE id = ?').run(`KF-${String(id).padStart(5, '0')}`, id);
    return id;
  };

  beforeEach(() => {
    db.exec('DELETE FROM key_form_docs');
    process.env.SMTP_USER = 'keys@citywideboston.com';
    process.env.SMTP_PASS = 'secret';
  });

  it('a failed send is findable, even though the row status reads "unsigned"', async () => {
    const good = seedForm('Signed Person');
    const bad = seedForm('Failed Person');
    db.prepare("UPDATE key_form_docs SET status='sent' WHERE id=?").run(good);
    db.prepare("UPDATE key_form_docs SET status='unsigned', send_error='550 5.7.60 SendAsDenied' WHERE id=?").run(bad);

    const res = await auth(request(app).get('/api/key-forms?status=send_failed'));
    expect(res.body.forms.map((f: any) => f.id)).toEqual([bad]);
    // The count is unfiltered, so the chip shows the backlog from any view.
    expect(res.body.failed_count).toBe(1);

    const all = await auth(request(app).get('/api/key-forms'));
    expect(all.body.forms).toHaveLength(2);
    expect(all.body.failed_count).toBe(1);
  });

  it('retry-failed replays every failed form and clears the backlog on success', async () => {
    const a = seedForm('First Failed');
    const b = seedForm('Second Failed');
    for (const id of [a, b]) {
      db.prepare("UPDATE key_form_docs SET status='unsigned', send_error='transient' WHERE id=?").run(id);
    }
    expect(obj(db.prepare('SELECT COUNT(*) AS c FROM key_form_docs WHERE send_error IS NOT NULL').get()).c).toBe(2);

    const res = await auth(request(app).post('/api/key-forms/retry-failed')).send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ queued: 2, attempted: 2, sent: 2, failed: 0, remaining: 0, stopped_early: false });
    expect(obj(db.prepare('SELECT COUNT(*) AS c FROM key_form_docs WHERE send_error IS NOT NULL').get()).c).toBe(0);
  });

  it('a still-failing retry keeps the form in the backlog and reports why', async () => {
    const id = seedForm('Stubborn');
    db.prepare("UPDATE key_form_docs SET status='unsigned', send_error='old error' WHERE id=?").run(id);
    sendBehaviour = () => { const e: any = new Error('still broken'); e.responseCode = 535; throw e; };

    const res = await auth(request(app).post('/api/key-forms/retry-failed')).send({});
    expect(res.body).toMatchObject({ attempted: 1, sent: 0, failed: 1, remaining: 1 });
    // One rejection ends the batch — the same error repeated across a backlog
    // is minutes of waiting for information already in hand.
    expect(res.body.stopped_early).toBe(true);
    expect(res.body.results[0].error).toMatch(/still broken/);
    expect(res.body.results[0].form_no).toBe(`KF-${String(id).padStart(5, '0')}`);
  });

  it('stops the batch at the first rejection instead of repeating it', async () => {
    const ids = [seedForm('One'), seedForm('Two'), seedForm('Three')];
    for (const id of ids) {
      db.prepare("UPDATE key_form_docs SET status='unsigned', send_error='queued' WHERE id=?").run(id);
    }
    sendBehaviour = () => { const e: any = new Error('535 5.7.139 Authentication unsuccessful'); throw e; };

    const res = await auth(request(app).post('/api/key-forms/retry-failed')).send({});
    expect(res.body).toMatchObject({ queued: 3, attempted: 1, sent: 0, failed: 1, stopped_early: true });
    // The other two were never touched, so they are still queued for the
    // retry that follows an actual fix.
    expect(res.body.remaining).toBe(3);
    // Only the first form reached the transport. It retried within itself
    // (transient failures are still worth retrying), but the batch did not
    // move on to forms two and three.
    expect(res.body.results).toHaveLength(1);
    expect(new Set(sent.map((m: any) => m.subject)).size).toBe(1);
  });

  it('is a no-op when nothing has failed', async () => {
    const res = await auth(request(app).post('/api/key-forms/retry-failed')).send({});
    expect(res.body).toMatchObject({ queued: 0, attempted: 0, sent: 0, failed: 0 });
  });
});

// ══════════════════════════ RESEND ══════════════════════════════════════════
// Microsoft disabled SMTP AUTH at the tenant (535 5.7.139), which no client
// configuration can work around. Resend is the second path; SMTP stays.
describe('Resend provider', () => {
  const RESEND_KEY = 're_test_ABCDEFGH_notarealkey';

  it('selects Resend when MAIL_PROVIDER says so', () => {
    process.env.MAIL_PROVIDER = 'resend';
    expect(mailer.activeProvider()).toEqual({ provider: 'resend', source: 'MAIL_PROVIDER' });
  });

  it('selects Resend automatically once a key is present', () => {
    process.env.RESEND_API_KEY = RESEND_KEY;
    // Adding the key is the intent; nothing else should be needed to switch.
    expect(mailer.activeProvider()).toEqual({ provider: 'resend', source: 'auto' });
  });

  it('still falls back to SMTP, and MAIL_PROVIDER=smtp wins over a stray key', () => {
    expect(mailer.activeProvider()).toEqual({ provider: 'smtp', source: 'default' });
    process.env.RESEND_API_KEY = RESEND_KEY;
    process.env.MAIL_PROVIDER = 'smtp';
    expect(mailer.activeProvider()).toEqual({ provider: 'smtp', source: 'MAIL_PROVIDER' });
  });

  it('defaults From to the shared sender, and flags what that costs', () => {
    process.env.MAIL_PROVIDER = 'resend';
    process.env.RESEND_API_KEY = RESEND_KEY;
    expect(mailer.fromConfig()).toMatchObject({
      address: 'onboarding@resend.dev',
      header: 'City Wide Key Management <onboarding@resend.dev>',
      addressSource: 'RESEND_DEFAULT',
      sharedTestSender: true,
    });

    process.env.MAIL_FROM_ADDRESS = 'keys@citywideboston.com';
    expect(mailer.fromConfig()).toMatchObject({
      address: 'keys@citywideboston.com',
      addressSource: 'MAIL_FROM_ADDRESS',
      sharedTestSender: false,
      // SMTP's send-as concept does not apply here.
      mismatch: false,
    });
  });

  it('posts a correctly shaped request, with the logo as an inline attachment', async () => {
    process.env.MAIL_PROVIDER = 'resend';
    process.env.RESEND_API_KEY = RESEND_KEY;
    process.env.MAIL_FROM_ADDRESS = 'keys@citywideboston.com';
    process.env.MAIL_REPLY_TO = 'cara@citywideboston.com';

    const mail = await import('../src/lib/custodyMail');
    const r = await mail.sendBranded('Subject', '<p>hi</p>', 'hi', ['a@example.test', 'b@example.test']);

    expect(r.ok).toBe(true);
    expect(r.provider).toBe('resend');
    expect(posted).toHaveLength(1);
    expect(posted[0].url).toBe('https://api.resend.com/emails');
    expect(posted[0].headers.Authorization).toBe(`Bearer ${RESEND_KEY}`);
    expect(posted[0].body).toMatchObject({
      from: 'City Wide Key Management <keys@citywideboston.com>',
      // Resend takes an array, not a comma-joined string.
      to: ['a@example.test', 'b@example.test'],
      subject: 'Subject',
      reply_to: 'cara@citywideboston.com',
    });
    // The branded shell references cid:cwlogo; without content_id it arrives
    // as a broken image.
    const logo = posted[0].body.attachments?.find((a: any) => a.filename === 'cw-logo.png');
    expect(logo).toBeTruthy();
    expect(logo.content_id).toBe('cwlogo');
    expect(typeof logo.content).toBe('string');   // base64, not a Buffer
    // Nothing went near SMTP.
    expect(sent).toHaveLength(0);
  });

  it('reports the Resend id as the message ID', async () => {
    process.env.MAIL_PROVIDER = 'resend';
    process.env.RESEND_API_KEY = RESEND_KEY;
    resendBehaviour = () => ({ status: 200, body: { id: 'abc-123' } });
    const mail = await import('../src/lib/custodyMail');
    const r = await mail.sendBranded('S', '<p>h</p>', 'h', ['a@example.test']);
    expect(r.messageId).toBe('<abc-123@resend>');
    expect(r.response).toMatch(/abc-123/);
  });

  it('surfaces a Resend rejection whole — name, status and body', async () => {
    process.env.MAIL_PROVIDER = 'resend';
    process.env.RESEND_API_KEY = RESEND_KEY;
    // What Resend actually returns when the domain is not verified.
    resendBehaviour = () => ({
      status: 403,
      body: {
        statusCode: 403,
        name: 'validation_error',
        message: 'The citywideboston.com domain is not verified. Please verify your domain on https://resend.com/domains',
      },
    });
    const mail = await import('../src/lib/custodyMail');
    const r = await mail.sendBranded('S', '<p>h</p>', 'h', ['a@example.test'], [], { singleAttempt: true });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not verified/);
    expect(r.error).toMatch(/validation_error/);
    expect(r.error).toMatch(/responseCode=403/);
    expect(r.error).toMatch(/command=POST \/emails/);
  });

  it('says the key is missing rather than posting without one', async () => {
    process.env.MAIL_PROVIDER = 'resend';
    const mail = await import('../src/lib/custodyMail');
    const r = await mail.sendBranded('S', '<p>h</p>', 'h', ['a@example.test']);
    expect(r).toMatchObject({ ok: false, skipped: true });
    expect(r.error).toMatch(/RESEND_API_KEY is not set/);
    expect(posted).toHaveLength(0);
  });
});

describe('Email config + test send under Resend', () => {
  const RESEND_KEY = 're_test_ABCDEFGH_notarealkey';

  it('names Resend as the active provider and how it was chosen', async () => {
    process.env.MAIL_PROVIDER = 'resend';
    process.env.RESEND_API_KEY = RESEND_KEY;
    process.env.MAIL_FROM_ADDRESS = 'keys@citywideboston.com';
    const res = await auth(request(app).get('/api/settings/email'));
    expect(res.body).toMatchObject({
      provider: 'Resend (HTTPS API)',
      provider_key: 'resend',
      provider_source: 'MAIL_PROVIDER',
      provider_configured: true,
      blocker: null,
    });
    expect(res.body.resend).toMatchObject({ api_key_set: true, shared_test_sender: false });
    expect(res.body.warnings).toEqual([]);
  });

  it('never returns the API key', async () => {
    process.env.MAIL_PROVIDER = 'resend';
    process.env.RESEND_API_KEY = RESEND_KEY;
    const res = await auth(request(app).get('/api/settings/email'));
    expect(JSON.stringify(res.body)).not.toContain(RESEND_KEY);
    expect(res.body.resend.key_hint).toBe('re_test_…');
  });

  it('warns that the shared sender only reaches the account owner', async () => {
    process.env.MAIL_PROVIDER = 'resend';
    process.env.RESEND_API_KEY = RESEND_KEY;
    const res = await auth(request(app).get('/api/settings/email'));
    expect(res.body.warnings.join(' ')).toMatch(/ONLY deliver to the email address that owns the Resend account/);
  });

  it('does not raise SMTP warnings when SMTP is not the active provider', async () => {
    process.env.MAIL_PROVIDER = 'resend';
    process.env.RESEND_API_KEY = RESEND_KEY;
    process.env.MAIL_FROM_ADDRESS = 'keys@citywideboston.com';
    const res = await auth(request(app).get('/api/settings/email'));
    // SMTP_USER/SMTP_PASS are unset here, and that is irrelevant.
    expect(res.body.warnings.join(' ')).not.toMatch(/SMTP_USER|SMTP_PASS/);
  });

  it('sends the test through Resend and reports the id', async () => {
    process.env.MAIL_PROVIDER = 'resend';
    process.env.RESEND_API_KEY = RESEND_KEY;
    process.env.MAIL_FROM_ADDRESS = 'keys@citywideboston.com';
    resendBehaviour = () => ({ status: 200, body: { id: 'test-send-id' } });

    const res = await auth(request(app).post('/api/settings/email/test'))
      .send({ to: 'tye@example.test' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, message_id: '<test-send-id@resend>' });
    expect(posted).toHaveLength(1);
    // The message says how it was actually delivered, not a generic template.
    expect(posted[0].body.html).toMatch(/Resend \(HTTPS API\)/);
    expect(posted[0].body.html).toMatch(/api\.resend\.com/);

    const log = obj(db.prepare("SELECT * FROM audit_log WHERE action='test_email_sent' ORDER BY id DESC LIMIT 1").get());
    expect(JSON.parse(log.metadata)).toMatchObject({ provider: 'resend', message_id: '<test-send-id@resend>' });
  });

  it('returns the whole Resend error on a failed test send', async () => {
    process.env.MAIL_PROVIDER = 'resend';
    process.env.RESEND_API_KEY = RESEND_KEY;
    resendBehaviour = () => ({
      status: 401,
      body: { statusCode: 401, name: 'validation_error', message: 'API key is invalid' },
    });
    const res = await auth(request(app).post('/api/settings/email/test')).send({});
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/API key is invalid/);
    expect(res.body.error).toMatch(/responseCode=401/);
  });
});
