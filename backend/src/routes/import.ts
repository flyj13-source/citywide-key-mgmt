import { Router, Response } from 'express';
import multer from 'multer';
import * as XLSX from 'xlsx';
import { requireAuth, AuthRequest } from '../middleware/auth';
import db from '../lib/db';
import { logAudit } from '../lib/audit';
import { encrypt } from '../lib/crypto';
import { gridTotal } from '../lib/roleKeys';
import {
  detectShape, describeHeaders, parseStaffRows, parseIcRows,
  importStaffEmails, importIcEmails,
  resolveCustomerIcEmails, type StaffEmailRow, type IcEmailRow,
} from '../lib/emailImport';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// ── Column name → field mapping (case-insensitive, trimmed) ─────────────────
const COLUMN_MAP: Record<string, string> = {
  // Customer sheet columns (Key Inventory Log format)
  'client name': 'ic_company_name',
  'bc client number': 'bc_client_number',
  'bc client #': 'bc_client_number',
  'independent contractor': 'ic_name',
  'ic name': 'ic_name',
  'bc vendor number': 'bc_vendor_number',
  'bc vendor #': 'bc_vendor_number',
  'vendor number': 'bc_vendor_number',
  'account manager': 'account_manager',
  'contract compliance manager': 'ccm_manager',
  'compliance manager': 'ccm_manager',
  // Role key counts (Y/yes treated as 1, numeric values used directly)
  //
  // IMPORTANT: the real registry sheet has BOTH a manager-NAME column
  // ("Contract Compliance Manager") AND a separate, later, short KEY-COUNT
  // column ("CCM"). A bare 'ccm' alias here used to point at ccm_manager,
  // which collided with the name column on the SAME destination field — the
  // blank key-count "CCM" column (appearing after "Contract Compliance
  // Manager" in the sheet) silently overwrote the correctly-imported name
  // with an empty value. 'ccm' (bare) now correctly means the KEY-COUNT
  // column and points at ccm_keys; only "Contract Compliance Manager" /
  // "Compliance Manager" / "CCM Manager" / "CCM Mgr" (below) set the name.
  // Flat holder-total columns — "hold as unspecified": a bare "AM"/"CCM"/"IC"/
  // "Office" header sets that holder's TOTAL directly (via gridTotal's legacy-
  // preserve path) WITHOUT fabricating a type breakdown. We deliberately do NOT
  // distribute the number across Metal/Card/Fob/Dispenser — a flat "AM: 3" says
  // "AM has 3 keys of some type," not "AM has 0.75 of each type." The real
  // breakdown, if ever entered later (in the app or a future sheet with the
  // per-cell headers below), becomes authoritative and this total is recomputed.
  'am key': 'am_keys',
  'am keys': 'am_keys',
  'am key(s)': 'am_keys',
  'am': 'am_keys',
  'ccm key': 'ccm_keys',
  'ccm keys': 'ccm_keys',
  'ccm key(s)': 'ccm_keys',
  'ccm': 'ccm_keys',
  'contractor key': 'contractor_keys',
  'contractor keys': 'contractor_keys',
  'contractor key(s)': 'contractor_keys',
  'ic key': 'contractor_keys',
  'ic keys': 'contractor_keys',
  'ic key(s)': 'contractor_keys',
  'ic': 'contractor_keys',
  // "Office" is now a HOLDER (like AM/CCM/IC), not a key TYPE — a bare
  // "Office" column sets the Office holder's total (office_keys_held), same
  // hold-as-unspecified rule as above. It no longer means "site office key
  // count" (that concept is retired; see office_keys migration in db.ts).
  'office': 'office_keys_held',
  'office key': 'office_keys_held',
  'office keys': 'office_keys_held',
  // Shared client-site columns (Key Inventory — row totals of the grid)
  'keys y/n': 'keys_yn',
  'keys': 'keys_yn',
  'security app y/n': 'security_app_yn',
  'security app': 'security_app_yn',
  'metal keys': 'metal_keys',
  'key cards': 'key_cards',
  'key fobs': 'has_fob',
  'fob': 'has_fob',
  'dispenser key': 'dispenser_keys',
  'dispenser keys': 'dispenser_keys',
  // Optional per-holder per-type breakdown — the grid's 16 cells. Rows are
  // types (Metal/Card/Fob/Dispenser); each holder (AM/CCM/Contractor·IC/
  // Office) gets its own column. Case-insensitive, singular/plural.
  'am metal': 'am_metal', 'am metal key': 'am_metal', 'am metal keys': 'am_metal',
  'am card': 'am_card', 'am key card': 'am_card', 'am key cards': 'am_card',
  'am fob': 'am_fob', 'am key fob': 'am_fob', 'am key fobs': 'am_fob',
  'am dispenser': 'am_dispenser', 'am dispenser key': 'am_dispenser', 'am dispenser keys': 'am_dispenser',
  'ccm metal': 'ccm_metal', 'ccm metal key': 'ccm_metal', 'ccm metal keys': 'ccm_metal',
  'ccm card': 'ccm_card', 'ccm key card': 'ccm_card', 'ccm key cards': 'ccm_card',
  'ccm fob': 'ccm_fob', 'ccm key fob': 'ccm_fob', 'ccm key fobs': 'ccm_fob',
  'ccm dispenser': 'ccm_dispenser', 'ccm dispenser key': 'ccm_dispenser', 'ccm dispenser keys': 'ccm_dispenser',
  'contractor metal': 'contractor_metal', 'contractor metal key': 'contractor_metal', 'contractor metal keys': 'contractor_metal',
  'ic metal': 'contractor_metal', 'ic metal key': 'contractor_metal',
  'contractor card': 'contractor_card', 'contractor key card': 'contractor_card', 'contractor key cards': 'contractor_card',
  'ic card': 'contractor_card', 'ic key card': 'contractor_card',
  'contractor fob': 'contractor_fob', 'contractor key fob': 'contractor_fob', 'contractor key fobs': 'contractor_fob',
  'ic fob': 'contractor_fob', 'ic key fob': 'contractor_fob',
  'contractor dispenser': 'contractor_dispenser', 'contractor dispenser key': 'contractor_dispenser', 'contractor dispenser keys': 'contractor_dispenser',
  'ic dispenser': 'contractor_dispenser', 'ic dispenser key': 'contractor_dispenser',
  'office metal': 'office_metal', 'office metal key': 'office_metal', 'office metal keys': 'office_metal',
  'office card': 'office_card', 'office key card': 'office_card', 'office key cards': 'office_card',
  'office fob': 'office_fob', 'office key fob': 'office_fob', 'office key fobs': 'office_fob',
  'office dispenser': 'office_dispenser', 'office dispenser key': 'office_dispenser', 'office dispenser keys': 'office_dispenser',
  'lockbox code': 'lockbox_code',
  'lockbox': 'lockbox_code',
  'door code': 'door_code',
  'alarm code': 'alarm_code',
  'notes': 'notes',
  'status': 'status',
  // Extra real-world aliases — abbreviated manager titles, singular key-type
  // headers, common typos. Defensive: doesn't replace exact matches above.
  'contract compliance mgr': 'ccm_manager',
  'compliance mgr': 'ccm_manager',
  'ccm manager': 'ccm_manager',
  'ccm mgr': 'ccm_manager',
  'account mgr': 'account_manager',
  'am manager': 'account_manager',
  'metal key': 'metal_keys',
  'key card': 'key_cards',
  'key fob': 'has_fob',
  'security app y/n?': 'security_app_yn',
  'keys y/n?': 'keys_yn',
};

