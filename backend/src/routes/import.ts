import { Router, Response } from 'express';
import multer from 'multer';
import * as XLSX from 'xlsx';
import { requireAuth, AuthRequest } from '../middleware/auth';
import db from '../lib/db';
import { logAudit } from '../lib/audit';
import { encrypt } from '../lib/crypto';

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
  'ccm': 'ccm_manager',
  // Role key counts (Y/yes treated as 1, numeric values used directly)
  'am key': 'am_keys',
  'am keys': 'am_keys',
  'am key(s)': 'am_keys',
  'ccm key': 'ccm_keys',
  'ccm keys': 'ccm_keys',
  'ccm key(s)': 'ccm_keys',
  'contractor key': 'contractor_keys',
  'contractor keys': 'contractor_keys',
  'contractor key(s)': 'contractor_keys',
  'ic key': 'contractor_keys',
  'ic keys': 'contractor_keys',
  'ic key(s)': 'contractor_keys',
  // Shared columns
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
  'office key': 'office_keys',
  'office keys': 'office_keys',
  'ic office key': 'ic_office_keys',
  'ic office keys': 'ic_office_keys',
  'am office key': 'am_office_keys',
  'am office keys': 'am_office_keys',
  'ccm office key': 'ccm_office_keys',
  'ccm office keys': 'ccm_office_keys',
  'lockbox code': 'lockbox_code',
  'lockbox': 'lockbox_code',
  'door code': 'door_code',
  'alarm code': 'alarm_code',
  'notes': 'notes',
  'status': 'status',
};

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

function parseRows(buffer: Buffer, mimetype: string): Record<string, any>[] {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const raw: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  if (raw.length < 2) return [];

  const headers = (raw[0] as any[]).map((h) => String(h ?? '').trim().toLowerCase());
  const fieldMap: Record<number, string> = {};
  headers.forEach((h, i) => {
    if (COLUMN_MAP[h]) fieldMap[i] = COLUMN_MAP[h];
  });

  return raw.slice(1).map((row) => {
    const obj: Record<string, any> = {};
    Object.entries(fieldMap).forEach(([idx, field]) => {
      obj[field] = (row as any[])[Number(idx)] ?? '';
    });
    return obj;
  }).filter((r) => Object.values(r).some((v) => String(v).trim() !== ''));
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
  metal_keys: number;
  key_cards: number;
  has_fob: number;
  dispenser_keys: number;
  office_keys: number;
  ic_office_keys: number;
  am_office_keys: number;
  ccm_office_keys: number;
  am_keys: number;
  ccm_keys: number;
  contractor_keys: number;
  lockbox_code: string;
  door_code: string;
  alarm_code: string;
  notes: string;
  status: string;
}

function normalizeRow(raw: Record<string, any>): ParsedRow {
  return {
    ic_company_name: String(raw.ic_company_name ?? '').trim(),
    bc_client_number: String(raw.bc_client_number ?? '').trim(),
    bc_vendor_number: String(raw.bc_vendor_number ?? '').trim(),
    ic_name: String(raw.ic_name ?? '').trim(),
    account_manager: String(raw.account_manager ?? '').trim(),
    ccm_manager: String(raw.ccm_manager ?? '').trim(),
    keys_yn: parseYN(raw.keys_yn),
    security_app_yn: parseYN(raw.security_app_yn),
    metal_keys: parseNum(raw.metal_keys),
    key_cards: parseNum(raw.key_cards),
    has_fob: parseYN(raw.has_fob),
    dispenser_keys: parseNum(raw.dispenser_keys),
    office_keys: parseCount(raw.office_keys),
    ic_office_keys: parseCount(raw.ic_office_keys),
    am_office_keys: parseCount(raw.am_office_keys),
    ccm_office_keys: parseCount(raw.ccm_office_keys),
    am_keys: parseCount(raw.am_keys),
    ccm_keys: parseCount(raw.ccm_keys),
    contractor_keys: parseCount(raw.contractor_keys),
    lockbox_code: String(raw.lockbox_code ?? '').trim(),
    door_code: String(raw.door_code ?? '').trim(),
    alarm_code: String(raw.alarm_code ?? '').trim(),
    notes: String(raw.notes ?? '').trim(),
    status: String(raw.status ?? 'active').trim() || 'active',
  };
}

