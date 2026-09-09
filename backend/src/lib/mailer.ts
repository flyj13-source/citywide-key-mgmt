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
  addressSource: 'MAIL_FROM_ADDRESS' | 'SMTP_USER' | 'unset';
  nameSource: 'MAIL_FROM_NAME' | 'default';
  /** True when the From address is not the authenticated mailbox. */
  mismatch: boolean;
}

export function fromConfig(): FromConfig {
  const name = trimmed(process.env.MAIL_FROM_NAME) ?? DEFAULT_FROM_NAME;
  const user = trimmed(process.env.SMTP_USER);
  const override = trimmed(process.env.MAIL_FROM_ADDRESS);
  const address = override ?? user;
  return {
    name,
    address,
    header: address ? `${name} <${address}>` : null,
    replyTo: trimmed(process.env.MAIL_REPLY_TO),
    addressSource: override ? 'MAIL_FROM_ADDRESS' : user ? 'SMTP_USER' : 'unset',
    nameSource: trimmed(process.env.MAIL_FROM_NAME) ? 'MAIL_FROM_NAME' : 'default',
    mismatch: !!override && !!user && override.toLowerCase() !== user.toLowerCase(),
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
