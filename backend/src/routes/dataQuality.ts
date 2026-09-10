import { Router, Response } from 'express';
import ExcelJS from 'exceljs';
import { requireAuth, AuthRequest } from '../middleware/auth';
import {
  findDuplicates, findMissingEmail, duplicateSummary,
  type DuplicatePair, type NoEmailRecord,
} from '../lib/duplicates';

const router = Router();

// ── Data quality — READ ONLY ─────────────────────────────────────────────────
// Every route in this file is a GET. There is no merge, no archive, no edit and
// no delete, and there must never be one added here: the point of the view is
// that Cara can look at two near-identical records WITHOUT the tool having
// already decided which one is real. Real account data has to be verified
// before anything is merged, and a button on this screen would invite exactly
// the shortcut that skips that.
//
// The evidence columns are the deliverable. A pair is only actionable once you
// can see which side has the clients, the keys and the open custody attached.

router.get('/duplicates', requireAuth, (req: AuthRequest, res: Response) => {
  const includeTest = req.query.include_test === '1' || req.query.include_test === 'true';
  let pairs = findDuplicates();
  if (!includeTest) pairs = pairs.filter((p) => !(p.a.is_test === 1 || p.b.is_test === 1));

  const population = String(req.query.population ?? '');
  if (population === 'staff' || population === 'ic' || population === 'customer') {
    pairs = pairs.filter((p) => p.population === population);
  }

  res.json({
    pairs,
    total: pairs.length,
    summary: duplicateSummary(includeTest),
    // Said in the payload as well as the UI, because an export or an API
    // consumer should not have to infer it.
    read_only: true,
  });
});

router.get('/missing-email', requireAuth, (req: AuthRequest, res: Response) => {
  const includeTest = req.query.include_test === '1' || req.query.include_test === 'true';
  let records = findMissingEmail();
  if (!includeTest) records = records.filter((r) => r.is_test !== 1);
  const summary = duplicateSummary(includeTest);
  res.json({
    records,
    total: records.length,
    // "12 of 506" — the denominator is what makes the number mean anything.
    of_total: summary.staff_total + summary.ic_total,
    read_only: true,
  });
});

router.get('/summary', requireAuth, (req: AuthRequest, res: Response) => {
  const includeTest = req.query.include_test === '1' || req.query.include_test === 'true';
  res.json(duplicateSummary(includeTest));
});

// ── Excel export ─────────────────────────────────────────────────────────────
// So Cara can work through it offline. Two sheets, one per question, with the
// same columns the screen shows — a pair on one row, both sides side by side,
// because comparing them is the whole task.

const HEADER_FILL = 'FF1A1A1A';

function styleHeader(row: ExcelJS.Row) {
  row.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
  row.alignment = { vertical: 'middle' };
  row.height = 22;
}

const dateOnly = (s: string | null) => (s ? String(s).slice(0, 10) : '');

function addDuplicateSheet(wb: ExcelJS.Workbook, pairs: DuplicatePair[]) {
  const ws = wb.addWorksheet('Possible Duplicates');
  ws.columns = [
    { header: 'Type', key: 'kind', width: 16 },
    { header: 'Confidence', key: 'confidence', width: 12 },
    { header: 'Why flagged', key: 'reason', width: 46 },
    { header: 'A — Name', key: 'aname', width: 30 },
    { header: 'A — Email', key: 'aemail', width: 28 },
    { header: 'A — Role/Type', key: 'arole', width: 14 },
    { header: 'A — Number', key: 'anum', width: 15 },
    { header: 'A — Clients', key: 'aclients', width: 10 },
    { header: 'A — Keys', key: 'akeys', width: 9 },
    { header: 'A — Active custody', key: 'acust', width: 16 },
    { header: 'A — Created', key: 'acreated', width: 12 },
    { header: 'B — Name', key: 'bname', width: 30 },
    { header: 'B — Email', key: 'bemail', width: 28 },
    { header: 'B — Role/Type', key: 'brole', width: 14 },
    { header: 'B — Number', key: 'bnum', width: 15 },
    { header: 'B — Clients', key: 'bclients', width: 10 },
    { header: 'B — Keys', key: 'bkeys', width: 9 },
    { header: 'B — Active custody', key: 'bcust', width: 16 },
    { header: 'B — Created', key: 'bcreated', width: 12 },
    { header: 'Cara’s note', key: 'note', width: 40 },
  ];
  styleHeader(ws.getRow(1));
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  for (const p of pairs) {
    ws.addRow({
      kind: p.kind.replace(/_/g, ' '),
      confidence: p.confidence,
      reason: p.reason,
      aname: p.a.name, aemail: p.a.email ?? '', arole: p.a.role, anum: p.a.number ?? '',
      aclients: p.a.clients_linked, akeys: p.a.keys_held, acust: p.a.active_custody,
      acreated: dateOnly(p.a.created_at),
      bname: p.b.name, bemail: p.b.email ?? '', brole: p.b.role, bnum: p.b.number ?? '',
      bclients: p.b.clients_linked, bkeys: p.b.keys_held, bcust: p.b.active_custody,
      bcreated: dateOnly(p.b.created_at),
      note: '',
    });
  }
  if (!pairs.length) ws.addRow({ kind: 'None found', reason: 'No candidate pairs matched.' });
  ws.autoFilter = { from: 'A1', to: { row: 1, column: ws.columnCount } };
}

