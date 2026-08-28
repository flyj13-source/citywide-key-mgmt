import { Router, Response } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth';
import db from '../lib/db';
import { logAudit } from '../lib/audit';
import { encrypt } from '../lib/crypto';
import { gridTotal, num } from '../lib/roleKeys';

const router = Router();

/**
 * The registry's filter set, in ONE place. The list endpoint and the
 * select-all-matching endpoint must agree exactly: if "Select all 577
 * matching" resolved a different set than the rows on screen, a bulk archive
 * would hit records the user never saw. Sharing this builder is what makes
 * that impossible.
 */
export function buildAccountFilter(q: Record<string, string>): { where: string; params: any[] } {
  const {
    search = '', status = '', type = 'all', exclude_test = '',
    account_manager = '', ccm_manager = '', office_keys = '', archived = '0',
  } = q;

  let whereClauses = '1=1';
  const params: any[] = [];

  // Soft delete: archived records are hidden from every normal view. The
  // Archived tab passes archived=1 to see them.
  whereClauses += archived === '1' ? ' AND archived = 1' : ' AND COALESCE(archived, 0) = 0';

  // Dashboard hygiene: the dashboard passes exclude_test=1 so sentinel/test
  // records (bc_client_number starting "999") don't distort real counts. The
  // registry list omits the flag, so those rows stay visible there.
  if (exclude_test === '1' || exclude_test === 'true') {
    whereClauses += " AND (bc_client_number IS NULL OR bc_client_number NOT LIKE '999%')";
  }

  if (search) {
    whereClauses += ' AND (ic_company_name LIKE ? OR notes LIKE ? OR bc_vendor_number LIKE ? OR bc_client_number LIKE ? OR ic_name LIKE ? OR account_manager LIKE ?)';
    params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
  }
  if (status) {
    whereClauses += ' AND status = ?';
    params.push(status);
  }
  if (type === 'ic') {
    whereClauses += " AND (record_type = 'ic' OR record_type IS NULL)";
  } else if (type === 'customer') {
    whereClauses += " AND record_type = 'customer'";
  }
  // Exact-match drill-down from the roster tabs (click a person → their clients)
  if (account_manager) {
    whereClauses += ' AND account_manager = ?';
    params.push(account_manager);
  }
  if (ccm_manager) {
    whereClauses += ' AND ccm_manager = ?';
    params.push(ccm_manager);
  }
  // Office tab — customers where the Office holder physically holds keys.
  if (office_keys === '1' || office_keys === 'true') {
    whereClauses += ' AND COALESCE(office_keys_held, 0) > 0';
  }

  return { where: whereClauses, params };
}

router.get('/', requireAuth, (req: AuthRequest, res: Response) => {
  const q = req.query as Record<string, string>;
  const { page = '1', limit = '50' } = q;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  const { where, params } = buildAccountFilter(q);

  const countRow = db.prepare(`SELECT COUNT(*) as c FROM accounts WHERE ${where}`).get(...params) as any;
  const total = Object.assign({}, countRow).c as number;

  const accounts = db.prepare(
    `SELECT * FROM accounts WHERE ${where} ORDER BY ic_company_name ASC LIMIT ? OFFSET ?`
  ).all(...params, parseInt(limit), offset);

  res.json({ accounts: accounts.map((a) => Object.assign({}, a)), total, page: parseInt(page), limit: parseInt(limit) });
});

// ── GET /api/accounts/ids — every id matching the CURRENT filter ─────────────
// Powers "Select all N matching". Returns ids plus only the fields the
// selection toolbar needs to decide which bulk actions are legal — never the
// full row, and never a code of any kind.
//
// Declared BEFORE /:id so the literal path is not matched as an id.
router.get('/ids', requireAuth, (req: AuthRequest, res: Response) => {
  const { where, params } = buildAccountFilter(req.query as Record<string, string>);
  const rows = db.prepare(
    `SELECT id, ic_company_name, record_type, account_manager, ccm_manager, archived,
            COALESCE(pending_handover, 0) AS pending_handover
       FROM accounts WHERE ${where} ORDER BY ic_company_name ASC`
  ).all(...params) as any[];
  const items = rows.map((r) => Object.assign({}, r));
  res.json({ ids: items.map((r) => r.id), items, total: items.length });
});

