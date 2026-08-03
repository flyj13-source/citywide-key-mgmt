import { Router, Response } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { logAudit } from '../lib/audit';
import {
  buildSheets, countRows, sheetsToXlsx, sheetsToCsv, ExportOpts, ExportTab,
} from '../lib/registryExportOnDemand';

const router = Router();

const TAB_LABEL: Record<ExportTab, string> = {
  customer: 'Customers',
  ic: 'IC-Vendors',
  am: 'Account-Managers',
  ccm: 'CCM',
  office: 'Office',
  cwemployees: 'CW-Employees',
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

export default router;