function addMissingEmailSheet(wb: ExcelJS.Workbook, records: NoEmailRecord[], ofTotal: number) {
  const ws = wb.addWorksheet('No Email On File');
  ws.columns = [
    { header: 'Name', key: 'name', width: 32 },
    { header: 'Role/Type', key: 'role', width: 14 },
    { header: 'Population', key: 'population', width: 12 },
    { header: 'Active', key: 'active', width: 8 },
    { header: 'Clients linked', key: 'clients', width: 14 },
    { header: 'Keys held', key: 'keys', width: 11 },
    { header: 'Active custody records', key: 'custody', width: 20 },
    { header: 'Created', key: 'created', width: 12 },
    { header: 'Email to add', key: 'email', width: 30 },
  ];
  styleHeader(ws.getRow(1));
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  for (const r of records) {
    ws.addRow({
      name: r.name, role: r.role, population: r.population,
      active: r.active ? 'Yes' : 'No',
      clients: r.clients_linked, keys: r.keys_held, custody: r.active_custody,
      created: dateOnly(r.created_at), email: '',
    });
  }
  ws.addRow({});
  ws.addRow({ name: `${records.length} of ${ofTotal} staff and IC records have no email on file.` });
  ws.autoFilter = { from: 'A1', to: { row: 1, column: ws.columnCount } };
}

router.get('/export', requireAuth, async (req: AuthRequest, res: Response) => {
  const includeTest = req.query.include_test === '1' || req.query.include_test === 'true';
  let pairs = findDuplicates();
  let missing = findMissingEmail();
  if (!includeTest) {
    pairs = pairs.filter((p) => !(p.a.is_test === 1 || p.b.is_test === 1));
    missing = missing.filter((r) => r.is_test !== 1);
  }
  const summary = duplicateSummary(includeTest);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'City Wide Boston — Key Management';
  wb.created = new Date();

  const intro = wb.addWorksheet('Read Me');
  intro.columns = [{ width: 100 }];
  intro.addRow(['Possible Duplicates — review sheet']);
  intro.getRow(1).font = { bold: true, size: 14 };
  intro.addRow([]);
  for (const line of [
    'This workbook is a REPORT. Nothing has been merged, archived, edited or deleted.',
    'Every record named here is exactly as it was entered.',
    '',
    'Each row on "Possible Duplicates" is one candidate PAIR, with both sides side by side.',
    'The columns that matter are Clients, Keys and Active custody: they show which record',
    'has real history attached, which is what decides whether a pair is a duplicate at all.',
    '',
    'A near-match is a suggestion, not a finding. Two people can legitimately have names',
    'one character apart, and one mailbox can legitimately be shared.',
    '',
    'Use the "Cara’s note" column to record what you want done with each pair.',
    '',
    `Generated ${new Date().toLocaleString()}`,
    `${pairs.length} candidate pair(s) — ${summary.exact} exact, ${summary.near} near.`,
    `${missing.length} of ${summary.staff_total + summary.ic_total} staff and IC records have no email on file.`,
  ]) intro.addRow([line]);

  addDuplicateSheet(wb, pairs);
  addMissingEmailSheet(wb, missing, summary.staff_total + summary.ic_total);

  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="possible-duplicates-${stamp}.xlsx"`);
  res.send(buf);
});

export default router;
