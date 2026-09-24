// ── Key Forms API ────────────────────────────────────────────────────────────
// The auditable artifact: list, generate, send, sign, download.
//
// Sending is idempotent and always logged — every send and resend writes an
// audit entry naming the recipients, the timestamp and who sent it, so an audit
// can reconstruct exactly who was told what and when.

import { Router, Response, Request } from 'express';
import fs from 'fs';
import path from 'path';
import { requireAuth, AuthRequest } from '../middleware/auth';
import db from '../lib/db';
import { logAudit } from '../lib/audit';
import { hashSignature } from '../lib/pdf';
import {
  createKeyForm, getKeyForm, getKeyFormByToken, listKeyForms, markSent,
  parseScope, serializeForm, snapshotHolder, FORM_EVENT_LABEL, EmptyHoldingsError,
  docKindOf, docTitleFor, docTableHeadingFor, docTotalLabelFor, formCoverageOf, ackVariantOf,
  type FormEventType,
} from '../lib/keyForm';
import { failedSendCount, failedSendIds, correctionFormCounts, archivedFormCount } from '../lib/keyForm';
import ExcelJS from 'exceljs';
import { checkReason, voidKeyForm, acknowledgeKeyForm, MIN_REASON_LENGTH } from '../lib/corrections';
import { generateKeyFormPdf } from '../lib/keyFormPdf';
import { readKeyLines, bcNumberForAssignment } from '../lib/custody';
import { sendKeyForm, caraAddress, notifyAddresses } from '../lib/custodyMail';
import { propagateSignature, refreshFormPdfs } from '../lib/signatureSync';
import { runSweepSafely, linkStateCounts, reviveLinkForManualSend } from '../lib/signatureLink';

/** Same base the custody sign-off links use. */
const frontendBase = (): string => process.env.FRONTEND_URL || 'http://localhost:5173';

const router = Router();

const cleanText = (v: any): string => (v == null ? '' : String(v).trim());
const isEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

export const keyFormLinkFor = (token: string): string => `${frontendBase()}/key-form/${token}`;

/** Regenerate the PDF from the row's current state. Never throws upward. */
async function refreshPdf(id: number): Promise<string | null> {
  const row = getKeyForm(id);
  if (!row) return null;
  try {
    const file = await generateKeyFormPdf(row);
    db.prepare('UPDATE key_form_docs SET pdf_path = ? WHERE id = ?').run(file, id);
    return file;
  } catch (e) {
    // A PDF failure must never lose the form itself.
    console.error(`[keyform] PDF generation failed for ${id}:`, (e as Error).message);
    return null;
  }
}

/**
 * Rebuild a return receipt's line items from the custody record it names.
 *
 * Forms carry source_kind='assignment' + source_ref=<id>, so the keys that
 * moved are recoverable from the row itself rather than from the holder's
 * position today. Returns an empty array when the record cannot be found,
 * which the caller reports rather than papering over — inventing line items
 * for a document somebody signs would be worse than refusing.
 */
function receiptLinesFromSource(form: any, viaOverride?: string): any[] {
  if (!form.source_ref) return [];
  // A transfer's keys are on its receiving record; both sides moved the same set.
  const raw = form.source_kind === 'assignment'
    ? db.prepare('SELECT * FROM key_assignments WHERE id = ?').get(Number(form.source_ref)) as any
    : form.source_kind === 'transfer'
      ? db.prepare("SELECT * FROM key_assignments WHERE transfer_id = ? AND transfer_role = 'to' ORDER BY id LIMIT 1")
        .get(String(form.source_ref)) as any
      : null;
  if (!raw) return [];
  const rec = Object.assign({}, raw);
  let keys = readKeyLines(rec);
  // An ISSUE is rebuilt from what was issued. The custody row is not a
  // reliable record of that: a partial return splits it and shrinks its key
  // list to what is still out. The check-out's own audit entry was written at
  // the moment of issue and carries the exact set, so it is preferred.
  if (form.event_type === 'checkout' && form.source_kind === 'assignment') {
    const a = db.prepare(`
      SELECT metadata FROM audit_log
       WHERE action = 'key_checked_out' AND json_extract(metadata, '$.assignment_id') = ?
       ORDER BY id ASC LIMIT 1
    `).get(Number(form.source_ref)) as any;
    try {
      const issued = a ? JSON.parse(Object.assign({}, a).metadata).keys : null;
      if (Array.isArray(issued) && issued.length) keys = readKeyLines({ keys_json: JSON.stringify(issued) });
    } catch { /* fall back to the custody row */ }
  }
  const total = keys.reduce((n, k) => n + k.qty, 0);
  if (!total) return [];

  const line: any = {
    account_id: rec.account_id ?? null,
    client: rec.account_name ?? 'Client',
    bc_client_number: bcNumberForAssignment(rec),
    metal: 0, card: 0, fob: 0, dispenser: 0, office: 0,
    subtotal: total, assigned: 0, checked_out: total,
    via: viaOverride
      ?? (form.counterparty_name ? `Transferred to ${form.counterparty_name}` : 'Returned by this event'),
  };
  for (const k of keys) if (k.type in line) line[k.type] += k.qty;
  return [line];
}

