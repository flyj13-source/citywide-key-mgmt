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
import { sendCheckoutNotice, sendCheckinNotice, sendSignedReceipt, caraAddress, MailResult } from '../lib/custodyMail';
import { hashSignature } from '../lib/pdf';
import { generateCustodyReceipt } from '../lib/custodyPdf';

const router = Router();

const SIGNOFF_TTL_MS = 48 * 60 * 60 * 1000;

export type SignatureStatus =
  | 'signed' | 'awaiting_signature' | 'signature_unavailable'
  | 'signature_send_failed' | 'not_required';

// The two states that mean "a human has to do something about this". Both are
// shown in red; neither will resolve on its own.
export const NEEDS_ATTENTION: SignatureStatus[] = ['signature_unavailable', 'signature_send_failed'];

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
    signature_status: (a.signature_status as SignatureStatus)
      ?? (a.signed_at ? 'signed' : a.status === 'checked_out' ? 'awaiting_signature' : 'not_required'),
    no_email_reason: a.no_email_reason ?? null,
    signed_in_person_by: a.signed_in_person_by ?? null,
    signature_send_error: a.signature_send_error ?? null,
    signature_send_attempts: a.signature_send_attempts ?? 0,
    counterparty_name: a.counterparty_name ?? null,
    counterparty_email: a.counterparty_email ?? null,
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
  // ?signature=missing — everything Cara has to chase: no email on file, a send
  // that failed, or a link that was sent and never signed.
  const signature = String((req.query as any).signature || '');
  if (signature === 'missing') {
    where += " AND COALESCE(signature_status, CASE WHEN signed_at IS NOT NULL THEN 'signed' ELSE 'awaiting_signature' END) IN ('signature_unavailable','signature_send_failed','awaiting_signature')";
  } else if (signature === 'unresolvable') {
    where += " AND COALESCE(signature_status,'') IN ('signature_unavailable','signature_send_failed')";
  } else if (signature) {
    where += ' AND signature_status = ?';
    params.push(signature);
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
    const email = cleanText(s.email);
    return {
      id: s.id, name: s.name, email, type: 'employee' as const,
      detail: s.role_category === 'crew' ? 'Crew' : 'Manager',
      has_email: !!email,
    };
  });

  const ics = (db.prepare(`
    SELECT id, ic_company_name, bc_vendor_number, ic_email FROM accounts
     WHERE (record_type = 'ic' OR record_type IS NULL) AND COALESCE(archived, 0) = 0
       ${search ? 'AND (ic_company_name LIKE ? OR bc_vendor_number LIKE ?)' : ''}
     ORDER BY ic_company_name ASC
  `).all(...(search ? [like, like] : [])) as any[]).map((r) => {
    const c = Object.assign({}, r);
    const email = cleanText(c.ic_email);
    return {
      id: c.id, name: c.ic_company_name, email, type: 'ic' as const,
      detail: c.bc_vendor_number || 'IC', has_email: !!email,
    };
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

  // ── Missing-email gate ────────────────────────────────────────────────────
  // No email means no signature request can be sent. Refuse to create the
  // record silently: the caller must either supply an address or state, in
  // writing, why the keys are going out unsigned.
  const no_email_reason = cleanText(body.no_email_reason);
  if (!holder_email && !no_email_reason) {
    return res.status(422).json({
      error: `${holder} has no email on file — a signature cannot be sent.`,
      code: 'HOLDER_EMAIL_MISSING',
      holder,
      remedies: ['add_email', 'continue_without_signature'],
    });
  }

  const counterparty_name = cleanText(body.counterparty_name);
  const counterparty_email = cleanText(body.counterparty_email);

  const checked_out_at = new Date().toISOString();
  // A record with nowhere to send the link gets no token — an unusable token
  // would only make the record look like it is waiting for something.
  const token = holder_email ? crypto.randomBytes(32).toString('hex') : null;
  const signoff_expires_at = holder_email ? new Date(Date.now() + SIGNOFF_TTL_MS).toISOString() : null;
  const initialSigStatus: SignatureStatus = holder_email ? 'awaiting_signature' : 'signature_unavailable';
  const keys_json = multiKey ? JSON.stringify(lines) : null;
  const summary = multiKey ? summarizeKeys(lines) : cleanText(body.keys_held);
  const legacy_key_type = multiKey ? (lines[0]?.type ?? 'physical') : (cleanText(body.key_type) || 'physical');

  const result = db.prepare(`
    INSERT INTO key_assignments
      (account_id, account_name, assignee, assignee_email, key_type, keys_held, keys_json,
       holder_type, holder_id, recorded_by, checked_out_at, due_at, notes, status,
       signoff_token, signoff_expires_at, signature_status, no_email_reason,
       counterparty_name, counterparty_email)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'checked_out', ?, ?, ?, ?, ?, ?)
  `).run(
    account_id, account_name, holder, holder_email, legacy_key_type,
    summary, keys_json, holder_type, holder_id, actor,
    checked_out_at, due_at, notes, token, signoff_expires_at,
    initialSigStatus, no_email_reason, counterparty_name, counterparty_email,
  );
  const id = Number(result.lastInsertRowid);

  logAudit(req, 'key_checked_out', account_name, account_id, {
    assignment_id: id,
    holder, holder_type, holder_email,
    actor, on_behalf: onBehalf,
    summary: custodySummary(actor, 'checkout', holder, onBehalf),
    keys: lines, total_keys: totalQty(lines), due_at,
    signature_status: initialSigStatus,
    no_email_reason: no_email_reason || undefined,
  });

  const baseUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
  const signoffLink = token ? `${baseUrl}/key-signoff/${token}` : null;

  // Cara is notified either way (spec 4) — when there is no holder email the
  // notice goes to her alone, carrying a red "No signature sent" banner.
  const mail = await sendCheckoutNotice({
    holder, holderEmail: holder_email, client: account_name, keys: lines,
    checkedOutAt: checked_out_at, dueAt: due_at, recordedBy: actor, onBehalf,
    signoffLink, noEmailReason: no_email_reason,
  });
  logMail(req, mail, 'checkout', account_name, account_id, holder);

  // Email existed but SMTP gave up after its retries → this record is NOT
  // waiting for a signature, it is stuck. Say so in red, not amber.
  let signatureStatus: SignatureStatus = initialSigStatus;
  if (holder_email && !mail.ok) {
    signatureStatus = 'signature_send_failed';
    logAudit(req, 'signature_send_failed', account_name, account_id, {
      assignment_id: id, holder, recipients: mail.recipients,
      attempts: mail.attempts, error: mail.error,
    });
  }
  db.prepare(
    `UPDATE key_assignments
        SET signature_status = ?, signature_send_attempts = ?, signature_send_error = ?,
            signature_last_attempt_at = ?
      WHERE id = ?`
  ).run(signatureStatus, mail.attempts, mail.ok ? null : (mail.error ?? null), new Date().toISOString(), id);

  if (!holder_email) {
    logAudit(req, 'signature_unavailable', account_name, account_id, {
      assignment_id: id, holder, holder_type, reason: no_email_reason,
      note: 'Keys released without a signature — holder has no email on file',
    });
  }

  const row = db.prepare('SELECT * FROM key_assignments WHERE id = ?').get(id);
  res.status(201).json({
    id,
    assignment: serializeAssignment(row),
    signoff_link: signoffLink,
    signature_status: signatureStatus,
    email: {
      ok: mail.ok, recipients: mail.recipients, error: mail.error,
      attempts: mail.attempts, cara: caraAddress(),
    },
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

// ── POST /api/assignments/holder-email — close the gap permanently ──────────
// Saves an address onto the person's actual staff/IC record (not just this one
// transaction), so the same hole is not hit again at the next handover.
router.post('/holder-email', requireAuth, (req: AuthRequest, res: Response) => {
  const type = req.body?.holder_type === 'ic' ? 'ic' : 'employee';
  const id = Number(req.body?.holder_id);
  const email = cleanText(req.body?.email);
  if (!id) return res.status(400).json({ error: 'holder_id is required' });
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: 'Enter a valid email address' });
  }

  if (type === 'employee') {
    const raw = db.prepare('SELECT id, name, email FROM staff_managers WHERE id = ?').get(id) as any;
    if (!raw) return res.status(404).json({ error: 'Staff member not found' });
    const person = Object.assign({}, raw);
    db.prepare('UPDATE staff_managers SET email = ? WHERE id = ?').run(email, id);
    logAudit(req, 'holder_email_added', person.name, null, {
      holder_type: 'employee', holder_id: id, email, previous: person.email ?? null,
    });
    return res.json({ success: true, name: person.name, email });
  }

  // ICs are account rows; their contact address rides on the account record.
  const raw = db.prepare('SELECT id, ic_company_name, ic_email FROM accounts WHERE id = ?').get(id) as any;
  if (!raw) return res.status(404).json({ error: 'IC not found' });
  const acct = Object.assign({}, raw);
  db.prepare('UPDATE accounts SET ic_email = ? WHERE id = ?').run(email, id);
  logAudit(req, 'holder_email_added', acct.ic_company_name, id, {
    holder_type: 'ic', holder_id: id, email, previous: acct.ic_email ?? null,
  });
  res.json({ success: true, name: acct.ic_company_name, email });
});

// ── POST /api/assignments/:id/sign-in-person ────────────────────────────────
// The fallback that makes every unsigned record recoverable: Cara or a manager
// captures a wet signature on a tablet at handover. Same canvas, same PDF, same
// audit — the only difference is a recorded witness, which is the honest
// distinction between "they signed remotely" and "someone watched them sign".
router.post('/:id/sign-in-person', requireAuth, async (req: AuthRequest, res: Response) => {
  const raw = db.prepare('SELECT * FROM key_assignments WHERE id = ?').get(req.params.id) as any;
  if (!raw) return res.status(404).json({ error: 'Assignment not found' });
  const a = Object.assign({}, raw);
  if (a.signed_at) return res.status(409).json({ error: 'These keys have already been signed for' });

  const signature_data = typeof req.body?.signature_data === 'string' ? req.body.signature_data : '';
  if (!signature_data.startsWith('data:image/png;base64,')) {
    return res.status(400).json({ error: 'A signature is required' });
  }

  const witness = req.manager?.name ?? 'System';
  const signedAt = new Date().toISOString();
  const keys = readKeyLines(a);
  const hash = hashSignature(signature_data);

  let pdfPath: string | null = null;
  let pdfError: string | null = null;
  try {
    pdfPath = await generateCustodyReceipt({
      assignmentId: a.id,
      holder: a.assignee,
      holderType: a.holder_type === 'ic' ? 'ic' : 'employee',
      holderEmail: a.assignee_email ?? null,
      client: a.account_name,
      keys,
      checkedOutAt: a.checked_out_at,
      dueAt: a.due_at ?? null,
      recordedBy: a.recorded_by || 'City Wide Boston',
      signatureData: signature_data,
      signedAt,
      witnessedBy: witness,
    });
  } catch (err: any) {
    // The signature is the legal record — never lose it to a PDF failure.
    pdfError = err?.message || 'PDF generation failed';
  }

  db.prepare(
    `UPDATE key_assignments
        SET signed_at = ?, signature_data = ?, signature_hash = ?, pdf_path = ?,
            signature_status = 'signed', signed_in_person_by = ?, signoff_token = NULL
      WHERE id = ?`
  ).run(signedAt, signature_data, hash, pdfPath, witness, a.id);

  logAudit(req, 'checkout_signed_in_person', a.account_name, a.account_id, {
    assignment_id: a.id, holder: a.assignee, witnessed_by: witness,
    previous_status: a.signature_status ?? null,
    hash: hash.slice(0, 16), pdf: pdfPath ? path.basename(pdfPath) : null,
    pdf_error: pdfError || undefined,
  });

  const mail = await sendSignedReceipt({
    signer: a.assignee, signerEmail: a.assignee_email ?? null, client: a.account_name,
    keys, signedAt, witnessedBy: witness,
    counterpartyName: a.counterparty_name ?? null, counterpartyEmail: a.counterparty_email ?? null,
    pdfPath, pdfFilename: pdfPath ? path.basename(pdfPath) : null,
  });
  logAudit(req, mail.ok ? 'signed_receipt_sent' : 'signed_receipt_failed', a.account_name, a.account_id, {
    assignment_id: a.id, recipients: mail.recipients, attempts: mail.attempts, error: mail.error,
  });

  const row = db.prepare('SELECT * FROM key_assignments WHERE id = ?').get(a.id);
  res.json({
    success: true,
    signed_at: signedAt,
    witnessed_by: witness,
    pdf: pdfPath ? path.basename(pdfPath) : null,
    pdf_error: pdfError,
    assignment: serializeAssignment(row),
    email: { ok: mail.ok, recipients: mail.recipients, error: mail.error, attempts: mail.attempts },
  });
});

// ── GET /api/assignments/signature-gaps — the systemic view ─────────────────
// Feeds the dashboard card and the Custody Report summary. Counts only OPEN
// custody, since a returned record's missing signature is history, not a task.
router.get('/signature-gaps', requireAuth, (_req: AuthRequest, res: Response) => {
  const count = (clause: string): number => {
    const row = db.prepare(
      `SELECT COUNT(*) AS c FROM key_assignments
        WHERE status = 'checked_out' AND ${clause}`
    ).get() as any;
    return Object.assign({}, row).c as number;
  };
  const resolved = "COALESCE(signature_status, CASE WHEN signed_at IS NOT NULL THEN 'signed' ELSE 'awaiting_signature' END)";
  const no_email = count(`${resolved} = 'signature_unavailable'`);
  const send_failed = count(`${resolved} = 'signature_send_failed'`);
  const awaiting = count(`${resolved} = 'awaiting_signature'`);

  // People who will hit this again next time — the proactive half.
  const staffNoEmail = Object.assign({}, db.prepare(
    "SELECT COUNT(*) AS c FROM staff_managers WHERE COALESCE(active,1)=1 AND (email IS NULL OR TRIM(email)='')"
  ).get() as any).c as number;

  res.json({
    no_email, send_failed, awaiting,
    needs_attention: no_email + send_failed,   // red — will not resolve itself
    total_missing: no_email + send_failed + awaiting,
    staff_without_email: staffNoEmail,
  });
});

export default router;
