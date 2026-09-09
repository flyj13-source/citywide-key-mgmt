import nodemailer from 'nodemailer';

// ── SMTP transport ───────────────────────────────────────────────────────────
// Office 365 on port 587 is STARTTLS, not implicit TLS: the connection opens in
// the clear and is upgraded by the STARTTLS command. In nodemailer that is
// `secure: false` PLUS `requireTLS: true` — secure:false alone would permit a
// silent fall back to an unencrypted session, which Office 365 then refuses at
// AUTH. Port 465 is the implicit-TLS port and is the only case where
// secure:true is right, so it is derived from the port rather than guessed.
//
// Host and port are read from the environment. They were previously hardcoded,
// which meant SMTP_HOST / SMTP_PORT could be set in the deploy environment and
// silently ignored.

export const DEFAULT_SMTP_HOST = 'smtp.office365.com';
export const DEFAULT_SMTP_PORT = 587;

// ── Provider ─────────────────────────────────────────────────────────────────
// Two delivery paths, because SMTP is not always available: Microsoft 365
// disables SMTP AUTH at the tenant level (535 5.7.139) and no amount of
// correct client configuration gets past that. Resend is an HTTPS API, so it
// sidesteps SMTP entirely.
//
// SMTP is kept, not replaced. The tenant policy can change back, and a second
// working path is worth having.

export type MailProvider = 'smtp' | 'resend';

export const RESEND_ENDPOINT = 'https://api.resend.com/emails';
/** Resend's shared sender, usable before any domain is verified. */
export const RESEND_TEST_FROM = 'onboarding@resend.dev';

const trimmed = (v: string | undefined): string | null => {
  const s = (v ?? '').trim();
  return s === '' ? null : s;
};

export interface SmtpConfig {
  host: string;
  port: number;
  /** true only for implicit TLS (465). 587 upgrades via STARTTLS instead. */
  secure: boolean;
  requireTLS: boolean;
  user: string | null;
  hasPassword: boolean;
  /** Whether host/port came from the environment or fell back to a default. */
  hostSource: 'env' | 'default';
  portSource: 'env' | 'default';
}

export function smtpConfig(): SmtpConfig {
  const envHost = trimmed(process.env.SMTP_HOST);
  const envPort = trimmed(process.env.SMTP_PORT);
  const parsedPort = envPort !== null ? Number(envPort) : NaN;
  const port = Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535
    ? parsedPort
    : DEFAULT_SMTP_PORT;

  // SMTP_SECURE is an explicit override for the unusual case; otherwise the
  // port decides, because that is what actually determines the handshake.
  const secureOverride = trimmed(process.env.SMTP_SECURE);
  const secure = secureOverride !== null
    ? /^(1|true|yes)$/i.test(secureOverride)
    : port === 465;

  return {
    host: envHost ?? DEFAULT_SMTP_HOST,
    port,
    secure,
    // Demand the STARTTLS upgrade on every non-implicit-TLS port.
    requireTLS: !secure,
    user: trimmed(process.env.SMTP_USER),
    hasPassword: !!trimmed(process.env.SMTP_PASS),
    hostSource: envHost ? 'env' : 'default',
    portSource: Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535 ? 'env' : 'default',
  };
}

export interface ResendConfig {
  apiKeySet: boolean;
  /** First few characters only — enough to tell two keys apart, never the key. */
  keyHint: string | null;
  endpoint: string;
}

export function resendConfig(): ResendConfig {
  const key = trimmed(process.env.RESEND_API_KEY);
  return {
    apiKeySet: !!key,
    keyHint: key ? `${key.slice(0, 8)}…` : null,
    endpoint: RESEND_ENDPOINT,
  };
}

/**
 * Which path outbound mail takes. MAIL_PROVIDER decides; with nothing set, a
 * present RESEND_API_KEY is taken as the intent, so adding the key is enough
 * to switch over.
 */
export function activeProvider(): { provider: MailProvider; source: 'MAIL_PROVIDER' | 'auto' | 'default' } {
  const explicit = trimmed(process.env.MAIL_PROVIDER)?.toLowerCase();
  if (explicit === 'resend' || explicit === 'smtp') return { provider: explicit, source: 'MAIL_PROVIDER' };
  if (trimmed(process.env.RESEND_API_KEY)) return { provider: 'resend', source: 'auto' };
  return { provider: 'smtp', source: 'default' };
}

/** Is the active provider actually usable? */
export function providerConfigured(): boolean {
  const { provider } = activeProvider();
  if (provider === 'resend') return resendConfig().apiKeySet && !!fromConfig().address;
  const s = smtpConfig();
  return !!s.user && s.hasPassword;
}

export function createTransport() {
  const cfg = smtpConfig();
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    requireTLS: cfg.requireTLS,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    // NOTE: this deliberately does NOT pin `ciphers: 'SSLv3'`. That string is
    // a widely copied legacy snippet; on current Node/OpenSSL it narrows the
    // cipher list to a set Office 365 will not negotiate, and the handshake
    // fails before authentication is ever attempted. Modern defaults are
    // correct — the only floor worth stating is the minimum TLS version.
    tls: { minVersion: 'TLSv1.2' },
  });
}

