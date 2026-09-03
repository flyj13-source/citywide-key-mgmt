import { Router, Response } from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { requireAuth, AuthRequest } from '../middleware/auth';
import db from '../lib/db';
import { logAudit } from '../lib/audit';
import {
  KEY_TYPES, availabilityFor, checkAvailability, parseKeyLines, readKeyLines, counterpartyOf,
  summarizeKeys, totalQty, KeyLine, bcNumberFor, bcNumberForAssignment,
  transferSignatureState,
} from '../lib/custody';
import { sendCheckoutNotice, sendCheckinNotice, sendSignedReceipt, caraAddress, MailResult } from '../lib/custodyMail';
import { hashSignature } from '../lib/pdf';
import { generateCustodyReceipt } from '../lib/custodyPdf';
import { createKeyForm, serializeForm, getKeyForm, type FormEventType } from '../lib/keyForm';
import { generateKeyFormPdf } from '../lib/keyFormPdf';

const router = Router();

export const SIGNOFF_TTL_MS = 48 * 60 * 60 * 1000;

const frontendBase = (): string => process.env.FRONTEND_URL || 'http://localhost:5173';
export const signoffLinkFor = (token: string): string => `${frontendBase()}/key-signoff/${token}`;
const mintToken = (): { token: string; expires: string } => ({
  token: crypto.randomBytes(32).toString('hex'),
  expires: new Date(Date.now() + SIGNOFF_TTL_MS).toISOString(),
});

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
    signature_typed_name: a.signature_typed_name ?? null,
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
    // Check-IN signature — its own independent state, so a record can be
    // "signed out, awaiting return signature" and say so.
    checkin_signed_at: a.checkin_signed_at ?? null,
    checkin_signature_hash: a.checkin_signature_hash ?? null,
    checkin_signature_typed_name: a.checkin_signature_typed_name ?? null,
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

/**
 * Every custody event produces a Key Form — the complete statement of what the
 * holder has AFTER the event. Generated here so no event path can forget one.
 * A form failure is logged but never fails the custody transaction itself: the
 * keys really moved, and losing that record to a PDF error would be worse.
 */
export async function generateEventForm(
  req: AuthRequest,
  input: {
    eventType: FormEventType; holderName: string; holderType: 'employee' | 'ic';
    holderEmail?: string | null; holderId?: number | null; eventNote?: string | null;
    sourceKind?: string | null; sourceRef?: string | null; counterpartyName?: string | null;
    lines?: any[];
  },
): Promise<any | null> {
  try {
    const row = createKeyForm({
      eventType: input.eventType,
      holderName: input.holderName,
      holderType: input.holderType,
      holderEmail: input.holderEmail ?? null,
      holderId: input.holderId ?? null,
      lines: input.lines,
      eventNote: input.eventNote ?? null,
      generatedBy: req.manager?.name ?? 'System',
      sourceKind: input.sourceKind ?? null,
      sourceRef: input.sourceRef ?? null,
      counterpartyName: input.counterpartyName ?? null,
    });
    try {
      const pdf = await generateKeyFormPdf(row);
      db.prepare('UPDATE key_form_docs SET pdf_path = ? WHERE id = ?').run(pdf, row.id);
    } catch (e) {
      console.error('[keyform] PDF failed:', (e as Error).message);
    }
    const fresh = getKeyForm(row.id);
    logAudit(req, 'key_form_generated', null, null, {
      form_id: row.id, form_no: row.form_no, holder: input.holderName,
      event_type: input.eventType, total_keys: row.total_keys,
      clients: row.clients_covered, no_email: !!row.no_email,
      source: input.sourceKind, source_ref: input.sourceRef,
    });
    return serializeForm(fresh);
  } catch (e) {
    console.error('[keyform] generation failed:', (e as Error).message);
    return null;
  }
}

