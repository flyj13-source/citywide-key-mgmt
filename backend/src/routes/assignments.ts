import { Router, Response } from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { requireAuth, AuthRequest } from '../middleware/auth';
import db from '../lib/db';
import { logAudit } from '../lib/audit';
import {
  KEY_TYPES, availabilityFor, checkAvailability, parseKeyLines, readKeyLines,
  summarizeKeys, totalQty, KeyLine, bcNumberFor, bcNumberForAssignment,
  transferSignatureState,
} from '../lib/custody';
import { sendCheckoutNotice, sendCheckinNotice, caraAddress, MailResult } from '../lib/custodyMail';

const router = Router();

export const SIGNOFF_TTL_MS = 48 * 60 * 60 * 1000;

const frontendBase = (): string => process.env.FRONTEND_URL || 'http://localhost:5173';
export const signoffLinkFor = (token: string): string => `${frontendBase()}/key-signoff/${token}`;
const mintToken = (): { token: string; expires: string } => ({
  token: crypto.randomBytes(32).toString('hex'),
  expires: new Date(Date.now() + SIGNOFF_TTL_MS).toISOString(),
});

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
    // Check-IN signature — its own independent state, so a record can be
    // "signed out, awaiting return signature" and say so.
    checkin_signed_at: a.checkin_signed_at ?? null,
    checkin_signature_hash: a.checkin_signature_hash ?? null,
    has_checkin_pdf: !!a.checkin_pdf_path,
    checkin_signoff_pending: a.status === 'returned' && !a.checkin_signed_at,
    checkin_signoff_expires_at: a.checkin_signoff_expires_at ?? null,
    // Person-to-person transfer linkage.
    transfer_id: a.transfer_id ?? null,
    transfer_role: (a.transfer_role as 'from' | 'to') ?? null,
    linked_assignment_id: a.linked_assignment_id ?? null,
    return_reason: a.return_reason ?? null,
    transfer_signatures: a.transfer_id ? transferSignatureState(a.transfer_id) : null,
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
  const { token, expires: signoff_expires_at } = mintToken();
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

  const signoffLink = signoffLinkFor(token);

  const mail = await sendCheckoutNotice({
    holder, holderEmail: holder_email, holderType: holder_type,
    client: account_name, bcNumber: bcNumberFor(account), keys: lines,
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
// Every custody EVENT generates a signature form, returns included: the holder
// gets a 48h tokenized link asking them to acknowledge that they are RETURNING
// these keys, and the signed PDF goes to the notification recipient.
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

  // The return needs its own signature. Mint the token against the RETURNED
  // record (which on a partial return is the newly split row, not the original)
  // so the form lists exactly the keys that actually came back.
  const { token: checkinToken, expires: checkinExpires } = mintToken();
  db.prepare('UPDATE key_assignments SET checkin_signoff_token=?, checkin_signoff_expires_at=?, return_reason=COALESCE(return_reason, ?) WHERE id=?')
    .run(checkinToken, checkinExpires, 'returned', returnedId);
  const signoffLink = signoffLinkFor(checkinToken);

  logAudit(req, 'key_checked_in', assignment.account_name, assignment.account_id, {
    assignment_id: Number(id),
    returned_record_id: returnedId,
    holder, holder_type: assignment.holder_type ?? null,
    actor, on_behalf: onBehalf,
    summary: custodySummary(actor, 'checkin', holder, onBehalf),
    keys: returning, total_keys: totalQty(returning), condition,
    partial: remaining.length > 0,
    still_out: remaining.length ? remaining : undefined,
    signature_requested: true,
  });

  const mail = await sendCheckinNotice({
    holder, holderEmail: assignment.assignee_email ?? null,
    holderType: (assignment.holder_type as 'employee' | 'ic') ?? null,
    client: assignment.account_name, bcNumber: bcNumberForAssignment(assignment),
    keys: returning, returnedAt: returned_at, condition, recordedBy: actor, onBehalf,
    signoffLink,
  });
  logMail(req, mail, 'checkin', assignment.account_name, assignment.account_id, holder);

  const row = db.prepare('SELECT * FROM key_assignments WHERE id = ?').get(returnedId);
  res.json({
    success: true,
    partial: remaining.length > 0,
    still_out: remaining,
    assignment: serializeAssignment(row),
    signoff_link: signoffLink,
    email: { ok: mail.ok, recipients: mail.recipients, error: mail.error, cara: caraAddress() },
  });
});

