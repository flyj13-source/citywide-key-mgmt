import { Router, Response } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { logAudit } from '../lib/audit';
import {
  CUSTODY_NOTIFY_KEY, getSetting, setSetting, settingMeta,
  parseRecipients, custodyNotifyRecipients, seedCustodyNotifyDefault,
} from '../lib/settings';
import { DUE_DAYS_KEY, DEFAULT_DUE_DAYS, defaultDueDays, defaultDueDate } from '../lib/custodyDefaults';
import {
  smtpConfig, fromConfig, resendConfig, activeProvider, providerBlocker, RESEND_TEST_FROM,
} from '../lib/mailer';
import { sendTestEmail } from '../lib/custodyMail';
import db from '../lib/db';

const router = Router();

// ── Operator-editable system settings ────────────────────────────────────────
// Today this holds exactly one thing: who receives a copy of every key custody
// email. It lives in the database rather than in a constant or an env var
// precisely so it survives the person currently in that seat moving on.

// ── GET /api/settings/custody-notification ───────────────────────────────────
router.get('/custody-notification', requireAuth, (_req: AuthRequest, res: Response) => {
  seedCustodyNotifyDefault();
  const stored = getSetting(CUSTODY_NOTIFY_KEY);
  const meta = settingMeta(CUSTODY_NOTIFY_KEY);
  res.json({
    value: stored ?? '',
    // What the mailer will ACTUALLY use right now, after fallbacks — so the
    // screen can never claim a recipient the emails do not go to.
    effective: custodyNotifyRecipients(),
    source: stored ? 'settings' : (process.env.CARA_EMAIL ? 'environment' : 'default'),
    updated_at: meta.updated_at,
    updated_by: meta.updated_by,
  });
});

// ── PUT /api/settings/custody-notification ───────────────────────────────────
// One or more comma-separated addresses. Rejects a malformed address outright:
// silently dropping it would mean nobody is notified and nothing says so.
router.put('/custody-notification', requireAuth, (req: AuthRequest, res: Response) => {
  const raw = req.body?.value;
  if (typeof raw !== 'string') {
    return res.status(400).json({ error: 'value must be a string of one or more email addresses' });
  }
  const { valid, invalid } = parseRecipients(raw);
  if (invalid.length) {
    return res.status(400).json({ error: `Not a valid email address: ${invalid.join(', ')}` });
  }
  if (!valid.length) {
    return res.status(400).json({ error: 'At least one recipient address is required' });
  }

  const previous = getSetting(CUSTODY_NOTIFY_KEY);
  const value = valid.join(', ');
  setSetting(CUSTODY_NOTIFY_KEY, value, req.manager?.name ?? 'System');

  logAudit(req, 'settings_updated', null, null, {
    key: CUSTODY_NOTIFY_KEY, from: previous, to: value,
  });

  const meta = settingMeta(CUSTODY_NOTIFY_KEY);
  res.json({
    success: true,
    value,
    effective: custodyNotifyRecipients(),
    source: 'settings',
    updated_at: meta.updated_at,
    updated_by: meta.updated_by,
  });
});

// ── GET /api/settings/custody-defaults ───────────────────────────────────────
// The due-date window every check-out starts from. Stored, not hardcoded, so
// "we give them 30 days" can become 14 or 60 without a deploy.
router.get('/custody-defaults', requireAuth, (_req: AuthRequest, res: Response) => {
  const meta = settingMeta(DUE_DAYS_KEY);
  res.json({
    due_days: defaultDueDays(),
    is_default: getSetting(DUE_DAYS_KEY) == null,
    fallback_due_days: DEFAULT_DUE_DAYS,
    // What a check-out opened right now would propose, so the screen shows the
    // actual date rather than only the number of days.
    example_due_at: defaultDueDate(),
    updated_at: meta.updated_at,
    updated_by: meta.updated_by,
  });
});

