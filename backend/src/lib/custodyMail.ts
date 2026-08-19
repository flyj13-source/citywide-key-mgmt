import fs from 'fs';
import path from 'path';
import { createTransport } from './mailer';
import type { KeyLine } from './custody';

// ── CW-branded custody notifications ─────────────────────────────────────────
// Check-out and check-in both notify the holder AND Cara. The markup mirrors the
// launch email template: white card on a light page, charcoal header bar with
// the CW logo, a red accent stripe, charcoal table head, red totals.
//
// Sends NEVER fail silently: every attempt returns a MailResult that the route
// writes to audit_log and surfaces to the UI.

const CW_RED = '#C0272D';
const CW_CHARCOAL = '#1a1a1a';
const CW_BG = '#f4f4f2';
const CW_BORDER = '#e0e0dd';
const CW_MUTED = '#6b6b68';

/** Where the "and Cara" copy of every custody email goes. */
export function caraAddress(): string {
  return process.env.CARA_EMAIL || process.env.SMTP_USER || 'cara@citywideboston.com';
}

// Same resolution order as the PDF branding — the logo is bundled under
// backend/src/assets so Render serves it without a network fetch. Missing logo
// degrades to a text wordmark, never an exception.
const LOGO_CANDIDATES = [
  path.join(__dirname, '../assets/cw-logo.png'),
  path.join(__dirname, '../../src/assets/cw-logo.png'),
  path.join(process.cwd(), 'src/assets/cw-logo.png'),
];
let cachedLogo: Buffer | null | undefined;
function logoBytes(): Buffer | null {
  if (cachedLogo !== undefined) return cachedLogo;
  for (const p of LOGO_CANDIDATES) {
    try {
      if (fs.existsSync(p)) { cachedLogo = fs.readFileSync(p); return cachedLogo; }
    } catch { /* try next */ }
  }
  cachedLogo = null;
  return null;
}

const esc = (v: any): string =>
  String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// New rows carry an ISO timestamp; older ones carry SQLite's 'YYYY-MM-DD
// HH:MM:SS' in UTC with no zone marker. Normalize before formatting.
const hasZone = (s: string) => /[Tt]/.test(s) || /[Zz]$/.test(s) || /[+-]\d{2}:?\d{2}$/.test(s);