/**
 * What kind of document SHOULD this form be, judged from the event it records
 * rather than from what was stored on it.
 *
 * A check-in is the only ambiguous case: origin='reconciled' means it closed no
 * prior check-out — Cara putting keys somebody already has on record — which is
 * a holdings assertion, not a return. Everything else keeps its stored kind,
 * which callers set deliberately (a transfer stores one of each).
 */
function rederiveDocKind(form: any): 'holdings' | 'return_receipt' {
  if (form.event_type === 'checkin' && form.source_kind === 'assignment' && form.source_ref) {
    const raw = db.prepare('SELECT origin FROM key_assignments WHERE id = ?')
      .get(Number(form.source_ref)) as any;
    if (raw) {
      return Object.assign({}, raw).origin === 'reconciled' ? 'holdings' : 'return_receipt';
    }
  }
  return docKindOf(form);
}

/** The list filters, parsed once so the tab and its Excel export agree exactly. */
function filtersFrom(q: Record<string, string>) {
  const accountId = Number(q.account_id);
  const archived = q.archived === 'all' || q.archived === 'archived' ? q.archived : undefined;
  return {
    search: cleanText(q.search) || undefined,
    event_type: cleanText(q.event_type) || undefined,
    status: cleanText(q.status) || undefined,
    from: cleanText(q.from) || undefined,
    to: cleanText(q.to) || undefined,
    holder: cleanText(q.holder) || undefined,
    account_id: Number.isInteger(accountId) && accountId > 0 ? accountId : undefined,
    archived: archived as 'all' | 'archived' | undefined,
  };
}

// ── GET /api/key-forms — the Forms tab ───────────────────────────────────────
router.get('/', requireAuth, (req: AuthRequest, res: Response) => {
  const q = req.query as Record<string, string>;
  const page = Math.max(1, parseInt(q.page || '1', 10));
  const limit = Math.min(200, Math.max(1, parseInt(q.limit || '50', 10)));
  // On-read fallback for the scheduler: any link that ran out since the last
  // tick is renewed (or stopped at the cap) before the list is read, so the
  // pills and counts are current even if the interval missed — a restart, a
  // deploy, a crash. The sweep is idempotent; running it here costs one query
  // when nothing is due.
  runSweepSafely();
  const { rows, total } = listKeyForms({ ...filtersFrom(q), limit, offset: (page - 1) * limit });
  // Always returned, regardless of the active filter — the chip has to show
  // the backlog even while the list is filtered to something else.
  res.json({
    forms: rows, total, page, limit,
    failed_count: failedSendCount(),
    ...correctionFormCounts(),
    link_counts: linkStateCounts(),
    archived_count: archivedFormCount(),
  });
});

// ── GET /api/key-forms/export — the filtered list, as Excel ──────────────────
// Exactly the rows the tab is showing for these filters (not just the current
// page), one per form, with its clients spelled out.
router.get('/export', requireAuth, async (req: AuthRequest, res: Response) => {
  const { rows, total } = listKeyForms({ ...filtersFrom(req.query as Record<string, string>), limit: 10000, offset: 0 });
  const wb = new ExcelJS.Workbook();
  wb.creator = 'City Wide Boston — Key Management';
  const ws = wb.addWorksheet('Key Forms');
  ws.columns = [
    { header: 'Form #', key: 'form_no', width: 11 },
    { header: 'Generated', key: 'generated', width: 20 },
    { header: 'Event', key: 'event', width: 14 },
    { header: 'Document', key: 'doc', width: 22 },
    { header: 'Covers', key: 'coverage', width: 13 },
    { header: 'Holder', key: 'holder', width: 28 },
    { header: 'Role', key: 'role', width: 10 },
    { header: 'Client(s)', key: 'clients', width: 44 },
    { header: 'BC #', key: 'bc', width: 24 },
    { header: 'Total keys', key: 'total', width: 10 },
    { header: 'Status', key: 'status', width: 18 },
    { header: 'Signed', key: 'signed', width: 20 },
    { header: 'Archived', key: 'archived', width: 9 },
  ];
  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A1A1A' } };
  const COVER: Record<string, string> = { transaction: 'Transaction', full: 'Full picture', client: 'One client' };
  for (const f of rows) {
    ws.addRow({
      form_no: f.form_no, generated: f.generated_at, event: f.event_label, doc: f.doc_title,
      coverage: COVER[f.form_coverage] ?? f.form_coverage,
      holder: f.holder_name, role: f.holder_role ?? '',
      clients: f.clients.map((c: any) => c.client).join('; '),
      bc: f.clients.map((c: any) => c.bc_client_number).filter(Boolean).join('; '),
      total: f.total_keys,
      status: f.status === 'signed' ? 'Signed' : f.link_state === 'expired' ? 'Expired'
        : f.link_state === 'expiring_soon' ? 'Expiring soon' : f.link_state ? 'Awaiting signature' : f.status,
      signed: f.signed_at ?? '', archived: f.archived ? 'Yes' : '',
    });
  }
  ws.autoFilter = { from: 'A1', to: 'M1' };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  logAudit(req, 'key_forms_exported', null, null, {
    rows: total, filters: filtersFrom(req.query as Record<string, string>),
  });
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="CityWide-KeyForms-${stamp}.xlsx"`);
  res.send(Buffer.from(await wb.xlsx.writeBuffer()));
});

// ── GET /api/key-forms/holder-clients — for the client-by-client picker ──────
// The clients a holder has keys at right now, with how many — the same source
// a full-picture form snapshots, so the picker never offers a client that
// would produce an empty form.
router.get('/holder-clients', requireAuth, (req: AuthRequest, res: Response) => {
  const name = cleanText(req.query.holder as string);
  if (!name) return res.json({ clients: [] });
  const type = req.query.holder_type === 'ic' ? 'ic' : 'employee';
  res.json({
    clients: snapshotHolder(name, type)
      .filter((l) => l.account_id != null && l.subtotal > 0)
      .map((l) => ({ account_id: l.account_id, client: l.client, bc_client_number: l.bc_client_number, keys: l.subtotal })),
  });
});

// ── GET /api/key-forms/:id ───────────────────────────────────────────────────
router.get('/:id(\\d+)', requireAuth, (req: AuthRequest, res: Response) => {
  const row = getKeyForm(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Form not found' });
  res.json({ form: serializeForm(row) });
});

// ── GET /api/key-forms/:id/pdf — download ────────────────────────────────────
router.get('/:id(\\d+)/pdf', requireAuth, async (req: AuthRequest, res: Response) => {
  const id = Number(req.params.id);
  let row = getKeyForm(id);
  if (!row) return res.status(404).json({ error: 'Form not found' });
  if (!row.pdf_path || !fs.existsSync(row.pdf_path)) {
    await refreshPdf(id);
    row = getKeyForm(id);
  }
  if (!row?.pdf_path || !fs.existsSync(row.pdf_path)) {
    return res.status(500).json({ error: 'The PDF could not be generated' });
  }
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${path.basename(row.pdf_path)}"`);
  res.send(fs.readFileSync(row.pdf_path));
});

