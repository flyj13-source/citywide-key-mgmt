import { Router, Response } from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { requireAuth, AuthRequest } from '../middleware/auth';
import db from '../lib/db';
import { logAudit } from '../lib/audit';
import {
  KEY_TYPES, availabilityFor, checkAvailability, parseKeyLines, readKeyLines,
  summarizeKeys, totalQty, KeyLine,
} from '../lib/custody';
import { sendCheckoutNotice, sendCheckinNotice, caraAddress, MailResult } from '../lib/custodyMail';

const router = Router();

const SIGNOFF_TTL_MS = 48 * 60 * 60 * 1000;

const cleanText = (v: any): string | null => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};

// ── Row serializer ───────────────────────────────────────────────────────────
// Every custody row surfaces the parsed key set, the holder/actor split, and the
// signature state the Checked Out tab renders as a pill.
export function serializeAssignment(raw: any) {
  const a = Object.assign({}, raw);
  const keys = readKeyLines(a);
  const overdue = a.status === 'checked_out' && !!a.due_at && new Date(`${a.due_at}`.replace(' ', 'T')) < new Date();
  return {
    id: a.id,
    account_id: a.account_id ?? null,
    account_name: a.account_name,
    holder: a.assignee,
    holder_email: a.assignee_email ?? null,
    holder_type: (a.holder_type as 'employee' | 'ic') ?? null,
    holder_id: a.holder_id ?? null,
    keys,
    keys_summary: keys.length ? summarizeKeys(keys) : (a.keys_held ?? ''),
    total_keys: totalQty(keys),
    checked_out_at: a.checked_out_at,
    due_at: a.due_at ?? null,
    returned_at: a.returned_at ?? null,
    condition_on_return: a.condition_on_return ?? null,
    notes: a.notes ?? null,
    status: a.status,
    overdue,
    recorded_by: a.recorded_by ?? null,
    checkin_recorded_by: a.checkin_recorded_by ?? null,
    signed_at: a.signed_at ?? null,
    signature_hash: a.signature_hash ?? null,
    has_pdf: !!a.pdf_path,
    signoff_pending: a.status === 'checked_out' && !a.signed_at,
    signoff_expires_at: a.signoff_expires_at ?? null,
    // Legacy fields kept so older consumers (reports, Claude context) still read.
    assignee: a.assignee,
    keys_held: a.keys_held ?? null,
    key_type: a.key_type ?? null,
  };
}

// ── GET /api/assignments ─────────────────────────────────────────────────────
// ?status=checked_out|returned  ?search=  ?sort=<field>  ?dir=asc|desc
const SORTABLE: Record<string, string> = {
  holder: 'assignee',
  account_name: 'account_name',
  checked_out_at: 'checked_out_at',
  due_at: 'due_at',
  returned_at: 'returned_at',
  status: 'status',
  condition: 'condition_on_return',
  recorded_by: 'checkin_recorded_by',
};

