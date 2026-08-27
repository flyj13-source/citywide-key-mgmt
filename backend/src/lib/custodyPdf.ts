import { PDFDocument, StandardFonts } from 'pdf-lib';
import fs from 'fs';
import path from 'path';
import {
  CW_RED, CW_CHARCOAL, CW_GRAY, CW_BORDER, CW_LIGHT, WHITE,
  embedLogo, drawBrandedHeader, drawFooter,
} from './pdfBrand';
import { hashSignature } from './pdf';
import type { KeyLine } from './custody';

export interface CustodyReceiptData {
  assignmentId: number;
  holder: string;
  holderType: 'employee' | 'ic';
  holderEmail: string | null;
  client: string;
  keys: KeyLine[];
  checkedOutAt: string;
  dueAt: string | null;
  recordedBy: string;
  signatureData: string;
  signedAt: string;
  /** Set when a manager captured a wet signature on a device at handover. */
  witnessedBy?: string | null;
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

const ACKNOWLEDGEMENT = [
  'I acknowledge receipt of the keys listed above and agree to: (1) safeguard all keys and',
  'access credentials, (2) not duplicate or share keys with unauthorized personnel, (3) return',
  'all keys immediately upon request or upon termination of my assignment/contract, and',
  '(4) report any lost or stolen keys to City Wide Boston within 24 hours.',
];

/**
 * Branded one-page receipt for a signed key check-out. Written to
 * uploads/signatures and referenced from the assignment row (pdf_path).
 */
export async function generateCustodyReceipt(d: CustodyReceiptData): Promise<string> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const { width } = page.getSize();
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const logo = await embedLogo(doc);

  let y = drawBrandedHeader(
    page, { bold, regular }, logo,
    'Key Check-Out Receipt',
    'BOSTON — Signed acknowledgement of key custody',
  );

  page.drawText(`Receipt #${d.assignmentId}`, { x: 36, y, size: 14, font: bold, color: CW_CHARCOAL });
  y -= 26;

  // ── Details block ──────────────────────────────────────────────────────────
  const rows: [string, string][] = [
    ['Holder', `${d.holder}  (${d.holderType === 'ic' ? 'Independent Contractor' : 'City Wide Employee'})`],
    ['Email', d.holderEmail || '—'],
    ['Client', d.client],
    ['Checked out', fmt(d.checkedOutAt)],
    ['Due back', fmtDay(d.dueAt)],
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
  for (const line of ACKNOWLEDGEMENT) {
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
  page.drawText(`${d.holder} — Electronic Signature`, { x: 36, y, size: 9, font: regular, color: CW_GRAY });
  y -= 13;
  page.drawText(`Signed ${fmt(d.signedAt)}`, { x: 36, y, size: 9, font: regular, color: CW_GRAY });
  if (d.witnessedBy) {
    y -= 13;
    page.drawText(`Signed in person, witnessed by ${d.witnessedBy}`, {
      x: 36, y, size: 9, font: regular, color: CW_GRAY,
    });
  }

  const hash = hashSignature(d.signatureData);
  drawFooter(page, regular, `Signature SHA-256: ${hash}`);

  const bytes = await doc.save();
  const dir = path.join(__dirname, '../../uploads/signatures');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const file = path.join(
    dir,
    `keycheckout_${d.assignmentId}_${d.holder.replace(/[^a-z0-9]+/gi, '_')}.pdf`,
  );
  fs.writeFileSync(file, bytes);
  return file;
}