// Normalizes a raw header cell for matching: trim, collapse internal
// whitespace (incl. non-breaking spaces) to a single space, drop a trailing
// colon, lowercase. Applied to BOTH the sheet's header row and (implicitly,
// since COLUMN_MAP keys are already in this form) the lookup table, so stray
// double-spaces / NBSP / trailing punctuation don't cause a silent miss.
function normalizeHeader(raw: any): string {
  return String(raw ?? '')
    .replace(/\u00A0/g, ' ') // non-breaking space → regular space
    .trim()
    .replace(/:\s*$/, '') // drop a trailing colon (e.g. "CCM Manager:")
    .replace(/\s+/g, ' ') // collapse double/multi spaces
    .toLowerCase();
}

function parseYN(val: any): number {
  if (val === null || val === undefined || val === '') return 0;
  const s = String(val).trim().toLowerCase();
  return ['y', 'yes', '1', 'true'].includes(s) ? 1 : 0;
}

function parseNum(val: any): number {
  const n = parseInt(String(val ?? '0').trim(), 10);
  return isNaN(n) ? 0 : n;
}

// Handles both "Y"/"yes" (→1) and numeric counts
function parseCount(val: any): number {
  if (val === null || val === undefined || val === '') return 0;
  const s = String(val).trim().toLowerCase();
  if (['y', 'yes', 'true'].includes(s)) return 1;
  const n = parseInt(s, 10);
  return isNaN(n) ? 0 : n;
}

