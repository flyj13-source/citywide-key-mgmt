// ── Access codes API ─────────────────────────────────────────────────────────
// A client's labeled door/gate/alarm/lockbox codes.
//
// THE SECURITY RULE, in one place: `code_encrypted` and `code_iv` are selected
// by exactly ONE handler — reveal — and every reveal writes an audit row naming
// who read which code and when. Every other handler selects an explicit column
// list that excludes them, so a ciphertext cannot reach a list response, an
// export or a log line by accident. `shapeRow` is the only thing that builds a
// client-facing code object, and it has no access to the ciphertext at all.
//
// PERMISSIONS: viewing and revealing are open to any signed-in manager, exactly
// as the vault has always been. Creating, editing, moving and archiving need
// `can_delete` — the same gate as deleting an account, because all four change
// who can open a client's door.

import { Router, Response } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth';
import db from '../lib/db';
import { logAudit } from '../lib/audit';
import { encrypt, decrypt } from '../lib/crypto';

const router = Router();

/** The fixed vocabulary. 'other' is the only type that carries a free label. */
export const CODE_TYPES = [
  { key: 'front_door', label: 'Front Door' },
  { key: 'back_door', label: 'Back Door' },
  { key: 'supply_closet', label: 'Supply Closet' },
  { key: 'gate', label: 'Gate' },
  { key: 'alarm', label: 'Alarm' },
  { key: 'lockbox', label: 'Lockbox' },
  { key: 'other', label: 'Other' },
] as const;

const TYPE_KEYS = new Set(CODE_TYPES.map((t) => t.key as string));
const TYPE_LABEL = new Map(CODE_TYPES.map((t) => [t.key as string, t.label as string]));

const clean = (v: any): string => (v == null ? '' : String(v).trim());

const PERMISSION_DENIED =
  'Managing access codes requires delete access — contact Cara Angeloni';

/** Add / edit / move / archive all change who can open a door. Same gate. */
function requireManage(req: AuthRequest, res: Response): boolean {
  if (!req.manager?.can_delete) {
    res.status(403).json({ error: PERMISSION_DENIED, code: 'PERMISSION_DENIED' });
    return false;
  }
  return true;
}

/**
 * The client-facing shape. Takes only already-safe columns — the ciphertext is
 * never passed in, so it cannot be leaked by forgetting to strip it here.
 */
function shapeRow(raw: any) {
  const r = Object.assign({}, raw);
  const type = r.code_type as string;
  return {
    id: r.id as number,
    account_id: r.account_id as number,
    client: r.ic_company_name ?? null,
    bc_client_number: r.bc_client_number ?? null,
    record_type: r.record_type ?? null,
    code_type: type,
    type_label: TYPE_LABEL.get(type) ?? type,
    // What the row is CALLED: the custom label when the type is 'other',
    // otherwise the type's own name. One field the UI prints.
    label: type === 'other' ? (r.custom_label || 'Other') : (TYPE_LABEL.get(type) ?? type),
    custom_label: r.custom_label ?? null,
    notes: r.notes ?? null,
    created_by: r.created_by ?? null,
    created_at: r.created_at ?? null,
    updated_by: r.updated_by ?? null,
    updated_at: r.updated_at ?? null,
    is_test: Number(r.is_test) === 1 ? 1 : 0,
    archived: Number(r.archived) === 1 ? 1 : 0,
  };
}

/**
 * Explicit column list — NOT `SELECT *`. The ciphertext columns are absent by
 * construction rather than stripped afterwards, so adding a column to the table
 * can never widen what a list response returns.
 */
const SAFE_COLUMNS = `
  c.id, c.account_id, c.code_type, c.custom_label, c.notes,
  c.created_by, c.created_at, c.updated_by, c.updated_at,
  c.is_test, c.archived,
  a.ic_company_name, a.bc_client_number, a.record_type
`;

