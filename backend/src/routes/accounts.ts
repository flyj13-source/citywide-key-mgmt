import { Router, Response } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth';
import db from '../lib/db';
import { logAudit } from '../lib/audit';
import { encrypt } from '../lib/crypto';

const router = Router();

router.get('/', requireAuth, (req: AuthRequest, res: Response) => {
  const { search = '', status = '', type = 'all', exclude_test = '', page = '1', limit = '50' } = req.query as Record<string, string>;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  let whereClauses = '1=1';
  const params: any[] = [];

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
    metal_keys, key_cards, has_fob, dispenser_keys,
    am_keys, ccm_keys, contractor_keys,
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

  const result = db.prepare(`
    INSERT INTO accounts (
      ic_company_name, bc_vendor_number, bc_client_number,
      ic_name, account_manager, ccm_manager,
      keys_yn, security_app_yn,
      metal_keys, key_cards, has_fob, dispenser_keys,
      am_keys, ccm_keys, contractor_keys,
      lockbox_code,
      door_code_encrypted, door_code_iv,
      alarm_code_encrypted, alarm_code_iv,
      door_access_code_encrypted, door_access_code_iv,
      notes, status, record_type
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    ic_company_name, bc_vendor_number || null, bc_client_number || null,
    ic_name || null, account_manager || null, ccm_manager || null,
    keys_yn ? 1 : 0, security_app_yn ? 1 : 0,
    metal_keys || 0, key_cards || 0, has_fob ? 1 : 0, dispenser_keys || 0,
    am_keys || 0, ccm_keys || 0, contractor_keys || 0,
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
  const account = db.prepare('SELECT * FROM accounts WHERE bc_vendor_number = ?').get(req.params.vendorNumber) as any;
  if (!account) return res.status(404).json({ error: 'No account found' });
  const assignments = db.prepare(
    'SELECT * FROM key_assignments WHERE account_id = ? ORDER BY checked_out_at DESC LIMIT 20'
  ).all(account.id);
  res.json({ ...Object.assign({}, account), assignments: assignments.map((a) => Object.assign({}, a)) });
});

// Customer-only lookup — search by bc_client_number (primary customer ID)
router.get('/customer-lookup/:bcNumber', requireAuth, (req: AuthRequest, res: Response) => {
  const account = db.prepare(
    "SELECT * FROM accounts WHERE bc_client_number = ? AND record_type = 'customer'"
  ).get(req.params.bcNumber) as any;
  if (!account) return res.status(404).json({ error: 'No customer found' });
  const assignments = db.prepare(
    'SELECT * FROM key_assignments WHERE account_id = ? ORDER BY checked_out_at DESC LIMIT 20'
  ).all(account.id);
  res.json({ ...Object.assign({}, account), assignments: assignments.map((a) => Object.assign({}, a)) });
});

// Key-holder stats for dashboard card
router.get('/key-holder-stats', requireAuth, (_req: AuthRequest, res: Response) => {
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(am_keys), 0)          AS am_total,
      COALESCE(SUM(ccm_keys), 0)         AS ccm_total,
      COALESCE(SUM(contractor_keys), 0)  AS contractor_total
    FROM accounts
    WHERE record_type = 'customer'
      AND (bc_client_number IS NULL OR bc_client_number NOT LIKE '999%')
  `).get() as any;
  const r = Object.assign({}, row);
  res.json({ am_total: r.am_total, ccm_total: r.ccm_total, contractor_total: r.contractor_total });
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
    am_keys, ccm_keys, contractor_keys,
    lockbox_code, door_code, alarm_code, door_access_code,
    notes, status,
  } = req.body;

  db.prepare(`
    UPDATE accounts SET
      ic_company_name=?, bc_vendor_number=?, bc_client_number=?,
      ic_name=?, account_manager=?, ccm_manager=?,
      keys_yn=?, security_app_yn=?,
      metal_keys=?, key_cards=?, has_fob=?, dispenser_keys=?,
      am_keys=?, ccm_keys=?, contractor_keys=?,
      lockbox_code=?, notes=?, status=?
    WHERE id=?
  `).run(
    ic_company_name, bc_vendor_number || null, bc_client_number || null,
    ic_name || null, account_manager || null, ccm_manager || null,
    keys_yn ? 1 : 0, security_app_yn ? 1 : 0,
    metal_keys ?? 0, key_cards ?? 0, has_fob ? 1 : 0, dispenser_keys ?? 0,
    am_keys ?? 0, ccm_keys ?? 0, contractor_keys ?? 0,
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

router.delete('/:id', requireAuth, (req: AuthRequest, res: Response) => {
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(req.params.id) as any;
  if (!account) return res.status(404).json({ error: 'Not found' });

  db.prepare('DELETE FROM accounts WHERE id = ?').run(req.params.id);

  logAudit(req, 'account_deleted', account.ic_company_name, req.params.id, {
    bc_vendor_number: account.bc_vendor_number, record_type: account.record_type,
  });

  res.json({ success: true });
});

export default router;