function logMail(req: AuthRequest, result: MailResult, kind: 'checkout' | 'checkin' | 'established', accountName: string, accountId: number | null, holder: string) {
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
  // A record with nowhere to send the link gets NO token — an unusable token
  // would only make the record look like it is waiting for something.
  const minted = holder_email ? mintToken() : { token: null, expires: null };
  const token = minted.token;
  const signoff_expires_at = minted.expires;
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

  const signoffLink = token ? signoffLinkFor(token) : null;

  // Cara is notified either way (spec 4) — when there is no holder email the
  // notice goes to her alone, carrying a red "No signature sent" banner.
  const mail = await sendCheckoutNotice({
    holder, holderEmail: holder_email, holderType: holder_type,
    client: account_name, bcNumber: bcNumberFor(account), keys: lines,
    checkedOutAt: checked_out_at, dueAt: due_at, recordedBy: actor, onBehalf, signoffLink,
    noEmailReason: no_email_reason,
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

  const keyForm = await generateEventForm(req, {
    eventType: 'checkout', holderName: holder, holderType: holder_type,
    holderEmail: holder_email || null, holderId: holder_id,
    eventNote: `Checked out at ${account_name}: ${summarizeKeys(lines)}`,
    sourceKind: 'assignment', sourceRef: String(id),
  });

  const row = db.prepare('SELECT * FROM key_assignments WHERE id = ?').get(id);
  res.status(201).json({
    id,
    assignment: serializeAssignment(row),
    key_form: keyForm,
    signoff_link: signoffLink,
    signature_status: signatureStatus,
    email: {
      ok: mail.ok, recipients: mail.recipients, error: mail.error,
      attempts: mail.attempts, cara: caraAddress(),
    },
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
/**
 * A check-IN for keys this system never saw go out. Creates the record and
 * closes it in one transaction, marked origin='reconciled' so a report can
 * tell a reconciling entry from a transaction we actually issued.
 *
 * If an OPEN record already exists for this holder at this client, it is used
 * instead of inventing a second one — otherwise a careless entry would leave
 * the original still showing as out.
 */
async function reconcileCheckin(req: AuthRequest, res: Response) {
  const body = req.body || {};
  const actor = req.manager?.name ?? 'System';

  const holder = cleanText(body.holder ?? body.assignee);
  if (!holder) return res.status(400).json({ error: 'A holder is required' });
  const account_id = body.account_id != null && body.account_id !== '' ? Number(body.account_id) : null;
  if (!account_id) return res.status(400).json({ error: 'A client is required' });
  const acctRaw = db.prepare('SELECT * FROM accounts WHERE id = ?').get(account_id) as any;
  if (!acctRaw) return res.status(404).json({ error: 'Client not found' });
  const account = Object.assign({}, acctRaw);

  const parsed = parseKeyLines(body.keys);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  if (!parsed.lines.length) return res.status(400).json({ error: 'Select at least one key' });

  const holder_email = cleanText(body.holder_email ?? body.assignee_email);
  const holder_type = body.holder_type === 'ic' ? 'ic' : 'employee';
  const holder_id = body.holder_id != null && body.holder_id !== '' ? Number(body.holder_id) : null;
  const condition = cleanText(body.condition_on_return) || 'good';
  const notes = cleanText(body.notes);
  const returned_at = cleanText(body.returned_at) || new Date().toISOString();
  const lines = parsed.lines;

  const result = db.prepare(`
    INSERT INTO key_assignments
      (account_id, account_name, assignee, assignee_email, key_type, keys_held, keys_json,
       holder_type, holder_id, recorded_by, checkin_recorded_by, checked_out_at, returned_at,
       condition_on_return, notes, status, signature_status, origin)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'returned', 'not_required', 'reconciled')
  `).run(
    account_id, account.ic_company_name, holder, holder_email,
    lines[0]?.type ?? 'physical', summarizeKeys(lines), JSON.stringify(lines),
    holder_type, holder_id, actor, actor, returned_at, returned_at,
    condition, notes,
  );
  const newId = Number(result.lastInsertRowid);

  logAudit(req, 'key_checked_in', account.ic_company_name, account_id, {
    assignment_id: newId, holder, holder_type, actor,
    origin: 'reconciled',
    keys: lines, total_keys: totalQty(lines), condition,
    summary: `${actor} recorded a return from ${holder} with no prior check-out on file`,
    note: 'Reconciling entry — the keys came back from someone this system never saw take them',
  });

  const form = await generateEventForm(req, {
    eventType: 'checkin', holderName: holder, holderType: holder_type,
    holderEmail: holder_email || null, holderId: holder_id,
    eventNote: `Reconciling check-in at ${account.ic_company_name}: ${summarizeKeys(lines)}`,
    sourceKind: 'assignment', sourceRef: String(newId),
  });

  const mail = await sendCheckinNotice({
    holder, holderEmail: holder_email || null, holderType: holder_type,
    client: account.ic_company_name, bcNumber: bcNumberFor(account),
    keys: lines, returnedAt: returned_at, condition, recordedBy: actor, onBehalf: true,
    signoffLink: null,
  });
  logMail(req, mail, 'checkin', account.ic_company_name, account_id, holder);

  const row = db.prepare('SELECT * FROM key_assignments WHERE id = ?').get(newId);
  return res.status(201).json({
    success: true,
    reconciled: true,
    partial: false,
    still_out: [],
    assignment: serializeAssignment(row),
    key_form: form,
    signoff_link: null,
    email: { ok: mail.ok, recipients: mail.recipients, error: mail.error, cara: caraAddress() },
  });
}

router.post('/checkin', requireAuth, async (req: AuthRequest, res: Response) => {
  const { id, condition_on_return, notes } = req.body || {};

  // ── No assignment named? Resolve one, or take the entry anyway. ───────────
  // People held keys long before this system existed, and a check-IN that
  // refuses the return because nothing was ever checked OUT is a dead end that
  // loses real information.
  //
  // Order matters: an OPEN record for this holder at this client is closed
  // normally, because inventing a second row would leave the original showing
  // as still out. Only when there is genuinely nothing on file does the entry
  // become a reconciling one.
  let resolvedId = id;
  if (resolvedId == null || resolvedId === '') {
    const holderName = cleanText(req.body?.holder ?? req.body?.assignee);
    const acctId = req.body?.account_id != null && req.body.account_id !== ''
      ? Number(req.body.account_id) : null;
    if (holderName && acctId) {
      const openRaw = db.prepare(`
        SELECT id FROM key_assignments
         WHERE status = 'checked_out' AND account_id = ?
           AND LOWER(TRIM(assignee)) = LOWER(TRIM(?))
         ORDER BY id LIMIT 1
      `).get(acctId, holderName) as any;
      if (openRaw) resolvedId = Object.assign({}, openRaw).id;
    }
    if (resolvedId == null || resolvedId === '') return reconcileCheckin(req, res);
  }

  const raw = db.prepare('SELECT * FROM key_assignments WHERE id = ?').get(resolvedId) as any;
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

  let returnedId = Number(resolvedId);

  if (remaining.length) {
    // Partial return — split the transaction.
    db.prepare('UPDATE key_assignments SET keys_json=?, keys_held=?, key_type=? WHERE id=?')
      .run(JSON.stringify(remaining), summarizeKeys(remaining), remaining[0].type, resolvedId);

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
    `).run(returned_at, condition, actor, appendNote(assignment.notes ?? null, extraNotes), resolvedId);
  }

  // The return needs its own signature. Mint the token against the RETURNED
  // record (which on a partial return is the newly split row, not the original)
  // so the form lists exactly the keys that actually came back.
  const { token: checkinToken, expires: checkinExpires } = mintToken();
  db.prepare('UPDATE key_assignments SET checkin_signoff_token=?, checkin_signoff_expires_at=?, return_reason=COALESCE(return_reason, ?) WHERE id=?')
    .run(checkinToken, checkinExpires, 'returned', returnedId);
  const signoffLink = signoffLinkFor(checkinToken);

  logAudit(req, 'key_checked_in', assignment.account_name, assignment.account_id, {
    assignment_id: Number(resolvedId),
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

  const keyForm = await generateEventForm(req, {
    eventType: 'checkin', holderName: holder,
    holderType: (assignment.holder_type as 'employee' | 'ic') ?? 'employee',
    holderEmail: assignment.assignee_email ?? null, holderId: assignment.holder_id ?? null,
    eventNote: `Returned at ${assignment.account_name}: ${summarizeKeys(returning)}`
      + (remaining.length ? ` — ${summarizeKeys(remaining)} still out` : ''),
    sourceKind: 'assignment', sourceRef: String(returnedId),
  });

  const row = db.prepare('SELECT * FROM key_assignments WHERE id = ?').get(returnedId);
  res.json({
    success: true,
    partial: remaining.length > 0,
    still_out: remaining,
    assignment: serializeAssignment(row),
    key_form: keyForm,
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

  // ── Transfer mode ─────────────────────────────────────────────────────────
  // A transfer can move the physical keys, the manager assignment, or both.
  // They are genuinely different events: keys change hands without the account
  // moving (covering a shift), and an account moves without keys changing
  // hands (a reassignment where the metal follows later).
  const mode: 'keys' | 'accounts' | 'both' =
    body.mode === 'accounts' ? 'accounts' : body.mode === 'both' ? 'both' : 'keys';
  const movesKeys = mode === 'keys' || mode === 'both';
  const movesAccounts = mode === 'accounts' || mode === 'both';

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

  // An accounts-only transfer moves no keys, so there is nothing to parse and
  // nothing to validate against holdings.
  let lines: KeyLine[] = [];
  if (movesKeys) {
    const parsed = parseKeyLines(body.keys);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    if (!parsed.lines.length) {
      return res.status(400).json({ error: 'Select at least one key to transfer' });
    }
    lines = parsed.lines;
  }

  // What the FROM holder actually has out at this client, right now.
  const { rows: sourceRows, keys: heldKeys } = openHoldingsFor(account_id, from_holder);
  if (movesKeys && !sourceRows.length) {
    return res.status(409).json({
      error: `${from_holder} has no keys on record at ${account_name}. If they already hold keys, record a check-in first — or choose "Accounts only" to move the assignment without the keys.`,
      code: 'NO_KEYS_ON_RECORD',
    });
  }
  const heldBy = new Map(heldKeys.map((k) => [k.type, k.qty]));
  for (const line of (movesKeys ? lines : [])) {
    const have = heldBy.get(line.type) ?? 0;
    if (line.qty > have) {
      return res.status(409).json({
        error: `${from_holder} has ${have} ${line.label}${have === 1 ? '' : 's'} out at ${account_name} — cannot transfer ${line.qty}.`,
      });
    }
  }

  const from_holder_type = (sourceRows[0]?.holder_type as 'employee' | 'ic') ?? null;
  const from_holder_email = sourceRows.find((r) => r.assignee_email)?.assignee_email ?? null;

  // ── Missing-email gate (same contract as check-out) ───────────────────────
  // A transfer needs BOTH signatures to be complete, so a party with no address
  // is a hole in the chain of custody, not a detail. Refuse silently creating
  // one: the caller must supply an address or state why it is going unsigned.
  const no_email_reason = cleanText(body.no_email_reason);
  const unreachable = movesKeys
    ? [
      ...(!from_holder_email ? [from_holder] : []),
      ...(!to_holder_email ? [to_holder] : []),
    ]
    // An accounts-only move issues no signature request — there is no custody
    // hand-over to acknowledge — so a missing address costs a notification,
    // not a link in the chain of custody.
    : [];
  if (unreachable.length && !no_email_reason) {
    return res.status(422).json({
      error: `${unreachable.join(' and ')} ${unreachable.length === 1 ? 'has' : 'have'} no email on file — a signature cannot be sent.`,
      code: 'HOLDER_EMAIL_MISSING',
      holder: unreachable.join(' and '),
      unreachable,
      remedies: ['add_email', 'continue_without_signature'],
    });
  }
  const transferId = crypto.randomBytes(12).toString('hex');
  const now = new Date().toISOString();
  let accountMoved: { role: 'am' | 'ccm'; from: string | null; to: string } | null = null;
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
    for (const { row, take, held } of (movesKeys ? plan : [])) {
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

    primaryFromId = fromIds[0] ?? 0;

    if (movesKeys) {
    const insertedTo = db.prepare(`
      INSERT INTO key_assignments
        (account_id, account_name, assignee, assignee_email, key_type, keys_held, keys_json,
         holder_type, holder_id, recorded_by, checked_out_at, due_at, notes, status,
         signoff_token, signoff_expires_at, transfer_id, transfer_role, linked_assignment_id,
         signature_status, no_email_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'checked_out', ?, ?, ?, 'to', ?, ?, ?)
    `).run(
      account_id, account_name, to_holder, to_holder_email,
      lines[0].type, summarizeKeys(lines), JSON.stringify(lines),
      to_holder_type, to_holder_id, actor, now, due_at,
      notes ? `Transferred from ${from_holder}. ${notes}` : `Transferred from ${from_holder}`,
      // No address for the receiver → no usable link, and the record is flagged
      // red rather than left looking like it is waiting on a signature.
      to_holder_email ? toToken.token : null,
      to_holder_email ? toToken.expires : null,
      transferId, primaryFromId,
      to_holder_email ? 'awaiting_signature' : 'signature_unavailable',
      to_holder_email ? null : no_email_reason,
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
    }

    // ── Account assignment ──────────────────────────────────────────────────
    // The manager column moves inside the SAME transaction as the keys, so a
    // "keys and accounts" transfer can never half-land.
    if (movesAccounts) {
      const role: 'am' | 'ccm' = body.account_role === 'ccm' ? 'ccm' : 'am';
      const col = role === 'ccm' ? 'ccm_manager' : 'account_manager';
      const before = Object.assign({}, db.prepare(
        `SELECT ${col} AS current FROM accounts WHERE id = ?`
      ).get(account_id) as any).current ?? null;
      db.prepare(`UPDATE accounts SET ${col} = ?, pending_handover = ?, pending_handover_from = ?,
                         pending_handover_to = ?, pending_handover_role = ?, pending_handover_at = ?
                   WHERE id = ?`)
        .run(to_holder, movesKeys ? 0 : 1, before, to_holder, role, now, account_id);
      accountMoved = { role, from: before, to: to_holder };
    }

    db.exec('COMMIT');
  } catch (err: any) {
    db.exec('ROLLBACK');
    return res.status(500).json({ error: err?.message || 'Transfer failed — nothing was changed' });
  }

  const fromLink = movesKeys ? signoffLinkFor(fromToken.token) : null;
  const toLink = movesKeys ? signoffLinkFor(toToken.token) : null;

  logAudit(req, 'keys_transferred', account_name, account_id, {
    transfer_id: transferId,
    mode,
    account_moved: accountMoved ?? undefined,
    from: from_holder, from_holder_type, from_record_ids: fromIds, primary_from_record_id: primaryFromId,
    to: to_holder, to_holder_type, to_record_id: toId,
    client: account_name, bc_number: bcNumber,
    keys: lines, total_keys: totalQty(lines),
    actor,
    summary: `${actor} transferred ${totalQty(lines)} key(s) from ${from_holder} to ${to_holder} at ${account_name}`,
  });

  // Both halves are notified, and both signature forms go out, before this
  // responds — so the UI can report the true outcome of each send.
  const fromMail = !movesKeys
    ? ({ ok: true, recipients: [], attempts: 0, skipped: true } as MailResult)
    : await sendCheckinNotice({
    holder: from_holder, holderEmail: from_holder_email, holderType: from_holder_type,
    client: account_name, bcNumber, keys: lines, returnedAt: now, condition: 'good',
    recordedBy: actor, onBehalf: actor.trim().toLowerCase() !== from_holder.trim().toLowerCase(),
    signoffLink: fromLink, transferTo: to_holder,
  });
  if (movesKeys) logMail(req, fromMail, 'checkin', account_name, account_id, from_holder);

  const toMail = !movesKeys
    ? ({ ok: true, recipients: [], attempts: 0, skipped: true } as MailResult)
    : await sendCheckoutNotice({
    holder: to_holder, holderEmail: to_holder_email, holderType: to_holder_type,
    client: account_name, bcNumber, keys: lines, checkedOutAt: now, dueAt: due_at,
    recordedBy: actor, onBehalf: actor.trim().toLowerCase() !== to_holder.trim().toLowerCase(),
    signoffLink: toLink, transferFrom: from_holder,
  });
  if (movesKeys) logMail(req, toMail, 'checkout', account_name, account_id, to_holder);

  // ── Paired Key Forms ──────────────────────────────────────────────────────
  // Both parties get a form stating what they hold AFTER the transfer, each
  // naming the other. One form for the outgoing side and one for the incoming
  // side — a transfer that produced only one would leave half the chain of
  // custody undocumented.
  const movedNote = [
    movesKeys ? `${summarizeKeys(lines)} at ${account_name}` : null,
    movesAccounts ? `account assignment (${accountMoved?.role.toUpperCase()}) for ${account_name}` : null,
  ].filter(Boolean).join(' + ');

  const fromForm = await generateEventForm(req, {
    eventType: 'transfer', holderName: from_holder,
    holderType: from_holder_type ?? 'employee', holderEmail: from_holder_email,
    eventNote: `Transferred OUT to ${to_holder}: ${movedNote}`,
    sourceKind: 'transfer', sourceRef: transferId, counterpartyName: to_holder,
  });
  const toForm = await generateEventForm(req, {
    eventType: 'transfer', holderName: to_holder,
    holderType: to_holder_type, holderEmail: to_holder_email, holderId: to_holder_id,
    eventNote: `Received IN from ${from_holder}: ${movedNote}`,
    sourceKind: 'transfer', sourceRef: transferId, counterpartyName: from_holder,
  });

  const fromRow = primaryFromId
    ? db.prepare('SELECT * FROM key_assignments WHERE id = ?').get(primaryFromId) : null;
  const toRow = toId
    ? db.prepare('SELECT * FROM key_assignments WHERE id = ?').get(toId) : null;

  res.status(201).json({
    success: true,
    transfer_id: transferId,
    mode,
    account_moved: accountMoved,
    key_forms: { from: fromForm, to: toForm },
    from: { record_id: primaryFromId, all_record_ids: fromIds, holder: from_holder, signoff_link: fromLink, assignment: fromRow ? serializeAssignment(fromRow) : null },
    to: { record_id: toId, holder: to_holder, signoff_link: toLink, assignment: toRow ? serializeAssignment(toRow) : null },
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
  // Direction matters: a return is acknowledged, not received, and each
  // direction carries its own signature so one never overwrites the other.
  const kind: 'checkout' | 'checkin' = req.body?.kind === 'checkin' ? 'checkin' : 'checkout';
  const alreadySigned = kind === 'checkin' ? a.checkin_signed_at : a.signed_at;
  if (alreadySigned) {
    return res.status(409).json({
      error: kind === 'checkin'
        ? 'This return has already been signed for'
        : 'These keys have already been signed for',
    });
  }

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
      action: kind,
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
      transferCounterparty: counterpartyOf(a)?.name ?? null,
    });
  } catch (err: any) {
    // The signature is the legal record — never lose it to a PDF failure.
    pdfError = err?.message || 'PDF generation failed';
  }

  db.prepare(
    kind === 'checkin'
      ? `UPDATE key_assignments
            SET checkin_signed_at = ?, checkin_signature_data = ?, checkin_signature_hash = ?,
                checkin_pdf_path = ?, signed_in_person_by = ?, checkin_signoff_token = NULL
          WHERE id = ?`
      : `UPDATE key_assignments
            SET signed_at = ?, signature_data = ?, signature_hash = ?, pdf_path = ?,
                signed_in_person_by = ?, signature_status = 'signed', signoff_token = NULL
          WHERE id = ?`
  ).run(signedAt, signature_data, hash, pdfPath, witness, a.id);

  logAudit(req, 'checkout_signed_in_person', a.account_name, a.account_id, {
    assignment_id: a.id, kind, holder: a.assignee, witnessed_by: witness,
    previous_status: a.signature_status ?? null,
    hash: hash.slice(0, 16), pdf: pdfPath ? path.basename(pdfPath) : null,
    pdf_error: pdfError || undefined,
  });

  const other = counterpartyOf(a);
  const mail = await sendSignedReceipt({
    action: kind,
    holder: a.assignee,
    holderEmail: a.assignee_email ?? null,
    holderType: a.holder_type === 'ic' ? 'ic' : 'employee',
    client: a.account_name,
    bcNumber: bcNumberFor(db.prepare('SELECT * FROM accounts WHERE id = ?').get(a.account_id)),
    keys,
    signedAt,
    witnessedBy: witness,
    counterpartyName: other?.name ?? null,
    counterpartyEmail: other?.email ?? null,
    pdf: pdfPath && fs.existsSync(pdfPath)
      ? { filename: path.basename(pdfPath), content: fs.readFileSync(pdfPath) }
      : null,
    pdfError,
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