interface ParseResult {
  rows: Record<string, any>[];
  // Header cells that didn't match anything in COLUMN_MAP — surfaced to the
  // preview response so a mapping gap is VISIBLE instead of silently landing
  // as null/0 for every row (the failure mode that caused ccm_manager and the
  // key-count columns to import empty).
  unmappedHeaders: string[];
  mappedHeaders: string[];
  // Two DIFFERENT sheet columns that both resolved to the same destination
  // field (e.g. a manager-NAME column and an unrelated short KEY-COUNT column
  // both pointing at the same field via an ambiguous alias). This is the bug
  // class that caused "Contract Compliance Manager" to import blank: a later
  // blank "CCM" key-count column silently overwrote it. Reported so it's
  // visible even if a future alias addition reintroduces a collision.
  fieldCollisions: { field: string; headers: string[] }[];
}

function parseRows(buffer: Buffer, mimetype: string): ParseResult {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const ws = wb.Sheets[pickSheet(wb)];
  const raw: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  if (raw.length < 2) return { rows: [], unmappedHeaders: [], mappedHeaders: [], fieldCollisions: [] };

  const headers = (raw[0] as any[]).map((h) => normalizeHeader(h));
  const fieldMap: Record<number, string> = {};
  const unmappedHeaders: string[] = [];
  const mappedHeaders: string[] = [];
  const headersByField: Record<string, { idx: number; label: string }[]> = {};
  headers.forEach((h, i) => {
    if (!h) return; // blank trailing column — not a real header, don't report it
    if (COLUMN_MAP[h]) {
      const field = COLUMN_MAP[h];
      fieldMap[i] = field;
      const label = String(raw[0][i]).trim();
      mappedHeaders.push(label);
      (headersByField[field] ??= []).push({ idx: i, label });
    } else {
      unmappedHeaders.push(String(raw[0][i]).trim());
    }
  });

  // Surface any destination field claimed by more than one distinct header.
  const fieldCollisions = Object.entries(headersByField)
    .filter(([, hs]) => hs.length > 1)
    .map(([field, hs]) => ({ field, headers: hs.map((h) => h.label) }));

  const rows = raw.slice(1).map((row) => {
    const obj: Record<string, any> = {};
    // Group indices by destination field so a collision prefers the first
    // NON-BLANK value across the colliding columns for this row, instead of
    // blindly letting the last column (by index) win and zero out real data.
    for (const [field, entries] of Object.entries(headersByField)) {
      let value: any = '';
      for (const { idx } of entries) {
        const cell = (row as any[])[idx];
        if (cell !== undefined && cell !== null && String(cell).trim() !== '') { value = cell; break; }
      }
      obj[field] = value;
    }
    return obj;
  }).filter((r) => Object.values(r).some((v) => String(v).trim() !== ''));

  return { rows, unmappedHeaders, mappedHeaders, fieldCollisions };
}

interface ParsedRow {
  ic_company_name: string;
  bc_client_number: string;
  bc_vendor_number: string;
  ic_name: string;
  account_manager: string;
  ccm_manager: string;
  keys_yn: number;
  security_app_yn: number;
  // Client-site totals (Key Inventory row totals). If the grid below has data
  // for a type, its row sum overrides these; otherwise these (flat/legacy
  // values) are preserved — see gridTotal() usage at the call sites.
  metal_keys: number;
  key_cards: number;
  has_fob: number;
  dispenser_keys: number;
  // Holder × type grid — TRANSPOSED: rows are types, these 16 are the columns.
  am_metal: number; am_card: number; am_fob: number; am_dispenser: number;
  ccm_metal: number; ccm_card: number; ccm_fob: number; ccm_dispenser: number;
  contractor_metal: number; contractor_card: number; contractor_fob: number; contractor_dispenser: number;
  office_metal: number; office_card: number; office_fob: number; office_dispenser: number;
  // Column totals — computed from the grid, or the flat "hold as unspecified"
  // total when no per-type breakdown was given.
  am_keys: number;
  ccm_keys: number;
  contractor_keys: number;
  office_keys_held: number;
  lockbox_code: string;
  door_code: string;
  alarm_code: string;
  notes: string;
  status: string;
}

