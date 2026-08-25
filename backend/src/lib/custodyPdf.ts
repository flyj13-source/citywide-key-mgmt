import { PDFDocument, StandardFonts } from 'pdf-lib';
import fs from 'fs';
import path from 'path';
import {
  CW_RED, CW_CHARCOAL, CW_GRAY, CW_BORDER, CW_LIGHT, WHITE,
  embedLogo, drawBrandedHeader, drawFooter,
} from './pdfBrand';
import { hashSignature } from './pdf';
import type { KeyLine } from './custody';

// ── Branded signed receipts ──────────────────────────────────────────────────
// One generator, two directions. A check-OUT receipt acknowledges RECEIVING
// keys; a check-IN receipt acknowledges RETURNING them. They are separate
// documents with separate acknowledgement text — a return signed against
// "I acknowledge receipt of the keys listed above" would be evidence of the
// wrong event.

export type CustodyAction = 'checkout' | 'checkin';

export interface CustodyReceiptData {
  assignmentId: number;
  action: CustodyAction;
  holder: string;
  holderType: 'employee' | 'ic';
  holderEmail: string | null;
  client: string;
  bcNumber?: string | null;
  keys: KeyLine[];
  checkedOutAt: string;
  dueAt: string | null;
  returnedAt?: string | null;
  condition?: string | null;
  recordedBy: string;
  signatureData: string;
  /** The name the signer typed to confirm the drawn mark is theirs. */
  typedName?: string | null;
  signedAt: string;
  /** Set when this receipt is one half of a person-to-person transfer. */
  transferCounterparty?: string | null;
}

const hasZone = (s: string) => /[Tt]/.test(s) || /[Zz]$/.test(s) || /[+-]\d{2}:?\d{2}$/.test(s);