const fmtDate = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  const d = new Date(hasZone(iso) ? iso : `${iso.replace(' ', 'T')}Z`);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString('en-US', {
    timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
};

const fmtDay = (iso: string | null | undefined): string => {
  if (!iso) return 'No due date';
  const d = new Date(hasZone(iso) ? iso : `${iso}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric' });
};

function keyRows(keys: KeyLine[]): string {
  if (!keys.length) return `<tr><td colspan="2" style="padding:10px 14px;color:${CW_MUTED}">No key types recorded</td></tr>`;
  return keys.map((k, i) => `
    <tr style="background:${i % 2 === 0 ? '#ffffff' : CW_BG}">
      <td style="padding:10px 14px;border-top:1px solid ${CW_BORDER};color:${CW_CHARCOAL}">${esc(k.label)}</td>
      <td style="padding:10px 14px;border-top:1px solid ${CW_BORDER};text-align:right;font-weight:700;color:${CW_CHARCOAL}">${k.qty}</td>
    </tr>`).join('');
}

function detailRows(pairs: [string, string][]): string {
  return pairs.map(([label, value]) => `
    <tr>
      <td style="padding:5px 0;color:${CW_MUTED};font-size:13px;width:150px;vertical-align:top">${esc(label)}</td>
      <td style="padding:5px 0;color:${CW_CHARCOAL};font-size:13px;font-weight:600">${esc(value)}</td>
    </tr>`).join('');
}

export function brandedShell(title: string, subtitle: string, body: string, hasLogo = !!logoBytes()): string {
  const brand = hasLogo
    ? `<div style="background:#ffffff;border-radius:4px;padding:8px 12px;display:inline-block">
         <img src="cid:cwlogo" alt="City Wide Building Services" width="132" style="display:block;width:132px;height:auto" />
       </div>`
    : `<div style="color:#ffffff;font-weight:700;font-size:16px;letter-spacing:.5px">CITY WIDE BUILDING SERVICES</div>`;

  return `<!doctype html>
<html><body style="margin:0;padding:0;background:${CW_BG};font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${CW_BG};padding:24px 12px">
    <tr><td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border:1px solid ${CW_BORDER};border-radius:6px;overflow:hidden">
        <tr><td style="background:${CW_CHARCOAL};padding:20px 24px">
          ${brand}
          <div style="color:#9a9a97;font-size:11px;letter-spacing:2px;text-transform:uppercase;margin-top:10px">Boston · Key Management</div>
        </td></tr>
        <tr><td style="background:${CW_RED};height:4px;line-height:4px;font-size:0">&nbsp;</td></tr>
        <tr><td style="padding:24px">
          <h1 style="margin:0 0 4px;font-size:19px;color:${CW_CHARCOAL}">${esc(title)}</h1>
          <p style="margin:0 0 20px;font-size:13px;color:${CW_MUTED}">${esc(subtitle)}</p>
          ${body}
        </td></tr>
        <tr><td style="background:${CW_BG};border-top:1px solid ${CW_BORDER};padding:16px 24px;color:${CW_MUTED};font-size:11px">
          City Wide Building Services · Boston, MA<br />
          Sent automatically by the City Wide Key Management System.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

export interface MailResult {
  ok: boolean;
  recipients: string[];
  error?: string;
  skipped?: boolean;
}

export interface CheckoutMail {
  holder: string;
  holderEmail: string | null;
  client: string;
  keys: KeyLine[];
  checkedOutAt: string;
  dueAt: string | null;
  recordedBy: string;
  onBehalf: boolean;
  signoffLink: string | null;
}

export interface CheckinMail {
  holder: string;
  holderEmail: string | null;
  client: string;
  keys: KeyLine[];
  returnedAt: string;
  condition: string;
  recordedBy: string;
  onBehalf: boolean;
}

// Shared send path: builds recipients (holder + Cara), attaches the inline
// logo, and converts any transport error into a reported failure.
export async function sendBranded(subject: string, html: string, text: string, to: string[]): Promise<MailResult> {
  const recipients = Array.from(new Set(to.filter(Boolean).map((t) => t.trim()).filter(Boolean)));
  if (!recipients.length) {
    return { ok: false, recipients: [], skipped: true, error: 'No recipient address on file' };
  }
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    return { ok: false, recipients, skipped: true, error: 'SMTP is not configured (SMTP_USER / SMTP_PASS unset)' };
  }
  const logo = logoBytes();
  try {
    await createTransport().sendMail({
      from: `City Wide Key Management <${process.env.SMTP_USER}>`,
      to: recipients.join(', '),
      subject,
      text,
      html,
      attachments: logo
        ? [{ filename: 'cw-logo.png', content: logo, cid: 'cwlogo', contentDisposition: 'inline' as const }]
        : [],
    });
    return { ok: true, recipients };
  } catch (err: any) {
    return { ok: false, recipients, error: err?.message || 'SMTP send failed' };
  }
}

export async function sendCheckoutNotice(d: CheckoutMail): Promise<MailResult> {
  const subject = `Keys checked out — ${d.client}`;
  const recordedLine: [string, string][] = d.onBehalf
    ? [['Recorded by', `${d.recordedBy} (on behalf of ${d.holder})`]]
    : [['Recorded by', d.recordedBy]];

  const signoff = d.signoffLink
    ? `<div style="margin-top:24px;padding:18px;border:1px solid ${CW_BORDER};border-left:4px solid ${CW_RED};border-radius:4px;background:${CW_BG}">
         <div style="font-weight:700;color:${CW_CHARCOAL};font-size:14px;margin-bottom:6px">Signature required</div>
         <p style="margin:0 0 14px;font-size:13px;color:${CW_MUTED}">
           Please acknowledge receipt of these keys. No login is needed — the link expires in 48 hours.
         </p>
         <a href="${esc(d.signoffLink)}" style="display:inline-block;padding:12px 22px;background:${CW_RED};color:#ffffff;text-decoration:none;border-radius:4px;font-weight:600;font-size:14px">Sign for these keys</a>
         <p style="margin:14px 0 0;font-size:11px;color:${CW_MUTED};word-break:break-all">${esc(d.signoffLink)}</p>
       </div>`
    : '';

  const html = brandedShell(
    'Keys checked out',
    `${d.holder} has keys checked out for ${d.client}.`,
    `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin-bottom:20px">
       ${detailRows([
         ['Holder', d.holder],
         ['Client', d.client],
         ['Date out', fmtDate(d.checkedOutAt)],
         ['Due back', fmtDay(d.dueAt)],
         ...recordedLine,
       ])}
     </table>
     <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border:1px solid ${CW_BORDER};border-radius:4px;border-collapse:separate;overflow:hidden">
       <tr style="background:${CW_CHARCOAL};color:#ffffff;font-size:12px;text-transform:uppercase;letter-spacing:1px">
         <th align="left" style="padding:10px 14px;font-weight:600">Key type</th>
         <th align="right" style="padding:10px 14px;font-weight:600">Qty</th>
       </tr>
       ${keyRows(d.keys)}
       <tr style="background:${CW_BG}">
         <td style="padding:10px 14px;border-top:2px solid ${CW_RED};font-weight:700;color:${CW_CHARCOAL}">Total</td>
         <td style="padding:10px 14px;border-top:2px solid ${CW_RED};text-align:right;font-weight:700;color:${CW_RED}">${d.keys.reduce((n, k) => n + k.qty, 0)}</td>
       </tr>
     </table>
     ${signoff}`,
    !!logoBytes(),
  );

  const text = [
    `Keys checked out — ${d.client}`,
    `Holder: ${d.holder}`,
    `Client: ${d.client}`,
    `Date out: ${fmtDate(d.checkedOutAt)}`,
    `Due back: ${fmtDay(d.dueAt)}`,
    `Recorded by: ${d.recordedBy}${d.onBehalf ? ` (on behalf of ${d.holder})` : ''}`,
    '',
    'Keys:',
    ...d.keys.map((k) => `  ${k.qty} × ${k.label}`),
    ...(d.signoffLink ? ['', `Sign for these keys (expires in 48 hours): ${d.signoffLink}`] : []),
  ].join('\n');

  return sendBranded(subject, html, text, [d.holderEmail || '', caraAddress()]);
}

export async function sendCheckinNotice(d: CheckinMail): Promise<MailResult> {
  const subject = `Keys returned — ${d.client}`;
  const html = brandedShell(
    'Keys returned',
    `${d.holder} has returned keys for ${d.client}. No signature is required.`,
    `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin-bottom:20px">
       ${detailRows([
         ['Holder', d.holder],
         ['Client', d.client],
         ['Date returned', fmtDate(d.returnedAt)],
         ['Condition', d.condition],
         ['Recorded by', d.onBehalf ? `${d.recordedBy} (on behalf of ${d.holder})` : d.recordedBy],
       ])}
     </table>
     <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border:1px solid ${CW_BORDER};border-radius:4px;border-collapse:separate;overflow:hidden">
       <tr style="background:${CW_CHARCOAL};color:#ffffff;font-size:12px;text-transform:uppercase;letter-spacing:1px">
         <th align="left" style="padding:10px 14px;font-weight:600">Key type returned</th>
         <th align="right" style="padding:10px 14px;font-weight:600">Qty</th>
       </tr>
       ${keyRows(d.keys)}
       <tr style="background:${CW_BG}">
         <td style="padding:10px 14px;border-top:2px solid ${CW_RED};font-weight:700;color:${CW_CHARCOAL}">Total</td>
         <td style="padding:10px 14px;border-top:2px solid ${CW_RED};text-align:right;font-weight:700;color:${CW_RED}">${d.keys.reduce((n, k) => n + k.qty, 0)}</td>
       </tr>
     </table>
     <p style="margin:20px 0 0;font-size:12px;color:${CW_MUTED}">This is a confirmation only — no signature is required for a return.</p>`,
    !!logoBytes(),
  );

  const text = [
    `Keys returned — ${d.client}`,
    `Holder: ${d.holder}`,
    `Client: ${d.client}`,
    `Date returned: ${fmtDate(d.returnedAt)}`,
    `Condition: ${d.condition}`,
    `Recorded by: ${d.recordedBy}${d.onBehalf ? ` (on behalf of ${d.holder})` : ''}`,
    '',
    'Keys returned:',
    ...d.keys.map((k) => `  ${k.qty} × ${k.label}`),
    '',
    'No signature is required for a return.',
  ].join('\n');

  return sendBranded(subject, html, text, [d.holderEmail || '', caraAddress()]);
}