// ── From / Reply-To ──────────────────────────────────────────────────────────
// Office 365 will only accept a From address that is the authenticated mailbox
// or an alias it is licensed to send as; anything else is rejected with
// 5.7.60 SendAsDenied. So the default From is the SMTP user itself, and an
// override is honoured but reported as a mismatch by the config readout.
export const DEFAULT_FROM_NAME = 'City Wide Key Management';

export interface FromConfig {
  name: string;
  address: string | null;
  /** Exactly what lands in the message header. */
  header: string | null;
  replyTo: string | null;
  addressSource: 'MAIL_FROM_ADDRESS' | 'SMTP_USER' | 'RESEND_DEFAULT' | 'unset';
  nameSource: 'MAIL_FROM_NAME' | 'default';
  /** SMTP only: the From address is not the authenticated mailbox. */
  mismatch: boolean;
  /** Resend only: sending from @resend.dev, which reaches only the account owner. */
  sharedTestSender: boolean;
}

export function fromConfig(): FromConfig {
  const name = trimmed(process.env.MAIL_FROM_NAME) ?? DEFAULT_FROM_NAME;
  const override = trimmed(process.env.MAIL_FROM_ADDRESS);
  const { provider } = activeProvider();

  if (provider === 'resend') {
    // Resend has no "authenticated mailbox" to default to. With no From set it
    // falls back to Resend's shared sender, which works with no domain
    // verification at all — but only reaches the account owner's own address.
    const address = override ?? RESEND_TEST_FROM;
    return {
      name,
      address,
      header: `${name} <${address}>`,
      replyTo: trimmed(process.env.MAIL_REPLY_TO),
      addressSource: override ? 'MAIL_FROM_ADDRESS' : 'RESEND_DEFAULT',
      nameSource: trimmed(process.env.MAIL_FROM_NAME) ? 'MAIL_FROM_NAME' : 'default',
      // Not a concept under Resend: the domain either verifies or it does not,
      // and Resend says so at send time.
      mismatch: false,
      sharedTestSender: address.toLowerCase().endsWith('@resend.dev'),
    };
  }

  const user = trimmed(process.env.SMTP_USER);
  const address = override ?? user;
  return {
    name,
    address,
    header: address ? `${name} <${address}>` : null,
    replyTo: trimmed(process.env.MAIL_REPLY_TO),
    addressSource: override ? 'MAIL_FROM_ADDRESS' : user ? 'SMTP_USER' : 'unset',
    nameSource: trimmed(process.env.MAIL_FROM_NAME) ? 'MAIL_FROM_NAME' : 'default',
    mismatch: !!override && !!user && override.toLowerCase() !== user.toLowerCase(),
    sharedTestSender: false,
  };
}

/** The From header every outbound message uses. */
export function fromHeader(): string {
  return fromConfig().header ?? DEFAULT_FROM_NAME;
}

export async function sendOverdueAlert(
  to: string,
  overdueList: Array<{ account_name: string; assignee: string; days: number }>
) {
  const transport = createTransport();
  const rows = overdueList
    .map(
      (o) =>
        `<tr><td style="padding:4px 8px">${o.account_name}</td><td style="padding:4px 8px">${o.assignee}</td><td style="padding:4px 8px;color:#C0272D">${o.days} days</td></tr>`
    )
    .join('');
  const reply = fromConfig().replyTo;
  await transport.sendMail({
    from: fromHeader(),
    ...(reply ? { replyTo: reply } : {}),
    to,
    subject: `[Key Alert] ${overdueList.length} overdue key assignment(s)`,
    html: `
      <h2 style="color:#C0272D">City Wide Boston — Overdue Key Assignments</h2>
      <table border="1" cellspacing="0" style="border-collapse:collapse;font-family:sans-serif">
        <thead><tr style="background:#1a1a1a;color:#fff">
          <th style="padding:4px 8px">Account</th>
          <th style="padding:4px 8px">Assignee</th>
          <th style="padding:4px 8px">Days Overdue</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p style="color:#6b6b68;font-size:12px">Sent by City Wide Key Management System</p>
    `,
  });
}

export async function sendContractorInvite(to: string, name: string, magicLink: string) {
  const transport = createTransport();
  const reply = fromConfig().replyTo;
  await transport.sendMail({
    from: fromHeader(),
    ...(reply ? { replyTo: reply } : {}),
    to,
    subject: 'City Wide Boston — Key Receipt Acknowledgement Required',
    html: `
      <h2 style="color:#C0272D">Key Receipt Acknowledgement</h2>
      <p>Hello ${name},</p>
      <p>Please click the link below to acknowledge receipt of your assigned keys. This link expires in 48 hours.</p>
      <a href="${magicLink}" style="display:inline-block;padding:12px 24px;background:#C0272D;color:#fff;text-decoration:none;border-radius:4px">Acknowledge Key Receipt</a>
      <p style="color:#6b6b68;font-size:12px">City Wide Building Services · Boston, MA</p>
    `,
  });
}