router.get('/', requireAuth, (req: AuthRequest, res: Response) => {
  const {
    status = '', search = '', page = '1', limit = '50', sort = '', dir = 'desc',
  } = req.query as Record<string, string>;
  const offset = (Math.max(1, parseInt(page) || 1) - 1) * (parseInt(limit) || 50);
  let where = '1=1';
  const params: any[] = [];
  if (status) { where += ' AND status = ?'; params.push(status); }
  if (search) {
    where += ' AND (assignee LIKE ? OR account_name LIKE ? OR keys_held LIKE ? OR assignee_email LIKE ?)';
    const s = `%${search}%`;
    params.push(s, s, s, s);
  }

  const countRow = db.prepare(`SELECT COUNT(*) as c FROM key_assignments WHERE ${where}`).get(...params) as any;
  const total = Object.assign({}, countRow).c as number;

  const col = SORTABLE[sort] || (status === 'returned' ? 'returned_at' : 'checked_out_at');
  const order = String(dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';

  const rows = db.prepare(
    `SELECT * FROM key_assignments WHERE ${where} ORDER BY ${col} ${order}, id ${order} LIMIT ? OFFSET ?`
  ).all(...params, parseInt(limit) || 50, offset);

  res.json({ assignments: rows.map(serializeAssignment), total });
});

// ── GET /api/assignments/key-types — the catalog the dropdown renders ────────
router.get('/key-types', requireAuth, (_req: AuthRequest, res: Response) => {
  res.json({ types: KEY_TYPES.map((t) => ({ type: t.key, label: t.label })) });
});

// ── GET /api/assignments/availability?account_id=N ───────────────────────────
// Per-type: what exists at the client site, what is already out, what is left.
router.get('/availability', requireAuth, (req: AuthRequest, res: Response) => {
  const accountId = Number(req.query.account_id);
  if (!accountId) return res.status(400).json({ error: 'account_id is required' });
  const raw = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId) as any;
  if (!raw) return res.status(404).json({ error: 'Account not found' });
  const account = Object.assign({}, raw);
  res.json({
    account: { id: account.id, name: account.ic_company_name, record_type: account.record_type ?? 'ic' },
    types: availabilityFor(accountId),
  });
});

// ── GET /api/assignments/holders — the "Recording for" / holder picker ───────
// City Wide staff roster + the IC list, one shape, so the picker can offer both
// self-service and on-behalf selections from a single dropdown.
router.get('/holders', requireAuth, (req: AuthRequest, res: Response) => {
  const search = String(req.query.search || '').trim();
  const like = `%${search}%`;

  const staff = (db.prepare(`
    SELECT id, name, email, role_category, manager_type FROM staff_managers
     WHERE COALESCE(active, 1) = 1 ${search ? 'AND (name LIKE ? OR email LIKE ?)' : ''}
     ORDER BY name ASC
  `).all(...(search ? [like, like] : [])) as any[]).map((r) => {
    const s = Object.assign({}, r);
    return { id: s.id, name: s.name, email: s.email ?? null, type: 'employee' as const, detail: s.role_category === 'crew' ? 'Crew' : 'Manager' };
  });

  const ics = (db.prepare(`
    SELECT id, ic_company_name, bc_vendor_number FROM accounts
     WHERE (record_type = 'ic' OR record_type IS NULL) AND COALESCE(archived, 0) = 0
       ${search ? 'AND (ic_company_name LIKE ? OR bc_vendor_number LIKE ?)' : ''}
     ORDER BY ic_company_name ASC
  `).all(...(search ? [like, like] : [])) as any[]).map((r) => {
    const c = Object.assign({}, r);
    return { id: c.id, name: c.ic_company_name, email: null, type: 'ic' as const, detail: c.bc_vendor_number || 'IC' };
  });

  res.json({ employees: staff, ics });
});

// ── Audit helpers ────────────────────────────────────────────────────────────
// Both the ACTOR and the HOLDER are recorded on every custody entry — the audit
// trail must read "Cara Angeloni recorded checkout for J. Martinez", never just
// one of the two names.
function custodySummary(actor: string, verb: 'checkout' | 'checkin', holder: string, onBehalf: boolean): string {
  return onBehalf
    ? `${actor} recorded ${verb} for ${holder}`
    : `${holder} recorded their own ${verb}`;
}

function logMail(req: AuthRequest, result: MailResult, kind: 'checkout' | 'checkin', accountName: string, accountId: number | null, holder: string) {
  logAudit(req, result.ok ? 'custody_email_sent' : 'custody_email_failed', accountName, accountId, {
    kind, holder, recipients: result.recipients, error: result.error, skipped: result.skipped || undefined,
  });
}