// ── POST /api/assignments/:id/resend-signoff ─────────────────────────────────
// Re-mints the 48h token and re-sends the notification. Used when the first
// send failed (SMTP down) or the link expired unsigned. Works in BOTH
// directions: `kind` picks the check-out or the check-in signature, defaulting
// to whichever one this record is still waiting on.
router.post('/:id/resend-signoff', requireAuth, async (req: AuthRequest, res: Response) => {
  const raw = db.prepare('SELECT * FROM key_assignments WHERE id = ?').get(req.params.id) as any;
  if (!raw) return res.status(404).json({ error: 'Assignment not found' });
  const a = Object.assign({}, raw);

  const requested = String(req.body?.kind || '').toLowerCase();
  const kind: 'checkout' | 'checkin' = requested === 'checkin' || requested === 'checkout'
    ? (requested as 'checkout' | 'checkin')
    : (a.status === 'returned' ? 'checkin' : 'checkout');

  if (kind === 'checkout' && a.signed_at) {
    return res.status(409).json({ error: 'These keys have already been signed for' });
  }
  if (kind === 'checkin') {
    if (a.status !== 'returned') {
      return res.status(409).json({ error: 'This record has not been checked in yet' });
    }
    if (a.checkin_signed_at) {
      return res.status(409).json({ error: 'This return has already been signed for' });
    }
  }

  const { token, expires } = mintToken();
  db.prepare(
    kind === 'checkout'
      ? 'UPDATE key_assignments SET signoff_token=?, signoff_expires_at=? WHERE id=?'
      : 'UPDATE key_assignments SET checkin_signoff_token=?, checkin_signoff_expires_at=? WHERE id=?'
  ).run(token, expires, a.id);

  const signoffLink = signoffLinkFor(token);
  const actor = req.manager?.name ?? 'System';
  const keys = readKeyLines(a);
  const bcNumber = bcNumberForAssignment(a);
  const holderType = (a.holder_type as 'employee' | 'ic') ?? null;

  const mail = kind === 'checkout'
    ? await sendCheckoutNotice({
      holder: a.assignee, holderEmail: a.assignee_email ?? null, holderType,
      client: a.account_name, bcNumber, keys,
      checkedOutAt: a.checked_out_at, dueAt: a.due_at ?? null,
      recordedBy: a.recorded_by || actor, onBehalf: !!a.recorded_by && a.recorded_by !== a.assignee,
      signoffLink,
      transferFrom: a.transfer_role === 'to' ? transferCounterpartyName(a) : null,
    })
    : await sendCheckinNotice({
      holder: a.assignee, holderEmail: a.assignee_email ?? null, holderType,
      client: a.account_name, bcNumber, keys,
      returnedAt: a.returned_at, condition: a.condition_on_return || 'good',
      recordedBy: a.checkin_recorded_by || a.recorded_by || actor,
      onBehalf: !!a.checkin_recorded_by && a.checkin_recorded_by !== a.assignee,
      signoffLink,
      transferTo: a.transfer_role === 'from' ? transferCounterpartyName(a) : null,
    });

  logAudit(req, kind === 'checkout' ? 'checkout_signoff_resent' : 'checkin_signoff_resent',
    a.account_name, a.account_id, {
      assignment_id: a.id, holder: a.assignee, kind, email_ok: mail.ok, error: mail.error,
    });
  logMail(req, mail, kind, a.account_name, a.account_id, a.assignee);

  res.json({
    success: true, kind, signoff_link: signoffLink,
    email: { ok: mail.ok, recipients: mail.recipients, error: mail.error, cara: caraAddress() },
  });
});

/** The other party on a transferred record — used to label transfer emails. */
function transferCounterpartyName(row: any): string | null {
  if (!row?.linked_assignment_id) return null;
  const raw = db.prepare('SELECT assignee FROM key_assignments WHERE id = ?').get(row.linked_assignment_id) as any;
  return raw ? (Object.assign({}, raw).assignee ?? null) : null;
}