// ── POST /api/key-forms/generate — on demand, one OR many holders ────────────
// "Generate Key Form": pick one holder or multi-select several. Each gets their
// own form carrying their CURRENT state.
router.post('/generate', requireAuth, async (req: AuthRequest, res: Response) => {
  const actor = req.manager?.name ?? 'System';
  const body = req.body || {};
  const holders: any[] = Array.isArray(body.holders) && body.holders.length
    ? body.holders
    : [{ name: body.holder, type: body.holder_type, email: body.holder_email }];

  const clean = holders
    .map((h) => ({ name: cleanText(h?.name), type: h?.type === 'ic' ? 'ic' : 'employee', email: cleanText(h?.email) }))
    .filter((h) => h.name);
  if (!clean.length) return res.status(400).json({ error: 'Select at least one holder' });

  const eventType: FormEventType = 'audit';
  // Full picture (default): one form per holder covering every client they
  // hold keys at. Client by client: one form per holder PER selected client,
  // each separately signable, each found in search under its single client.
  const byClient = body.coverage === 'client';
  const accountIds: number[] = byClient && Array.isArray(body.account_ids)
    ? [...new Set((body.account_ids as any[]).map(Number).filter((n) => Number.isInteger(n) && n > 0))]
    : [];
  if (byClient && !accountIds.length) {
    return res.status(400).json({ error: 'Choose at least one client for client-by-client forms' });
  }
  const created: any[] = [];
  // Holders with nothing on record. Collected rather than thrown on, so a
  // multi-select generating ten forms still produces the nine that have
  // content and reports the one that does not.
  const empty: string[] = [];
  const jobs = clean.flatMap((h) => (byClient
    ? accountIds.map((accountId) => ({ h, accountId }))
    : [{ h, accountId: null as number | null }]));
  for (const { h, accountId } of jobs) {
    let row: any;
    try {
      row = createKeyForm({
        eventType,
        holderName: h.name,
        holderType: h.type as 'employee' | 'ic',
        holderEmail: h.email || null,
        generatedBy: actor,
        sourceKind: 'manual',
        coverage: accountId ? 'client' : 'full',
        clientAccountId: accountId,
      });
    } catch (e) {
      if (e instanceof EmptyHoldingsError) {
        // Named with the client in client-by-client mode, so the reply says
        // WHICH client they hold nothing at.
        if (accountId) {
          const a = db.prepare('SELECT ic_company_name FROM accounts WHERE id = ?').get(accountId) as any;
          empty.push(`${e.holder} at ${a ? Object.assign({}, a).ic_company_name : `client #${accountId}`}`);
        } else empty.push(e.holder);
        continue;
      }
      throw e;
    }
    await refreshPdf(row.id);
    const fresh = getKeyForm(row.id);
    created.push(serializeForm(fresh));
    logAudit(req, 'key_form_generated', null, null, {
      form_id: row.id, form_no: row.form_no, holder: h.name,
      event_type: eventType, total_keys: row.total_keys, clients: row.clients_covered,
      no_email: !!row.no_email,
    });
  }
  // Nothing could be generated at all — the whole request was holders with no
  // keys. That is a refusal, not an empty success.
  if (!created.length && empty.length) {
    return res.status(409).json({
      error: empty.length === 1
        ? `${empty[0]} has no keys on record; generate a return receipt instead.`
        : `No keys on record for ${empty.join(', ')}; generate a return receipt instead.`,
      code: 'NO_KEYS_ON_RECORD',
      skipped: empty,
    });
  }
  res.status(201).json({
    forms: created,
    count: created.length,
    // Named, so a partial run never looks like it covered everyone asked for.
    skipped: empty,
  });
});

/** Shared send path — used by the single, bulk and auto-send callers. */
export async function deliverKeyForm(
  req: AuthRequest, id: number, customTo?: string | null,
): Promise<{ ok: boolean; recipients: string[]; error?: string | null; form: any }> {
  // A person sending this by hand is the "manual attention" the renewal cap
  // asks for. If the link is dead, revive it first — an email must never carry
  // a link that fails on open.
  reviveLinkForManualSend(id, req.manager?.name ?? 'System');
  let row = getKeyForm(id);
  if (!row) return { ok: false, recipients: [], error: 'Form not found', form: null };

  if (!row.pdf_path || !fs.existsSync(row.pdf_path)) {
    await refreshPdf(id);
    row = getKeyForm(id);
  }
  const scope = parseScope(row);

  // Holder + Cara + any custom audit address. A form with no holder email can
  // still be routed somewhere by naming an address explicitly.
  const custom = cleanText(customTo);
  const recipients = [
    cleanText(row.holder_email),
    ...notifyAddresses(),
    ...(custom && isEmail(custom) ? [custom] : []),
  ].filter(Boolean);

  const mail = await sendKeyForm({
    formNo: row.form_no ?? `KF-${row.id}`,
    eventLabel: FORM_EVENT_LABEL[row.event_type as FormEventType] ?? row.event_type,
    holder: row.holder_name,
    holderRole: row.holder_role,
    clients: row.clients_covered,
    totalKeys: row.total_keys,
    lines: scope.lines,
    signLink: row.token ? keyFormLinkFor(row.token) : null,
    signed: !!row.signed_at,
    totalLabel: docTotalLabelFor(row).toLowerCase().replace(/^./, (c) => c.toUpperCase()),
    pdf: row.pdf_path && fs.existsSync(row.pdf_path)
      ? { filename: path.basename(row.pdf_path), content: fs.readFileSync(row.pdf_path) }
      : null,
    recipients,
  });

  markSent(id, mail.recipients, mail.ok, mail.error);

  logAudit(req, mail.ok ? 'key_form_sent' : 'key_form_send_failed', null, null, {
    form_id: id, form_no: row.form_no, holder: row.holder_name,
    recipients: mail.recipients, custom_recipient: custom || undefined,
    sent_by: req.manager?.name ?? 'System', at: new Date().toISOString(),
    error: mail.error, attempts: mail.attempts,
  });

  return { ok: mail.ok, recipients: mail.recipients, error: mail.error, form: serializeForm(getKeyForm(id)) };
}

// ── POST /api/key-forms/:id/send — send or resend ────────────────────────────
// ── POST /api/key-forms/:id/regenerate ───────────────────────────────────────
// Produce a fresh form for the same holder at the CURRENT position, and mark
// the original superseded.
//
// The original is never deleted or edited. It may already have been emailed or
// signed, and a document somebody attested to is evidence — the fix for a
// stale one is a new one that says so, linked in both directions, not a quiet
// rewrite of the old.
router.post('/:id(\\d+)/regenerate', requireAuth, async (req: AuthRequest, res: Response) => {
  const id = Number(req.params.id);
  const old = getKeyForm(id);
  if (!old) return res.status(404).json({ error: 'Form not found' });

  // A signature is the strongest record there is. Superseding the document it
  // attaches to would destroy it, so this refuses rather than deciding for you.
  if (old.signed_at || old.status === 'signed') {
    return res.status(409).json({
      error: 'This form is signed. Generate a new form for the holder instead — '
        + 'superseding a signed document would replace the evidence of that signature.',
      code: 'FORM_SIGNED',
    });
  }
  if (old.status === 'superseded' || old.superseded_by) {
    return res.status(409).json({
      error: `Already superseded by form #${old.superseded_by}.`,
      code: 'ALREADY_SUPERSEDED',
    });
  }
  if (old.status === 'voided') {
    return res.status(409).json({ error: 'This form is voided.', code: 'FORM_VOIDED' });
  }

  const actor = req.manager?.name ?? 'System';
  // The kind is RE-DERIVED, not copied from the row being replaced.
  //
  // Copying it would make regenerate useless for the case it exists to fix: a
  // form whose stored kind is wrong would rebuild wrong forever. The truth is
  // on the custody record — a check-in with origin='reconciled' closed nothing,
  // so it is a HOLDINGS statement ("these keys are in my possession"), and only
  // a check-in that actually closed a check-out is a return receipt.
  const kind = rederiveDocKind(old);

  // A RECEIPT is rebuilt from the custody record it was written for, not from
  // the holder's current position: what came back on that day is a historical
  // fact and does not change because the world moved on. This is also what
  // repairs the forms written before receipts existed — a check-in form that
  // stored the post-return snapshot (and so read "holds no keys") regenerates
  // into the receipt it should always have been.
  let receiptLines: any[] | undefined;
  // What the NEW form covers. Regenerating is how an old full-snapshot event
  // form becomes the transaction form it would be today; an Audit keeps the
  // coverage it was generated with.
  let coverage: 'transaction' | 'full' | 'client' = 'transaction';
  let clientAccountId: number | null = null;
  if (old.event_type === 'audit') {
    coverage = formCoverageOf(old) === 'client' ? 'client' : 'full';
    if (coverage === 'client') {
      const c = db.prepare('SELECT account_id FROM form_clients WHERE form_id = ? LIMIT 1').get(id) as any;
      clientAccountId = c ? Number(Object.assign({}, c).account_id) : null;
    }
  } else if (old.event_type === 'reassignment') {
    coverage = 'full';
  } else if (kind === 'holdings' && (old.event_type === 'checkout' || old.event_type === 'transfer')) {
    receiptLines = receiptLinesFromSource(
      old,
      old.event_type === 'checkout' ? 'Issued in this transaction'
        : `Received from ${old.counterparty_name ?? 'the previous holder'}`,
    );
    // An accounts-only transfer moved no keys; it keeps its full statement.
    if (!receiptLines.length) {
      if (old.event_type === 'transfer') { coverage = 'full'; receiptLines = undefined; }
      else {
        return res.status(409).json({
          error: `${old.form_no} cannot be rebuilt — the custody record it was generated from is `
            + 'no longer available, so the keys it covered cannot be established.',
          code: 'RECEIPT_SOURCE_MISSING',
        });
      }
    }
  }
  // A reconciled check-in states what the holder HAS, but it still lists the
  // keys that were recorded rather than a fresh snapshot — the record is of
  // that moment. Same source, different assertion.
  if (kind === 'holdings' && old.event_type === 'checkin') {
    receiptLines = receiptLinesFromSource(old, 'Recorded as held');
    if (!receiptLines.length) {
      return res.status(409).json({
        error: `${old.form_no} cannot be rebuilt — the custody record it was generated from is `
          + 'no longer available, so the keys it covered cannot be established.',
        code: 'RECEIPT_SOURCE_MISSING',
      });
    }
  }
  if (kind === 'return_receipt') {
    receiptLines = receiptLinesFromSource(old);
    if (!receiptLines.length) {
      return res.status(409).json({
        error: `${old.form_no} cannot be rebuilt as a return receipt — the custody record `
          + 'it was generated from is no longer available, so the keys it covered cannot be '
          + 'established. Record the return again to produce a fresh receipt.',
        code: 'RECEIPT_SOURCE_MISSING',
      });
    }
  }

  // Fresh, from the database — never from the old form's stored scope.
  let fresh: any;
  try {
    fresh = createKeyForm({
      eventType: old.event_type as FormEventType,
      holderName: old.holder_name,
      holderType: (old.holder_type as 'employee' | 'ic') ?? 'employee',
      holderEmail: old.holder_email ?? null,
      holderId: old.holder_id ?? null,
      docKind: kind,
      lines: receiptLines,
      coverage,
      clientAccountId,
      eventNote: old.event_type === 'audit' ? null : `Regenerated from ${old.form_no}`,
      // Carried through so a rebuilt transfer receipt keeps naming the person
      // the keys went to — which is what makes it a transfer and not a return.
      generatedBy: actor,
      sourceKind: old.source_kind ?? null,
      sourceRef: old.source_ref ?? null,
      counterpartyName: old.counterparty_name ?? null,
      supersedes: id,
    });
  } catch (e) {
    // The holder has returned everything since this form was made. Refusing
    // leaves the original standing rather than replacing a real statement of
    // holdings with a blank one.
    if (e instanceof EmptyHoldingsError) {
      return res.status(409).json({
        error: `${old.holder_name} has no keys on record; generate a return receipt instead. `
          + `${old.form_no} is left as it stands.`,
        code: 'NO_KEYS_ON_RECORD',
      });
    }
    throw e;
  }
  await refreshPdf(fresh.id);

  db.prepare(`
    UPDATE key_form_docs
       SET status_before_void = COALESCE(status_before_void, status),
           status = 'superseded', superseded_by = ?, superseded_at = ?
     WHERE id = ?
  `).run(fresh.id, new Date().toISOString(), id);

  const after = getKeyForm(fresh.id);
  logAudit(req, 'key_form_regenerated', null, null, {
    superseded_form_id: id, superseded_form_no: old.form_no,
    new_form_id: fresh.id, new_form_no: fresh.form_no,
    holder: old.holder_name,
    // The numbers that changed are the whole reason to regenerate.
    was_total_keys: old.total_keys, now_total_keys: after.total_keys,
    was_clients: old.clients_covered, now_clients: after.clients_covered,
    was_data_version: old.data_version ?? null, now_data_version: after.data_version ?? null,
    by: actor,
  });

  res.status(201).json({
    form: serializeForm(after),
    superseded: serializeForm(getKeyForm(id)),
  });
});

router.post('/:id(\\d+)/send', requireAuth, async (req: AuthRequest, res: Response) => {
  const id = Number(req.params.id);
  if (!getKeyForm(id)) return res.status(404).json({ error: 'Form not found' });
  const to = cleanText(req.body?.to);
  if (to && !isEmail(to)) return res.status(400).json({ error: `"${to}" is not a valid email address` });
  const r = await deliverKeyForm(req, id, to || null);
  res.json({ ok: r.ok, recipients: r.recipients, error: r.error, form: r.form });
});

// ── POST /api/key-forms/bulk-send ────────────────────────────────────────────
router.post('/bulk-send', requireAuth, async (req: AuthRequest, res: Response) => {
  const ids: number[] = Array.isArray(req.body?.ids)
    ? (req.body.ids as any[]).map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0)
    : [];
  if (!ids.length) return res.status(400).json({ error: 'No forms selected' });
  if (ids.length > 200) return res.status(400).json({ error: 'Too many forms at once (max 200)' });
  const to = cleanText(req.body?.to);
  if (to && !isEmail(to)) return res.status(400).json({ error: `"${to}" is not a valid email address` });

  const results: { id: number; ok: boolean; recipients: string[]; error?: string | null }[] = [];
  for (const id of [...new Set(ids)]) {
    if (!getKeyForm(id)) { results.push({ id, ok: false, recipients: [], error: 'Not found' }); continue; }
    const r = await deliverKeyForm(req, id, to || null);
    results.push({ id, ok: r.ok, recipients: r.recipients, error: r.error });
  }
  const sent = results.filter((r) => r.ok).length;
  logAudit(req, 'key_forms_bulk_sent', null, null, {
    requested: ids.length, sent, failed: results.length - sent,
    custom_recipient: to || undefined, sent_by: req.manager?.name ?? 'System',
  });
  res.json({ sent, failed: results.length - sent, results });
});