// ── POST /api/accounts/import — parse + preview (no DB write) ───────────────
router.post('/', requireAuth, upload.single('file'), (req: AuthRequest, res: Response) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  let rawRows: Record<string, any>[];
  try {
    rawRows = parseRows(req.file.buffer, req.file.mimetype);
  } catch (e: any) {
    return res.status(400).json({ error: 'Could not parse file: ' + e.message });
  }

  if (rawRows.length === 0) return res.status(400).json({ error: 'No data rows found — check column headers' });

  const existingBcClient = new Set(
    (db.prepare('SELECT bc_client_number FROM accounts WHERE bc_client_number IS NOT NULL').all() as any[])
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

  res.json({ valid, warnings, errors, total: rawRows.length });
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
    (db.prepare('SELECT bc_client_number FROM accounts WHERE bc_client_number IS NOT NULL').all() as any[])
      .map((r) => Object.assign({}, r).bc_client_number as string)
  );

  const insert = db.prepare(`
    INSERT INTO accounts (
      ic_company_name, bc_client_number, bc_vendor_number,
      ic_name, account_manager, ccm_manager,
      keys_yn, security_app_yn,
      metal_keys, key_cards, has_fob, dispenser_keys, office_keys,
      ic_office_keys, am_office_keys, ccm_office_keys,
      am_keys, ccm_keys, contractor_keys,
      lockbox_code,
      door_code_encrypted, door_code_iv, alarm_code_encrypted, alarm_code_iv,
      notes, status, record_type
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'customer')
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
      office_keys       = CASE WHEN office_keys = 0       THEN ? ELSE office_keys END,
      ic_office_keys    = CASE WHEN ic_office_keys = 0    THEN ? ELSE ic_office_keys END,
      am_office_keys    = CASE WHEN am_office_keys = 0    THEN ? ELSE am_office_keys END,
      ccm_office_keys   = CASE WHEN ccm_office_keys = 0   THEN ? ELSE ccm_office_keys END,
      am_keys           = CASE WHEN am_keys = 0           THEN ? ELSE am_keys END,
      ccm_keys          = CASE WHEN ccm_keys = 0          THEN ? ELSE ccm_keys END,
      contractor_keys   = CASE WHEN contractor_keys = 0   THEN ? ELSE contractor_keys END,
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
            r.metal_keys, r.key_cards, r.has_fob, r.dispenser_keys, r.office_keys,
            r.ic_office_keys, r.am_office_keys, r.ccm_office_keys,
            r.am_keys, r.ccm_keys, r.contractor_keys,
            r.lockbox_code || null, r.notes || null,
            r.bc_client_number,
          );
          updated++;
        } else {
          insert.run(
            r.ic_company_name, r.bc_client_number || null, r.bc_vendor_number || null,
            r.ic_name || null, r.account_manager || null, r.ccm_manager || null,
            r.keys_yn, r.security_app_yn,
            r.metal_keys, r.key_cards, r.has_fob, r.dispenser_keys, r.office_keys,
            r.ic_office_keys ?? 0, r.am_office_keys ?? 0, r.ccm_office_keys ?? 0,
            r.am_keys ?? 0, r.ccm_keys ?? 0, r.contractor_keys ?? 0,
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

// ── GET /api/accounts/import/template — download blank .xlsx ────────────────
router.get('/template', requireAuth, (_req: AuthRequest, res: Response) => {
  const wb = XLSX.utils.book_new();
  const headers = [
    'Client Name', 'BC Client Number', 'Independent Contractor', 'BC Vendor Number',
    'Account Manager', 'Contract Compliance Manager',
    'Keys Y/N', 'Security App Y/N',
    'Metal Keys', 'Key Cards', 'Key Fobs', 'Dispenser Key', 'Office Key',
    'AM Key', 'CCM Key', 'Contractor Key',
    'IC Office Key', 'AM Office Key', 'CCM Office Key',
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
