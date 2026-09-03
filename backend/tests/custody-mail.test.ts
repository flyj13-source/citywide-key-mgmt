import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

// ── Isolated temp DB — the real citywide.db is NEVER touched ─────────────────
const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'citywide-mail-'));
process.env.CITYWIDE_DB_DIR = TEST_DIR;
delete process.env.DB_PATH;
process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
// SMTP configured so the send path actually runs; the transport itself is
// stubbed below, so nothing leaves the machine.
process.env.SMTP_USER = 'keys@citywideboston.com';
process.env.SMTP_PASS = 'not-a-real-password';
delete process.env.CARA_EMAIL;

const sent: any[] = [];
vi.mock('../src/lib/mailer', () => ({
  createTransport: () => ({
    sendMail: async (msg: any) => { sent.push(msg); return { messageId: 'test' }; },
  }),
}));

let mail: typeof import('../src/lib/custodyMail');
let settings: typeof import('../src/lib/settings');

const KEYS = [
  { type: 'metal' as const, label: 'Metal Key', qty: 2 },
  { type: 'fob' as const, label: 'Key Fob', qty: 1 },
];

beforeAll(async () => {
  mail = await import('../src/lib/custodyMail');
  settings = await import('../src/lib/settings');
});

beforeEach(() => {
  sent.length = 0;
  settings.setSetting(settings.CUSTODY_NOTIFY_KEY, 'cara@citywideboston.com', 'test');
});

// ═══════════════════════════ TEST-FIXTURE MARKING ═══════════════════════════
// A fixture's contact address is the operator's own inbox. Anything sent there
// during a test run has to be unmistakable at a glance in that inbox.
describe('TEST FIXTURE EMAILS ARE PREFIXED', () => {
  it('prefixes [TEST] when the recipient is a fixture contact', async () => {
    const fx = await import('../src/lib/testFixtures');
    fx.seedTestFixtures();

    const r = await mail.sendCheckoutNotice({
      holder: fx.TEST_MANAGER_NAME, holderEmail: fx.TEST_EMAIL, holderType: 'employee',
      client: fx.TEST_CLIENT_NAME, bcNumber: fx.TEST_CLIENT_BC, keys: KEYS,
      checkedOutAt: new Date().toISOString(), dueAt: '2026-09-01',
      recordedBy: 'Cara Angeloni', onBehalf: true, signoffLink: 'https://keys.test/key-signoff/abc',
    });
    expect(r.ok).toBe(true);
    expect(sent[0].subject.startsWith('[TEST] ')).toBe(true);
    expect(sent[0].subject).toContain(fx.TEST_MANAGER_NAME);
  });

  it('leaves a real recipient\'s subject untouched', async () => {
    const r = await mail.sendCheckoutNotice({
      holder: 'J. Martinez', holderEmail: 'jm@example.test', holderType: 'employee',
      client: 'ACME TOWER', bcNumber: '01014000123', keys: KEYS,
      checkedOutAt: new Date().toISOString(), dueAt: '2026-09-01',
      recordedBy: 'Cara Angeloni', onBehalf: true, signoffLink: 'https://keys.test/key-signoff/abc',
    });
    expect(r.ok).toBe(true);
    expect(sent[0].subject.startsWith('[TEST]')).toBe(false);
  });
});

// ══════════════════════════════ SUBJECT LINES ═══════════════════════════════
describe('CUSTODY EMAIL SUBJECTS', () => {
  it('check-out reads "Keys checked out — [Holder] — [Client]"', async () => {
    const r = await mail.sendCheckoutNotice({
      holder: 'J. Martinez', holderEmail: 'jm@example.test', holderType: 'employee',
      client: 'ACME TOWER', bcNumber: '01014000123', keys: KEYS,
      checkedOutAt: new Date().toISOString(), dueAt: '2026-09-01',
      recordedBy: 'Cara Angeloni', onBehalf: true, signoffLink: 'https://keys.test/key-signoff/abc',
    });
    expect(r.ok).toBe(true);
    expect(sent[0].subject).toBe('Keys checked out — J. Martinez — ACME TOWER');
  });

  it('check-in reads "Keys returned — [Holder] — [Client]"', async () => {
    const r = await mail.sendCheckinNotice({
      holder: 'J. Martinez', holderEmail: 'jm@example.test', holderType: 'employee',
      client: 'ACME TOWER', bcNumber: '01014000123', keys: KEYS,
      returnedAt: new Date().toISOString(), condition: 'good',
      recordedBy: 'Cara Angeloni', onBehalf: false, signoffLink: 'https://keys.test/key-signoff/def',
    });
    expect(r.ok).toBe(true);
    expect(sent[0].subject).toBe('Keys returned — J. Martinez — ACME TOWER');
  });

  it('the signed receipt reads "Signed key receipt — [Holder] — [Client]"', async () => {
    const r = await mail.sendSignedReceipt({
      action: 'checkout', holder: 'J. Martinez', holderEmail: 'jm@example.test',
      holderType: 'employee', client: 'ACME TOWER', bcNumber: '01014000123',
      keys: KEYS, signedAt: new Date().toISOString(),
      pdf: { filename: 'receipt.pdf', content: Buffer.from('%PDF-1.7 test') },
    });
    expect(r.ok).toBe(true);
    expect(sent[0].subject).toBe('Signed key receipt — J. Martinez — ACME TOWER');
  });
});