// ── POST /api/key-forms/retry-failed ─────────────────────────────────────────
// Replays every form whose last send failed. Built for the case this exists
// for: mail was misconfigured, a batch of forms queued up behind it, and the
// config has now been fixed. Oldest first, so the queue drains in order.
router.post('/retry-failed', requireAuth, async (req: AuthRequest, res: Response) => {
  const ids = failedSendIds(200);
  if (!ids.length) {
    return res.json({
      queued: 0, attempted: 0, sent: 0, failed: 0,
      stopped_early: false, results: [], remaining: 0,
    });
  }

  const results: { id: number; form_no: string | null; ok: boolean; error?: string | null }[] = [];
  // Stop at the first rejection. These forms are queued precisely BECAUSE mail
  // was misconfigured; if it still is, grinding through the whole backlog with
  // per-form retries would take many minutes to report the same error the
  // first attempt already gave. One failure is the answer.
  let abortedAfter: number | null = null;
  for (const id of ids) {
    const row = getKeyForm(id);
    if (!row) { results.push({ id, form_no: null, ok: false, error: 'Not found' }); continue; }
    const r = await deliverKeyForm(req, id, null);
    results.push({ id, form_no: row.form_no ?? `KF-${id}`, ok: r.ok, error: r.error });
    if (!r.ok) { abortedAfter = results.length; break; }
  }
  const sent = results.filter((r) => r.ok).length;
  logAudit(req, 'key_forms_retry_failed', null, null, {
    queued: ids.length, attempted: results.length, sent, failed: results.length - sent,
    stopped_early: abortedAfter !== null,
    // The first remaining error is what the operator needs to see next.
    first_error: results.find((r) => !r.ok)?.error ?? null,
    retried_by: req.manager?.name ?? 'System',
  });
  res.json({
    queued: ids.length,
    attempted: results.length,
    sent,
    failed: results.length - sent,
    stopped_early: abortedAfter !== null,
    results,
    remaining: failedSendCount(),
  });
});

