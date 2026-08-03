import ExcelJS from 'exceljs';
import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from 'pdf-lib';
import {
  CW_RED, CW_CHARCOAL, CW_GRAY, CW_LIGHT, CW_BORDER, WHITE,
  drawBrandedHeader, drawFooter, embedLogo,
} from './pdfBrand';

// ── Export model ─────────────────────────────────────────────────────────────
// Built purely from the /api/staff/:id detail payload (serialize(row, true)),
// so the numbers here are the SAME numbers the CW Employees roster + StaffDetail
// page show — totals reconcile by construction. NO decrypted door/alarm codes
// are ever part of this model; codes live only in the vault.

type Breakdown = { metal: number; card: number; fob: number; dispenser: number; other: number };
const emptyBreak = (): Breakdown => ({ metal: 0, card: 0, fob: 0, dispenser: 0, other: 0 });
const acctKey = (id: any, name: any) =>
  id !== null && id !== undefined ? `id:${id}` : `name:${String(name || '').toLowerCase()}`;

const ZEBRA = rgb(0.957, 0.957, 0.949); // #f4f4f2

export interface EmployeeExportRow {
  client: string;
  bc: string;
  ic: string;
  role: string;
  metal: number; card: number; fob: number; dispenser: number; other: number;
  total: number;
}

export interface EmployeeExportModel {
  name: string;
  role_label: string;
  shift: string | null;
  day_night: string | null;
  email: string | null;
  phone: string | null;
  summary: { clients: number; totalKeys: number } & Breakdown;
  rows: EmployeeExportRow[];
}

/** Transform the serialized staff-detail payload into the export model. */
export function buildEmployeeModel(d: any): EmployeeExportModel {
  const perAcct = new Map<string, Breakdown>();
  const bump = (key: string): Breakdown => {
    let b = perAcct.get(key);
    if (!b) { b = emptyBreak(); perAcct.set(key, b); }
    return b;
  };

  for (const h of (d.holdings || [])) {
    const b = bump(acctKey(h.account_id, h.account_name));
    if (h.source === 'manager') {
      b.metal += h.metal || 0; b.card += h.card || 0; b.fob += h.fob || 0; b.dispenser += h.dispenser || 0;
    } else if (h.source === 'crew') {
      const bucket = (h.bucket as keyof Breakdown) || 'other';
      if (bucket in b) b[bucket] += 1; else b.other += 1;
    }
  }

  const rows: EmployeeExportRow[] = (d.accounts || []).map((a: any) => {
    const b = perAcct.get(acctKey(a.id, a.name)) || emptyBreak();
    const total = b.metal + b.card + b.fob + b.dispenser + b.other;
    return {
      client: a.name || '',
      bc: a.bc_client_number || '',
      ic: a.ic_name || '',
      role: a.role || '—',
      ...b,
      total,
    };
  });

  return {
    name: d.name,
    role_label: d.role_label,
    shift: d.shift ?? null,
    day_night: d.day_night ?? null,
    email: d.email ?? null,
    phone: d.phone ?? null,
    summary: {
      clients: d.accounts_assigned ?? rows.length,
      totalKeys: d.total_keys_held ?? 0,
      metal: d.keys_metal || 0,
      card: d.keys_card || 0,
      fob: d.keys_fob || 0,
      dispenser: d.keys_dispenser || 0,
      other: d.keys_other || 0,
    },
    rows,
  };
}

const contactLine = (m: EmployeeExportModel): string =>
  [m.email, m.phone].filter(Boolean).join('  ·  ') || '—';
const shiftLine = (m: EmployeeExportModel): string =>
  [m.shift ? `${m.shift} shift` : null, m.day_night ? m.day_night[0].toUpperCase() + m.day_night.slice(1) : null]
    .filter(Boolean).join('  ·  ') || '—';