// ── POST /api/accounts/bulk-archive — archive N records atomically ───────────
// One transaction: either every archivable row is archived or none is. Rows
// still holding checked-out keys are REFUSED individually and reported back by
// name, rather than silently skipped or allowed to orphan live custody.
// Writes one audit entry per record PLUS a summary entry for the batch.
router.post('/bulk-archive', requireAuth, (req: AuthRequest, res: Response) => {
  if (!requireDelete(req, res)) return;
  const { ids } = req.body as { ids: number[] };
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'No records selected' });
  }
  const MAX = 1000;
  if (ids.length > MAX) {
    return res.status(400).json({ error: `Too many records at once (max ${MAX})` });
  }

  const clean = [...new Set(ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  const ph = clean.map(() => '?').join(',');

  const found = (db.prepare(
    `SELECT id, ic_company_name, bc_vendor_number, bc_client_number, record_type, COALESCE(archived,0) AS archived
       FROM accounts WHERE id IN (${ph})`
  ).all(...clean) as any[]).map((r) => Object.assign({}, r));

  // Which of them still hold checked-out keys? Archiving those would orphan
  // live custody, so they are blocked and named.
  const blockedIds = new Set(
    (db.prepare(
      `SELECT DISTINCT account_id AS id FROM key_assignments
        WHERE status = 'checked_out' AND account_id IN (${ph})`
    ).all(...clean) as any[]).map((r) => Object.assign({}, r).id as number)
  );

  const byId = new Map(found.map((f) => [f.id, f]));
  const missing = clean.filter((id) => !byId.has(id));
  const alreadyArchived = found.filter((f) => f.archived === 1);
  const blocked = found.filter((f) => blockedIds.has(f.id));
  const toArchive = found.filter((f) => f.archived !== 1 && !blockedIds.has(f.id));

  const archive = db.prepare(
    'UPDATE accounts SET archived = 1, archived_at = CURRENT_TIMESTAMP, archived_by = ? WHERE id = ?'
  );

  db.exec('BEGIN');
  try {
    for (const a of toArchive) {
      archive.run(req.manager!.name, a.id);
      // One entry per record — a bulk action must stay individually traceable.
      logAudit(req, 'account_archived', a.ic_company_name, a.id, {
        bc_vendor_number: a.bc_vendor_number, bc_client_number: a.bc_client_number,
        record_type: a.record_type, bulk: true,
      });
    }
    // …plus one summary entry for the batch itself.
    logAudit(req, 'accounts_bulk_archived', null, null, {
      requested: clean.length,
      archived: toArchive.length,
      archived_names: toArchive.map((a) => a.ic_company_name),
      blocked_checked_out: blocked.map((b) => b.ic_company_name),
      already_archived: alreadyArchived.length,
      not_found: missing.length,
    });
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  res.json({
    archived: toArchive.length,
    archivedNames: toArchive.map((a) => a.ic_company_name),
    blocked: blocked.map((b) => ({ id: b.id, name: b.ic_company_name })),
    alreadyArchived: alreadyArchived.length,
    notFound: missing.length,
  });
});

router.post('/', requireAuth, (req: AuthRequest, res: Response) => {
  const {
    ic_company_name, bc_vendor_number, bc_client_number,
    ic_name, account_manager, ccm_manager,
    keys_yn, security_app_yn,
    // Client-site totals (Key Inventory) — accepted as a legacy/explicit
    // fallback; normally auto-computed from the holder grid below.
    metal_keys, key_cards, has_fob, dispenser_keys,
    // Holder × type grid — TRANSPOSED: rows are types, these are the columns.
    am_metal, am_card, am_fob, am_dispenser,
    ccm_metal, ccm_card, ccm_fob, ccm_dispenser,
    contractor_metal, contractor_card, contractor_fob, contractor_dispenser,
    office_metal, office_card, office_fob, office_dispenser,
    // Column totals — accepted as a legacy/explicit fallback; normally
    // auto-computed from the grid.
    am_keys, ccm_keys, contractor_keys, office_keys_held,
    lockbox_code, door_code, alarm_code, door_access_code,
    notes, status, record_type,
  } = req.body;

  let door_enc: string | null = null, door_iv: string | null = null;
  let alarm_enc: string | null = null, alarm_iv: string | null = null;
  let da_enc: string | null = null, da_iv: string | null = null;
  if (door_code) { const r = encrypt(door_code); door_enc = r.encrypted; door_iv = r.iv; }
  if (alarm_code) { const r = encrypt(alarm_code); alarm_enc = r.encrypted; alarm_iv = r.iv; }
  if (door_access_code) { const r = encrypt(door_access_code); da_enc = r.encrypted; da_iv = r.iv; }

  const rtype = record_type === 'customer' ? 'customer' : 'ic';

  // COLUMN totals (one holder, all 4 types) — computed from the grid,
  // preserving a legacy/explicit total when no grid cells were entered.
  const amTotal = gridTotal(am_metal, am_card, am_fob, am_dispenser, am_keys);
  const ccmTotal = gridTotal(ccm_metal, ccm_card, ccm_fob, ccm_dispenser, ccm_keys);
  const contractorTotal = gridTotal(contractor_metal, contractor_card, contractor_fob, contractor_dispenser, contractor_keys);
  const officeTotal = gridTotal(office_metal, office_card, office_fob, office_dispenser, office_keys_held);

  // ROW totals (one type, all 4 holders) — this IS the client-site Key
  // Inventory. Collapsed into the grid: if any holder has this type entered,
  // the row sum is authoritative; otherwise the explicit/legacy site total
  // (from an old import, or untouched) is preserved so existing data is never
  // zeroed.
  const metalRow = gridTotal(am_metal, ccm_metal, contractor_metal, office_metal, metal_keys);
  const cardRow = gridTotal(am_card, ccm_card, contractor_card, office_card, key_cards);
  const fobRow = gridTotal(am_fob, ccm_fob, contractor_fob, office_fob, has_fob);
  const dispenserRow = gridTotal(am_dispenser, ccm_dispenser, contractor_dispenser, office_dispenser, dispenser_keys);

  const result = db.prepare(`
    INSERT INTO accounts (
      ic_company_name, bc_vendor_number, bc_client_number,
      ic_name, account_manager, ccm_manager,
      keys_yn, security_app_yn,
      metal_keys, key_cards, has_fob, dispenser_keys,
      am_metal, am_card, am_fob, am_dispenser,
      ccm_metal, ccm_card, ccm_fob, ccm_dispenser,
      contractor_metal, contractor_card, contractor_fob, contractor_dispenser,
      office_metal, office_card, office_fob, office_dispenser,
      am_keys, ccm_keys, contractor_keys, office_keys_held,
      lockbox_code,
      door_code_encrypted, door_code_iv,
      alarm_code_encrypted, alarm_code_iv,
      door_access_code_encrypted, door_access_code_iv,
      notes, status, record_type
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    ic_company_name, bc_vendor_number || null, bc_client_number || null,
    ic_name || null, account_manager || null, ccm_manager || null,
    keys_yn ? 1 : 0, security_app_yn ? 1 : 0,
    metalRow, cardRow, fobRow, dispenserRow,
    num(am_metal), num(am_card), num(am_fob), num(am_dispenser),
    num(ccm_metal), num(ccm_card), num(ccm_fob), num(ccm_dispenser),
    num(contractor_metal), num(contractor_card), num(contractor_fob), num(contractor_dispenser),
    num(office_metal), num(office_card), num(office_fob), num(office_dispenser),
    amTotal, ccmTotal, contractorTotal, officeTotal,
    lockbox_code || null,
    door_enc, door_iv,
    alarm_enc, alarm_iv,
    da_enc, da_iv,
    notes || null, status || 'active', rtype,
  );

  logAudit(req, 'account_created', ic_company_name, result.lastInsertRowid, { bc_vendor_number, record_type: rtype });

  res.status(201).json({ id: result.lastInsertRowid });
});

// IC-only lookup (original route — searches all types for backward compat)
router.get('/by-customer-id/:vendorNumber', requireAuth, (req: AuthRequest, res: Response) => {
  const account = db.prepare('SELECT * FROM accounts WHERE bc_vendor_number = ? AND COALESCE(archived, 0) = 0').get(req.params.vendorNumber) as any;
  if (!account) return res.status(404).json({ error: 'No account found' });
  const assignments = db.prepare(
    'SELECT * FROM key_assignments WHERE account_id = ? ORDER BY checked_out_at DESC LIMIT 20'
  ).all(account.id);
  res.json({ ...Object.assign({}, account), assignments: assignments.map((a) => Object.assign({}, a)) });
});

// Customer-only lookup — search by bc_client_number (primary customer ID)
router.get('/customer-lookup/:bcNumber', requireAuth, (req: AuthRequest, res: Response) => {
  const account = db.prepare(
    "SELECT * FROM accounts WHERE bc_client_number = ? AND record_type = 'customer' AND COALESCE(archived, 0) = 0"
  ).get(req.params.bcNumber) as any;
  if (!account) return res.status(404).json({ error: 'No customer found' });
  const assignments = db.prepare(
    'SELECT * FROM key_assignments WHERE account_id = ? ORDER BY checked_out_at DESC LIMIT 20'
  ).all(account.id);
  res.json({ ...Object.assign({}, account), assignments: assignments.map((a) => Object.assign({}, a)) });
});

// Key-holder stats for the dashboard "Keys Personally Held" card.
// Office is now an independent HOLDER (like AM/CCM/IC), not a bolt-on to the
// other roles — so each holder's personal total is simply their own column
// total from the grid (am_keys/ccm_keys/contractor_keys/office_keys_held).
router.get('/key-holder-stats', requireAuth, (_req: AuthRequest, res: Response) => {
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(am_keys), 0)          AS am_total,
      COALESCE(SUM(ccm_keys), 0)         AS ccm_total,
      COALESCE(SUM(contractor_keys), 0)  AS contractor_total,
      COALESCE(SUM(office_keys_held), 0) AS office_total
    FROM accounts
    WHERE record_type = 'customer'
      AND COALESCE(archived, 0) = 0
      AND (bc_client_number IS NULL OR bc_client_number NOT LIKE '999%')
  `).get() as any;
  const r = Object.assign({}, row);
  res.json({
    am_total: r.am_total, ccm_total: r.ccm_total, contractor_total: r.contractor_total, office_total: r.office_total,
    ic_personal: r.contractor_total,
    am_personal: r.am_total,
    ccm_personal: r.ccm_total,
    office_personal: r.office_total,
  });
});

router.get('/:id', requireAuth, (req: AuthRequest, res: Response) => {
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(req.params.id) as any;
  if (!account) return res.status(404).json({ error: 'Not found' });
  const assignments = db.prepare(
    'SELECT * FROM key_assignments WHERE account_id = ? ORDER BY checked_out_at DESC LIMIT 20'
  ).all(req.params.id);
  res.json({ ...Object.assign({}, account), assignments: assignments.map((a) => Object.assign({}, a)) });
});

// Shared update handler for PUT (legacy) and PATCH. Accepts the full account
// object from the Add/Edit modal, honors the holder grid + computed totals,
// never zeroes unspecified fields (see gridTotal), and logs an 'account_edited'
// audit entry naming exactly which fields changed. Secret code values are NEVER
// logged — the diff records only WHICH code was rotated (door/alarm/door_access),
// never the value.
function updateAccountHandler(req: AuthRequest, res: Response) {
  const {
    ic_company_name, bc_vendor_number, bc_client_number,
    ic_name, account_manager, ccm_manager,
    keys_yn, security_app_yn,
    metal_keys, key_cards, has_fob, dispenser_keys,
    am_metal, am_card, am_fob, am_dispenser,
    ccm_metal, ccm_card, ccm_fob, ccm_dispenser,
    contractor_metal, contractor_card, contractor_fob, contractor_dispenser,
    office_metal, office_card, office_fob, office_dispenser,
    am_keys, ccm_keys, contractor_keys, office_keys_held,
    lockbox_code, door_code, alarm_code, door_access_code,
    notes, status,
  } = req.body;

  // Read the existing row so we can preserve legacy totals (grid cells all 0)
  // yet honor an intentional clear-to-zero of a cell that previously had data.
  const prev: any = Object.assign({}, db.prepare('SELECT * FROM accounts WHERE id = ?').get(req.params.id) || {});
  if (prev.id === undefined) return res.status(404).json({ error: 'Not found' });

  // COLUMN totals (one holder, all 4 types).
  const amTotal = gridTotal(am_metal, am_card, am_fob, am_dispenser, am_keys,
    num(prev.am_metal) + num(prev.am_card) + num(prev.am_fob) + num(prev.am_dispenser), prev.am_keys);
  const ccmTotal = gridTotal(ccm_metal, ccm_card, ccm_fob, ccm_dispenser, ccm_keys,
    num(prev.ccm_metal) + num(prev.ccm_card) + num(prev.ccm_fob) + num(prev.ccm_dispenser), prev.ccm_keys);
  const contractorTotal = gridTotal(contractor_metal, contractor_card, contractor_fob, contractor_dispenser, contractor_keys,
    num(prev.contractor_metal) + num(prev.contractor_card) + num(prev.contractor_fob) + num(prev.contractor_dispenser), prev.contractor_keys);
  const officeTotal = gridTotal(office_metal, office_card, office_fob, office_dispenser, office_keys_held,
    num(prev.office_metal) + num(prev.office_card) + num(prev.office_fob) + num(prev.office_dispenser), prev.office_keys_held);

  // ROW totals (one type, all 4 holders) = the client-site Key Inventory.
  const metalRow = gridTotal(am_metal, ccm_metal, contractor_metal, office_metal, metal_keys,
    num(prev.am_metal) + num(prev.ccm_metal) + num(prev.contractor_metal) + num(prev.office_metal), prev.metal_keys);
  const cardRow = gridTotal(am_card, ccm_card, contractor_card, office_card, key_cards,
    num(prev.am_card) + num(prev.ccm_card) + num(prev.contractor_card) + num(prev.office_card), prev.key_cards);
  const fobRow = gridTotal(am_fob, ccm_fob, contractor_fob, office_fob, has_fob,
    num(prev.am_fob) + num(prev.ccm_fob) + num(prev.contractor_fob) + num(prev.office_fob), prev.has_fob);
  const dispenserRow = gridTotal(am_dispenser, ccm_dispenser, contractor_dispenser, office_dispenser, dispenser_keys,
    num(prev.am_dispenser) + num(prev.ccm_dispenser) + num(prev.contractor_dispenser) + num(prev.office_dispenser), prev.dispenser_keys);

  db.prepare(`
    UPDATE accounts SET
      ic_company_name=?, bc_vendor_number=?, bc_client_number=?,
      ic_name=?, account_manager=?, ccm_manager=?,
      keys_yn=?, security_app_yn=?,
      metal_keys=?, key_cards=?, has_fob=?, dispenser_keys=?,
      am_metal=?, am_card=?, am_fob=?, am_dispenser=?,
      ccm_metal=?, ccm_card=?, ccm_fob=?, ccm_dispenser=?,
      contractor_metal=?, contractor_card=?, contractor_fob=?, contractor_dispenser=?,
      office_metal=?, office_card=?, office_fob=?, office_dispenser=?,
      am_keys=?, ccm_keys=?, contractor_keys=?, office_keys_held=?,
      lockbox_code=?, notes=?, status=?
    WHERE id=?
  `).run(
    ic_company_name, bc_vendor_number || null, bc_client_number || null,
    ic_name || null, account_manager || null, ccm_manager || null,
    keys_yn ? 1 : 0, security_app_yn ? 1 : 0,
    metalRow, cardRow, fobRow, dispenserRow,
    num(am_metal), num(am_card), num(am_fob), num(am_dispenser),
    num(ccm_metal), num(ccm_card), num(ccm_fob), num(ccm_dispenser),
    num(contractor_metal), num(contractor_card), num(contractor_fob), num(contractor_dispenser),
    num(office_metal), num(office_card), num(office_fob), num(office_dispenser),
    amTotal, ccmTotal, contractorTotal, officeTotal,
    lockbox_code || null, notes || null, status || 'active',
    req.params.id,
  );

  if (door_code) {
    const { encrypted, iv } = encrypt(door_code);
    db.prepare('UPDATE accounts SET door_code_encrypted=?, door_code_iv=? WHERE id=?').run(encrypted, iv, req.params.id);
  }
  if (alarm_code) {
    const { encrypted, iv } = encrypt(alarm_code);
    db.prepare('UPDATE accounts SET alarm_code_encrypted=?, alarm_code_iv=? WHERE id=?').run(encrypted, iv, req.params.id);
  }
  if (door_access_code) {
    const { encrypted, iv } = encrypt(door_access_code);
    db.prepare('UPDATE accounts SET door_access_code_encrypted=?, door_access_code_iv=? WHERE id=?').run(encrypted, iv, req.params.id);
  }

  // ── Field-level diff (prev row → the values just written) ──────────────────
  // Powers the 'account_edited' audit entry. Compared against the ACTUAL stored
  // result: grid cells as written, totals as computed above. Secret codes are
  // recorded only as a rotation flag — the value never enters the log.
  const changed: string[] = [];
  const cmpText = (field: string, next: any) => {
    const a = prev[field] === undefined || prev[field] === null ? '' : String(prev[field]);
    const b = next === undefined || next === null ? '' : String(next);
    if (a !== b) changed.push(field);
  };
  const cmpNum = (field: string, next: any) => { if (num(prev[field]) !== num(next)) changed.push(field); };
  const cmpBool = (field: string, next: any) => { if ((prev[field] ? 1 : 0) !== (next ? 1 : 0)) changed.push(field); };

  cmpText('ic_company_name', ic_company_name);
  cmpText('bc_vendor_number', bc_vendor_number || null);
  cmpText('bc_client_number', bc_client_number || null);
  cmpText('ic_name', ic_name || null);
  cmpText('account_manager', account_manager || null);
  cmpText('ccm_manager', ccm_manager || null);
  cmpBool('keys_yn', keys_yn);
  cmpBool('security_app_yn', security_app_yn);
  cmpText('lockbox_code', lockbox_code || null);
  cmpText('notes', notes || null);
  cmpText('status', status || 'active');
  for (const holder of ['am', 'ccm', 'contractor', 'office']) {
    for (const t of ['metal', 'card', 'fob', 'dispenser']) {
      const field = `${holder}_${t}`;
      cmpNum(field, num((req.body as any)[field]));
    }
  }
  cmpNum('metal_keys', metalRow); cmpNum('key_cards', cardRow);
  cmpNum('has_fob', fobRow); cmpNum('dispenser_keys', dispenserRow);
  cmpNum('am_keys', amTotal); cmpNum('ccm_keys', ccmTotal);
  cmpNum('contractor_keys', contractorTotal); cmpNum('office_keys_held', officeTotal);
  if (door_code) changed.push('door_code');
  if (alarm_code) changed.push('alarm_code');
  if (door_access_code) changed.push('door_access_code');

  logAudit(req, 'account_edited', ic_company_name, req.params.id, { bc_vendor_number, changed });

  res.json({ success: true, changed });
}

// Same handler on both verbs: PUT kept for back-compat, PATCH is the documented
// edit route for the Edit Customer / Edit IC flow.
router.put('/:id', requireAuth, updateAccountHandler);
router.patch('/:id', requireAuth, updateAccountHandler);

// Archive / restore / purge all require the can_delete permission.
const DELETE_DENIED = 'Delete access required — contact Cara Angeloni';
function requireDelete(req: AuthRequest, res: Response): boolean {
  if (!req.manager?.can_delete) { res.status(403).json({ error: DELETE_DENIED }); return false; }
  return true;
}

// ── Soft delete (archive) — record leaves the registry, history preserved ────
router.post('/:id/archive', requireAuth, (req: AuthRequest, res: Response) => {
  if (!requireDelete(req, res)) return;
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(req.params.id) as any;
  if (!account) return res.status(404).json({ error: 'Not found' });

  // Never orphan live custody: block if keys are still checked out.
  const active = Object.assign({}, db.prepare(
    "SELECT COUNT(*) AS c FROM key_assignments WHERE account_id = ? AND status = 'checked_out'"
  ).get(req.params.id)) as any;
  if (active.c > 0) {
    return res.status(409).json({ error: 'Return checked-out keys before archiving' });
  }

  db.prepare('UPDATE accounts SET archived = 1, archived_at = CURRENT_TIMESTAMP, archived_by = ? WHERE id = ?')
    .run(req.manager!.name, req.params.id);

  logAudit(req, 'account_archived', account.ic_company_name, req.params.id, {
    bc_vendor_number: account.bc_vendor_number, bc_client_number: account.bc_client_number,
    record_type: account.record_type,
  });

  res.json({ success: true });
});

// ── Restore an archived record back into the registry ────────────────────────
router.post('/:id/restore', requireAuth, (req: AuthRequest, res: Response) => {
  if (!requireDelete(req, res)) return;
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(req.params.id) as any;
  if (!account) return res.status(404).json({ error: 'Not found' });

  db.prepare('UPDATE accounts SET archived = 0, archived_at = NULL, archived_by = NULL WHERE id = ?')
    .run(req.params.id);

  logAudit(req, 'account_restored', account.ic_company_name, req.params.id, {
    record_type: account.record_type,
  });

  res.json({ success: true });
});

// ── Hard purge — admin only, typed confirmation. Removes the account row ONLY;
// audit rows remain (they reference the name string, not a FK). ──────────────
router.delete('/:id', requireAuth, (req: AuthRequest, res: Response) => {
  if (!requireDelete(req, res)) return;
  if (req.manager?.role !== 'admin') {
    return res.status(403).json({ error: 'Only an admin can permanently delete accounts' });
  }
  const { confirm } = req.body as { confirm?: string };
  if (confirm !== 'DELETE') {
    return res.status(400).json({ error: 'Type DELETE to confirm permanent deletion' });
  }

  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(req.params.id) as any;
  if (!account) return res.status(404).json({ error: 'Not found' });

  db.prepare('DELETE FROM accounts WHERE id = ?').run(req.params.id);

  logAudit(req, 'account_purged', account.ic_company_name, req.params.id, {
    bc_vendor_number: account.bc_vendor_number, bc_client_number: account.bc_client_number,
    record_type: account.record_type,
  });

  res.json({ success: true });
});

export default router;