// ── Corrections on key forms ─────────────────────────────────────────────────
const FORM_CORRECTION_DENIED = 'Delete access required — contact Cara Angeloni';
function requireDelete(req: AuthRequest, res: Response): boolean {
  if (!req.manager?.can_delete) { res.status(403).json({ error: FORM_CORRECTION_DENIED }); return false; }
  return true;
}

router.post('/:id(\\d+)/void', requireAuth, (req: AuthRequest, res: Response) => {
  if (!requireDelete(req, res)) return;
  const check = checkReason(req.body?.reason);
  if (!check.ok) {
    return res.status(400).json({ error: check.error, code: 'REASON_REQUIRED', min_length: MIN_REASON_LENGTH });
  }
  const id = Number(req.params.id);
  const row = getKeyForm(id);
  if (!row) return res.status(404).json({ error: 'Form not found' });
  const out = voidKeyForm(id, check.reason, req.manager?.name ?? 'System');
  if (!out) return res.status(409).json({ error: 'This form is already voided.', code: 'ALREADY_VOIDED' });

  logAudit(req, 'key_form_voided', null, null, {
    form_id: id, form_no: row.form_no, holder: row.holder_name,
    previous_status: out.previous_status, reason: check.reason,
    voided_by: req.manager?.name ?? 'System',
  });
  res.json({ ok: true, form: serializeForm(getKeyForm(id)), reason: check.reason });
});