function normalizeRow(raw: Record<string, any>): ParsedRow {
  const am_metal = parseCount(raw.am_metal), am_card = parseCount(raw.am_card),
    am_fob = parseCount(raw.am_fob), am_dispenser = parseCount(raw.am_dispenser);
  const ccm_metal = parseCount(raw.ccm_metal), ccm_card = parseCount(raw.ccm_card),
    ccm_fob = parseCount(raw.ccm_fob), ccm_dispenser = parseCount(raw.ccm_dispenser);
  const contractor_metal = parseCount(raw.contractor_metal), contractor_card = parseCount(raw.contractor_card),
    contractor_fob = parseCount(raw.contractor_fob), contractor_dispenser = parseCount(raw.contractor_dispenser);
  const office_metal = parseCount(raw.office_metal), office_card = parseCount(raw.office_card),
    office_fob = parseCount(raw.office_fob), office_dispenser = parseCount(raw.office_dispenser);

  return {
    ic_company_name: String(raw.ic_company_name ?? '').trim(),
    bc_client_number: String(raw.bc_client_number ?? '').trim(),
    bc_vendor_number: String(raw.bc_vendor_number ?? '').trim(),
    ic_name: String(raw.ic_name ?? '').trim(),
    account_manager: String(raw.account_manager ?? '').trim(),
    ccm_manager: String(raw.ccm_manager ?? '').trim(),
    keys_yn: parseYN(raw.keys_yn),
    security_app_yn: parseYN(raw.security_app_yn),
    // Client-site row totals: the grid (summed across all 4 holders for this
    // type) wins if present, else the flat/legacy value is preserved.
    metal_keys: gridTotal(am_metal, ccm_metal, contractor_metal, office_metal, parseNum(raw.metal_keys)),
    key_cards: gridTotal(am_card, ccm_card, contractor_card, office_card, parseNum(raw.key_cards)),
    has_fob: gridTotal(am_fob, ccm_fob, contractor_fob, office_fob, parseCount(raw.has_fob)),
    dispenser_keys: gridTotal(am_dispenser, ccm_dispenser, contractor_dispenser, office_dispenser, parseNum(raw.dispenser_keys)),
    am_metal, am_card, am_fob, am_dispenser,
    ccm_metal, ccm_card, ccm_fob, ccm_dispenser,
    contractor_metal, contractor_card, contractor_fob, contractor_dispenser,
    office_metal, office_card, office_fob, office_dispenser,
    // Column totals: computed from a breakdown when present, else the flat
    // "hold as unspecified" holder total.
    am_keys: gridTotal(am_metal, am_card, am_fob, am_dispenser, parseCount(raw.am_keys)),
    ccm_keys: gridTotal(ccm_metal, ccm_card, ccm_fob, ccm_dispenser, parseCount(raw.ccm_keys)),
    contractor_keys: gridTotal(contractor_metal, contractor_card, contractor_fob, contractor_dispenser, parseCount(raw.contractor_keys)),
    office_keys_held: gridTotal(office_metal, office_card, office_fob, office_dispenser, parseCount(raw.office_keys_held)),
    lockbox_code: String(raw.lockbox_code ?? '').trim(),
    door_code: String(raw.door_code ?? '').trim(),
    alarm_code: String(raw.alarm_code ?? '').trim(),
    notes: String(raw.notes ?? '').trim(),
    status: String(raw.status ?? 'active').trim() || 'active',
  };
}

// ── Sheet selection ─────────────────────────────────────────────────────────
// The IC export ships a "hiddenSheet" alongside the real one, and the employee
// workbook has several tabs. Never blindly take SheetNames[0].
function pickSheet(wb: XLSX.WorkBook): string {
  const named = wb.SheetNames.find((n) => {
    const l = n.toLowerCase();
    return l.includes('active independent contractor') || l.includes('current employee');
  });
  if (named) return named;
  const visible = wb.SheetNames.filter((n) => n.toLowerCase() !== 'hiddensheet');
  return visible[0] ?? wb.SheetNames[0];
}

/** Header row of the chosen sheet, plus the raw grid, for shape detection. */
function readGrid(buffer: Buffer): { sheet: string; raw: any[][] } {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheet = pickSheet(wb);
  // raw:false keeps zero-padded vendor numbers as the text Excel stored.
  const raw: any[][] = XLSX.utils.sheet_to_json(wb.Sheets[sheet], { header: 1, defval: '', raw: false });
  return { sheet, raw };
}