// ── GET /api/assignments/:id/receipt?kind=checkout|checkin ───────────────────
// The signed PDF. A record can hold BOTH receipts (signed out, then signed
// back in), so the direction is explicit and defaults to whichever exists.
router.get('/:id/receipt', requireAuth, (req: AuthRequest, res: Response) => {
  const raw = db.prepare('SELECT * FROM key_assignments WHERE id = ?').get(req.params.id) as any;
  if (!raw) return res.status(404).json({ error: 'Assignment not found' });
  const a = Object.assign({}, raw);

  const requested = String(req.query.kind || '').toLowerCase();
  const kind: 'checkout' | 'checkin' = requested === 'checkin'
    ? 'checkin'
    : requested === 'checkout'
      ? 'checkout'
      : (a.pdf_path ? 'checkout' : 'checkin');

  const file = kind === 'checkin' ? a.checkin_pdf_path : a.pdf_path;
  if (!file) {
    return res.status(404).json({
      error: kind === 'checkin' ? 'No signed return receipt for this record' : 'No signed receipt for this check-out',
    });
  }
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Receipt file not found' });

  logAudit(req, 'custody_receipt_downloaded', a.account_name, a.account_id, {
    assignment_id: a.id, holder: a.assignee, kind,
  });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${path.basename(file)}"`);
  fs.createReadStream(file).pipe(res);
});

// ═══════════════════════════════ TRANSFERS ══════════════════════════════════
// Keys moving straight from one person to another, without a trip through the
// office. Modelled as one atomic operation that closes the releasing holder's
// custody and opens the receiving holder's — never as "check in, then remember
// to check out", which leaves a window where the registry says nobody holds
// keys that are in someone's pocket.

/** The FROM holder's open check-outs at a client, plus the aggregate key set. */
function openHoldingsFor(accountId: number, holder: string): { rows: any[]; keys: KeyLine[] } {
  const rows = (db.prepare(
    `SELECT * FROM key_assignments
      WHERE account_id = ? AND status = 'checked_out' AND LOWER(TRIM(assignee)) = LOWER(TRIM(?))
      ORDER BY checked_out_at ASC, id ASC`
  ).all(accountId, holder) as any[]).map((r) => Object.assign({}, r));

  const totals = new Map<string, KeyLine>();
  for (const row of rows) {
    for (const line of readKeyLines(row)) {
      const cur = totals.get(line.type);
      if (cur) cur.qty += line.qty;
      else totals.set(line.type, { ...line });
    }
  }
  return { rows, keys: [...totals.values()] };
}

// ── GET /api/assignments/transferable?account_id=N&holder=NAME ───────────────
// Feeds the Transfer modal: everything this person currently has out at this
// client, aggregated across their open check-outs so the checkbox list is one
// line per key type.
router.get('/transferable', requireAuth, (req: AuthRequest, res: Response) => {
  const accountId = Number(req.query.account_id);
  const holder = cleanText(req.query.holder);
  if (!accountId || !holder) {
    return res.status(400).json({ error: 'account_id and holder are required' });
  }
  const acctRaw = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId) as any;
  if (!acctRaw) return res.status(404).json({ error: 'Client not found' });
  const account = Object.assign({}, acctRaw);

  const { rows, keys } = openHoldingsFor(accountId, holder);
  res.json({
    account: { id: account.id, name: account.ic_company_name, bc_number: bcNumberFor(account) },
    holder,
    holder_type: (rows[0]?.holder_type as 'employee' | 'ic') ?? null,
    holder_email: rows[0]?.assignee_email ?? null,
    keys,
    total_keys: totalQty(keys),
    assignments: rows.map(serializeAssignment),
  });
});