// ── PUT /api/settings/custody-defaults ───────────────────────────────────────
router.put('/custody-defaults', requireAuth, (req: AuthRequest, res: Response) => {
  const raw = req.body?.due_days;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 3650) {
    return res.status(400).json({ error: 'due_days must be a whole number of days between 1 and 3650' });
  }
  const previous = getSetting(DUE_DAYS_KEY);
  setSetting(DUE_DAYS_KEY, String(n), req.manager?.name ?? 'System');
  logAudit(req, 'settings_updated', null, null, { key: DUE_DAYS_KEY, from: previous, to: String(n) });
  res.json({ due_days: n, example_due_at: defaultDueDate(n) });
});

// ── Email configuration + test send ──────────────────────────────────────────
// The mail path has more ways to be silently wrong than anything else here:
// a host that is ignored, implicit TLS on a STARTTLS port, a From address the
// tenant will not send as. This reports what the process ACTUALLY holds, and
// then lets an admin prove it by sending one message.

const isEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

function lastTestSend(): any | null {
  try {
    const raw = db.prepare(
      "SELECT action, manager, metadata, created_at FROM audit_log " +
      "WHERE action IN ('test_email_sent','test_email_failed') ORDER BY id DESC LIMIT 1"
    ).get() as any;
    if (!raw) return null;
    const r = Object.assign({}, raw);
    let meta: any = {};
    try { meta = JSON.parse(r.metadata || '{}'); } catch { meta = {}; }
    return {
      ok: r.action === 'test_email_sent',
      at: r.created_at,
      by: r.manager,
      recipients: meta.recipients ?? [],
      message_id: meta.message_id ?? null,
      error: meta.error ?? null,
    };
  } catch {
    return null;
  }
}

/** The read-only picture of how mail is wired, with the problems named. */
function emailConfig() {
  const smtp = smtpConfig();
  const from = fromConfig();
  const resend = resendConfig();
  const notify = custodyNotifyRecipients();
  const { provider, source: providerSource } = activeProvider();

  // Anything here means mail is misconfigured in a way a test send will expose.
  const warnings: string[] = [];

  if (provider === 'resend') {
    if (!resend.apiKeySet) warnings.push('RESEND_API_KEY is not set — no mail can be sent.');
    if (from.sharedTestSender) {
      // The single most surprising Resend restriction, and the one that makes
      // a "working" test send look like working custody mail when it is not.
      warnings.push(
        `Sending from ${from.address}, Resend's shared sender. It needs no domain verification, but it can ` +
        'ONLY deliver to the email address that owns the Resend account. Custody mail to staff and ICs ' +
        'needs a verified domain and MAIL_FROM_ADDRESS set to an address on it.'
      );
    }
  } else {
    if (!smtp.user) warnings.push('SMTP_USER is not set — no mail can be sent.');
    if (!smtp.hasPassword) warnings.push('SMTP_PASS is not set — no mail can be sent.');
    if (smtp.port === 587 && smtp.secure) {
      warnings.push('Port 587 is a STARTTLS port but SMTP_SECURE forces implicit TLS — the handshake will fail.');
    }
    if (smtp.port === 465 && !smtp.secure) {
      warnings.push('Port 465 is the implicit-TLS port but the transport is set to STARTTLS — the handshake will fail.');
    }
    if (from.mismatch) {
      warnings.push(
        `MAIL_FROM_ADDRESS (${from.address}) is not the authenticated mailbox (${smtp.user}). ` +
        'Office 365 rejects this with 5.7.60 SendAsDenied unless that mailbox has Send As rights.'
      );
    }
  }
  if (!notify.length) warnings.push('No custody notification recipient is configured.');

  const providerLabel = provider === 'resend'
    ? 'Resend (HTTPS API)'
    : smtp.host.toLowerCase().includes('office365')
      ? 'Microsoft 365 SMTP (Exchange Online)'
      : `SMTP — ${smtp.host}`;

  return {
    provider: providerLabel,
    provider_key: provider,
    provider_source: providerSource,
    provider_configured: !providerBlocker(),
    blocker: providerBlocker(),
    resend: {
      api_key_set: resend.apiKeySet,
      key_hint: resend.keyHint,
      endpoint: resend.endpoint,
      shared_test_sender: from.sharedTestSender,
      test_sender_address: RESEND_TEST_FROM,
    },
    smtp: {
      host: smtp.host,
      port: smtp.port,
      host_source: smtp.hostSource,
      port_source: smtp.portSource,
      secure: smtp.secure,
      require_tls: smtp.requireTLS,
      // Said in words, because "secure:false" reads like a mistake to anyone
      // who has not met nodemailer's naming.
      tls_mode: smtp.secure
        ? 'Implicit TLS (SMTPS) — connection encrypted from the first byte'
        : 'STARTTLS — connection upgraded to TLS before AUTH, and required',
      min_tls_version: 'TLSv1.2',
      user: smtp.user,
      password_set: smtp.hasPassword,
      configured: !!smtp.user && smtp.hasPassword,
    },
    from: {
      name: from.name,
      address: from.address,
      // Exactly what a recipient sees in the From column.
      header: from.header,
      reply_to: from.replyTo,
      name_source: from.nameSource,
      address_source: from.addressSource,
      mismatch: from.mismatch,
      shared_test_sender: from.sharedTestSender,
    },
    notification_recipients: notify,
    environment: process.env.NODE_ENV || 'development',
    warnings,
  };
}