// ── POST /api/accounts/import/emails/confirm — apply an email backfill ───────
// Both email sheets are idempotent, so this endpoint is safe to re-run: it only
// ever fills blanks and never overwrites a populated contact or address.
router.post('/emails/confirm', requireAuth, (req: AuthRequest, res: Response) => {
  const { kind, rows } = req.body as { kind: string; rows: any[] };
  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ error: 'No rows to import' });
  }

  db.exec('BEGIN');
  try {
    if (kind === 'staff-emails') {
      const report = importStaffEmails(db, rows as StaffEmailRow[]);
      db.exec('COMMIT');
      logAudit(req, 'staff_emails_imported', null, null, {
        source: 'registry import', rows: report.totalRows,
        updated: report.matchedUpdated.length, created: report.created.length,
        ambiguous: report.ambiguous.map((a) => a.name),
        still_missing: report.remainingWithoutEmail.length,
      });
      return res.json({ kind, report });
    }
    if (kind === 'ic-emails') {
      const report = importIcEmails(db, rows as IcEmailRow[]);
      const resolution = resolveCustomerIcEmails(db);
      db.exec('COMMIT');
      logAudit(req, 'ic_emails_imported', null, null, {
        source: 'registry import', rows: report.totalRows,
        updated: report.matchedUpdated.length, created: report.created.length,
        missing_email: report.missingEmail.length,
        missing_vendor_no: report.missingVendorNo.length,
        customers_resolved: resolution.resolved, customers_total: resolution.totalCustomers,
      });
      return res.json({ kind, report, resolution });
    }
    db.exec('ROLLBACK');
    return res.status(400).json({ error: `Unknown import kind "${kind}"` });
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
});

// ── POST /api/accounts/import — parse + preview (no DB write) ───────────────
router.post('/', requireAuth, upload.single('file'), (req: AuthRequest, res: Response) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  // The same uploader handles three sheet shapes. The two email backfills are
  // recognised from their header row and previewed as a DRY RUN, so Cara can
  // re-run them herself whenever the source exports are refreshed.
  try {
    const { sheet, raw } = readGrid(req.file.buffer);
    const shape = detectShape(raw[0] ?? []);
    if (shape === 'staff-emails') {
      const parsed = parseStaffRows(raw);
      return res.json({
        kind: 'staff-emails', sheet, rows: parsed,
        headers: describeHeaders(raw[0] ?? [], 'staff-emails'),
        preview: importStaffEmails(db, parsed, { dryRun: true }),
      });
    }
    if (shape === 'ic-emails') {
      const parsed = parseIcRows(raw);
      return res.json({
        kind: 'ic-emails', sheet, rows: parsed,
        headers: describeHeaders(raw[0] ?? [], 'ic-emails'),
        preview: importIcEmails(db, parsed, { dryRun: true }),
        resolutionBefore: resolveCustomerIcEmails(db),
      });
    }
  } catch (e: any) {
    return res.status(400).json({ error: 'Could not parse file: ' + e.message });
  }

  let rawRows: Record<string, any>[];
  let unmappedHeaders: string[];
  let mappedHeaders: string[];
  let fieldCollisions: { field: string; headers: string[] }[];
  try {
    ({ rows: rawRows, unmappedHeaders, mappedHeaders, fieldCollisions } = parseRows(req.file.buffer, req.file.mimetype));
  } catch (e: any) {
    return res.status(400).json({ error: 'Could not parse file: ' + e.message });
  }

  if (mappedHeaders.length === 0) {
    return res.status(400).json({
      error: 'No recognized column headers found — check the header row',
      unmappedHeaders,
    });
  }
  if (rawRows.length === 0) return res.status(400).json({ error: 'No data rows found — check column headers', unmappedHeaders });

  const existingBcClient = new Set(
    (db.prepare('SELECT bc_client_number FROM accounts WHERE bc_client_number IS NOT NULL AND COALESCE(archived, 0) = 0').all() as any[])
      .map((r) => Object.assign({}, r).bc_client_number as string)
  );

  const valid: Array<ParsedRow & { _row: number }> = [];
  const warnings: Array<{ row: number; data: ParsedRow; message: string }> = [];
  const errors: Array<{ row: number; message: string; raw: Record<string, any> }> = [];

  rawRows.forEach((raw, i) => {
    const row = i + 2;
    const data = normalizeRow(raw);

    if (!data.ic_company_name) {
      errors.push({ row, message: 'Missing Client Name (required)', raw });
      return;
    }

    if (data.bc_client_number && existingBcClient.has(data.bc_client_number)) {
      warnings.push({ row, data, message: `BC Client Number "${data.bc_client_number}" already exists — will be skipped on confirm (use upsert mode to backfill)` });
      return;
    }

    valid.push({ ...data, _row: row });
  });

  res.json({ valid, warnings, errors, total: rawRows.length, unmappedHeaders, mappedHeaders, fieldCollisions });
});