// ══════════════════════════════ BODY CONTENTS ═══════════════════════════════
describe('CUSTODY EMAIL BODY', () => {
  it('carries holder type, client + BC #, key list, dates and who recorded it', async () => {
    await mail.sendCheckoutNotice({
      holder: 'Rick Ruiz', holderEmail: 'rick@example.test', holderType: 'ic',
      client: 'ACME TOWER', bcNumber: '01014000123', keys: KEYS,
      checkedOutAt: '2026-08-25T14:00:00.000Z', dueAt: '2026-09-01',
      recordedBy: 'Cara Angeloni', onBehalf: true, signoffLink: 'https://keys.test/key-signoff/abc',
    });
    const { html, text } = sent[0];

    expect(html).toContain('Rick Ruiz (Independent Contractor (IC))');
    expect(html).toContain('ACME TOWER (BC #01014000123)');
    expect(html).toContain('Metal Key');
    expect(html).toContain('Key Fob');
    expect(html).toContain('Due back');
    expect(html).toContain('Cara Angeloni (on behalf of Rick Ruiz)');
    // The sign-off CTA is present and worded for RECEIVING.
    expect(html).toContain('https://keys.test/key-signoff/abc');
    expect(html).toContain('acknowledge that you are RECEIVING these keys');
    // Plain-text alternative carries the same facts.
    expect(text).toContain('Rick Ruiz (Independent Contractor (IC))');
    expect(text).toContain('BC #01014000123');
    expect(text).toContain('2 × Metal Key');
  });

  it('a check-in states the condition and asks for a RETURN signature', async () => {
    await mail.sendCheckinNotice({
      holder: 'Rick Ruiz', holderEmail: 'rick@example.test', holderType: 'ic',
      client: 'ACME TOWER', bcNumber: '01014000123', keys: KEYS,
      returnedAt: '2026-08-26T14:00:00.000Z', condition: 'damaged',
      recordedBy: 'Cara Angeloni', onBehalf: true, signoffLink: 'https://keys.test/key-signoff/def',
    });
    const { html } = sent[0];
    expect(html).toContain('damaged');
    expect(html).toContain('acknowledge that you are RETURNING these keys');
    expect(html).toContain('https://keys.test/key-signoff/def');
  });

  it('a transfer names the counterparty on both halves', async () => {
    await mail.sendCheckinNotice({
      holder: 'Tina', holderEmail: 't@example.test', holderType: 'employee',
      client: 'ACME TOWER', bcNumber: null, keys: KEYS,
      returnedAt: new Date().toISOString(), condition: 'good',
      recordedBy: 'Cara Angeloni', onBehalf: true, signoffLink: 'https://keys.test/key-signoff/1',
      transferTo: 'Rick',
    });
    expect(sent[0].html).toContain('Handed directly to <strong>Rick</strong>');

    await mail.sendCheckoutNotice({
      holder: 'Rick', holderEmail: 'r@example.test', holderType: 'ic',
      client: 'ACME TOWER', bcNumber: null, keys: KEYS,
      checkedOutAt: new Date().toISOString(), dueAt: null,
      recordedBy: 'Cara Angeloni', onBehalf: true, signoffLink: 'https://keys.test/key-signoff/2',
      transferFrom: 'Tina',
    });
    expect(sent[1].html).toContain('Received directly from <strong>Tina</strong>');
  });
});