router.post('/:id(\\d+)/acknowledge', requireAuth, (req: AuthRequest, res: Response) => {
  if (!requireDelete(req, res)) return;
  const check = checkReason(req.body?.reason);
  if (!check.ok) {
    return res.status(400).json({ error: check.error, code: 'REASON_REQUIRED', min_length: MIN_REASON_LENGTH });
  }
  const id = Number(req.params.id);
  const row = getKeyForm(id);
  if (!row) return res.status(404).json({ error: 'Form not found' });
  const out = acknowledgeKeyForm(id, check.reason, req.manager?.name ?? 'System');
  if (out && 'refused' in out) return res.status(409).json({ error: out.refused });
  if (!out) return res.status(409).json({ error: 'This form is already acknowledged.' });

  logAudit(req, 'key_form_acknowledged_unsigned', null, null, {
    form_id: id, form_no: row.form_no, holder: row.holder_name,
    previous_status: out.previous_status, reason: check.reason,
    acknowledged_by: req.manager?.name ?? 'System',
    signature_collected: false,
  });
  res.json({ ok: true, form: serializeForm(getKeyForm(id)), reason: check.reason });
});

// ── POST /api/key-forms/bulk-correct ────────────────────────────────────────
router.post('/bulk-correct', requireAuth, (req: AuthRequest, res: Response) => {
  if (!requireDelete(req, res)) return;
  const action = req.body?.action === 'acknowledge' ? 'acknowledge' : 'void';
  const check = checkReason(req.body?.reason);
  if (!check.ok) {
    return res.status(400).json({ error: check.error, code: 'REASON_REQUIRED', min_length: MIN_REASON_LENGTH });
  }
  const ids: number[] = Array.isArray(req.body?.ids)
    ? (req.body.ids as any[]).map(Number).filter((n) => Number.isInteger(n) && n > 0)
    : [];
  if (!ids.length) return res.status(400).json({ error: 'No forms selected' });
  if (ids.length > 200) return res.status(400).json({ error: 'Too many forms at once (max 200)' });

  const actor = req.manager?.name ?? 'System';
  const applied: number[] = [];
  const skipped: { id: number; why: string }[] = [];
  for (const id of [...new Set(ids)]) {
    const row = getKeyForm(id);
    if (!row) { skipped.push({ id, why: 'not found' }); continue; }
    const out = action === 'void'
      ? voidKeyForm(id, check.reason, actor)
      : acknowledgeKeyForm(id, check.reason, actor);
    if (!out || 'refused' in out) {
      skipped.push({ id, why: out && 'refused' in out ? out.refused : 'already applied' });
      continue;
    }
    applied.push(id);
    logAudit(req, action === 'void' ? 'key_form_voided' : 'key_form_acknowledged_unsigned', null, null, {
      form_id: id, form_no: row.form_no, holder: row.holder_name,
      reason: check.reason, by: actor, bulk: true,
      ...(action === 'acknowledge' ? { signature_collected: false } : {}),
    });
  }
  res.json({ ok: true, action, applied: applied.length, skipped, ids: applied });
});