// ── POST /api/assignments/checkout ───────────────────────────────────────────
// Multi-key, self-service OR on-behalf. Blocks over-checkout, mints a 48h
// sign-off token, emails the holder + Cara, and audits actor AND holder.
router.post('/checkout', requireAuth, async (req: AuthRequest, res: Response) => {
  const body = req.body || {};
  const actor = req.manager?.name ?? 'System';

  const account_id = body.account_id != null && body.account_id !== '' ? Number(body.account_id) : null;
  if (!account_id) return res.status(400).json({ error: 'A client is required' });
  const acctRaw = db.prepare('SELECT * FROM accounts WHERE id = ?').get(account_id) as any;
  if (!acctRaw) return res.status(404).json({ error: 'Client not found' });
  const account = Object.assign({}, acctRaw);
  const account_name = cleanText(body.account_name) || account.ic_company_name;

  const holder = cleanText(body.holder ?? body.assignee);
  if (!holder) return res.status(400).json({ error: 'A holder is required' });
  const holder_email = cleanText(body.holder_email ?? body.assignee_email);
  const holder_type = body.holder_type === 'ic' ? 'ic' : 'employee';
  const holder_id = body.holder_id != null && body.holder_id !== '' ? Number(body.holder_id) : null;

  // Legacy single-key callers (the pre-multi-key API) send key_type/keys_held
  // instead of a keys array. Honor both, but only the multi-key path writes
  // keys_json — a legacy row keeps its own free text verbatim rather than being
  // rewritten into a normalized summary that could lose detail.
  const multiKey = Array.isArray(body.keys);
  let lines: KeyLine[];
  if (multiKey) {
    const parsed = parseKeyLines(body.keys);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    lines = parsed.lines;
    const conflict = checkAvailability(account_id, lines);
    if (conflict) return res.status(409).json({ error: conflict });
  } else {
    lines = readKeyLines({ key_type: body.key_type, keys_held: body.keys_held });
  }

  const due_at = cleanText(body.due_at);
  const notes = cleanText(body.notes);
  // Self-service when the actor IS the holder; otherwise this is on-behalf.
  const onBehalf = body.on_behalf != null
    ? !!body.on_behalf
    : actor.trim().toLowerCase() !== holder.trim().toLowerCase();

  const checked_out_at = new Date().toISOString();
  const token = crypto.randomBytes(32).toString('hex');
  const signoff_expires_at = new Date(Date.now() + SIGNOFF_TTL_MS).toISOString();
  const keys_json = multiKey ? JSON.stringify(lines) : null;
  const summary = multiKey ? summarizeKeys(lines) : cleanText(body.keys_held);
  const legacy_key_type = multiKey ? (lines[0]?.type ?? 'physical') : (cleanText(body.key_type) || 'physical');

  const result = db.prepare(`
    INSERT INTO key_assignments
      (account_id, account_name, assignee, assignee_email, key_type, keys_held, keys_json,
       holder_type, holder_id, recorded_by, checked_out_at, due_at, notes, status,
       signoff_token, signoff_expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'checked_out', ?, ?)
  `).run(
    account_id, account_name, holder, holder_email, legacy_key_type,
    summary, keys_json, holder_type, holder_id, actor,
    checked_out_at, due_at, notes, token, signoff_expires_at,
  );
  const id = Number(result.lastInsertRowid);

  logAudit(req, 'key_checked_out', account_name, account_id, {
    assignment_id: id,
    holder, holder_type, holder_email,
    actor, on_behalf: onBehalf,
    summary: custodySummary(actor, 'checkout', holder, onBehalf),
    keys: lines, total_keys: totalQty(lines), due_at,
  });

  const baseUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
  const signoffLink = `${baseUrl}/key-signoff/${token}`;

  const mail = await sendCheckoutNotice({
    holder, holderEmail: holder_email, client: account_name, keys: lines,
    checkedOutAt: checked_out_at, dueAt: due_at, recordedBy: actor, onBehalf, signoffLink,
  });
  logMail(req, mail, 'checkout', account_name, account_id, holder);

  const row = db.prepare('SELECT * FROM key_assignments WHERE id = ?').get(id);
  res.status(201).json({
    id,
    assignment: serializeAssignment(row),
    signoff_link: signoffLink,
    email: { ok: mail.ok, recipients: mail.recipients, error: mail.error, cara: caraAddress() },
  });
});