// ── Excel (.xlsx) ────────────────────────────────────────────────────────────
export async function buildEmployeeWorkbook(m: EmployeeExportModel): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'City Wide Boston Key Management';
  wb.created = new Date();
  const ws = wb.addWorksheet('Employee');

  const bold = (cell: ExcelJS.Cell) => { cell.font = { bold: true }; };
  const label = (r: number, text: string, value: string | number) => {
    ws.getCell(`A${r}`).value = text; bold(ws.getCell(`A${r}`));
    ws.getCell(`B${r}`).value = value;
  };

  ws.mergeCells('A1:I1');
  ws.getCell('A1').value = 'City Wide Boston — Employee Key Report';
  ws.getCell('A1').font = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } };
  ws.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A1A1A' } };
  ws.getRow(1).height = 22;

  label(3, 'Employee', m.name);
  label(4, 'Role', m.role_label);
  label(5, 'Shift', shiftLine(m));
  label(6, 'Contact', contactLine(m));

  label(8, 'Total Clients Managed', m.summary.clients);
  label(9, 'Total Keys Held', m.summary.totalKeys);
  label(10, 'Keys by Type', [
    `${m.summary.metal} Metal`,
    `${m.summary.card} Key Card`,
    `${m.summary.fob} Key Fob`,
    `${m.summary.dispenser} Dispenser`,
    ...(m.summary.other ? [`${m.summary.other} Other`] : []),
  ].join('  ·  '));

  const headerRowNum = 12;
  const columns = [
    { header: 'Client Name', width: 34 },
    { header: 'BC Client #', width: 15 },
    { header: 'Independent Contractor', width: 28 },
    { header: 'Role', width: 12 },
    { header: 'Metal', width: 8 },
    { header: 'Key Card', width: 10 },
    { header: 'Key Fob', width: 9 },
    { header: 'Dispenser', width: 11 },
    { header: 'Total', width: 8 },
  ];
  columns.forEach((c, i) => {
    ws.getColumn(i + 1).width = c.width;
    const cell = ws.getCell(headerRowNum, i + 1);
    cell.value = c.header;
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A1A1A' } };
  });

  let r = headerRowNum + 1;
  for (const row of m.rows) {
    ws.getCell(r, 1).value = row.client;
    ws.getCell(r, 2).value = row.bc;
    ws.getCell(r, 3).value = row.ic;
    ws.getCell(r, 4).value = row.role;
    ws.getCell(r, 5).value = row.metal;
    ws.getCell(r, 6).value = row.card;
    ws.getCell(r, 7).value = row.fob;
    ws.getCell(r, 8).value = row.dispenser;
    ws.getCell(r, 9).value = row.total;
    r++;
  }

  const totalsRow = r;
  ws.getCell(totalsRow, 1).value = 'TOTAL';
  ws.getCell(totalsRow, 5).value = m.summary.metal;
  ws.getCell(totalsRow, 6).value = m.summary.card;
  ws.getCell(totalsRow, 7).value = m.summary.fob;
  ws.getCell(totalsRow, 8).value = m.summary.dispenser;
  ws.getCell(totalsRow, 9).value = m.summary.totalKeys;
  for (let c = 1; c <= 9; c++) bold(ws.getCell(totalsRow, c));

  ws.views = [{ state: 'frozen', ySplit: headerRowNum }];
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ── One-page branded PDF ─────────────────────────────────────────────────────
type Col = { key: keyof EmployeeExportRow; label: string; x: number; w: number; align: 'left' | 'right' };