// ── Unified delivery ─────────────────────────────────────────────────────────
// One entry point for every outbound message, so callers compose a message and
// never a transport. Both paths raise on failure with the SAME enriched shape
// (message, code, responseCode, command, response), because the diagnosis is
// the point and it must read the same whichever provider produced it.

export interface MailAttachmentInput {
  filename: string;
  content: Buffer;
  contentType?: string;
  /** Set for an inline image referenced as cid:<id> in the HTML. */
  cid?: string;
}

export interface DeliverInput {
  from: string;
  replyTo?: string | null;
  to: string[];
  subject: string;
  text: string;
  html: string;
  attachments?: MailAttachmentInput[];
}

export interface DeliverOutcome {
  provider: MailProvider;
  messageId?: string;
  /** The provider's own acceptance line, verbatim. */
  response?: string;
}

/** Attach code/response/command to an Error so the formatter can read them. */
function enrich(err: any, extra: Record<string, any>): Error {
  const e = err instanceof Error ? err : new Error(String(err));
  for (const [k, v] of Object.entries(extra)) if (v !== undefined) (e as any)[k] = v;
  return e;
}

async function deliverViaResend(input: DeliverInput): Promise<DeliverOutcome> {
  const key = trimmed(process.env.RESEND_API_KEY);
  if (!key) throw enrich(new Error('RESEND_API_KEY is not set'), { code: 'ENOKEY' });

  const body: Record<string, any> = {
    from: input.from,
    to: input.to,
    subject: input.subject,
    text: input.text,
    html: input.html,
  };
  if (input.replyTo) body.reply_to = input.replyTo;
  if (input.attachments?.length) {
    body.attachments = input.attachments.map((a) => ({
      filename: a.filename,
      content: a.content.toString('base64'),
      ...(a.contentType ? { content_type: a.contentType } : {}),
      // Resend's inline-image form. The branded shell references the logo as
      // cid:cwlogo; without this it would arrive as a broken image.
      ...(a.cid ? { content_id: a.cid } : {}),
    }));
  }

  let res: Response;
  try {
    res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err: any) {
    // DNS, TLS or egress problems reaching the API at all.
    throw enrich(err, { code: err?.code ?? 'EFETCH', command: 'POST /emails' });
  }

  const raw = await res.text();
  let parsed: any = null;
  try { parsed = raw ? JSON.parse(raw) : null; } catch { /* keep the raw text */ }

  if (!res.ok) {
    // Resend answers with { statusCode, name, message }. Keep all of it: the
    // name is what separates a missing domain from a bad key from a bad body.
    const message = parsed?.message || raw || `${res.status} ${res.statusText}`;
    throw enrich(new Error(message), {
      code: parsed?.name ?? `HTTP_${res.status}`,
      responseCode: res.status,
      command: 'POST /emails',
      response: raw ? raw.trim() : `${res.status} ${res.statusText}`,
    });
  }

  return {
    provider: 'resend',
    messageId: parsed?.id ? `<${parsed.id}@resend>` : undefined,
    response: parsed?.id ? `202 Accepted · Resend id ${parsed.id}` : `${res.status} ${res.statusText}`,
  };
}

async function deliverViaSmtp(input: DeliverInput): Promise<DeliverOutcome> {
  const info: any = await createTransport().sendMail({
    from: input.from,
    ...(input.replyTo ? { replyTo: input.replyTo } : {}),
    to: input.to.join(', '),
    subject: input.subject,
    text: input.text,
    html: input.html,
    attachments: (input.attachments ?? []).map((a) => ({
      filename: a.filename,
      content: a.content,
      ...(a.contentType ? { contentType: a.contentType } : {}),
      ...(a.cid ? { cid: a.cid, contentDisposition: 'inline' as const } : {}),
    })),
  });
  return { provider: 'smtp', messageId: info?.messageId, response: info?.response };
}

export async function deliverMessage(input: DeliverInput): Promise<DeliverOutcome> {
  const { provider } = activeProvider();
  return provider === 'resend' ? deliverViaResend(input) : deliverViaSmtp(input);
}

/** Why the active provider cannot send, or null when it can. */
export function providerBlocker(): string | null {
  const { provider } = activeProvider();
  if (provider === 'resend') {
    if (!resendConfig().apiKeySet) return 'Resend is selected but RESEND_API_KEY is not set';
    if (!fromConfig().address) return 'Resend is selected but no From address could be resolved';
    return null;
  }
  const s = smtpConfig();
  if (!s.user || !s.hasPassword) return 'SMTP is not configured (SMTP_USER / SMTP_PASS unset)';
  return null;
}
