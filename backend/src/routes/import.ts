import { Router, Response } from 'express';
import multer from 'multer';
import * as XLSX from 'xlsx';
import { requireAuth, AuthRequest } from '../middleware/auth';
import db from '../lib/db';
import { encrypt } from '../lib/crypto';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ── Column name → field mapping (case-insensitive, trimmed) ─────────────────
const COLUMN_MAP: Record<string, string> = {
  'independent contractor': 'ic_company_name',
  'ic company': 'ic_company_name',
  'ic company name': 'ic_company_name',
  'company': 'ic_company_name',
  'bc vendor number': 'bc_vendor_number',
  'bc vendor #': 'bc_vendor_number',
  'vendor number': 'bc_vendor_number',
  'vendor #': 'bc_vendor_number',
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
  'lockbox code': 'lockbox_code',
  'lockbox': 'lockbox_code',
  'door code': 'door_code',
  'alarm code': 'alarm_code',
  'ic name': 'ic_name',
  'ic contact': 'ic_name',
  'ic id': 'ic_id_number',
  'ic id number': 'ic_id_number',
  'customer id': 'customer_id',
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

function parseRows(buffer: Buffer, mimetype: string): Record<string, any>[] {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const raw: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  if (raw.length < 2) return [];

  // Map header row
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
  bc_vendor_number: string;
  keys_yn: number;
  security_app_yn: number;
  metal_keys: number;
  key_cards: number;
  has_fob: number;
  dispenser_keys: number;
  lockbox_code: string;
  door_code: string;
  alarm_code: string;
  ic_name: string;
  ic_id_number: string;
  customer_id: string;
  notes: string;
  status: string;
}

function normalizeRow(raw: Record<string, any>): ParsedRow {
  return {
    ic_company_name: String(raw.ic_company_name ?? '').trim(),
    bc_vendor_number: String(raw.bc_vendor_number ?? '').trim(),
    keys_yn: parseYN(raw.keys_yn),
    security_app_yn: parseYN(raw.security_app_yn),
    metal_keys: parseNum(raw.metal_keys),
    key_cards: parseNum(raw.key_cards),
    has_fob: parseYN(raw.has_fob),
    dispenser_keys: parseNum(raw.dispenser_keys),
    lockbox_code: String(raw.lockbox_code ?? '').trim(),
    door_code: String(raw.door_code ?? '').trim(),
    alarm_code: String(raw.alarm_code ?? '').trim(),
    ic_name: String(raw.ic_name ?? '').trim(),
    ic_id_number: String(raw.ic_id_number ?? '').trim(),
    customer_id: String(raw.customer_id ?? '').trim(),
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

  // Fetch existing bc_vendor_numbers for duplicate detection
  const existing = new Set(
    (db.prepare('SELECT bc_vendor_number FROM accounts WHERE bc_vendor_number IS NOT NULL').all() as any[])
      .map((r) => Object.assign({}, r).bc_vendor_number as string)
  );

  const valid: Array<ParsedRow & { _row: number }> = [];
  const warnings: Array<{ row: number; data: ParsedRow; message: string }> = [];
  const errors: Array<{ row: number; message: string; raw: Record<string, any> }> = [];

  rawRows.forEach((raw, i) => {
    const row = i + 2; // 1-indexed, +1 for header
    const data = normalizeRow(raw);

    if (!data.ic_company_name) {
      errors.push({ row, message: 'Missing IC Company Name (required)', raw });
      return;
    }

    if (data.bc_vendor_number && existing.has(data.bc_vendor_number)) {
      warnings.push({ row, data, message: `BC Vendor Number "${data.bc_vendor_number}" already exists — will be skipped on confirm` });
      return;
    }

    valid.push({ ...data, _row: row });
  });

  res.json({ valid, warnings, errors, total: rawRows.length });
});

// ── POST /api/accounts/import/confirm — insert validated rows ────────────────
router.post('/confirm', requireAuth, (req: AuthRequest, res: Response) => {
  const { rows } = req.body as { rows: ParsedRow[] };
  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ error: 'No rows to import' });
  }

  // Re-check duplicates in case state changed between preview and confirm
  const existing = new Set(
    (db.prepare('SELECT bc_vendor_number FROM accounts WHERE bc_vendor_number IS NOT NULL').all() as any[])
      .map((r) => Object.assign({}, r).bc_vendor_number as string)
  );

  const insert = db.prepare(`
    INSERT INTO accounts (
      ic_company_name, bc_vendor_number, keys_yn, security_app_yn,
      metal_keys, key_cards, has_fob, dispenser_keys, lockbox_code,
      door_code_encrypted, door_code_iv, alarm_code_encrypted, alarm_code_iv,
      ic_name, ic_id_number, customer_id, notes, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let inserted = 0;
  let skipped = 0;

  for (const r of rows) {
    if (!r.ic_company_name) { skipped++; continue; }
    if (r.bc_vendor_number && existing.has(r.bc_vendor_number)) { skipped++; continue; }

    let door_enc: string | null = null, door_iv: string | null = null;
    let alarm_enc: string | null = null, alarm_iv: string | null = null;
    if (r.door_code) { const e = encrypt(r.door_code); door_enc = e.encrypted; door_iv = e.iv; }
    if (r.alarm_code) { const e = encrypt(r.alarm_code); alarm_enc = e.encrypted; alarm_iv = e.iv; }

    try {
      insert.run(
        r.ic_company_name, r.bc_vendor_number || null,
        r.keys_yn, r.security_app_yn,
        r.metal_keys, r.key_cards, r.has_fob, r.dispenser_keys,
        r.lockbox_code || null,
        door_enc, door_iv, alarm_enc, alarm_iv,
        r.ic_name || null, r.ic_id_number || null,
        r.customer_id || null, r.notes || null,
        r.status || 'active'
      );
      if (r.bc_vendor_number) existing.add(r.bc_vendor_number);
      inserted++;
    } catch {
      skipped++;
    }
  }

  db.prepare('INSERT INTO audit_log (action, account_name, account_id, manager, metadata) VALUES (?, ?, ?, ?, ?)').run(
    'bulk_import', null, null, req.manager!.name,
    JSON.stringify({ inserted, skipped, total: rows.length })
  );

  res.json({ inserted, skipped });
});

// ── GET /api/accounts/import/template — download blank .xlsx ────────────────
router.get('/template', requireAuth, (_req: AuthRequest, res: Response) => {
  const wb = XLSX.utils.book_new();
  const headers = [
    'Independent Contractor', 'BC Vendor Number', 'Keys Y/N', 'Security App Y/N',
    'Metal Keys', 'Key Cards', 'Key Fobs', 'Dispenser Key', 'Lockbox Code',
    'Door Code', 'Alarm Code', 'IC Name', 'IC ID Number', 'Customer ID', 'Notes',
  ];
  const ws = XLSX.utils.aoa_to_sheet([headers, []]);

  // Column widths
  ws['!cols'] = headers.map((h) => ({ wch: Math.max(h.length + 4, 16) }));

  XLSX.utils.book_append_sheet(wb, ws, 'IC Registry Import');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="CityWide_IC_Import_Template.xlsx"');
  res.send(buf);
});

export default router;
