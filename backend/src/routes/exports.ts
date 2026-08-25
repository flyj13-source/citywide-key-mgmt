import { Router, Response } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { logAudit } from '../lib/audit';
import {
  buildSheets, countRows, sheetsToXlsx, sheetsToCsv, ExportOpts, ExportTab,
} from '../lib/registryExportOnDemand';
import {
  runCustodyReport, reportToXlsx, reportToPdf, describeFilters,
  type CustodyReportFilters, type CustodyStatusFilter, type SignatureFilter, type HolderTypeFilter,
} from '../lib/custodyReport';

const router = Router();

const TAB_LABEL: Record<ExportTab, string> = {
  customer: 'Customers',
  ic: 'IC-Vendors',
  am: 'Account-Managers',
  ccm: 'CCM',
  office: 'Office',
  cwemployees: 'CW-Employees',
  checkedout: 'Checked-Out',
  checkedin: 'Checked-In',
  all: 'All',
  archived: 'Archived',
};
const VALID_TABS = Object.keys(TAB_LABEL) as ExportTab[];

// ── POST /api/exports/registry — full or current-tab registry export ─────────
// Body: { scope: 'current'|'all', tab, format: 'xlsx'|'csv', search?, includeArchived? }
// "What I see is what I get": respects the active search + archived opt-in, and
// mirrors on-screen column order. SECURITY: no decrypted codes — only
// Has Door/Alarm Code Yes/No columns. Audit-logged with scope + row count.
router.post('/registry', requireAuth, async (req: AuthRequest, res: Response) => {
  const {
    scope = 'current', tab = 'all', format = 'xlsx', search = '', includeArchived = false,
  } = (req.body || {}) as Partial<ExportOpts> & { format?: string };

  if (scope !== 'current' && scope !== 'all') {
    return res.status(400).json({ error: "scope must be 'current' or 'all'" });
  }
  if (!VALID_TABS.includes(tab as ExportTab)) {
    return res.status(400).json({ error: 'invalid tab' });
  }
  const fmt = String(format).toLowerCase();
  if (fmt !== 'xlsx' && fmt !== 'csv') {
    return res.status(400).json({ error: "format must be 'xlsx' or 'csv'" });
  }

  const opts: ExportOpts = {
    scope,
    tab: tab as ExportTab,
    search: String(search || '').trim(),
    includeArchived: !!includeArchived,
  };

  const sheets = buildSheets(opts);
  const rowCount = countRows(sheets);
  const scopeLabel = scope === 'all' ? 'Full' : TAB_LABEL[opts.tab];
  const date = new Date().toISOString().slice(0, 10);
  const filename = `CityWide-KeyRegistry-${scopeLabel}-${date}.${fmt}`;

  logAudit(req, 'export_registry', null, null, {
    scope, tab: opts.tab, format: fmt, includeArchived: opts.includeArchived,
    search: opts.search || undefined, row_count: rowCount, sheets: sheets.map((s) => s.name),
  });

  if (fmt === 'csv') {
    const buf = sheetsToCsv(sheets);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.end(buf);
  }

  const buf = await sheetsToXlsx(sheets);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  return res.end(buf);
});

// ── Custody Report ───────────────────────────────────────────────────────────
// Reads the filters off the query string so the same shape drives the JSON the
// screen renders and the two exports — the spreadsheet can never disagree with
// what the person was looking at when they clicked Export.
export function readCustodyFilters(q: Record<string, any>): CustodyReportFilters {
  const pick = <T extends string>(v: any, allowed: readonly T[], fallback: T): T =>
    (allowed as readonly string[]).includes(String(v)) ? (String(v) as T) : fallback;
  return {
    date_from: q.date_from ? String(q.date_from) : null,
    date_to: q.date_to ? String(q.date_to) : null,
    holder: q.holder ? String(q.holder) : null,
    client: q.client ? String(q.client) : null,
    holder_type: pick<HolderTypeFilter>(q.holder_type, ['all', 'employee', 'ic'] as const, 'all'),
    status: pick<CustodyStatusFilter>(q.status, ['all', 'active', 'returned', 'overdue'] as const, 'all'),
    signature: pick<SignatureFilter>(q.signature, ['all', 'signed', 'awaiting'] as const, 'all'),
  };
}

// ── GET /api/exports/custody-report — the on-screen report ───────────────────
router.get('/custody-report', requireAuth, (req: AuthRequest, res: Response) => {
  const filters = readCustodyFilters(req.query as Record<string, any>);
  const { rows, summary } = runCustodyReport(filters);
  res.json({ rows, summary, filters, description: describeFilters(filters) });
});

// ── GET /api/exports/custody-report/download?format=xlsx|pdf ─────────────────
// SECURITY: the report reads only holder/client/key/date columns — door and
// alarm codes are never selected, so no export can carry them.
router.get('/custody-report/download', requireAuth, async (req: AuthRequest, res: Response) => {
  const fmt = String(req.query.format || 'xlsx').toLowerCase();
  if (fmt !== 'xlsx' && fmt !== 'pdf') {
    return res.status(400).json({ error: "format must be 'xlsx' or 'pdf'" });
  }
  const filters = readCustodyFilters(req.query as Record<string, any>);
  const { rows, summary } = runCustodyReport(filters);

  const date = new Date().toISOString().slice(0, 10);
  const filename = `CityWide-CustodyReport-${date}.${fmt}`;

  logAudit(req, 'export_custody_report', null, null, {
    format: fmt, row_count: rows.length, filters, summary, codes_included: false,
  });

  const buf = fmt === 'pdf'
    ? await reportToPdf(rows, summary, filters)
    : await reportToXlsx(rows, summary, filters);

  res.setHeader('Content-Type', fmt === 'pdf'
    ? 'application/pdf'
    : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  return res.end(buf);
});

export default router;