// ═══════════════════════════════ RECIPIENTS ═════════════════════════════════
describe('CUSTODY EMAIL RECIPIENTS', () => {
  it('goes to the holder AND the configured notification recipient', async () => {
    await mail.sendCheckoutNotice({
      holder: 'J. Martinez', holderEmail: 'jm@example.test', holderType: 'employee',
      client: 'ACME TOWER', bcNumber: null, keys: KEYS,
      checkedOutAt: new Date().toISOString(), dueAt: null,
      recordedBy: 'Cara Angeloni', onBehalf: false, signoffLink: null,
    });
    expect(sent[0].to).toBe('jm@example.test, cara@citywideboston.com');
  });

  it('follows the recipient when Settings changes it — no redeploy', async () => {
    settings.setSetting(settings.CUSTODY_NOTIFY_KEY, 'successor@citywideboston.com', 'test');
    await mail.sendCheckinNotice({
      holder: 'J. Martinez', holderEmail: 'jm@example.test', holderType: 'employee',
      client: 'ACME TOWER', bcNumber: null, keys: KEYS,
      returnedAt: new Date().toISOString(), condition: 'good',
      recordedBy: 'Cara Angeloni', onBehalf: false, signoffLink: null,
    });
    expect(sent[0].to).toBe('jm@example.test, successor@citywideboston.com');
  });

  it('never sends the holder two copies when they ARE the recipient', async () => {
    settings.setSetting(settings.CUSTODY_NOTIFY_KEY, 'cara@citywideboston.com', 'test');
    await mail.sendCheckoutNotice({
      holder: 'Cara Angeloni', holderEmail: 'cara@citywideboston.com', holderType: 'employee',
      client: 'ACME TOWER', bcNumber: null, keys: KEYS,
      checkedOutAt: new Date().toISOString(), dueAt: null,
      recordedBy: 'Cara Angeloni', onBehalf: false, signoffLink: null,
    });
    expect(sent[0].to).toBe('cara@citywideboston.com');
  });
});

// ════════════════════════════ SIGNED PDF DELIVERY ═══════════════════════════
describe('SIGNED RECEIPT DELIVERY', () => {
  it('attaches the PDF and sends it to the recipient AND the signer', async () => {
    await mail.sendSignedReceipt({
      action: 'checkin', holder: 'J. Martinez', holderEmail: 'jm@example.test',
      holderType: 'employee', client: 'ACME TOWER', bcNumber: '01014000123',
      keys: KEYS, signedAt: new Date().toISOString(),
      pdf: { filename: 'keycheckin_7_J_Martinez.pdf', content: Buffer.from('%PDF-1.7 test') },
    });
    const msg = sent[0];
    // The signer leads: the receipt is first and foremost THEIR proof of what
    // they accepted; the notification recipient and any counterparty follow.
    expect(msg.to).toBe('jm@example.test, cara@citywideboston.com');

    const pdf = msg.attachments.find((a: any) => a.filename.endsWith('.pdf'));
    expect(pdf).toBeTruthy();
    expect(pdf.contentType).toBe('application/pdf');
    expect(pdf.content.toString()).toBe('%PDF-1.7 test');
    expect(msg.html).toContain('signed PDF receipt is attached');
    expect(msg.html).toContain('Returned keys');
  });

  it('still sends — and says why — when the PDF could not be rendered', async () => {
    await mail.sendSignedReceipt({
      action: 'checkout', holder: 'J. Martinez', holderEmail: 'jm@example.test',
      holderType: 'employee', client: 'ACME TOWER', bcNumber: null,
      keys: KEYS, signedAt: new Date().toISOString(),
      pdf: null, pdfError: 'renderer out of memory',
    });
    const msg = sent[0];
    expect(msg.attachments.every((a: any) => !a.filename.endsWith('.pdf'))).toBe(true);
    expect(msg.html).toContain('could not be generated');
    expect(msg.html).toContain('renderer out of memory');
  });
});

// ═════════════════════════════ FAILURE REPORTING ════════════════════════════
describe('SEND FAILURES ARE REPORTED, NEVER SWALLOWED', () => {
  it('reports a missing recipient address instead of pretending to send', async () => {
    settings.setSetting(settings.CUSTODY_NOTIFY_KEY, '', 'test');
    const prevCara = process.env.CARA_EMAIL;
    const prevSmtp = process.env.SMTP_USER;
    // With nothing stored and no env bootstrap the fallback still resolves, so
    // force the genuinely empty case.
    delete process.env.CARA_EMAIL;
    process.env.SMTP_USER = '';
    const r = await mail.sendBranded('Subject', '<p>x</p>', 'x', ['']);
    expect(r.ok).toBe(false);
    expect(r.skipped).toBe(true);
    expect(r.error).toContain('No recipient');
    process.env.CARA_EMAIL = prevCara;
    process.env.SMTP_USER = prevSmtp;
  });

  it('reports an unconfigured SMTP rather than throwing', async () => {
    const prev = process.env.SMTP_PASS;
    delete process.env.SMTP_PASS;
    const r = await mail.sendBranded('Subject', '<p>x</p>', 'x', ['someone@example.test']);
    expect(r.ok).toBe(false);
    expect(r.skipped).toBe(true);
    expect(r.error).toContain('SMTP is not configured');
    process.env.SMTP_PASS = prev;
  });

  it('turns a transport error into a reported failure', async () => {
    const mailer = await import('../src/lib/mailer');
    const spy = vi.spyOn(mailer, 'createTransport').mockReturnValue({
      sendMail: async () => { throw new Error('550 mailbox unavailable'); },
    } as any);
    const r = await mail.sendBranded('Subject', '<p>x</p>', 'x', ['someone@example.test']);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('550 mailbox unavailable');
    spy.mockRestore();
  });
});
