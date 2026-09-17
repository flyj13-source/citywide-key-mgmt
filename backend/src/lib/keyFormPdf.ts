// ── Key Form PDF ─────────────────────────────────────────────────────────────
// The auditable artifact as a document: who holds what, by client and key type.
// CW branded — logo, charcoal header band, red accent — matching the rest of
// the printed set.
//
// SECURITY: door and alarm codes are NEVER rendered here. The form carries
// client names, BC numbers, key counts and a signature. Nothing else.

import fs from 'fs';
import path from 'path';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { drawBrandedHeader, drawFooter, embedLogo } from './pdfBrand';
import {
  FORM_EVENT_LABEL, FORM_COLUMNS, parseScope, isReturnReceipt,
  docTitleFor, docTableHeadingFor, docTotalLabelFor, docKindOf, type FormEventType,
} from './keyForm';
import { receiptDir } from './custodyPdf';

const CW_RED = rgb(0.753, 0.153, 0.176);
const CW_CHARCOAL = rgb(0.102, 0.102, 0.102);
const CW_LIGHT = rgb(0.957, 0.957, 0.949);
const WHITE = rgb(1, 1, 1);
const MUTED = rgb(0.42, 0.42, 0.41);

const hasZone = (s: string) => /[Tt]/.test(s) || /[Zz]$/.test(s) || /[+-]\d{2}:?\d{2}$/.test(s);