// ── GET /api/settings/email ──────────────────────────────────────────────────
router.get('/email', requireAuth, (_req: AuthRequest, res: Response) => {
  res.json({ ...emailConfig(), last_test: lastTestSend() });
});

// ── POST /api/settings/email/test ────────────────────────────────────────────
// Admin only. Sends one branded message and reports precisely what SMTP said —
// the message ID on acceptance, the complete error text otherwise. Both
// outcomes are written to the audit log; neither is swallowed.
router.post('/email/test', requireAuth, async (req: AuthRequest, res: Response) => {
  if (req.manager?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin only' });
  }

  const cfg = emailConfig();
  const override = typeof req.body?.to === 'string' ? req.body.to.trim() : '';
  if (override && !isEmail(override)) {
    return res.status(400).json({ error: `"${override}" is not a valid email address` });
  }
  const recipients = override ? [override] : cfg.notification_recipients;
  if (!recipients.length) {
    return res.status(400).json({
      error: 'No recipient — set a custody notification address above, or type one in "Send to".',
    });
  }

  const triggeredBy = req.manager?.name ?? 'System';
  let result;
  try {
    result = await sendTestEmail({
      to: recipients,
      environment: cfg.environment,
      provider: cfg.provider,
      transport: cfg.provider_key === 'resend'
        ? `HTTPS POST ${cfg.resend.endpoint}`
        : `${cfg.smtp.host}:${cfg.smtp.port} · ${cfg.smtp.tls_mode}`,
      from: cfg.from.header ?? '(no From address resolved)',
      triggeredBy,
    });
  } catch (err: any) {
    // sendBranded is not supposed to throw, but if it ever does the whole
    // thing goes to the operator rather than becoming a generic 500.
    const text = err?.stack || err?.message || String(err);
    logAudit(req, 'test_email_failed', null, null, {
      recipients, error: text, threw: true, triggered_by: triggeredBy,
    });
    return res.status(502).json({
      ok: false, recipients, error: text,
      config: cfg,
    });
  }

  logAudit(req, result.ok ? 'test_email_sent' : 'test_email_failed', null, null, {
    recipients: result.recipients,
    message_id: result.messageId ?? null,
    response: result.response ?? null,
    error: result.error ?? null,
    skipped: !!result.skipped,
    attempts: result.attempts,
    provider: cfg.provider_key,
    host: cfg.provider_key === 'resend' ? cfg.resend.endpoint : cfg.smtp.host,
    port: cfg.provider_key === 'resend' ? 443 : cfg.smtp.port,
    tls_mode: cfg.provider_key === 'resend' ? 'HTTPS' : cfg.smtp.tls_mode,
    from: cfg.from.header,
    triggered_by: triggeredBy,
  });

  res.status(result.ok ? 200 : 502).json({
    ok: result.ok,
    recipients: result.recipients,
    message_id: result.messageId ?? null,
    response: result.response ?? null,
    error: result.error ?? null,
    skipped: !!result.skipped,
    attempts: result.attempts,
    sent_at: new Date().toISOString(),
    config: cfg,
  });
});

export default router;
