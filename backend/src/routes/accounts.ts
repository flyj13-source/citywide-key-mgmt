import { Router, Response } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth';
import db from '../lib/db';
import { logAudit } from '../lib/audit';
import { encrypt } from '../lib/crypto';
import { gridTotal, num } from '../lib/roleKeys';

const router = Router();

router.get('/', requireAuth, (req: AuthRequest, res: Response) => {
  const { search = '', status = '', type = 'all', exclude_test = '', account_manager = '', ccm_manager = '', archived = '0', page = '1', limit = '50' } = req.query as Record<string, string>;
  const offset = (parseInt(page) - 1) * parseInt(limit);

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

  const countRow = db.prepare(`SELECT COUNT(*) as c FROM accounts WHERE ${whereClauses}`).get(...params) as any;
  const total = Object.assign({}, countRow).c as number;

  const accounts = db.prepare(
    `SELECT * FROM accounts WHERE ${whereClauses} ORDER BY ic_company_name ASC LIMIT ? OFFSET ?`
  ).all(...params, parseInt(limit), offset);

  res.json({ accounts: accounts.map((a) => Object.assign({}, a)), total, page: parseInt(page), limit: parseInt(limit) });
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

router.put('/:id', requireAuth, (req: AuthRequest, res: Response) => {
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

  logAudit(req, 'account_updated', ic_company_name, req.params.id, { bc_vendor_number });

  res.json({ success: true });
});

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