export async function buildEmployeePdf(m: EmployeeExportModel): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const logo = await embedLogo(doc);

  const PAGE_W = 612, PAGE_H = 792, MARGIN = 36;
  const cols: Col[] = [
    { key: 'client', label: 'Client Name', x: MARGIN, w: 168, align: 'left' },
    { key: 'bc', label: 'BC Client #', x: MARGIN + 168, w: 78, align: 'left' },
    { key: 'ic', label: 'Ind. Contractor', x: MARGIN + 246, w: 132, align: 'left' },
    { key: 'role', label: 'Role', x: MARGIN + 378, w: 54, align: 'left' },
    { key: 'metal', label: 'Mtl', x: MARGIN + 432, w: 26, align: 'right' },
    { key: 'card', label: 'Card', x: MARGIN + 458, w: 28, align: 'right' },
    { key: 'fob', label: 'Fob', x: MARGIN + 486, w: 24, align: 'right' },
    { key: 'dispenser', label: 'Disp', x: MARGIN + 510, w: 30, align: 'right' },
    { key: 'total', label: 'Tot', x: MARGIN + 540, w: 36, align: 'right' },
  ];
  const TABLE_RIGHT = MARGIN + 540 + 36;
  const FOOTER = `Generated ${new Date().toISOString().slice(0, 10)} · No access codes are included in this report.`;

  const clip = (s: string, font: PDFFont, size: number, maxW: number): string => {
    if (!s) return '';
    if (font.widthOfTextAtSize(s, size) <= maxW) return s;
    let t = s;
    while (t.length > 1 && font.widthOfTextAtSize(t + '…', size) > maxW) t = t.slice(0, -1);
    return t + '…';
  };
  const cellText = (page: PDFPage, text: any, col: Col, y: number, font: PDFFont, size: number) => {
    const s = clip(String(text ?? ''), font, size, col.w - 6);
    const x = col.align === 'right' ? col.x + col.w - 3 - font.widthOfTextAtSize(s, size) : col.x + 3;
    page.drawText(s, { x, y, size, font, color: CW_CHARCOAL });
  };

  const HEADER_H = 18, ROW_H = 15, HEADER_SIZE = 7.5, ROW_SIZE = 8;
  let page = doc.addPage([PAGE_W, PAGE_H]);
  let y = 0;

  const drawTableHeader = () => {
    page.drawRectangle({ x: MARGIN, y: y - HEADER_H, width: TABLE_RIGHT - MARGIN, height: HEADER_H, color: CW_CHARCOAL });
    for (const c of cols) {
      const s = c.label;
      const x = c.align === 'right' ? c.x + c.w - 3 - bold.widthOfTextAtSize(s, HEADER_SIZE) : c.x + 3;
      page.drawText(s, { x, y: y - HEADER_H + 6, size: HEADER_SIZE, font: bold, color: WHITE });
    }
    y -= HEADER_H;
  };

  // ── First page ─────────────────────────────────────────────────────────────
  y = drawBrandedHeader(page, { bold, regular }, logo, 'Employee Key Report', m.name);

  y -= 6;
  const infoLine = (labelText: string, value: string) => {
    page.drawText(labelText, { x: MARGIN, y, size: 9, font: bold, color: CW_CHARCOAL });
    page.drawText(value, { x: MARGIN + 96, y, size: 9, font: regular, color: CW_CHARCOAL });
    y -= 15;
  };
  infoLine('Role', m.role_label || '—');
  infoLine('Shift', shiftLine(m));
  infoLine('Contact', contactLine(m));

  // Summary band
  y -= 8;
  const bandH = 52;
  page.drawRectangle({ x: MARGIN, y: y - bandH, width: TABLE_RIGHT - MARGIN, height: bandH, color: CW_LIGHT });
  page.drawRectangle({ x: MARGIN, y: y - bandH, width: 4, height: bandH, color: CW_RED });
  page.drawText('SUMMARY', { x: MARGIN + 12, y: y - 16, size: 9, font: bold, color: CW_CHARCOAL });
  const stat = (x: number, big: string, small: string) => {
    page.drawText(big, { x, y: y - 34, size: 15, font: bold, color: CW_CHARCOAL });
    page.drawText(small, { x, y: y - 45, size: 7.5, font: regular, color: CW_GRAY });
  };
  stat(MARGIN + 12, String(m.summary.clients), 'Clients Managed');
  stat(MARGIN + 120, String(m.summary.totalKeys), 'Total Keys Held');
  stat(MARGIN + 228, String(m.summary.metal), 'Metal');
  stat(MARGIN + 300, String(m.summary.card), 'Key Card');
  stat(MARGIN + 372, String(m.summary.fob), 'Key Fob');
  stat(MARGIN + 444, String(m.summary.dispenser), 'Dispenser');
  y -= bandH + 22;

  page.drawText('Clients Under This Employee', { x: MARGIN, y, size: 10, font: bold, color: CW_CHARCOAL });
  y -= 6;
  drawTableHeader();

  const newPage = () => {
    drawFooter(page, regular, FOOTER);
    page = doc.addPage([PAGE_W, PAGE_H]);
    y = drawBrandedHeader(page, { bold, regular }, logo, 'Employee Key Report (cont.)', m.name);
    y -= 6;
    drawTableHeader();
  };

  let i = 0;
  for (const row of m.rows) {
    if (y - ROW_H < 60) newPage();
    if (i % 2 === 1) page.drawRectangle({ x: MARGIN, y: y - ROW_H, width: TABLE_RIGHT - MARGIN, height: ROW_H, color: ZEBRA });
    const ty = y - ROW_H + 5;
    for (const c of cols) cellText(page, row[c.key], c, ty, regular, ROW_SIZE);
    y -= ROW_H;
    i++;
  }
  if (m.rows.length === 0) {
    page.drawText('No clients assigned to this employee.', { x: MARGIN + 3, y: y - 12, size: 9, font: regular, color: CW_GRAY });
    y -= ROW_H;
  }

  // Totals row
  if (y - ROW_H < 60) newPage();
  page.drawRectangle({ x: MARGIN, y: y - ROW_H, width: TABLE_RIGHT - MARGIN, height: ROW_H, color: CW_BORDER });
  const ty = y - ROW_H + 5;
  cellText(page, 'TOTAL', cols[0], ty, bold, ROW_SIZE);
  cellText(page, m.summary.metal, cols[4], ty, bold, ROW_SIZE);
  cellText(page, m.summary.card, cols[5], ty, bold, ROW_SIZE);
  cellText(page, m.summary.fob, cols[6], ty, bold, ROW_SIZE);
  cellText(page, m.summary.dispenser, cols[7], ty, bold, ROW_SIZE);
  cellText(page, m.summary.totalKeys, cols[8], ty, bold, ROW_SIZE);

  drawFooter(page, regular, FOOTER);
  return Buffer.from(await doc.save());
}
