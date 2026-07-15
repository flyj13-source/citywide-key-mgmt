import { Router, Response } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth';
import db from '../lib/db';
import { logAudit } from '../lib/audit';
import { encrypt } from '../lib/crypto';
import { roleTotal, num } from '../lib/roleKeys';

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
    metal_keys, key_cards, has_fob, dispenser_keys, office_keys,
    ic_office_keys, am_office_keys, ccm_office_keys,
    am_keys, ccm_keys, contractor_keys,
    am_metal_keys, am_key_cards, am_key_fobs,
    ccm_metal_keys, ccm_key_cards, ccm_key_fobs,
    contractor_metal_keys, contractor_key_cards, contractor_key_fobs,
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

  // Totals are computed from the per-type breakdown (preserving legacy totals).
  const amTotal = roleTotal(am_metal_keys, am_key_cards, am_key_fobs, am_keys);
  const ccmTotal = roleTotal(ccm_metal_keys, ccm_key_cards, ccm_key_fobs, ccm_keys);
  const contractorTotal = roleTotal(contractor_metal_keys, contractor_key_cards, contractor_key_fobs, contractor_keys);

  const result = db.prepare(`
    INSERT INTO accounts (
      ic_company_name, bc_vendor_number, bc_client_number,
      ic_name, account_manager, ccm_manager,
      keys_yn, security_app_yn,
      metal_keys, key_cards, has_fob, dispenser_keys, office_keys,
      ic_office_keys, am_office_keys, ccm_office_keys,
      am_keys, ccm_keys, contractor_keys,
      am_metal_keys, am_key_cards, am_key_fobs,
      ccm_metal_keys, ccm_key_cards, ccm_key_fobs,
      contractor_metal_keys, contractor_key_cards, contractor_key_fobs,
      lockbox_code,
      door_code_encrypted, door_code_iv,
      alarm_code_encrypted, alarm_code_iv,
      door_access_code_encrypted, door_access_code_iv,
      notes, status, record_type
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    ic_company_name, bc_vendor_number || null, bc_client_number || null,
    ic_name || null, account_manager || null, ccm_manager || null,
    keys_yn ? 1 : 0, security_app_yn ? 1 : 0,
    metal_keys || 0, key_cards || 0, has_fob ? 1 : 0, dispenser_keys || 0, office_keys || 0,
    ic_office_keys || 0, am_office_keys || 0, ccm_office_keys || 0,
    amTotal, ccmTotal, contractorTotal,
    num(am_metal_keys), num(am_key_cards), num(am_key_fobs),
    num(ccm_metal_keys), num(ccm_key_cards), num(ccm_key_fobs),
    num(contractor_metal_keys), num(contractor_key_cards), num(contractor_key_fobs),
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
// Each role's total = their regular role keys + their share of office keys.
router.get('/key-holder-stats', requireAuth, (_req: AuthRequest, res: Response) => {
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(am_keys), 0)          AS am_total,
      COALESCE(SUM(ccm_keys), 0)         AS ccm_total,
      COALESCE(SUM(contractor_keys), 0)  AS contractor_total,
      COALESCE(SUM(office_keys), 0)      AS office_total,
      COALESCE(SUM(ic_office_keys), 0)   AS ic_office_total,
      COALESCE(SUM(am_office_keys), 0)   AS am_office_total,
      COALESCE(SUM(ccm_office_keys), 0)  AS ccm_office_total
    FROM accounts
    WHERE record_type = 'customer'
      AND COALESCE(archived, 0) = 0
      AND (bc_client_number IS NULL OR bc_client_number NOT LIKE '999%')
  `).get() as any;
  const r = Object.assign({}, row);
  res.json({
    // Regular role totals + site office total (kept for compatibility)
    am_total: r.am_total, ccm_total: r.ccm_total, contractor_total: r.contractor_total, office_total: r.office_total,
    // Personally-held = role keys + that role's office keys
    ic_personal: r.contractor_total + r.ic_office_total,
    am_personal: r.am_total + r.am_office_total,
    ccm_personal: r.ccm_total + r.ccm_office_total,
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
    metal_keys, key_cards, has_fob, dispenser_keys, office_keys,
    ic_office_keys, am_office_keys, ccm_office_keys,
    am_keys, ccm_keys, contractor_keys,
    am_metal_keys, am_key_cards, am_key_fobs,
    ccm_metal_keys, ccm_key_cards, ccm_key_fobs,
    contractor_metal_keys, contractor_key_cards, contractor_key_fobs,
    lockbox_code, door_code, alarm_code, door_access_code,
    notes, status,
  } = req.body;

  // Read the existing row so we can preserve legacy totals (breakdown 0) yet
  // honor an intentional clear-to-zero of a role that previously had a breakdown.
  const prev: any = Object.assign({}, db.prepare('SELECT * FROM accounts WHERE id = ?').get(req.params.id) || {});
  const amTotal = roleTotal(am_metal_keys, am_key_cards, am_key_fobs, am_keys,
    num(prev.am_metal_keys) + num(prev.am_key_cards) + num(prev.am_key_fobs), prev.am_keys);
  const ccmTotal = roleTotal(ccm_metal_keys, ccm_key_cards, ccm_key_fobs, ccm_keys,
    num(prev.ccm_metal_keys) + num(prev.ccm_key_cards) + num(prev.ccm_key_fobs), prev.ccm_keys);
  const contractorTotal = roleTotal(contractor_metal_keys, contractor_key_cards, contractor_key_fobs, contractor_keys,
    num(prev.contractor_metal_keys) + num(prev.contractor_key_cards) + num(prev.contractor_key_fobs), prev.contractor_keys);

  db.prepare(`
    UPDATE accounts SET
      ic_company_name=?, bc_vendor_number=?, bc_client_number=?,
      ic_name=?, account_manager=?, ccm_manager=?,
      keys_yn=?, security_app_yn=?,
      metal_keys=?, key_cards=?, has_fob=?, dispenser_keys=?, office_keys=?,
      ic_office_keys=?, am_office_keys=?, ccm_office_keys=?,
      am_keys=?, ccm_keys=?, contractor_keys=?,
      am_metal_keys=?, am_key_cards=?, am_key_fobs=?,
      ccm_metal_keys=?, ccm_key_cards=?, ccm_key_fobs=?,
      contractor_metal_keys=?, contractor_key_cards=?, contractor_key_fobs=?,
      lockbox_code=?, notes=?, status=?
    WHERE id=?
  `).run(
    ic_company_name, bc_vendor_number || null, bc_client_number || null,
    ic_name || null, account_manager || null, ccm_manager || null,
    keys_yn ? 1 : 0, security_app_yn ? 1 : 0,
    metal_keys ?? 0, key_cards ?? 0, has_fob ? 1 : 0, dispenser_keys ?? 0, office_keys ?? 0,
    ic_office_keys ?? 0, am_office_keys ?? 0, ccm_office_keys ?? 0,
    amTotal, ccmTotal, contractorTotal,
    num(am_metal_keys), num(am_key_cards), num(am_key_fobs),
    num(ccm_metal_keys), num(ccm_key_cards), num(ccm_key_fobs),
    num(contractor_metal_keys), num(contractor_key_cards), num(contractor_key_fobs),
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

// ── Soft delete (archive) — record leaves the registry, history preserved ────
router.post('/:id/archive', requireAuth, (req: AuthRequest, res: Response) => {
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