// ── PUBLIC: GET /api/key-forms/token/:token — the signature page ─────────────
router.get('/token/:token', (req: Request, res: Response) => {
  const row = getKeyFormByToken(req.params.token);
  if (!row) return res.status(404).json({ error: 'Invalid or expired link' });
  if (!row.token_expires_at || new Date(String(row.token_expires_at).replace(' ', 'T')) < new Date()) {
    return res.status(410).json({ error: 'This link has expired. Please contact City Wide Boston for a new one.' });
  }
  const scope = parseScope(row);
  res.json({
    form_no: row.form_no,
    event_type: row.event_type,
    event_label: FORM_EVENT_LABEL[row.event_type as FormEventType] ?? row.event_type,
    holder: row.holder_name,
    holder_role: row.holder_role,
    holder_email: row.holder_email,
    clients: scope.lines,
    event_note: scope.event_note,
    total_keys: row.total_keys,
    clients_covered: row.clients_covered,
    // What the signer is being asked to attest to. Resolved server-side so the
    // page never infers the document kind from the event name.
    doc_kind: docKindOf(row),
    doc_title: docTitleFor(row),
    table_heading: docTableHeadingFor(row),
    total_label: docTotalLabelFor(row),
    // What the form covers and what the signer attests to — decided once,
    // server-side, so the page never re-derives the wording.
    form_coverage: formCoverageOf(row),
    ack_variant: ackVariantOf(row),
    // Set on a transfer receipt: the person the keys went to.
    counterparty_name: row.counterparty_name ?? null,
    returned_keys: row.returned_keys ?? 0,
    generated_at: row.created_at,
    generated_by: row.generated_by,
    signed_at: row.signed_at,
  });
});