// ── GET /api/access-codes — the Door Codes tab ───────────────────────────────
router.get('/', requireAuth, (req: AuthRequest, res: Response) => {
  const q = req.query as Record<string, string>;
  const search = clean(q.search);
  const codeType = clean(q.code_type);
  const accountId = clean(q.account_id);
  const archived = q.archived === '1' || q.archived === 'true';
  const includeTest = q.include_test === '1' || q.include_test === 'true';

  let where = archived ? 'c.archived = 1' : 'COALESCE(c.archived, 0) = 0';
  const params: any[] = [];

  if (!includeTest) where += ' AND COALESCE(c.is_test, 0) = 0';
  if (accountId) { where += ' AND c.account_id = ?'; params.push(Number(accountId)); }
  if (codeType && TYPE_KEYS.has(codeType)) { where += ' AND c.code_type = ?'; params.push(codeType); }
  if (search) {
    // Client name, BC number, the type, and the custom label — the four things
    // somebody would type to find a code.
    where += ' AND (a.ic_company_name LIKE ? OR a.bc_client_number LIKE ? OR c.code_type LIKE ? OR c.custom_label LIKE ?)';
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }

  const rows = db.prepare(`
    SELECT ${SAFE_COLUMNS}
      FROM access_codes c
      JOIN accounts a ON a.id = c.account_id
     WHERE ${where}
     ORDER BY a.ic_company_name ASC, c.code_type ASC, c.id ASC
  `).all(...params) as any[];

  // Counts per type drive the filter chips, over the same filter set minus the
  // type itself — so a chip always shows how many it would reveal.
  let chipWhere = archived ? 'c.archived = 1' : 'COALESCE(c.archived, 0) = 0';
  const chipParams: any[] = [];
  if (!includeTest) chipWhere += ' AND COALESCE(c.is_test, 0) = 0';
  if (accountId) { chipWhere += ' AND c.account_id = ?'; chipParams.push(Number(accountId)); }
  if (search) {
    chipWhere += ' AND (a.ic_company_name LIKE ? OR a.bc_client_number LIKE ? OR c.code_type LIKE ? OR c.custom_label LIKE ?)';
    const like = `%${search}%`;
    chipParams.push(like, like, like, like);
  }
  const chipRows = db.prepare(`
    SELECT c.code_type AS t, COUNT(*) AS n
      FROM access_codes c JOIN accounts a ON a.id = c.account_id
     WHERE ${chipWhere} GROUP BY c.code_type
  `).all(...chipParams) as any[];
  const byType: Record<string, number> = {};
  let total = 0;
  for (const r of chipRows) {
    const o = Object.assign({}, r);
    byType[o.t as string] = Number(o.n) || 0;
    total += Number(o.n) || 0;
  }

  res.json({ codes: rows.map(shapeRow), counts: { total, by_type: byType }, types: CODE_TYPES });
});

// ── POST /api/access-codes/:id/reveal — the ONLY path to a plaintext code ────
// POST, not GET: a reveal is an audited event, and GETs get retried, prefetched
// and logged by intermediaries in ways that would corrupt that record.
router.post('/:id(\\d+)/reveal', requireAuth, (req: AuthRequest, res: Response) => {
  const raw = db.prepare(`
    SELECT c.*, a.ic_company_name, a.bc_client_number
      FROM access_codes c JOIN accounts a ON a.id = c.account_id
     WHERE c.id = ?
  `).get(Number(req.params.id)) as any;
  if (!raw) return res.status(404).json({ error: 'Code not found' });
  const row = Object.assign({}, raw);

  let code: string;
  try {
    code = decrypt(row.code_encrypted, row.code_iv);
  } catch {
    // Wrong ENCRYPTION_KEY, or a corrupted row. Say so plainly rather than
    // returning a garbled string that would be read as the real code.
    return res.status(500).json({
      error: 'This code could not be decrypted. It may have been stored under a different encryption key.',
      code: 'DECRYPT_FAILED',
    });
  }

  // Every reveal, always: who, which code, which client, when.
  logAudit(req, 'access_code_revealed', row.ic_company_name, row.account_id, {
    access_code_id: row.id,
    code_type: row.code_type,
    label: row.code_type === 'other' ? (row.custom_label || 'Other') : row.code_type,
    bc_client_number: row.bc_client_number ?? null,
    ip: req.ip,
  });

  res.json({ code });
});

