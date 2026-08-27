import ExcelJS from 'exceljs';
import { PDFDocument, StandardFonts, PDFFont, PDFPage } from 'pdf-lib';
import db from './db';
import {
  readKeyLines, summarizeKeys, totalQty, bcNumberFor, KeyLine,
} from './custody';
import {
  CW_RED, CW_CHARCOAL, CW_GRAY, CW_LIGHT, WHITE,
  embedLogo, drawBrandedHeader, drawFooter,
} from './pdfBrand';

// ── Custody Report ───────────────────────────────────────────────────────────
// One view over the whole custody history: who has what, who had what, what is
// late, and what is still waiting on a signature. Backs the on-screen report
// and both exports from the SAME query, so the spreadsheet can never disagree
// with the screen.
//
// SECURITY: this report selects named columns from key_assignments and the
// client's name/BC number only. Door and alarm codes are NEVER read here, so
// they cannot reach an export — see the explicit column list in ROW_COLUMNS.

export type CustodyStatusFilter = 'all' | 'active' | 'returned' | 'overdue';
export type SignatureFilter = 'all' | 'signed' | 'awaiting' | 'missing' | 'unresolvable';

/** Whether a signature could ever be collected — see key_assignments.signature_status. */
export type SignatureDelivery =
  | 'signed' | 'awaiting_signature' | 'signature_unavailable'
  | 'signature_send_failed' | 'not_required';

/** The two states nothing but a person will resolve. */
export const UNRESOLVABLE: SignatureDelivery[] = ['signature_unavailable', 'signature_send_failed'];
export type HolderTypeFilter = 'all' | 'employee' | 'ic';

export interface CustodyReportFilters {
  date_from?: string | null;
  date_to?: string | null;
  holder?: string | null;
  client?: string | null;
  holder_type?: HolderTypeFilter;
  status?: CustodyStatusFilter;
  signature?: SignatureFilter;
}

export type SignatureStatus = 'signed' | 'partial' | 'awaiting';

export interface CustodyReportRow {
  id: number;
  holder: string;
  holder_type: 'employee' | 'ic' | null;
  holder_type_label: string;
  client: string;
  bc_number: string | null;
  keys: KeyLine[];
  keys_summary: string;
  total_keys: number;
  checked_out_at: string | null;
  due_at: string | null;
  returned_at: string | null;
  status: 'checked_out' | 'returned';
  overdue: boolean;
  status_label: string;
  signed_out_at: string | null;
  signed_in_at: string | null;
  signature_status: SignatureStatus;
  signature_label: string;
  signature_delivery: SignatureDelivery | null;
  no_email_reason: string | null;
  recorded_by: string | null;
  transfer_id: string | null;
  transfer_role: 'from' | 'to' | null;
  linked_assignment_id: number | null;
  return_reason: string | null;
}

export interface CustodyReportSummary {
  total: number;
  currently_out: number;
  overdue: number;
  awaiting_signature: number;
  no_email: number;
  send_failed: number;
  needs_follow_up: number;
  total_keys_out: number;
}

// The ONLY columns this report reads. Door/alarm ciphertext is not among them
// and must never be added — the export path has no redaction step because it
// has nothing to redact.
const ROW_COLUMNS = [
  'a.id', 'a.account_id', 'a.account_name', 'a.assignee', 'a.holder_type',
  'a.keys_json', 'a.key_type', 'a.keys_held',
  'a.checked_out_at', 'a.due_at', 'a.returned_at', 'a.status',
  'a.signed_at', 'a.checkin_signed_at', 'a.recorded_by', 'a.checkin_recorded_by',
  'a.transfer_id', 'a.transfer_role', 'a.linked_assignment_id', 'a.return_reason',
  'a.signature_status AS signature_delivery', 'a.no_email_reason',
  'c.record_type AS client_record_type',
  'c.bc_client_number AS client_bc_client_number',
  'c.bc_vendor_number AS client_bc_vendor_number',
].join(', ');

const clean = (v: any): string | null => {
  const s = v == null ? '' : String(v).trim();
  return s === '' ? null : s;
};