// ── GET /api/assignments/current-holders?account_id=N ────────────────────────
// Who currently has keys out at a client — the "From" side of the Transfer
// modal. Only people with something out can transfer anything.
router.get('/current-holders', requireAuth, (req: AuthRequest, res: Response) => {
  const accountId = Number(req.query.account_id);
  if (!accountId) return res.status(400).json({ error: 'account_id is required' });

  const rows = (db.prepare(
    `SELECT * FROM key_assignments WHERE account_id = ? AND status = 'checked_out'
      ORDER BY checked_out_at ASC, id ASC`
  ).all(accountId) as any[]).map((r) => Object.assign({}, r));

  const byHolder = new Map<string, {
    holder: string; holder_type: 'employee' | 'ic' | null; holder_email: string | null;
    holder_id: number | null; keys: Map<string, KeyLine>; assignments: number;
  }>();
  for (const row of rows) {
    const key = String(row.assignee ?? '').trim().toLowerCase();
    if (!key) continue;
    let entry = byHolder.get(key);
    if (!entry) {
      entry = {
        holder: row.assignee,
        holder_type: (row.holder_type as 'employee' | 'ic') ?? null,
        holder_email: row.assignee_email ?? null,
        holder_id: row.holder_id ?? null,
        keys: new Map(), assignments: 0,
      };
      byHolder.set(key, entry);
    }
    entry.assignments += 1;
    if (!entry.holder_email && row.assignee_email) entry.holder_email = row.assignee_email;
    for (const line of readKeyLines(row)) {
      const cur = entry.keys.get(line.type);
      if (cur) cur.qty += line.qty;
      else entry.keys.set(line.type, { ...line });
    }
  }

  res.json({
    holders: [...byHolder.values()]
      .map((h) => {
        const keys = [...h.keys.values()];
        return {
          holder: h.holder, holder_type: h.holder_type, holder_email: h.holder_email,
          holder_id: h.holder_id, assignments: h.assignments,
          keys, total_keys: totalQty(keys),
        };
      })
      .sort((a, b) => a.holder.localeCompare(b.holder)),
  });
});

/**
 * Take `want` keys out of `rows` (a holder's open check-outs, oldest first).
 * Returns, per source row, exactly what to remove from it. A row that gives up
 * everything it holds gets closed; a row that gives up part of what it holds is
 * split, exactly as a partial check-in already does.
 */
function allocate(rows: any[], want: KeyLine[]): { row: any; take: KeyLine[]; held: KeyLine[] }[] {
  const need = new Map(want.map((l) => [l.type, l.qty]));
  const plan: { row: any; take: KeyLine[]; held: KeyLine[] }[] = [];
  for (const row of rows) {
    const held = readKeyLines(row);
    const take: KeyLine[] = [];
    for (const line of held) {
      const outstanding = need.get(line.type) ?? 0;
      if (outstanding <= 0) continue;
      const qty = Math.min(outstanding, line.qty);
      take.push({ ...line, qty });
      need.set(line.type, outstanding - qty);
    }
    if (take.length) plan.push({ row, take, held });
  }
  return plan;
}