const fmt = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  const d = new Date(hasZone(iso) ? iso : `${String(iso).replace(' ', 'T')}Z`);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString('en-US', {
    timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
};

/** A holdings form attests to a standing position. */
const ACKNOWLEDGEMENT = [
  'I confirm that the keys listed above are the keys currently in my possession for City Wide',
  'Boston. I agree to: (1) safeguard all keys and access credentials, (2) not duplicate or share',
  'keys with unauthorized personnel, (3) return all keys immediately upon request or upon',
  'termination of my assignment/contract, and (4) report any lost or stolen key within 24 hours.',
];

/**
 * A return receipt attests to a HANDOVER that happened, and to nothing else.
 *
 * It names only the keys on the document — no claim about what the signer
 * still holds elsewhere, because that is not what they are signing. The date
 * is substituted at render time: a receipt with no date proves nothing.
 *
 * `counterparty` is set on a transfer, where the keys went to a named person
 * rather than back to the company.
 */
const RETURN_ACKNOWLEDGEMENT = (dateText: string, counterparty?: string | null): string[] => (
  counterparty
    ? [
      `I confirm I have transferred the keys listed above to ${counterparty}`,
      `on behalf of City Wide Boston on ${dateText}, and that I no longer hold them.`,
      'I have retained no copies or duplicates, and I will report any discrepancy to',
      'City Wide Boston immediately.',
    ]
    : [
      `I confirm I have returned the keys listed above to City Wide Boston on ${dateText}.`,
      'I have handed back every key listed, have retained no copies or duplicates of them,',
      'and I no longer hold access to the client site by means of these keys. I will report',
      'any discrepancy to City Wide Boston immediately.',
    ]
);

/** Trim a string to fit a column, so a long client name never overruns. */
function fit(s: string, font: any, size: number, max: number): string {
  let out = String(s ?? '');
  while (out.length > 3 && font.widthOfTextAtSize(out, size) > max) out = out.slice(0, -1);
  return out.length < String(s ?? '').length ? `${out.slice(0, -1)}…` : out;
}

export async function generateKeyFormPdf(row: any): Promise<string> {
  const scope = parseScope(row);
  const doc = await PDFDocument.create();
  let page = doc.addPage([612, 792]);
  const { width } = page.getSize();
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const logo = await embedLogo(doc);

  const eventLabel = FORM_EVENT_LABEL[row.event_type as FormEventType] ?? row.event_type;

  // A receipt's subject is the keys that left this person's hands; a holdings
  // statement's is what they have. Same layout, different assertion — the kind
  // decides the title, the table heading, the total label and the signature.
  const kind = docKindOf(row);
  const isReturn = isReturnReceipt(row);
  const transferredTo = isReturn ? (row.counterparty_name || null) : null;
  // Resolved from the row, so a transfer-out never prints "returned".
  const docTitle = docTitleFor(row);

  let y = drawBrandedHeader(
    page, { bold, regular }, logo,
    docTitle,
    isReturn
      ? (transferredTo
          ? `BOSTON — Keys transferred by ${row.holder_name}`
          : `BOSTON — Keys returned by ${row.holder_name}`)
      : `BOSTON — Keys held by ${row.holder_name}`,
  );

  page.drawText(`${row.form_no ?? `KF-${row.id}`}`, { x: 36, y, size: 14, font: bold, color: CW_CHARCOAL });
  page.drawText(
    isReturn
      ? `${transferredTo ? 'Transfer of keys' : 'Return of keys'} · ${eventLabel}`
      : `Generated by ${eventLabel}`,
    {
      x: 36 + bold.widthOfTextAtSize(`${row.form_no ?? ''}`, 14) + 12, y, size: 10, font: regular, color: CW_RED,
    },
  );
  y -= 24;

  // ── Header block ───────────────────────────────────────────────────────────
  const rows: [string, string][] = [
    ['Holder', row.holder_name],
    ['Role', row.holder_role || '—'],
    ['Contact', row.holder_email || 'No email on file'],
    ...(row.holder_phone ? ([['Phone', row.holder_phone]] as [string, string][]) : []),
    ['Event', eventLabel],
    ...(row.counterparty_name ? ([['Counterparty', row.counterparty_name]] as [string, string][]) : []),
    ['Generated', fmt(row.created_at)],
    ['Generated by', row.generated_by || 'City Wide Boston'],
    // The data-version marker, printed on the document itself. Two forms
    // carrying the same one state the same position — which is what makes a
    // disagreement provable instead of arguable.
    ...(row.data_version ? [['Data version', String(row.data_version)] as [string, string]] : []),
    ...(row.superseded_by ? [['Superseded by', `Form #${row.superseded_by}`] as [string, string]] : []),
    ...(row.supersedes ? [['Replaces', `Form #${row.supersedes}`] as [string, string]] : []),
  ];
  for (const [label, value] of rows) {
    page.drawText(label, { x: 36, y, size: 10, font: bold, color: CW_CHARCOAL });
    page.drawText(String(value), { x: 150, y, size: 10, font: regular, color: CW_CHARCOAL });
    y -= 16;
  }
  if (scope.event_note) {
    y -= 4;
    page.drawText(fit(scope.event_note, regular, 9, width - 80), {
      x: 36, y, size: 9, font: regular, color: MUTED,
    });
    y -= 14;
  }
  y -= 10;

  // ── Body: one row per client, five key columns + subtotal ─────────────────
  // EIGHT positions: client, BC #, the five key columns, then the subtotal.
  // Five columns needs indices 2..6, so the total must sit at 7 — sharing an
  // index put "Office" and "Total" on top of each other.
  const colX = [40, 176, 262, 312, 366, 420, 470, 524];
  const TOTAL_X = colX[7];

  const drawTableHead = () => {
    page.drawRectangle({ x: 36, y: y - 4, width: width - 72, height: 20, color: CW_CHARCOAL });
    page.drawText('CLIENT', { x: colX[0], y: y + 2, size: 8, font: bold, color: WHITE });
    page.drawText('BC CLIENT #', { x: colX[1], y: y + 2, size: 8, font: bold, color: WHITE });
    FORM_COLUMNS.forEach((c, i) => {
      page.drawText(c.label.toUpperCase(), { x: colX[2 + i], y: y + 2, size: 7, font: bold, color: WHITE });
    });
    page.drawText('TOTAL', { x: TOTAL_X, y: y + 2, size: 8, font: bold, color: WHITE });
    y -= 20;
  };

  page.drawText(docTableHeadingFor(row).toUpperCase(), { x: 36, y, size: 9, font: bold, color: CW_CHARCOAL });
  y -= 16;
  drawTableHead();

  const totals = { metal: 0, card: 0, fob: 0, dispenser: 0, office: 0, subtotal: 0 };

  scope.lines.forEach((line: any, i: number) => {
    if (y < 210) {
      // Continue on a new page rather than writing off the bottom edge.
      page = doc.addPage([612, 792]);
      y = drawBrandedHeader(
        page, { bold, regular }, logo, `${docTitle} (continued)`, row.holder_name,
      );
      drawTableHead();
    }
    if (i % 2 === 0) {
      page.drawRectangle({ x: 36, y: y - 10, width: width - 72, height: 24, color: CW_LIGHT });
    }
    // Where the row came from — "AM", "CCM", "Checked out", or on a receipt
    // what the movement was. A number is only checkable if you can see its
    // source, and on a holdings form the two sources are tracked separately.
    const via = typeof line.via === 'string' && line.via ? line.via : null;
    page.drawText(fit(line.client, regular, 9, 130), { x: colX[0], y: y + 1, size: 9, font: regular, color: CW_CHARCOAL });
    if (via) {
      page.drawText(fit(via, regular, 6.5, 128), { x: colX[0] + 2, y: y - 6.5, size: 6.5, font: regular, color: MUTED });
    }
    page.drawText(String(line.bc_client_number || '—'), { x: colX[1], y: y + 1, size: 8, font: regular, color: MUTED });
    FORM_COLUMNS.forEach((c, ci) => {
      const v = Number(line[c.key] ?? 0);
      (totals as any)[c.key] += v;
      page.drawText(v ? String(v) : '—', {
        x: colX[2 + ci] + 6, y: y + 1, size: 9, font: regular, color: v ? CW_CHARCOAL : MUTED,
      });
    });
    totals.subtotal += Number(line.subtotal ?? 0);
    page.drawText(String(line.subtotal ?? 0), { x: TOTAL_X + 6, y: y + 1, size: 9, font: bold, color: CW_CHARCOAL });
    y -= 24;
  });

  // ── Grand total ────────────────────────────────────────────────────────────
  page.drawLine({ start: { x: 36, y: y + 10 }, end: { x: width - 36, y: y + 10 }, thickness: 1.5, color: CW_RED });
  y -= 4;
  page.drawText(docTotalLabelFor(row), { x: colX[0], y, size: 10, font: bold, color: CW_CHARCOAL });
  FORM_COLUMNS.forEach((c, ci) => {
    const v = (totals as any)[c.key];
    page.drawText(v ? String(v) : '—', { x: colX[2 + ci] + 6, y, size: 9, font: bold, color: CW_CHARCOAL });
  });
  page.drawText(String(totals.subtotal), { x: TOTAL_X + 6, y, size: 12, font: bold, color: CW_RED });
  y -= 28;

  // ── Acknowledgement + signature block ──────────────────────────────────────
  if (y < 200) { page = doc.addPage([612, 792]); y = 740; }
  page.drawText('ACKNOWLEDGEMENT', { x: 36, y, size: 9, font: bold, color: CW_CHARCOAL });
  y -= 14;
  const ackLines = isReturn
    ? RETURN_ACKNOWLEDGEMENT(
        fmt(row.signed_at ?? row.created_at).split(',').slice(0, 2).join(',').trim(),
        transferredTo,
      )
    : ACKNOWLEDGEMENT;
  for (const line of ackLines) {
    page.drawText(line, { x: 36, y, size: 8.5, font: regular, color: CW_CHARCOAL });
    y -= 11;
  }
  y -= 14;

  if (row.signature_data) {
    try {
      const b64 = String(row.signature_data).split(',')[1] ?? '';
      const png = await doc.embedPng(Buffer.from(b64, 'base64'));
      const w = 240;
      const h = (png.height / png.width) * w;
      page.drawRectangle({ x: 36, y: y - h - 6, width: w + 12, height: h + 12, borderColor: CW_LIGHT, borderWidth: 1 });
      page.drawImage(png, { x: 42, y: y - h, width: w, height: h });
      y -= h + 18;
    } catch { /* a broken signature image must not lose the rest of the form */ }
    page.drawLine({ start: { x: 36, y }, end: { x: 300, y }, thickness: 0.5, color: MUTED });
    y -= 12;
    page.drawText(`${row.holder_name} — Electronic Signature`, { x: 36, y, size: 8, font: regular, color: MUTED });
    y -= 11;
    if (row.signature_typed_name) {
      page.drawText(`Typed name confirmation: ${row.signature_typed_name}`, { x: 36, y, size: 8, font: regular, color: MUTED });
      y -= 11;
    }
    page.drawText(`Signed ${fmt(row.signed_at)}`, { x: 36, y, size: 8, font: regular, color: MUTED });
    y -= 16;
    if (row.signature_hash) {
      page.drawText(`Signature SHA-256: ${row.signature_hash}`, { x: 36, y, size: 6.5, font: regular, color: MUTED });
      y -= 12;
    }
  } else {
    // Unsigned: leave a real signature line so the form can be printed and
    // signed by hand during an audit.
    page.drawRectangle({ x: 36, y: y - 54, width: 252, height: 54, borderColor: CW_LIGHT, borderWidth: 1 });
    y -= 66;
    page.drawLine({ start: { x: 36, y }, end: { x: 300, y }, thickness: 0.5, color: MUTED });
    page.drawLine({ start: { x: 330, y }, end: { x: width - 36, y }, thickness: 0.5, color: MUTED });
    y -= 12;
    page.drawText('Signature', { x: 36, y, size: 8, font: regular, color: MUTED });
    page.drawText('Date', { x: 330, y, size: 8, font: regular, color: MUTED });
    y -= 16;
    page.drawText('UNSIGNED — this form has not been acknowledged electronically.', {
      x: 36, y, size: 8, font: bold, color: CW_RED,
    });
    y -= 14;
  }

  drawFooter(page, regular, `${row.form_no ?? `KF-${row.id}`} · No access codes appear on this form.`);

  const dir = receiptDir();
  fs.mkdirSync(dir, { recursive: true });
  const safe = String(row.holder_name).replace(/[^a-z0-9]+/gi, '_').slice(0, 40);
  const file = path.join(dir, `keyform_${row.id}_${safe}.pdf`);
  fs.writeFileSync(file, await doc.save());
  return file;
}