// ── POST /api/access-codes — add ─────────────────────────────────────────────
router.post('/', requireAuth, (req: AuthRequest, res: Response) => {
  if (!requireManage(req, res)) return;
  const body = req.body || {};

  const accountId = body.account_id != null && body.account_id !== '' ? Number(body.account_id) : null;
  if (!accountId) return res.status(400).json({ error: 'A client is required' });

  const acctRaw = db.prepare('SELECT id, ic_company_name, record_type, COALESCE(is_test,0) AS is_test FROM accounts WHERE id = ?')
    .get(accountId) as any;
  if (!acctRaw) return res.status(404).json({ error: 'Client not found' });
  const account = Object.assign({}, acctRaw);

  const codeType = clean(body.code_type);
  if (!TYPE_KEYS.has(codeType)) {
    return res.status(400).json({ error: `Unknown code type "${codeType}"` });
  }
  const customLabel = clean(body.custom_label);
  if (codeType === 'other' && !customLabel) {
    return res.status(400).json({ error: 'A label is required when the type is Other' });
  }

  const codeValue = clean(body.code);
  if (!codeValue) return res.status(400).json({ error: 'A code is required' });

  const { encrypted, iv } = encrypt(codeValue);
  const result = db.prepare(`
    INSERT INTO access_codes
      (account_id, code_type, custom_label, code_encrypted, code_iv, notes, created_by, is_test, archived)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
  `).run(
    accountId, codeType, codeType === 'other' ? customLabel : null,
    encrypted, iv, clean(body.notes) || null,
    req.manager?.name ?? 'System',
    // A code on a fixture client is itself apparatus, and is excluded from
    // counts for the same reason the client is.
    Number(account.is_test) === 1 ? 1 : 0,
  );

  // The code itself is NEVER in the audit metadata — only which code it was.
  logAudit(req, 'access_code_added', account.ic_company_name, accountId, {
    access_code_id: Number(result.lastInsertRowid),
    code_type: codeType,
    label: codeType === 'other' ? customLabel : codeType,
  });

  res.status(201).json({ code: shapeOne(Number(result.lastInsertRowid)) });
});

// ── PATCH /api/access-codes/:id — edit ───────────────────────────────────────
router.patch('/:id(\\d+)', requireAuth, (req: AuthRequest, res: Response) => {
  if (!requireManage(req, res)) return;
  const id = Number(req.params.id);
  const raw = db.prepare(`
    SELECT c.id, c.account_id, c.code_type, c.custom_label, c.notes, a.ic_company_name
      FROM access_codes c JOIN accounts a ON a.id = c.account_id WHERE c.id = ?
  `).get(id) as any;
  if (!raw) return res.status(404).json({ error: 'Code not found' });
  const row = Object.assign({}, raw);
  const body = req.body || {};

  const codeType = body.code_type !== undefined ? clean(body.code_type) : row.code_type;
  if (!TYPE_KEYS.has(codeType)) {
    return res.status(400).json({ error: `Unknown code type "${codeType}"` });
  }
  const customLabel = body.custom_label !== undefined ? clean(body.custom_label) : (row.custom_label ?? '');
  if (codeType === 'other' && !customLabel) {
    return res.status(400).json({ error: 'A label is required when the type is Other' });
  }

  const changed: string[] = [];
  if (codeType !== row.code_type) changed.push('code_type');
  const nextLabel = codeType === 'other' ? customLabel : null;
  if ((nextLabel ?? null) !== (row.custom_label ?? null)) changed.push('custom_label');

  const notes = body.notes !== undefined ? (clean(body.notes) || null) : (row.notes ?? null);
  if ((notes ?? null) !== (row.notes ?? null)) changed.push('notes');

  db.prepare(`
    UPDATE access_codes
       SET code_type = ?, custom_label = ?, notes = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?
  `).run(codeType, nextLabel, notes, req.manager?.name ?? 'System', id);

  // A blank `code` means "leave the secret alone" — the edit modal cannot show
  // the current value, so an empty field must never be read as "erase it".
  const newCode = clean(body.code);
  if (newCode) {
    const { encrypted, iv } = encrypt(newCode);
    db.prepare('UPDATE access_codes SET code_encrypted = ?, code_iv = ? WHERE id = ?').run(encrypted, iv, id);
    changed.push('code');
  }

  logAudit(req, 'access_code_updated', row.ic_company_name, row.account_id, {
    access_code_id: id, changed, code_type: codeType,
  });

  res.json({ code: shapeOne(id), changed });
});