// ── POST /api/assignments/transfer ───────────────────────────────────────────
// Person-to-person handover. Atomically: closes the FROM holder's custody
// (reason 'transferred'), opens the TO holder's, links the two records, and
// mints BOTH signature tokens. Emails go out after the commit — an SMTP outage
// must never roll back a handover that physically happened.
router.post('/transfer', requireAuth, async (req: AuthRequest, res: Response) => {
  const body = req.body || {};
  const actor = req.manager?.name ?? 'System';

  const account_id = body.account_id != null && body.account_id !== '' ? Number(body.account_id) : null;
  if (!account_id) return res.status(400).json({ error: 'A client is required' });
  const acctRaw = db.prepare('SELECT * FROM accounts WHERE id = ?').get(account_id) as any;
  if (!acctRaw) return res.status(404).json({ error: 'Client not found' });
  const account = Object.assign({}, acctRaw);
  const account_name = account.ic_company_name;
  const bcNumber = bcNumberFor(account);

  const from_holder = cleanText(body.from_holder);
  const to_holder = cleanText(body.to_holder);
  if (!from_holder) return res.status(400).json({ error: 'A holder to transfer FROM is required' });
  if (!to_holder) return res.status(400).json({ error: 'A holder to transfer TO is required' });
  if (from_holder.trim().toLowerCase() === to_holder.trim().toLowerCase()) {
    return res.status(400).json({ error: 'Keys cannot be transferred to the same person who already holds them' });
  }

  const to_holder_type: 'employee' | 'ic' = body.to_holder_type === 'ic' ? 'ic' : 'employee';
  const to_holder_id = body.to_holder_id != null && body.to_holder_id !== '' ? Number(body.to_holder_id) : null;
  const to_holder_email = cleanText(body.to_holder_email);
  const due_at = cleanText(body.due_at);
  const notes = cleanText(body.notes);

  const parsed = parseKeyLines(body.keys);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const lines = parsed.lines;

  // What the FROM holder actually has out at this client, right now.
  const { rows: sourceRows, keys: heldKeys } = openHoldingsFor(account_id, from_holder);
  if (!sourceRows.length) {
    return res.status(409).json({ error: `${from_holder} has no keys checked out at ${account_name}` });
  }
  const heldBy = new Map(heldKeys.map((k) => [k.type, k.qty]));
  for (const line of lines) {
    const have = heldBy.get(line.type) ?? 0;
    if (line.qty > have) {
      return res.status(409).json({
        error: `${from_holder} has ${have} ${line.label}${have === 1 ? '' : 's'} out at ${account_name} — cannot transfer ${line.qty}.`,
      });
    }
  }

  const from_holder_type = (sourceRows[0].holder_type as 'employee' | 'ic') ?? null;
  const from_holder_email = sourceRows.find((r) => r.assignee_email)?.assignee_email ?? null;
  const transferId = crypto.randomBytes(12).toString('hex');
  const now = new Date().toISOString();
  const plan = allocate(sourceRows, lines);

  const toToken = mintToken();
  const fromToken = mintToken();

  let toId = 0;
  let primaryFromId = 0;
  const fromIds: number[] = [];

  // ── Atomic swap ────────────────────────────────────────────────────────────
  // Custody must never show the same key held by two people, nor by nobody.
  // Everything below lands together or not at all.
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const { row, take, held } of plan) {
      const remaining = held
        .map((h) => ({ ...h, qty: h.qty - (take.find((t) => t.type === h.type)?.qty ?? 0) }))
        .filter((h) => h.qty > 0);

      if (remaining.length) {
        // Partial — the source row keeps what was not handed over, and the
        // transferred slice becomes its own closed record.
        db.prepare('UPDATE key_assignments SET keys_json=?, keys_held=?, key_type=? WHERE id=?')
          .run(JSON.stringify(remaining), summarizeKeys(remaining), remaining[0].type, row.id);

        const inserted = db.prepare(`
          INSERT INTO key_assignments
            (account_id, account_name, assignee, assignee_email, key_type, keys_held, keys_json,
             holder_type, holder_id, recorded_by, checkin_recorded_by, checked_out_at, due_at,
             returned_at, condition_on_return, notes, status, return_reason,
             signed_at, signature_data, signature_hash, pdf_path,
             transfer_id, transfer_role)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'returned', 'transferred', ?, ?, ?, ?, ?, 'from')
        `).run(
          row.account_id, row.account_name, row.assignee, row.assignee_email,
          take[0].type, summarizeKeys(take), JSON.stringify(take),
          row.holder_type, row.holder_id, row.recorded_by, actor,
          row.checked_out_at, row.due_at, now, 'good',
          `Transferred to ${to_holder}`,
          row.signed_at, row.signature_data, row.signature_hash, row.pdf_path,
          transferId,
        );
        fromIds.push(Number(inserted.lastInsertRowid));
      } else {
        db.prepare(`
          UPDATE key_assignments
             SET status='returned', returned_at=?, condition_on_return=COALESCE(condition_on_return,'good'),
                 checkin_recorded_by=?, return_reason='transferred',
                 transfer_id=?, transfer_role='from',
                 notes = CASE WHEN notes IS NULL OR notes = '' THEN ? ELSE notes || ' | ' || ? END
           WHERE id=?
        `).run(now, actor, transferId, `Transferred to ${to_holder}`, `Transferred to ${to_holder}`, row.id);
        fromIds.push(Number(row.id));
      }
    }

    primaryFromId = fromIds[0];

    const insertedTo = db.prepare(`
      INSERT INTO key_assignments
        (account_id, account_name, assignee, assignee_email, key_type, keys_held, keys_json,
         holder_type, holder_id, recorded_by, checked_out_at, due_at, notes, status,
         signoff_token, signoff_expires_at, transfer_id, transfer_role, linked_assignment_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'checked_out', ?, ?, ?, 'to', ?)
    `).run(
      account_id, account_name, to_holder, to_holder_email,
      lines[0].type, summarizeKeys(lines), JSON.stringify(lines),
      to_holder_type, to_holder_id, actor, now, due_at,
      notes ? `Transferred from ${from_holder}. ${notes}` : `Transferred from ${from_holder}`,
      toToken.token, toToken.expires, transferId, primaryFromId,
    );
    toId = Number(insertedTo.lastInsertRowid);

    // Cross-reference every from-record back to the new to-record, and put the
    // single check-in signature form on the PRIMARY one so a transfer always
    // produces exactly two signature requests.
    for (const id of fromIds) {
      db.prepare('UPDATE key_assignments SET linked_assignment_id=? WHERE id=?').run(toId, id);
    }
    db.prepare('UPDATE key_assignments SET checkin_signoff_token=?, checkin_signoff_expires_at=? WHERE id=?')
      .run(fromToken.token, fromToken.expires, primaryFromId);

    db.exec('COMMIT');
  } catch (err: any) {
    db.exec('ROLLBACK');
    return res.status(500).json({ error: err?.message || 'Transfer failed — nothing was changed' });
  }

  const fromLink = signoffLinkFor(fromToken.token);
  const toLink = signoffLinkFor(toToken.token);

  logAudit(req, 'keys_transferred', account_name, account_id, {
    transfer_id: transferId,
    from: from_holder, from_holder_type, from_record_ids: fromIds, primary_from_record_id: primaryFromId,
    to: to_holder, to_holder_type, to_record_id: toId,
    client: account_name, bc_number: bcNumber,
    keys: lines, total_keys: totalQty(lines),
    actor,
    summary: `${actor} transferred ${totalQty(lines)} key(s) from ${from_holder} to ${to_holder} at ${account_name}`,
  });

  // Both halves are notified, and both signature forms go out, before this
  // responds — so the UI can report the true outcome of each send.
  const fromMail = await sendCheckinNotice({
    holder: from_holder, holderEmail: from_holder_email, holderType: from_holder_type,
    client: account_name, bcNumber, keys: lines, returnedAt: now, condition: 'good',
    recordedBy: actor, onBehalf: actor.trim().toLowerCase() !== from_holder.trim().toLowerCase(),
    signoffLink: fromLink, transferTo: to_holder,
  });
  logMail(req, fromMail, 'checkin', account_name, account_id, from_holder);

  const toMail = await sendCheckoutNotice({
    holder: to_holder, holderEmail: to_holder_email, holderType: to_holder_type,
    client: account_name, bcNumber, keys: lines, checkedOutAt: now, dueAt: due_at,
    recordedBy: actor, onBehalf: actor.trim().toLowerCase() !== to_holder.trim().toLowerCase(),
    signoffLink: toLink, transferFrom: from_holder,
  });
  logMail(req, toMail, 'checkout', account_name, account_id, to_holder);

  const fromRow = db.prepare('SELECT * FROM key_assignments WHERE id = ?').get(primaryFromId);
  const toRow = db.prepare('SELECT * FROM key_assignments WHERE id = ?').get(toId);

  res.status(201).json({
    success: true,
    transfer_id: transferId,
    from: { record_id: primaryFromId, all_record_ids: fromIds, holder: from_holder, signoff_link: fromLink, assignment: serializeAssignment(fromRow) },
    to: { record_id: toId, holder: to_holder, signoff_link: toLink, assignment: serializeAssignment(toRow) },
    keys: lines,
    total_keys: totalQty(lines),
    signatures: transferSignatureState(transferId),
    email: {
      from: { ok: fromMail.ok, recipients: fromMail.recipients, error: fromMail.error },
      to: { ok: toMail.ok, recipients: toMail.recipients, error: toMail.error },
      cara: caraAddress(),
    },
  });
});

export default router;
