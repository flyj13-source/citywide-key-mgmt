import fs from 'fs';
import path from 'path';
import { createTransport } from './mailer';
import { custodyNotifyRecipients, custodyNotifyDisplay } from './settings';
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

/**
 * Where the "and Cara" copy of every custody email goes. Read from the settings
 * table (Settings → Key custody notifications), NOT from a constant or an env
 * var, so the address survives a staff change without a redeploy.
 */
export function notifyAddresses(): string[] {
  return custodyNotifyRecipients();
}

/** Display form of the same list — what the UI echoes back after a send. */
export function caraAddress(): string {
  return custodyNotifyDisplay();
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

/** Backoff between SMTP retries: ~1s, then ~4s. */
const RETRY_BACKOFF_MS = [1000, 4000];
const MAX_SEND_ATTEMPTS = 3;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface MailResult {
  ok: boolean;
  recipients: string[];
  error?: string;
  skipped?: boolean;
  /** How many send attempts were made (0 when skipped before trying). */
  attempts: number;
}

export interface MailAttachment {
  filename: string;
  content: Buffer;
  contentType?: string;
}

/** Fields every custody notification carries about WHO and WHERE. */
interface CustodyParty {
  holder: string;
  holderEmail: string | null;
  holderType: 'employee' | 'ic' | null;
  client: string;
  bcNumber: string | null;
}

export interface CheckoutMail extends CustodyParty {
  keys: KeyLine[];
  checkedOutAt: string;
  dueAt: string | null;
  recordedBy: string;
  onBehalf: boolean;
  signoffLink: string | null;
  /** Set when this check-out is the receiving half of a person-to-person transfer. */
  transferFrom?: string | null;
  /** Set when the holder has no email — the recipient is told plainly why
   *  nothing was sent, so an unsigned release cannot pass unnoticed. */
  noEmailReason?: string | null;
}

export interface CheckinMail extends CustodyParty {
  keys: KeyLine[];
  returnedAt: string;
  condition: string;
  recordedBy: string;
  onBehalf: boolean;
  signoffLink: string | null;
  /** Set when this return is the releasing half of a person-to-person transfer. */
  transferTo?: string | null;
}

export interface SignedReceiptMail extends CustodyParty {
  action: 'checkout' | 'checkin' | 'established';
  keys: KeyLine[];
  signedAt: string;
  pdf: MailAttachment | null;
  pdfError?: string | null;
  /** Recorded when a manager captured a wet signature on a device at handover. */
  witnessedBy?: string | null;
  /** The other side of a person-to-person transfer — they receive it too, so
   *  both parties end up holding both receipts. */
  counterpartyName?: string | null;
  counterpartyEmail?: string | null;
}

export const holderTypeLabel = (t: 'employee' | 'ic' | null | undefined): string =>
  t === 'ic' ? 'Independent Contractor (IC)' : t === 'employee' ? 'City Wide Employee' : 'Unspecified';

/** Holder + client, the shape every custody subject line uses. */
const subjectFor = (lead: string, holder: string, client: string): string =>
  `${lead} — ${holder} — ${client}`;

/** The identity block shared by every custody email. */
function partyRows(d: CustodyParty): [string, string][] {
  return [
    ['Holder', `${d.holder} (${holderTypeLabel(d.holderType)})`],
    ['Client', d.bcNumber ? `${d.client} (BC #${d.bcNumber})` : d.client],
  ];
}

function keyTable(keys: KeyLine[], header: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border:1px solid ${CW_BORDER};border-radius:4px;border-collapse:separate;overflow:hidden">
       <tr style="background:${CW_CHARCOAL};color:#ffffff;font-size:12px;text-transform:uppercase;letter-spacing:1px">
         <th align="left" style="padding:10px 14px;font-weight:600">${esc(header)}</th>
         <th align="right" style="padding:10px 14px;font-weight:600">Qty</th>
       </tr>
       ${keyRows(keys)}
       <tr style="background:${CW_BG}">
         <td style="padding:10px 14px;border-top:2px solid ${CW_RED};font-weight:700;color:${CW_CHARCOAL}">Total</td>
         <td style="padding:10px 14px;border-top:2px solid ${CW_RED};text-align:right;font-weight:700;color:${CW_RED}">${keys.reduce((n, k) => n + k.qty, 0)}</td>
       </tr>
     </table>`;
}

/**
 * The red "sign here" call-to-action. Wording differs by direction so the
 * signer is never asked to acknowledge RECEIVING keys they are handing back.
 */
function signoffBlock(link: string, action: 'checkout' | 'checkin' | 'established'): string {
  // An opening balance confirms keys the holder ALREADY has. Asking them to
  // acknowledge "receiving" would date the custody to today and misstate it.
  const line = action === 'checkout'
    ? 'Please acknowledge that you are RECEIVING these keys.'
    : action === 'checkin'
      ? 'Please acknowledge that you are RETURNING these keys.'
      : 'Please confirm that you CURRENTLY HOLD these keys.';
  return `<div style="margin-top:24px;padding:18px;border:1px solid ${CW_BORDER};border-left:4px solid ${CW_RED};border-radius:4px;background:${CW_BG}">
         <div style="font-weight:700;color:${CW_CHARCOAL};font-size:14px;margin-bottom:6px">Signature required</div>
         <p style="margin:0 0 14px;font-size:13px;color:${CW_MUTED}">
           ${esc(line)} No login is needed — the link expires in 48 hours.
         </p>
         <a href="${esc(link)}" style="display:inline-block;padding:12px 22px;background:${CW_RED};color:#ffffff;text-decoration:none;border-radius:4px;font-weight:600;font-size:14px">Sign for these keys</a>
         <p style="margin:14px 0 0;font-size:11px;color:${CW_MUTED};word-break:break-all">${esc(link)}</p>
       </div>`;
}

// Shared send path: de-duplicates recipients, attaches the inline logo (plus any
// document attachment), and converts any transport error into a REPORTED
// failure. Nothing here ever throws — a caller always gets a MailResult it can
// write to audit_log and show in the UI.
export async function sendBranded(
  subject: string, html: string, text: string, to: string[], attachments: MailAttachment[] = [],
): Promise<MailResult> {
  const recipients = Array.from(new Set(to.filter(Boolean).map((t) => t.trim()).filter(Boolean)));
  if (!recipients.length) {
    return { ok: false, recipients: [], skipped: true, attempts: 0, error: 'No recipient address on file' };
  }
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    return { ok: false, recipients, skipped: true, attempts: 0, error: 'SMTP is not configured (SMTP_USER / SMTP_PASS unset)' };
  }
  const logo = logoBytes();
  const payload = {
    from: `City Wide Key Management <${process.env.SMTP_USER}>`,
    to: recipients.join(', '),
    subject,
    text,
    html,
    attachments: [
      ...(logo
        ? [{ filename: 'cw-logo.png', content: logo, cid: 'cwlogo', contentDisposition: 'inline' as const }]
        : []),
      ...attachments.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType })),
    ],
  };

  // A transient SMTP hiccup must not become a permanently unsigned record, so
  // retry with backoff before reporting failure. Only after the last attempt
  // does the caller mark the record 'signature_send_failed'.
  let lastError = 'SMTP send failed';
  for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt++) {
    try {
      await createTransport().sendMail(payload);
      return { ok: true, recipients, attempts: attempt };
    } catch (err: any) {
      lastError = err?.message || 'SMTP send failed';
      if (attempt < MAX_SEND_ATTEMPTS) await sleep(RETRY_BACKOFF_MS[attempt - 1] ?? 4000);
    }
  }
  return { ok: false, recipients, attempts: MAX_SEND_ATTEMPTS, error: lastError };
}

export async function sendCheckoutNotice(d: CheckoutMail): Promise<MailResult> {
  // No holder email means no signature request went anywhere. Lead the email
  // with that, in red, so it can never be mistaken for a signature in flight.
  const noEmailBanner = !d.holderEmail
    ? `<div style="margin:0 0 20px;padding:16px;border:2px solid ${CW_RED};border-radius:4px;background:#fbeaea">
         <div style="font-weight:700;color:${CW_RED};font-size:15px;margin-bottom:4px">
           No signature sent — ${esc(d.holder)} has no email on file.
         </div>
         <p style="margin:0;font-size:13px;color:${CW_CHARCOAL}">
           This record needs manual follow-up: add an email to their record and resend, or capture a
           signature in person from the Key Registry.
         </p>
         ${d.noEmailReason ? `<p style="margin:8px 0 0;font-size:12px;color:${CW_MUTED}">Reason given: ${esc(d.noEmailReason)}</p>` : ''}
       </div>`
    : '';

  const subject = subjectFor('Keys checked out', d.holder, d.client);
  const recorded: [string, string] = d.onBehalf
    ? ['Recorded by', `${d.recordedBy} (on behalf of ${d.holder})`]
    : ['Recorded by', d.recordedBy];

  const transferNote = d.transferFrom
    ? `<p style="margin:0 0 16px;font-size:13px;color:${CW_CHARCOAL};background:${CW_BG};border-left:4px solid ${CW_RED};padding:10px 14px;border-radius:3px">
         Received directly from <strong>${esc(d.transferFrom)}</strong> — person-to-person transfer.
       </p>`
    : '';

  const html = brandedShell(
    'Keys checked out',
    `${d.holder} has keys checked out for ${d.client}.`,
    `${noEmailBanner}${transferNote}
     <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin-bottom:20px">
       ${detailRows([
         ...partyRows(d),
         ['Date out', fmtDate(d.checkedOutAt)],
         ['Due back', fmtDay(d.dueAt)],
         recorded,
       ])}
     </table>
     ${keyTable(d.keys, 'Key type')}
     ${d.signoffLink ? signoffBlock(d.signoffLink, 'checkout') : ''}`,
    !!logoBytes(),
  );

  const text = [
    subject,
    ...(!d.holderEmail
      ? [`** NO SIGNATURE SENT — ${d.holder} has no email on file. Manual follow-up required. **`,
         ...(d.noEmailReason ? [`   Reason given: ${d.noEmailReason}`] : []), '']
      : []),
    ...(d.transferFrom ? [`Received directly from ${d.transferFrom} (person-to-person transfer).`, ''] : []),
    `Holder: ${d.holder} (${holderTypeLabel(d.holderType)})`,
    `Client: ${d.client}${d.bcNumber ? ` (BC #${d.bcNumber})` : ''}`,
    `Date out: ${fmtDate(d.checkedOutAt)}`,
    `Due back: ${fmtDay(d.dueAt)}`,
    `Recorded by: ${d.recordedBy}${d.onBehalf ? ` (on behalf of ${d.holder})` : ''}`,
    '',
    'Keys:',
    ...d.keys.map((k) => `  ${k.qty} × ${k.label}`),
    ...(d.signoffLink ? ['', `Sign for these keys (expires in 48 hours): ${d.signoffLink}`] : []),
  ].join('\n');

  return sendBranded(subject, html, text, [d.holderEmail || '', ...notifyAddresses()]);
}

/**
 * Opening balance: the holder already has these keys. Everything here says
 * "currently holds", never "received" — the custody predates this record, and
 * wording it as a hand-over would misstate when it began.
 */
export interface EstablishMail extends CustodyParty {
  keys: KeyLine[];
  /** Every client this one acknowledgement covers (bulk rollout). */
  sites?: { client: string; bcNumber?: string | null; keys: KeyLine[] }[];
  recordedAt: string;
  heldSince: string | null;
  recordedBy: string;
  notes?: string | null;
  signoffLink: string | null;
  noEmailReason?: string | null;
}

export async function sendEstablishNotice(d: EstablishMail): Promise<MailResult> {
  const multi = !!(d.sites && d.sites.length > 1);
  const clientLabel = multi ? `${d.sites!.length} client sites` : d.client;

  const noEmailBanner = !d.holderEmail
    ? `<div style="margin:0 0 20px;padding:16px;border:2px solid ${CW_RED};border-radius:4px;background:#fbeaea">
         <div style="font-weight:700;color:${CW_RED};font-size:15px;margin-bottom:4px">
           No signature sent — ${esc(d.holder)} has no email on file.
         </div>
         <p style="margin:0;font-size:13px;color:${CW_CHARCOAL}">
           The custody record exists, but nobody has acknowledged it. Add an email and resend, or
           capture a signature in person from the Key Registry.
         </p>
         ${d.noEmailReason ? `<p style="margin:8px 0 0;font-size:12px;color:${CW_MUTED}">Reason given: ${esc(d.noEmailReason)}</p>` : ''}
       </div>`
    : '';

  const subject = subjectFor('Key custody recorded', d.holder, clientLabel);

  // An opening balance is not a transaction — say so plainly, so nobody reads
  // this as "keys went out today".
  const openingNote = `<p style="margin:0 0 16px;font-size:13px;color:${CW_CHARCOAL};background:${CW_BG};border-left:4px solid ${CW_RED};padding:10px 14px;border-radius:3px">
       This is an <strong>opening balance</strong> — a record of keys ${esc(d.holder)} already holds.
       No keys changed hands today.
     </p>`;

  const siteTables = multi
    ? d.sites!.map((sN) => `<div style="margin-bottom:16px">
         <div style="font-weight:700;color:${CW_RED};font-size:13px;margin-bottom:6px">
           ${esc(sN.client)}${sN.bcNumber ? ` (BC #${esc(sN.bcNumber)})` : ''}
         </div>
         ${keyTable(sN.keys, 'Key type held')}
       </div>`).join('')
    : keyTable(d.keys, 'Key type held');

  const html = brandedShell(
    'Key custody recorded',
    `${d.holder} currently holds keys for ${clientLabel}.`,
    `${noEmailBanner}${openingNote}
     <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin-bottom:20px">
       ${detailRows([
         ['Holder', `${d.holder} (${holderTypeLabel(d.holderType)})`],
         [multi ? 'Clients' : 'Client',
           multi ? clientLabel : (d.bcNumber ? `${d.client} (BC #${d.bcNumber})` : d.client)],
         ['Keys held since', d.heldSince ? `${fmtDay(d.heldSince)} (approximate)` : 'Not stated'],
         ['Recorded', fmtDate(d.recordedAt)],
         ['Recorded by', d.recordedBy],
         ...(d.notes ? [['Notes', d.notes] as [string, string]] : []),
       ])}
     </table>
     ${siteTables}
     ${d.signoffLink ? signoffBlock(d.signoffLink, 'established') : ''}`,
    !!logoBytes(),
  );

  const text = [
    subject,
    ...(!d.holderEmail
      ? [`** NO SIGNATURE SENT — ${d.holder} has no email on file. Manual follow-up required. **`,
         ...(d.noEmailReason ? [`   Reason given: ${d.noEmailReason}`] : []), '']
      : []),
    'This is an OPENING BALANCE — keys already held. No keys changed hands today.',
    '',
    `Holder: ${d.holder} (${holderTypeLabel(d.holderType)})`,
    `${multi ? 'Clients' : 'Client'}: ${multi ? clientLabel : d.client}${!multi && d.bcNumber ? ` (BC #${d.bcNumber})` : ''}`,
    `Keys held since: ${d.heldSince ? `${fmtDay(d.heldSince)} (approximate)` : 'Not stated'}`,
    `Recorded by: ${d.recordedBy}`,
    ...(d.notes ? [`Notes: ${d.notes}`] : []),
    '',
    ...(multi
      ? d.sites!.flatMap((sN) => [`${sN.client}:`, ...sN.keys.map((k) => `  ${k.qty} × ${k.label}`)])
      : ['Keys currently held:', ...d.keys.map((k) => `  ${k.qty} × ${k.label}`)]),
    ...(d.signoffLink
      ? ['', `Confirm you hold these keys (expires in 48 hours): ${d.signoffLink}`] : []),
  ].join('\n');

  return sendBranded(subject, html, text, [d.holderEmail || '', ...notifyAddresses()]);
}

export async function sendCheckinNotice(d: CheckinMail): Promise<MailResult> {
  const subject = subjectFor('Keys returned', d.holder, d.client);

  const transferNote = d.transferTo
    ? `<p style="margin:0 0 16px;font-size:13px;color:${CW_CHARCOAL};background:${CW_BG};border-left:4px solid ${CW_RED};padding:10px 14px;border-radius:3px">
         Handed directly to <strong>${esc(d.transferTo)}</strong> — person-to-person transfer.
       </p>`
    : '';

  const html = brandedShell(
    'Keys returned',
    `${d.holder} has returned keys for ${d.client}.`,
    `${transferNote}
     <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin-bottom:20px">
       ${detailRows([
         ...partyRows(d),
         ['Date returned', fmtDate(d.returnedAt)],
         ['Condition', d.condition],
         ['Recorded by', d.onBehalf ? `${d.recordedBy} (on behalf of ${d.holder})` : d.recordedBy],
       ])}
     </table>
     ${keyTable(d.keys, 'Key type returned')}
     ${d.signoffLink ? signoffBlock(d.signoffLink, 'checkin') : ''}`,
    !!logoBytes(),
  );

  const text = [
    subject,
    ...(d.transferTo ? [`Handed directly to ${d.transferTo} (person-to-person transfer).`, ''] : []),
    `Holder: ${d.holder} (${holderTypeLabel(d.holderType)})`,
    `Client: ${d.client}${d.bcNumber ? ` (BC #${d.bcNumber})` : ''}`,
    `Date returned: ${fmtDate(d.returnedAt)}`,
    `Condition: ${d.condition}`,
    `Recorded by: ${d.recordedBy}${d.onBehalf ? ` (on behalf of ${d.holder})` : ''}`,
    '',
    'Keys returned:',
    ...d.keys.map((k) => `  ${k.qty} × ${k.label}`),
    ...(d.signoffLink ? ['', `Sign for this return (expires in 48 hours): ${d.signoffLink}`] : []),
  ].join('\n');

  return sendBranded(subject, html, text, [d.holderEmail || '', ...notifyAddresses()]);
}

/**
 * The signed PDF receipt, emailed the moment a signature lands — to the
 * notification recipient AND back to the signer, so both ends hold the same
 * document. A PDF that failed to render still sends the notification, with the
 * failure stated in the body rather than an email that quietly has no
 * attachment.
 */
export async function sendSignedReceipt(d: SignedReceiptMail): Promise<MailResult> {
  const subject = subjectFor(
    d.action === 'established' ? 'Signed key custody acknowledgement' : 'Signed key receipt',
    d.holder, d.client,
  );
  const actionLine = d.action === 'checkout'
    ? `${d.holder} has signed for RECEIVING these keys.`
    : d.action === 'checkin'
      ? `${d.holder} has signed for RETURNING these keys.`
      : `${d.holder} has confirmed CURRENTLY HOLDING these keys.`;

  const attachNote = d.pdf
    ? `<p style="margin:20px 0 0;font-size:12px;color:${CW_MUTED}">The signed PDF receipt is attached to this email.</p>`
    : `<p style="margin:20px 0 0;font-size:12px;color:#7a5a00;background:#fff8e6;border:1px solid #e8cf8a;border-radius:4px;padding:10px 12px">
         The signature was recorded successfully, but the PDF receipt could not be generated${d.pdfError ? ` (${esc(d.pdfError)})` : ''}.
         The signature and its SHA-256 hash are stored on the assignment record.
       </p>`;

  const html = brandedShell(
    'Signed key receipt',
    actionLine,
    `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin-bottom:20px">
       ${detailRows([
         ...partyRows(d),
         ['Action', d.action === 'checkout' ? 'Received keys'
           : d.action === 'checkin' ? 'Returned keys' : 'Confirmed keys already held'],
         ['Signed', fmtDate(d.signedAt)],
         ...(d.witnessedBy
           ? [['Witnessed by', `${d.witnessedBy} (signed in person)`] as [string, string]] : []),
         ...(d.counterpartyName
           ? [[d.action === 'checkout' ? 'Handed over by' : 'Handed over to', d.counterpartyName] as [string, string]] : []),
       ])}
     </table>
     ${keyTable(d.keys, d.action === 'checkout' ? 'Key type received'
       : d.action === 'checkin' ? 'Key type returned' : 'Key type held')}
     ${attachNote}`,
    !!logoBytes(),
  );

  const text = [
    subject,
    actionLine,
    `Holder: ${d.holder} (${holderTypeLabel(d.holderType)})`,
    `Client: ${d.client}${d.bcNumber ? ` (BC #${d.bcNumber})` : ''}`,
    `Signed: ${fmtDate(d.signedAt)}`,
    ...(d.witnessedBy ? [`Witnessed by: ${d.witnessedBy} (signed in person)`] : []),
    ...(d.counterpartyName
      ? [`${d.action === 'checkout' ? 'Handed over by' : 'Handed over to'}: ${d.counterpartyName}`] : []),
    '',
    'Keys:',
    ...d.keys.map((k) => `  ${k.qty} × ${k.label}`),
    '',
    d.pdf
      ? 'The signed PDF receipt is attached.'
      : `The signature was recorded, but the PDF receipt could not be generated${d.pdfError ? ` (${d.pdfError})` : ''}.`,
  ].join('\n');

  // Three recipients: the signer (their own proof), the custody notification
  // address from Settings, and the counterparty on a transfer.
  return sendBranded(
    subject, html, text,
    [d.holderEmail || '', ...notifyAddresses(), d.counterpartyEmail || ''],
    d.pdf ? [{ ...d.pdf, contentType: 'application/pdf' }] : [],
  );
}