// ── POST /api/access-codes/:id/move — reassign to a different client ─────────
router.post('/:id(\\d+)/move', requireAuth, (req: AuthRequest, res: Response) => {
  if (!requireManage(req, res)) return;
  const id = Number(req.params.id);
  const raw = db.prepare(`
    SELECT c.id, c.account_id, c.code_type, c.custom_label, a.ic_company_name, a.bc_client_number
      FROM access_codes c JOIN accounts a ON a.id = c.account_id WHERE c.id = ?
  `).get(id) as any;
  if (!raw) return res.status(404).json({ error: 'Code not found' });
  const row = Object.assign({}, raw);

  const toId = req.body?.account_id != null && req.body.account_id !== '' ? Number(req.body.account_id) : null;
  if (!toId) return res.status(400).json({ error: 'A destination client is required' });
  if (toId === row.account_id) {
    return res.status(400).json({ error: 'That is the client this code is already on' });
  }
  const destRaw = db.prepare('SELECT id, ic_company_name, bc_client_number FROM accounts WHERE id = ?').get(toId) as any;
  if (!destRaw) return res.status(404).json({ error: 'Destination client not found' });
  const dest = Object.assign({}, destRaw);

  db.prepare('UPDATE access_codes SET account_id = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(toId, req.manager?.name ?? 'System', id);

  // Named in BOTH directions: "which codes left this client" and "where did
  // this code come from" are both questions an audit asks.
  logAudit(req, 'code_reassigned', dest.ic_company_name, toId, {
    access_code_id: id,
    code_type: row.code_type,
    label: row.code_type === 'other' ? (row.custom_label || 'Other') : row.code_type,
    from_account_id: row.account_id,
    from_client: row.ic_company_name,
    from_bc_client_number: row.bc_client_number ?? null,
    to_account_id: toId,
    to_client: dest.ic_company_name,
    to_bc_client_number: dest.bc_client_number ?? null,
  });

  res.json({ code: shapeOne(id), from: row.ic_company_name, to: dest.ic_company_name });
});

// ── POST /api/access-codes/:id/archive — soft delete ─────────────────────────
// Never a hard delete: who could open a client's door last year is history, and
// a DELETE would take the audit trail's subject with it.
router.post('/:id(\\d+)/archive', requireAuth, (req: AuthRequest, res: Response) => {
  if (!requireManage(req, res)) return;
  const id = Number(req.params.id);
  const raw = db.prepare(`
    SELECT c.id, c.account_id, c.code_type, c.custom_label, c.archived, a.ic_company_name
      FROM access_codes c JOIN accounts a ON a.id = c.account_id WHERE c.id = ?
  `).get(id) as any;
  if (!raw) return res.status(404).json({ error: 'Code not found' });
  const row = Object.assign({}, raw);
  if (Number(row.archived) === 1) {
    return res.status(409).json({ error: 'This code is already archived' });
  }

  db.prepare('UPDATE access_codes SET archived = 1, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(req.manager?.name ?? 'System', id);

  logAudit(req, 'access_code_archived', row.ic_company_name, row.account_id, {
    access_code_id: id, code_type: row.code_type,
    label: row.code_type === 'other' ? (row.custom_label || 'Other') : row.code_type,
  });

  res.json({ success: true, code: shapeOne(id) });
});

// ── POST /api/access-codes/:id/restore ───────────────────────────────────────
router.post('/:id(\\d+)/restore', requireAuth, (req: AuthRequest, res: Response) => {
  if (!requireManage(req, res)) return;
  const id = Number(req.params.id);
  const raw = db.prepare(`
    SELECT c.id, c.account_id, c.code_type, a.ic_company_name
      FROM access_codes c JOIN accounts a ON a.id = c.account_id WHERE c.id = ?
  `).get(id) as any;
  if (!raw) return res.status(404).json({ error: 'Code not found' });
  const row = Object.assign({}, raw);

  db.prepare('UPDATE access_codes SET archived = 0, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(req.manager?.name ?? 'System', id);
  logAudit(req, 'access_code_restored', row.ic_company_name, row.account_id, {
    access_code_id: id, code_type: row.code_type,
  });
  res.json({ success: true, code: shapeOne(id) });
});

/** Re-read one row through the same safe projection the list uses. */
function shapeOne(id: number) {
  const raw = db.prepare(`
    SELECT ${SAFE_COLUMNS}
      FROM access_codes c JOIN accounts a ON a.id = c.account_id
     WHERE c.id = ?
  `).get(id) as any;
  return raw ? shapeRow(raw) : null;
}

export default router;