// ── POST /api/accounts/import/confirm — insert validated rows ────────────────
// mode='upsert' (body field): for rows whose bc_client_number already exists,
// UPDATE only the fields that are currently NULL or empty rather than skipping.
router.post('/confirm', requireAuth, (req: AuthRequest, res: Response) => {
  const { rows, mode } = req.body as { rows: Array<ParsedRow & { _row?: number }>; mode?: string };
  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ error: 'No rows to import' });
  }

  const upsert = mode === 'upsert';

  const existingBcClient = new Set(
    (db.prepare('SELECT bc_client_number FROM accounts WHERE bc_client_number IS NOT NULL AND COALESCE(archived, 0) = 0').all() as any[])
      .map((r) => Object.assign({}, r).bc_client_number as string)
  );

  const insert = db.prepare(`
    INSERT INTO accounts (
      ic_company_name, bc_client_number, bc_vendor_number,
      ic_name, account_manager, ccm_manager,
      keys_yn, security_app_yn,
      metal_keys, key_cards, has_fob, dispenser_keys,
      am_metal, am_card, am_fob, am_dispenser,
      ccm_metal, ccm_card, ccm_fob, ccm_dispenser,
      contractor_metal, contractor_card, contractor_fob, contractor_dispenser,
      office_metal, office_card, office_fob, office_dispenser,
      am_keys, ccm_keys, contractor_keys, office_keys_held,
      lockbox_code,
      door_code_encrypted, door_code_iv, alarm_code_encrypted, alarm_code_iv,
      notes, status, record_type
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'customer')
  `);

  // Upsert UPDATE: fills NULL/blank text fields and zero numeric fields only
  const upsertUpdate = db.prepare(`
    UPDATE accounts SET
      ic_name           = CASE WHEN (ic_name IS NULL OR ic_name = '')           THEN ? ELSE ic_name END,
      bc_vendor_number  = CASE WHEN (bc_vendor_number IS NULL OR bc_vendor_number = '') THEN ? ELSE bc_vendor_number END,
      account_manager   = CASE WHEN (account_manager IS NULL OR account_manager = '')  THEN ? ELSE account_manager END,
      ccm_manager       = CASE WHEN (ccm_manager IS NULL OR ccm_manager = '')          THEN ? ELSE ccm_manager END,
      keys_yn           = CASE WHEN keys_yn = 0           THEN ? ELSE keys_yn END,
      security_app_yn   = CASE WHEN security_app_yn = 0   THEN ? ELSE security_app_yn END,
      metal_keys        = CASE WHEN metal_keys = 0        THEN ? ELSE metal_keys END,
      key_cards         = CASE WHEN key_cards = 0         THEN ? ELSE key_cards END,
      has_fob           = CASE WHEN has_fob = 0           THEN ? ELSE has_fob END,
      dispenser_keys    = CASE WHEN dispenser_keys = 0    THEN ? ELSE dispenser_keys END,
      am_metal          = CASE WHEN am_metal = 0          THEN ? ELSE am_metal END,
      am_card           = CASE WHEN am_card = 0           THEN ? ELSE am_card END,
      am_fob            = CASE WHEN am_fob = 0            THEN ? ELSE am_fob END,
      am_dispenser      = CASE WHEN am_dispenser = 0      THEN ? ELSE am_dispenser END,
      ccm_metal         = CASE WHEN ccm_metal = 0         THEN ? ELSE ccm_metal END,
      ccm_card          = CASE WHEN ccm_card = 0          THEN ? ELSE ccm_card END,
      ccm_fob           = CASE WHEN ccm_fob = 0           THEN ? ELSE ccm_fob END,
      ccm_dispenser     = CASE WHEN ccm_dispenser = 0     THEN ? ELSE ccm_dispenser END,
      contractor_metal     = CASE WHEN contractor_metal = 0     THEN ? ELSE contractor_metal END,
      contractor_card      = CASE WHEN contractor_card = 0      THEN ? ELSE contractor_card END,
      contractor_fob        = CASE WHEN contractor_fob = 0      THEN ? ELSE contractor_fob END,
      contractor_dispenser = CASE WHEN contractor_dispenser = 0 THEN ? ELSE contractor_dispenser END,
      office_metal      = CASE WHEN office_metal = 0      THEN ? ELSE office_metal END,
      office_card       = CASE WHEN office_card = 0       THEN ? ELSE office_card END,
      office_fob        = CASE WHEN office_fob = 0        THEN ? ELSE office_fob END,
      office_dispenser  = CASE WHEN office_dispenser = 0  THEN ? ELSE office_dispenser END,
      am_keys           = CASE WHEN am_keys = 0           THEN ? ELSE am_keys END,
      ccm_keys          = CASE WHEN ccm_keys = 0          THEN ? ELSE ccm_keys END,
      contractor_keys   = CASE WHEN contractor_keys = 0   THEN ? ELSE contractor_keys END,
      office_keys_held  = CASE WHEN office_keys_held = 0  THEN ? ELSE office_keys_held END,
      lockbox_code      = CASE WHEN (lockbox_code IS NULL OR lockbox_code = '')  THEN ? ELSE lockbox_code END,
      notes             = CASE WHEN (notes IS NULL OR notes = '')                THEN ? ELSE notes END
    WHERE bc_client_number = ? AND record_type = 'customer'
  `);

  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  const rowErrors: Array<{ row: number; message: string; data?: any }> = [];

  // Wrap in a single explicit transaction — all rows commit in one WAL write.
  // node:sqlite has no .transaction() helper so we use BEGIN/COMMIT manually.
  // Individual row errors are caught and collected; they don't abort the batch.
  const t0 = Date.now();
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      if (!r.ic_company_name) { skipped++; continue; }

      const alreadyExists = r.bc_client_number && existingBcClient.has(r.bc_client_number);

      if (alreadyExists && !upsert) { skipped++; continue; }

      let door_enc: string | null = null, door_iv: string | null = null;
      let alarm_enc: string | null = null, alarm_iv: string | null = null;
      if (r.door_code) { const e = encrypt(r.door_code); door_enc = e.encrypted; door_iv = e.iv; }
      if (r.alarm_code) { const e = encrypt(r.alarm_code); alarm_enc = e.encrypted; alarm_iv = e.iv; }

      try {
        if (alreadyExists && upsert) {
          upsertUpdate.run(
            r.ic_name || null, r.bc_vendor_number || null,
            r.account_manager || null, r.ccm_manager || null,
            r.keys_yn, r.security_app_yn,
            r.metal_keys, r.key_cards, r.has_fob, r.dispenser_keys,
            r.am_metal, r.am_card, r.am_fob, r.am_dispenser,
            r.ccm_metal, r.ccm_card, r.ccm_fob, r.ccm_dispenser,
            r.contractor_metal, r.contractor_card, r.contractor_fob, r.contractor_dispenser,
            r.office_metal, r.office_card, r.office_fob, r.office_dispenser,
            r.am_keys, r.ccm_keys, r.contractor_keys, r.office_keys_held,
            r.lockbox_code || null, r.notes || null,
            r.bc_client_number,
          );
          updated++;
        } else {
          insert.run(
            r.ic_company_name, r.bc_client_number || null, r.bc_vendor_number || null,
            r.ic_name || null, r.account_manager || null, r.ccm_manager || null,
            r.keys_yn, r.security_app_yn,
            r.metal_keys, r.key_cards, r.has_fob, r.dispenser_keys,
            r.am_metal ?? 0, r.am_card ?? 0, r.am_fob ?? 0, r.am_dispenser ?? 0,
            r.ccm_metal ?? 0, r.ccm_card ?? 0, r.ccm_fob ?? 0, r.ccm_dispenser ?? 0,
            r.contractor_metal ?? 0, r.contractor_card ?? 0, r.contractor_fob ?? 0, r.contractor_dispenser ?? 0,
            r.office_metal ?? 0, r.office_card ?? 0, r.office_fob ?? 0, r.office_dispenser ?? 0,
            r.am_keys ?? 0, r.ccm_keys ?? 0, r.contractor_keys ?? 0, r.office_keys_held ?? 0,
            r.lockbox_code || null,
            door_enc, door_iv, alarm_enc, alarm_iv,
            r.notes || null, r.status || 'active'
          );
          if (r.bc_client_number) existingBcClient.add(r.bc_client_number);
          inserted++;
        }
      } catch (e: any) {
        const errMsg = (e as Error).message ?? String(e);
        if (rowErrors.length < 10) {
          rowErrors.push({
            row: r._row ?? 0,
            message: errMsg,
            data: { ic_company_name: r.ic_company_name, bc_client_number: r.bc_client_number, bc_vendor_number: r.bc_vendor_number },
          });
        }
        console.error(`[import] row ${r._row ?? '?'} failed: ${errMsg} — client="${r.ic_company_name}" bc_client="${r.bc_client_number}"`);
        skipped++;
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  const elapsed = Date.now() - t0;

  logAudit(req, 'bulk_import', null, null, {
    inserted, updated, skipped, errors: rowErrors.length, total: rows.length, elapsed_ms: elapsed, mode: mode ?? 'insert',
  });

  res.json({ inserted, updated, skipped, errors: rowErrors });
});