// ── POST /api/assignments/checkin ────────────────────────────────────────────
// Notification only — a return never demands a signature (per spec).
//
// The whole transaction returns by default. When `keys` names a SUBSET of what
// is out, the return is split: the returned subset becomes its own 'returned'
// record (what the Checked In tab shows) and the original row stays checked out
// carrying only the keys still in the holder's possession, so availability keeps
// telling the truth.
router.post('/checkin', requireAuth, async (req: AuthRequest, res: Response) => {
  const { id, condition_on_return, notes } = req.body || {};
  const raw = db.prepare('SELECT * FROM key_assignments WHERE id = ?').get(id) as any;
  if (!raw) return res.status(404).json({ error: 'Assignment not found' });
  const assignment = Object.assign({}, raw);
  if (assignment.status === 'returned') {
    return res.status(409).json({ error: 'These keys have already been checked in' });
  }

  const actor = req.manager?.name ?? 'System';
  const holder = assignment.assignee as string;
  const onBehalf = req.body?.on_behalf != null
    ? !!req.body.on_behalf
    : actor.trim().toLowerCase() !== String(holder).trim().toLowerCase();
  const condition = cleanText(condition_on_return) || 'good';
  const returned_at = new Date().toISOString();
  const extraNotes = cleanText(notes);

  const outstanding = readKeyLines(assignment);
  let returning: KeyLine[] = outstanding;
  let remaining: KeyLine[] = [];

  if (Array.isArray(req.body.keys) && outstanding.length) {
    const parsed = parseKeyLines(req.body.keys);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    for (const line of parsed.lines) {
      const held = outstanding.find((o) => o.type === line.type);
      if (!held) return res.status(400).json({ error: `${line.label} is not part of this check-out` });
      if (line.qty > held.qty) {
        return res.status(400).json({ error: `Only ${held.qty} ${held.label}${held.qty === 1 ? '' : 's'} are checked out — cannot return ${line.qty}.` });
      }
    }
    returning = parsed.lines;
    remaining = outstanding
      .map((o) => ({ ...o, qty: o.qty - (parsed.lines.find((l) => l.type === o.type)?.qty ?? 0) }))
      .filter((o) => o.qty > 0);
  }

  const appendNote = (existing: string | null, add: string | null): string | null => {
    if (!add) return existing ?? null;
    return existing ? `${existing} | ${add}` : add;
  };

  let returnedId = Number(id);

  if (remaining.length) {
    // Partial return — split the transaction.
    db.prepare('UPDATE key_assignments SET keys_json=?, keys_held=?, key_type=? WHERE id=?')
      .run(JSON.stringify(remaining), summarizeKeys(remaining), remaining[0].type, id);

    const inserted = db.prepare(`
      INSERT INTO key_assignments
        (account_id, account_name, assignee, assignee_email, key_type, keys_held, keys_json,
         holder_type, holder_id, recorded_by, checkin_recorded_by, checked_out_at, due_at,
         returned_at, condition_on_return, notes, status,
         signed_at, signature_data, signature_hash, pdf_path)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'returned', ?, ?, ?, ?)
    `).run(
      assignment.account_id, assignment.account_name, assignment.assignee, assignment.assignee_email,
      returning[0].type, summarizeKeys(returning), JSON.stringify(returning),
      assignment.holder_type, assignment.holder_id, assignment.recorded_by, actor,
      assignment.checked_out_at, assignment.due_at, returned_at, condition,
      appendNote(assignment.notes ?? null, extraNotes ? `Partial return: ${extraNotes}` : 'Partial return'),
      assignment.signed_at, assignment.signature_data, assignment.signature_hash, assignment.pdf_path,
    );
    returnedId = Number(inserted.lastInsertRowid);
  } else {
    db.prepare(`
      UPDATE key_assignments
         SET status='returned', returned_at=?, condition_on_return=?, checkin_recorded_by=?, notes=?
       WHERE id=?
    `).run(returned_at, condition, actor, appendNote(assignment.notes ?? null, extraNotes), id);
  }

  logAudit(req, 'key_checked_in', assignment.account_name, assignment.account_id, {
    assignment_id: Number(id),
    returned_record_id: returnedId,
    holder, holder_type: assignment.holder_type ?? null,
    actor, on_behalf: onBehalf,
    summary: custodySummary(actor, 'checkin', holder, onBehalf),
    keys: returning, total_keys: totalQty(returning), condition,
    partial: remaining.length > 0,
    still_out: remaining.length ? remaining : undefined,
  });

  const mail = await sendCheckinNotice({
    holder, holderEmail: assignment.assignee_email ?? null, client: assignment.account_name,
    keys: returning, returnedAt: returned_at, condition, recordedBy: actor, onBehalf,
  });
  logMail(req, mail, 'checkin', assignment.account_name, assignment.account_id, holder);

  const row = db.prepare('SELECT * FROM key_assignments WHERE id = ?').get(returnedId);
  res.json({
    success: true,
    partial: remaining.length > 0,
    still_out: remaining,
    assignment: serializeAssignment(row),
    email: { ok: mail.ok, recipients: mail.recipients, error: mail.error, cara: caraAddress() },
  });
});