// Timestamps are ISO (new rows) or SQLite 'YYYY-MM-DD HH:MM:SS' in UTC (old
// rows) — both normalize to UTC. A BARE date (due_at) carries no time at all,
// so it is read at midday UTC; parsing it at midnight would render the day
// before once shifted into America/New_York.
const fmt = (iso: string | null | undefined): string => {
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

const CONDITION_LABEL: Record<string, string> = {
  good: 'Good', damaged: 'Damaged', missing_copy: 'Missing copy',
};

const RECEIVE_ACKNOWLEDGEMENT = [
  'I acknowledge receipt of the keys listed above and agree to: (1) safeguard all keys and',
  'access credentials, (2) not duplicate or share keys with unauthorized personnel, (3) return',
  'all keys immediately upon request or upon termination of my assignment/contract, and',
  '(4) report any lost or stolen keys to City Wide Boston within 24 hours.',
];

const RETURN_ACKNOWLEDGEMENT = [
  'I confirm that I have returned the keys listed above to City Wide Boston, that I have',
  'retained no copies or duplicates of them, and that I no longer hold access to the client',
  'site by means of these keys. I understand this record closes my custody of them as of the',
  'date and time shown below.',
];

const COPY: Record<CustodyAction, {
  title: string; subtitle: string; label: string; ack: string[]; sigCaption: string; file: string;
}> = {
  checkout: {
    title: 'Key Check-Out Receipt',
    subtitle: 'BOSTON — Signed acknowledgement of key custody',
    label: 'Receipt',
    ack: RECEIVE_ACKNOWLEDGEMENT,
    sigCaption: 'Electronic Signature — keys received',
    file: 'keycheckout',
  },
  checkin: {
    title: 'Key Check-In Receipt',
    subtitle: 'BOSTON — Signed acknowledgement of key return',
    label: 'Return receipt',
    ack: RETURN_ACKNOWLEDGEMENT,
    sigCaption: 'Electronic Signature — keys returned',
    file: 'keycheckin',
  },
};

export const receiptDir = (): string => path.join(__dirname, '../../uploads/signatures');

/**
 * Branded one-page receipt for a signed key check-out or check-in. Written to
 * uploads/signatures and referenced from the assignment row (pdf_path for a
 * check-out, checkin_pdf_path for a return).
 */
export async function generateCustodyReceipt(d: CustodyReceiptData): Promise<string> {
  const copy = COPY[d.action];
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const { width } = page.getSize();
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const logo = await embedLogo(doc);

  let y = drawBrandedHeader(page, { bold, regular }, logo, copy.title, copy.subtitle);

  page.drawText(`${copy.label} #${d.assignmentId}`, { x: 36, y, size: 14, font: bold, color: CW_CHARCOAL });
  y -= 26;

  // ── Details block ──────────────────────────────────────────────────────────
  const rows: [string, string][] = [
    ['Holder', `${d.holder}  (${d.holderType === 'ic' ? 'Independent Contractor' : 'City Wide Employee'})`],
    ['Email', d.holderEmail || '—'],
    ['Client', d.bcNumber ? `${d.client}  (BC #${d.bcNumber})` : d.client],
    ['Checked out', fmt(d.checkedOutAt)],
    ...(d.action === 'checkout'
      ? ([['Due back', fmtDay(d.dueAt)]] as [string, string][])
      : ([
        ['Returned', fmt(d.returnedAt)],
        ['Condition', CONDITION_LABEL[String(d.condition ?? '')] || d.condition || '—'],
      ] as [string, string][])),
    ...(d.transferCounterparty
      ? ([[d.action === 'checkout' ? 'Received from' : 'Handed to', d.transferCounterparty]] as [string, string][])
      : []),
    ['Recorded by', d.recordedBy],
  ];
  for (const [label, value] of rows) {
    page.drawText(label, { x: 36, y, size: 10, font: bold, color: CW_CHARCOAL });
    page.drawText(value, { x: 150, y, size: 10, font: regular, color: CW_CHARCOAL });
    y -= 17;
  }
  y -= 12;

  // ── Key table ──────────────────────────────────────────────────────────────
  page.drawRectangle({ x: 36, y: y - 4, width: width - 72, height: 20, color: CW_CHARCOAL });
  page.drawText('KEY TYPE', { x: 44, y: y + 2, size: 9, font: bold, color: WHITE });
  page.drawText('QTY', { x: width - 90, y: y + 2, size: 9, font: bold, color: WHITE });
  y -= 20;

  let total = 0;
  d.keys.forEach((k, i) => {
    total += k.qty;
    if (i % 2 === 0) {
      page.drawRectangle({ x: 36, y: y - 4, width: width - 72, height: 18, color: CW_LIGHT });
    }
    page.drawText(k.label, { x: 44, y: y + 1, size: 10, font: regular, color: CW_CHARCOAL });
    page.drawText(String(k.qty), { x: width - 90, y: y + 1, size: 10, font: bold, color: CW_CHARCOAL });
    y -= 18;
  });

  page.drawLine({ start: { x: 36, y: y + 10 }, end: { x: width - 36, y: y + 10 }, thickness: 1.5, color: CW_RED });
  y -= 4;
  page.drawText('Total keys', { x: 44, y, size: 10, font: bold, color: CW_CHARCOAL });
  page.drawText(String(total), { x: width - 90, y, size: 11, font: bold, color: CW_RED });
  y -= 30;

  // ── Acknowledgement ────────────────────────────────────────────────────────
  page.drawText('ACKNOWLEDGEMENT', { x: 36, y, size: 9, font: bold, color: CW_CHARCOAL });
  y -= 16;
  for (const line of copy.ack) {
    page.drawText(line, { x: 36, y, size: 9, font: regular, color: CW_GRAY });
    y -= 13;
  }
  y -= 18;

  // ── Signature ──────────────────────────────────────────────────────────────
  if (d.signatureData?.startsWith('data:image/png;base64,')) {
    try {
      const img = await doc.embedPng(Buffer.from(d.signatureData.split(',')[1], 'base64'));
      const maxW = 240;
      const scale = Math.min(maxW / img.width, 70 / img.height, 1);
      const w = img.width * scale, h = img.height * scale;
      page.drawRectangle({ x: 36, y: y - h - 8, width: w + 12, height: h + 12, borderColor: CW_BORDER, borderWidth: 1 });
      page.drawImage(img, { x: 42, y: y - h - 2, width: w, height: h });
      y -= h + 18;
    } catch { /* a corrupt signature must not break the receipt */ }
  }

  page.drawLine({ start: { x: 36, y }, end: { x: 300, y }, thickness: 1, color: CW_BORDER });
  y -= 13;
  page.drawText(`${d.holder} — ${copy.sigCaption}`, { x: 36, y, size: 9, font: regular, color: CW_GRAY });
  if (d.typedName) {
    y -= 13;
    page.drawText(`Typed name confirmation: ${d.typedName}`, { x: 36, y, size: 9, font: regular, color: CW_GRAY });
  }
  y -= 13;
  page.drawText(`Signed ${fmt(d.signedAt)}`, { x: 36, y, size: 9, font: regular, color: CW_GRAY });

  const hash = hashSignature(d.signatureData);
  drawFooter(page, regular, `Signature SHA-256: ${hash}`);

  const bytes = await doc.save();
  const dir = receiptDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const file = path.join(
    dir,
    `${copy.file}_${d.assignmentId}_${d.holder.replace(/[^a-z0-9]+/gi, '_')}.pdf`,
  );
  fs.writeFileSync(file, bytes);
  return file;
}