// ── PUBLIC: POST /api/key-forms/token/:token/sign ────────────────────────────
router.post('/token/:token/sign', async (req: Request, res: Response) => {
  const row = getKeyFormByToken(req.params.token);
  if (!row) return res.status(404).json({ error: 'Invalid or expired link' });
  if (!row.token_expires_at || new Date(String(row.token_expires_at).replace(' ', 'T')) < new Date()) {
    return res.status(410).json({ error: 'This link has expired. Please contact City Wide Boston for a new one.' });
  }
  if (row.signed_at) return res.status(409).json({ error: 'This form has already been signed' });

  const signature_data = typeof req.body?.signature_data === 'string' ? req.body.signature_data : '';
  if (!signature_data.startsWith('data:image/png;base64,')) {
    return res.status(400).json({ error: 'A signature is required' });
  }
  const typed_name = typeof req.body?.typed_name === 'string' ? req.body.typed_name.trim() : '';
  if (!typed_name) return res.status(400).json({ error: 'Please type your full name to confirm' });
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  if (norm(typed_name) !== norm(row.holder_name)) {
    return res.status(400).json({ error: `Please type the name this form is recorded against: ${row.holder_name}` });
  }

  const signedAt = new Date().toISOString();
  const hash = hashSignature(signature_data);
  // One transaction: this form AND every custody record it stands for (the
  // registry row(s), and any other form of the same event) become Signed
  // together, or nothing does.
  let synced = { forms: [] as number[], slots: [] as { assignmentId: number; slot: 'checkout' | 'checkin' }[] };
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`
      UPDATE key_form_docs
         SET signed_at = ?, signature_data = ?, signature_hash = ?, signature_typed_name = ?,
             status = 'signed', token = NULL
       WHERE id = ?
    `).run(signedAt, signature_data, hash, typed_name, row.id);
    synced = propagateSignature({ formId: row.id }, {
      signed_at: signedAt, signature_data, signature_hash: hash, typed_name, pdf_path: null,
    });
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* */ }
    throw e;
  }

  // Regenerate so the stored PDF carries the signature.
  await refreshPdf(row.id);
  await refreshFormPdfs(synced.forms.filter((f) => f !== row.id));
  const signed = getKeyForm(row.id);
  // The custody rows it closed point at this signed document as their receipt.
  for (const sl of synced.slots) {
    db.prepare(sl.slot === 'checkout'
      ? 'UPDATE key_assignments SET pdf_path = COALESCE(pdf_path, ?) WHERE id = ?'
      : 'UPDATE key_assignments SET checkin_pdf_path = COALESCE(checkin_pdf_path, ?) WHERE id = ?',
    ).run(signed.pdf_path ?? null, sl.assignmentId);
  }
  const scope = parseScope(signed);

  // Back to the signer, Cara, and anywhere this form was routed during an audit.
  let priorSends: string[] = [];
  try { priorSends = JSON.parse(signed.sent_to || '[]'); } catch { priorSends = []; }
  const recipients = [
    cleanText(signed.holder_email), ...notifyAddresses(), ...priorSends,
  ].filter(Boolean);

  const mail = await sendKeyForm({
    formNo: signed.form_no, eventLabel: FORM_EVENT_LABEL[signed.event_type as FormEventType] ?? signed.event_type,
    holder: signed.holder_name, holderRole: signed.holder_role,
    clients: signed.clients_covered, totalKeys: signed.total_keys,
    lines: scope.lines, signLink: null, signed: true,
    pdf: signed.pdf_path && fs.existsSync(signed.pdf_path)
      ? { filename: path.basename(signed.pdf_path), content: fs.readFileSync(signed.pdf_path) }
      : null,
    recipients,
  });

  db.prepare('INSERT INTO audit_log (action, account_name, account_id, manager, metadata) VALUES (?, ?, ?, ?, ?)').run(
    'key_form_signed', null, null, signed.holder_name,
    JSON.stringify({
      form_id: signed.id, form_no: signed.form_no, holder: signed.holder_name,
      total_keys: signed.total_keys, clients: signed.clients_covered,
      hash: hash.slice(0, 16), typed_name,
      // The other records of this transaction closed by the same signature.
      synced_custody_records: synced.slots, synced_forms: synced.forms.filter((f) => f !== signed.id),
      receipt_recipients: mail.recipients, receipt_error: mail.error,
    }),
  );

  res.json({
    success: true, form_no: signed.form_no, signed_at: signedAt,
    receipt_email: { ok: mail.ok, recipients: mail.recipients, error: mail.error, cara: caraAddress() },
  });
});

export default router;