// ── POST /api/accounts/import/dry-run — what an update-mode import WOULD fill ──
// Matches existing rows by bc_client_number and reports, per field, how many
// would be back-filled (DB empty/0, sheet has a value). Writes nothing.
const BACKFILL_TEXT = ['ic_name', 'bc_vendor_number', 'account_manager', 'ccm_manager', 'lockbox_code', 'notes'];
const BACKFILL_NUM = [
  'keys_yn', 'security_app_yn', 'metal_keys', 'key_cards', 'has_fob', 'dispenser_keys',
  'am_keys', 'ccm_keys', 'contractor_keys', 'office_keys_held',
  'am_metal', 'am_card', 'am_fob', 'am_dispenser',
  'ccm_metal', 'ccm_card', 'ccm_fob', 'ccm_dispenser',
  'contractor_metal', 'contractor_card', 'contractor_fob', 'contractor_dispenser',
  'office_metal', 'office_card', 'office_fob', 'office_dispenser',
];
router.post('/dry-run', requireAuth, (req: AuthRequest, res: Response) => {
  const { rows } = req.body as { rows: ParsedRow[] };
  if (!Array.isArray(rows)) return res.status(400).json({ error: 'No rows provided' });

  const find = db.prepare("SELECT * FROM accounts WHERE bc_client_number = ? AND record_type = 'customer' AND COALESCE(archived, 0) = 0");
  const wouldFill: Record<string, number> = {};
  let matched = 0, unmatched = 0, rowsWithFills = 0;

  for (const r of rows) {
    if (!r.bc_client_number) { unmatched++; continue; }
    const existing = find.get(r.bc_client_number) as any;
    if (!existing) { unmatched++; continue; }
    matched++;
    let rowFilled = false;
    for (const f of BACKFILL_TEXT) {
      const dbEmpty = existing[f] == null || String(existing[f]).trim() === '';
      const rowHas = (r as any)[f] != null && String((r as any)[f]).trim() !== '';
      if (dbEmpty && rowHas) { wouldFill[f] = (wouldFill[f] || 0) + 1; rowFilled = true; }
    }
    for (const f of BACKFILL_NUM) {
      if ((Number(existing[f]) || 0) === 0 && (Number((r as any)[f]) || 0) > 0) {
        wouldFill[f] = (wouldFill[f] || 0) + 1; rowFilled = true;
      }
    }
    if (rowFilled) rowsWithFills++;
  }

  res.json({ total: rows.length, matched, unmatched, rowsWithFills, wouldFill });
});