const hasZone = (s: string) => /[Tt]/.test(s) || /[Zz]$/.test(s) || /[+-]\d{2}:?\d{2}$/.test(s);
const parseStamp = (v: any): Date | null => {
  const s = clean(v);
  if (!s) return null;
  const d = new Date(hasZone(s) ? s : `${s.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
};

export const fmtStamp = (v: any): string => {
  const d = parseStamp(v);
  if (!d) return '';
  return d.toLocaleString('en-US', {
    timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
};

export const fmtDay = (v: any): string => {
  const s = clean(v);
  if (!s) return '';
  const d = hasZone(s) ? parseStamp(s) : parseStamp(`${s}T12:00:00Z`);
  if (!d) return s;
  return d.toLocaleDateString('en-US', {
    timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric',
  });
};

const holderTypeLabel = (t: any): string => (t === 'ic' ? 'IC' : t === 'employee' ? 'Employee' : '—');

/**
 * Which signatures this record needs, and how many it has. A record that is
 * still out needs the check-OUT signature only; once it has been returned it
 * needs the check-IN signature too, because both events happened.
 */
function signatureState(row: any): { status: SignatureStatus; label: string } {
  const required = row.status === 'returned' ? 2 : 1;
  const have = (row.signed_at ? 1 : 0) + (row.status === 'returned' && row.checkin_signed_at ? 1 : 0);
  if (have >= required) return { status: 'signed', label: 'Signed' };
  if (have === 0) return { status: 'awaiting', label: 'Awaiting signature' };
  return { status: 'partial', label: `Awaiting signature (${have} of ${required})` };
}

function toRow(raw: any): CustodyReportRow {
  const r = Object.assign({}, raw);
  const keys = readKeyLines(r);
  const due = parseStamp(r.due_at);
  const overdue = r.status === 'checked_out' && !!due && due < new Date();
  const sig = signatureState(r);
  return {
    id: r.id,
    holder: r.assignee,
    holder_type: (r.holder_type as 'employee' | 'ic') ?? null,
    holder_type_label: holderTypeLabel(r.holder_type),
    client: r.account_name,
    bc_number: bcNumberFor({
      record_type: r.client_record_type,
      bc_client_number: r.client_bc_client_number,
      bc_vendor_number: r.client_bc_vendor_number,
    }),
    keys,
    keys_summary: keys.length ? summarizeKeys(keys) : (r.keys_held || ''),
    total_keys: totalQty(keys),
    checked_out_at: r.checked_out_at ?? null,
    due_at: r.due_at ?? null,
    returned_at: r.returned_at ?? null,
    status: r.status === 'returned' ? 'returned' : 'checked_out',
    overdue,
    status_label: r.status === 'returned'
      ? (r.return_reason === 'transferred' ? 'Transferred' : 'Returned')
      : (overdue ? 'Overdue' : 'Out'),
    signed_out_at: r.signed_at ?? null,
    signed_in_at: r.checkin_signed_at ?? null,
    signature_status: sig.status,
    signature_label: sig.label,
    // Deliverability, distinct from whether a signature exists: 'awaiting' and
    // "no signature is ever coming" must never be counted as the same thing.
    signature_delivery: (r.signature_delivery as SignatureDelivery) ?? null,
    no_email_reason: r.no_email_reason ?? null,
    recorded_by: r.status === 'returned'
      ? (r.checkin_recorded_by || r.recorded_by || null)
      : (r.recorded_by || null),
    transfer_id: r.transfer_id ?? null,
    transfer_role: (r.transfer_role as 'from' | 'to') ?? null,
    linked_assignment_id: r.linked_assignment_id ?? null,
    return_reason: r.return_reason ?? null,
  };
}

/**
 * Run the report. Date range, holder, client and holder type narrow the SQL;
 * status and signature are applied in TypeScript because "overdue" and
 * "awaiting signature" are derived states, not columns.
 *
 * The date range matches on ACTIVITY: a record is in range if it was checked
 * out in the window or came back in the window. Filtering on checked-out date
 * alone would hide a return that happened today against a key taken last month
 * — exactly the row someone running a monthly report is looking for.
 */
export function runCustodyReport(f: CustodyReportFilters): {
  rows: CustodyReportRow[]; summary: CustodyReportSummary;
} {
  let where = '1=1';
  const params: any[] = [];

  const from = clean(f.date_from);
  const to = clean(f.date_to);
  if (from) {
    where += ' AND (DATE(a.checked_out_at) >= DATE(?) OR DATE(a.returned_at) >= DATE(?))';
    params.push(from, from);
  }
  if (to) {
    where += ' AND (DATE(a.checked_out_at) <= DATE(?) OR DATE(a.returned_at) <= DATE(?))';
    params.push(to, to);
  }
  const holder = clean(f.holder);
  if (holder) { where += ' AND a.assignee LIKE ?'; params.push(`%${holder}%`); }
  const client = clean(f.client);
  if (client) {
    where += ' AND (a.account_name LIKE ? OR c.bc_client_number LIKE ? OR c.bc_vendor_number LIKE ?)';
    params.push(`%${client}%`, `%${client}%`, `%${client}%`);
  }
  if (f.holder_type === 'employee' || f.holder_type === 'ic') {
    where += ' AND a.holder_type = ?';
    params.push(f.holder_type);
  }
  if (f.status === 'active' || f.status === 'overdue') where += " AND a.status = 'checked_out'";
  else if (f.status === 'returned') where += " AND a.status = 'returned'";

  const raw = db.prepare(`
    SELECT ${ROW_COLUMNS}
      FROM key_assignments a
      LEFT JOIN accounts c ON c.id = a.account_id
     WHERE ${where}
     ORDER BY COALESCE(a.returned_at, a.checked_out_at) DESC, a.id DESC
  `).all(...params) as any[];

  let rows = raw.map(toRow);
  if (f.status === 'overdue') rows = rows.filter((r) => r.overdue);
  if (f.signature === 'signed') rows = rows.filter((r) => r.signature_status === 'signed');
  else if (f.signature === 'awaiting') rows = rows.filter((r) => r.signature_status !== 'signed');
  else if (f.signature === 'missing') rows = rows.filter((r) => r.signature_status !== 'signed');
  else if (f.signature === 'unresolvable') {
    rows = rows.filter((r) => !!r.signature_delivery && UNRESOLVABLE.includes(r.signature_delivery));
  }

  const summary: CustodyReportSummary = {
    total: rows.length,
    currently_out: rows.filter((r) => r.status === 'checked_out').length,
    overdue: rows.filter((r) => r.overdue).length,
    awaiting_signature: rows.filter((r) => r.signature_status !== 'signed').length,
    // Split out the part that will NOT resolve itself, so the report answers
    // "how many need me?" and not just "how many are unsigned?".
    no_email: rows.filter((r) => r.signature_delivery === 'signature_unavailable').length,
    send_failed: rows.filter((r) => r.signature_delivery === 'signature_send_failed').length,
    needs_follow_up: rows.filter(
      (r) => !!r.signature_delivery && UNRESOLVABLE.includes(r.signature_delivery)).length,
    total_keys_out: rows.filter((r) => r.status === 'checked_out').reduce((n, r) => n + r.total_keys, 0),
  };

  return { rows, summary };
}

// ── Human-readable description of the active filters ─────────────────────────
// Printed on both exports so a saved file still says what it was a report OF.
export function describeFilters(f: CustodyReportFilters): string {
  const parts: string[] = [];
  const from = clean(f.date_from);
  const to = clean(f.date_to);
  if (from && to) parts.push(`${fmtDay(from)} – ${fmtDay(to)}`);
  else if (from) parts.push(`From ${fmtDay(from)}`);
  else if (to) parts.push(`Through ${fmtDay(to)}`);
  if (clean(f.holder)) parts.push(`Holder: ${clean(f.holder)}`);
  if (clean(f.client)) parts.push(`Client: ${clean(f.client)}`);
  if (f.holder_type && f.holder_type !== 'all') parts.push(f.holder_type === 'ic' ? 'ICs only' : 'Employees only');
  if (f.status && f.status !== 'all') {
    parts.push({ active: 'Active only', returned: 'Returned only', overdue: 'Overdue only' }[f.status]);
  }
  if (f.signature && f.signature !== 'all') {
    parts.push(
      f.signature === 'signed' ? 'Signed only'
        : f.signature === 'unresolvable' ? 'Missing signatures needing follow-up'
          : f.signature === 'missing' ? 'Missing signatures'
            : 'Awaiting signature only');
  }
  return parts.length ? parts.join(' · ') : 'All custody records';
}

// ── Export column contract (shared by xlsx and pdf) ──────────────────────────
interface ReportColumn {
  header: string;
  width: number;    // Excel character width
  pdfWidth: number; // PDF points
  value: (r: CustodyReportRow) => string | number;
  /** Narrower wording for the PDF, where a landscape page has to fit 11
   *  columns. Omitted when the full value already fits. */
  pdfValue?: (r: CustodyReportRow) => string;
}

// pdfWidth values are measured against real content at the 7.5pt body size and
// sum to the usable landscape width (see PDF_USABLE below). They are scaled
// down at render time if that ever stops being true, so adding a column can
// only make everything narrower — never push the last column off the page.
export const REPORT_COLUMNS: ReportColumn[] = [
  { header: 'Holder', width: 24, pdfWidth: 54, value: (r) => r.holder },
  { header: 'Type', width: 11, pdfWidth: 40, value: (r) => r.holder_type_label },
  { header: 'Client', width: 32, pdfWidth: 106, value: (r) => r.client },
  { header: 'BC #', width: 16, pdfWidth: 52, value: (r) => r.bc_number || '' },
  { header: 'Keys', width: 34, pdfWidth: 98, value: (r) => r.keys_summary },
  { header: 'Checked Out', width: 20, pdfWidth: 88, value: (r) => fmtStamp(r.checked_out_at) },
  { header: 'Due', width: 15, pdfWidth: 49, value: (r) => fmtDay(r.due_at) },
  { header: 'Returned', width: 20, pdfWidth: 88, value: (r) => fmtStamp(r.returned_at) },
  { header: 'Status', width: 13, pdfWidth: 42, value: (r) => r.status_label },
  {
    header: 'Signed', width: 24, pdfWidth: 60,
    value: (r) => r.signature_label,
    // "Awaiting signature (1 of 2)" does not fit a landscape column; under a
    // header that already reads "Signed", the word is redundant anyway.
    pdfValue: (r) => (r.signature_status === 'signed' ? 'Signed'
      : r.signature_status === 'partial' ? r.signature_label.replace('Awaiting signature', 'Awaiting')
        : 'Awaiting'),
  },
  { header: 'Recorded By', width: 22, pdfWidth: 54, value: (r) => r.recorded_by || '' },
];

export function summaryLine(s: CustodyReportSummary): string {
  return `${s.currently_out} currently out · ${s.overdue} overdue · ${s.awaiting_signature} awaiting signature`;
}

// ── Excel ────────────────────────────────────────────────────────────────────
export async function reportToXlsx(
  rows: CustodyReportRow[], summary: CustodyReportSummary, f: CustodyReportFilters,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'City Wide Boston Key Management';
  wb.created = new Date();
  const ws = wb.addWorksheet('Custody Report');

  ws.mergeCells(1, 1, 1, REPORT_COLUMNS.length);
  const title = ws.getCell(1, 1);
  title.value = 'City Wide Boston — Key Custody Report';
  title.font = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } };
  title.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A1A1A' } };
  title.alignment = { vertical: 'middle' };
  ws.getRow(1).height = 24;

  ws.mergeCells(2, 1, 2, REPORT_COLUMNS.length);
  const sub = ws.getCell(2, 1);
  sub.value = `${describeFilters(f)}    |    ${summaryLine(summary)}    |    Generated ${fmtStamp(new Date().toISOString())}`;
  sub.font = { size: 10, color: { argb: 'FFC0272D' }, bold: true };

  const headerRow = ws.getRow(4);
  REPORT_COLUMNS.forEach((c, i) => {
    headerRow.getCell(i + 1).value = c.header;
    ws.getColumn(i + 1).width = c.width;
  });
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A1A1A' } };
  headerRow.commit();
  ws.views = [{ state: 'frozen', ySplit: 4 }];

  rows.forEach((r) => {
    const row = ws.addRow(REPORT_COLUMNS.map((c) => c.value(r)));
    if (r.overdue) {
      row.getCell(REPORT_COLUMNS.findIndex((c) => c.header === 'Status') + 1)
        .font = { color: { argb: 'FFC0272D' }, bold: true };
    }
    if (r.signature_status !== 'signed') {
      row.getCell(REPORT_COLUMNS.findIndex((c) => c.header === 'Signed') + 1)
        .font = { color: { argb: 'FF7A5A00' }, bold: true };
    }
  });

  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ── Branded PDF ──────────────────────────────────────────────────────────────
const PAGE: [number, number] = [792, 612]; // US Letter landscape
const MARGIN = 28;
const CELL_PAD = 5;
const PDF_USABLE = PAGE[0] - MARGIN * 2 - CELL_PAD;

/**
 * Column widths actually used for drawing. If the declared widths ever exceed
 * the page, every column shrinks proportionally rather than the rightmost ones
 * being drawn past the paper edge — invisible, but still in the file.
 */
const PDF_WIDTHS: number[] = (() => {
  const declared = REPORT_COLUMNS.map((c) => c.pdfWidth);
  const total = declared.reduce((n, w) => n + w, 0);
  const scale = total > PDF_USABLE ? PDF_USABLE / total : 1;
  return declared.map((w) => w * scale);
})();

// pdf-lib's standard fonts are WinAnsi — a glyph outside that encoding throws
// mid-render and would lose the whole report. Ask the font itself what it can
// draw rather than guessing: WinAnsi covers ·, ×, the dashes and curly quotes,
// so the PDF keeps the same typography as the screen and only a genuinely
// undrawable character is substituted.
const encodable = new WeakMap<PDFFont, Map<string, boolean>>();
function canEncode(font: PDFFont, ch: string): boolean {
  let memo = encodable.get(font);
  if (!memo) { memo = new Map(); encodable.set(font, memo); }
  const cached = memo.get(ch);
  if (cached !== undefined) return cached;
  let ok = true;
  try { font.widthOfTextAtSize(ch, 10); } catch { ok = false; }
  memo.set(ch, ok);
  return ok;
}

function safe(v: any, font: PDFFont): string {
  let out = '';
  for (const ch of String(v ?? '')) out += canEncode(font, ch) ? ch : '?';
  return out;
}

function fit(text: any, font: PDFFont, size: number, maxWidth: number): string {
  let s = safe(text, font);
  if (font.widthOfTextAtSize(s, size) <= maxWidth) return s;
  while (s.length > 1 && font.widthOfTextAtSize(`${s}...`, size) > maxWidth) s = s.slice(0, -1);
  return `${s}...`;
}

function drawHeaderRow(page: PDFPage, bold: PDFFont, y: number): number {
  const width = PAGE[0] - MARGIN * 2;
  page.drawRectangle({ x: MARGIN, y: y - 4, width, height: 18, color: CW_CHARCOAL });
  let x = MARGIN + CELL_PAD;
  REPORT_COLUMNS.forEach((c, i) => {
    page.drawText(fit(c.header, bold, 7.5, PDF_WIDTHS[i] - 4), { x, y: y + 1, size: 7.5, font: bold, color: WHITE });
    x += PDF_WIDTHS[i];
  });
  return y - 18;
}

export async function reportToPdf(
  rows: CustodyReportRow[], summary: CustodyReportSummary, f: CustodyReportFilters,
): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const logo = await embedLogo(doc);

  const newPage = (): { page: PDFPage; y: number } => {
    const page = doc.addPage(PAGE);
    let y = drawBrandedHeader(page, { bold, regular }, logo, 'Key Custody Report', 'BOSTON — Check-out / check-in custody history');
    page.drawText(fit(describeFilters(f), regular, 9, PDF_USABLE), {
      x: MARGIN, y, size: 9, font: regular, color: CW_GRAY,
    });
    y -= 15;
    page.drawText(safe(summaryLine(summary), bold), { x: MARGIN, y, size: 10, font: bold, color: CW_RED });
    page.drawText(fit(
      `${summary.total} record${summary.total === 1 ? '' : 's'} · generated ${fmtStamp(new Date().toISOString())}`,
      regular, 8, PAGE[0] - MARGIN * 2 - 320,
    ), { x: MARGIN + 320, y, size: 8, font: regular, color: CW_GRAY });
    y -= 20;
    return { page, y: drawHeaderRow(page, bold, y) };
  };

  let { page, y } = newPage();
  let striped = 0;

  for (const r of rows) {
    if (y < 52) {
      drawFooter(page, regular, 'Contains no door or alarm access codes.');
      ({ page, y } = newPage());
      striped = 0;
    }
    if (striped % 2 === 0) {
      page.drawRectangle({ x: MARGIN, y: y - 3, width: PAGE[0] - MARGIN * 2, height: 15, color: CW_LIGHT });
    }
    let x = MARGIN + CELL_PAD;
    REPORT_COLUMNS.forEach((c, i) => {
      const emphasise = (c.header === 'Status' && r.overdue)
        || (c.header === 'Signed' && r.signature_status !== 'signed');
      const font = emphasise ? bold : regular;
      page.drawText(fit((c.pdfValue ?? c.value)(r), font, 7.5, PDF_WIDTHS[i] - 4), {
        x, y: y + 1, size: 7.5, font, color: emphasise ? CW_RED : CW_CHARCOAL,
      });
      x += PDF_WIDTHS[i];
    });
    y -= 15;
    striped += 1;
  }

  if (!rows.length) {
    page.drawText('No custody records match these filters.', {
      x: MARGIN + 5, y: y - 4, size: 10, font: regular, color: CW_GRAY,
    });
  }

  drawFooter(page, regular, 'Contains no door or alarm access codes.');
  return Buffer.from(await doc.save());
}