// ── POST /api/assignments/:id/resend-signoff ─────────────────────────────────
// Re-mints the 48h token and re-sends the check-out email. Used when the first
// send failed (SMTP down) or the link expired unsigned.
router.post('/:id/resend-signoff', requireAuth, async (req: AuthRequest, res: Response) => {
  const raw = db.prepare('SELECT * FROM key_assignments WHERE id = ?').get(req.params.id) as any;
  if (!raw) return res.status(404).json({ error: 'Assignment not found' });
  const a = Object.assign({}, raw);
  if (a.signed_at) return res.status(409).json({ error: 'These keys have already been signed for' });

  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SIGNOFF_TTL_MS).toISOString();
  db.prepare('UPDATE key_assignments SET signoff_token=?, signoff_expires_at=? WHERE id=?')
    .run(token, expires, a.id);

  const baseUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
  const signoffLink = `${baseUrl}/key-signoff/${token}`;
  const actor = req.manager?.name ?? 'System';

  const mail = await sendCheckoutNotice({
    holder: a.assignee, holderEmail: a.assignee_email ?? null, client: a.account_name,
    keys: readKeyLines(a), checkedOutAt: a.checked_out_at, dueAt: a.due_at ?? null,
    recordedBy: a.recorded_by || actor, onBehalf: !!a.recorded_by && a.recorded_by !== a.assignee,
    signoffLink,
  });
  logAudit(req, 'checkout_signoff_resent', a.account_name, a.account_id, {
    assignment_id: a.id, holder: a.assignee, email_ok: mail.ok, error: mail.error,
  });
  logMail(req, mail, 'checkout', a.account_name, a.account_id, a.assignee);

  res.json({ success: true, signoff_link: signoffLink, email: { ok: mail.ok, recipients: mail.recipients, error: mail.error } });
});

// ── GET /api/assignments/:id/receipt — the signed PDF ────────────────────────
router.get('/:id/receipt', requireAuth, (req: AuthRequest, res: Response) => {
  const raw = db.prepare('SELECT * FROM key_assignments WHERE id = ?').get(req.params.id) as any;
  if (!raw?.pdf_path) return res.status(404).json({ error: 'No signed receipt for this check-out' });
  const a = Object.assign({}, raw);
  if (!fs.existsSync(a.pdf_path)) return res.status(404).json({ error: 'Receipt file not found' });
  logAudit(req, 'checkout_receipt_downloaded', a.account_name, a.account_id, { assignment_id: a.id, holder: a.assignee });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${path.basename(a.pdf_path)}"`);
  fs.createReadStream(a.pdf_path).pipe(res);
});

export default router;