// ── GET /api/accounts/import/template — download blank .xlsx ────────────────
router.get('/template', requireAuth, (_req: AuthRequest, res: Response) => {
  const wb = XLSX.utils.book_new();
  const headers = [
    'Client Name', 'BC Client Number', 'Independent Contractor', 'BC Vendor Number',
    'Account Manager', 'Contract Compliance Manager',
    'Keys Y/N', 'Security App Y/N',
    'Metal Keys', 'Key Cards', 'Key Fobs', 'Dispenser Key',
    'AM Key', 'CCM Key', 'Contractor Key', 'Office Key',
    // Optional per-holder per-type breakdown (leave blank to use the totals
    // above) — rows are types, these are the holder columns.
    'AM Metal', 'AM Card', 'AM Fob', 'AM Dispenser',
    'CCM Metal', 'CCM Card', 'CCM Fob', 'CCM Dispenser',
    'Contractor Metal', 'Contractor Card', 'Contractor Fob', 'Contractor Dispenser',
    'Office Metal', 'Office Card', 'Office Fob', 'Office Dispenser',
    'Lockbox Code', 'Door Code', 'Alarm Code', 'Notes',
  ];
  const ws = XLSX.utils.aoa_to_sheet([headers, []]);
  ws['!cols'] = headers.map((h) => ({ wch: Math.max(h.length + 4, 16) }));

  XLSX.utils.book_append_sheet(wb, ws, 'Key Inventory Log Import');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="CityWide_KeyInventory_Import_Template.xlsx"');
  res.send(buf);
});

export default router;
