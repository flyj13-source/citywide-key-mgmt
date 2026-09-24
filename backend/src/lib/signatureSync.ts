// ── One signature, every record of the transaction ───────────────────────────
// A custody event is written in two places: the custody row(s) in
// key_assignments (what the Checked In / Checked Out tabs and the dashboard's
// "Without Signature" read) and the Key Form in key_form_docs (what the Key
// Forms tab and its Expiring / Expired counts read). Each had its OWN signature
// link, and signing either one closed only its own record — so a holder who
// signed the receipt left the Key Form "Awaiting signature" forever, and one
// who signed the Key Form left the registry row unsigned.
//
// custody_sign_links names, explicitly, which custody row + which signature
// slot each form stands for. Every signing path — the custody sign-off page,
// the Key Form page, sign-in-person — calls propagateSignature() inside the
// same transaction as its own write, so one signature closes the whole
// transaction or nothing.
//
// A slot is WHICH signature on a custody row: 'checkout' (keys issued — the
// signed_at columns) or 'checkin' (keys returned / recorded — the
// checkin_signed_at columns). A transfer's giving side is a check-in slot, its
// receiving side a check-out slot.

import db from './db';
import { getSetting, setSetting } from './settings';

export type Slot = 'checkout' | 'checkin';
export interface SignatureValue {
  signed_at: string;
  signature_data: string;
  signature_hash: string;
  typed_name: string | null;
  pdf_path?: string | null;
}

const obj = (r: any) => (r ? Object.assign({}, r) : null);
const PENDING_FORM = "status IN ('draft', 'sent', 'unsigned')";

/** Record that `formId` is the document for these custody rows' signature slots. */
export function linkFormToCustody(formId: number, links: { assignmentId: number; slot: Slot }[]): void {
  const ins = db.prepare('INSERT OR IGNORE INTO custody_sign_links (form_id, assignment_id, slot) VALUES (?, ?, ?)');
  for (const l of links) if (formId && l.assignmentId) ins.run(formId, l.assignmentId, l.slot);
}

/**
 * Every form and every (custody row, slot) that represents the same
 * transaction as the starting point. Walks the links both ways, so a return
 * that spanned three open records — one form, three rows — closes all three
 * whichever link was used.
 */
export function transactionGroup(start: { formId: number } | { assignmentId: number; slot: Slot }): {
  forms: number[]; slots: { assignmentId: number; slot: Slot }[];
} {
  const forms = new Set<number>();
  const slots = new Map<string, { assignmentId: number; slot: Slot }>();
  const qForm = db.prepare('SELECT assignment_id, slot FROM custody_sign_links WHERE form_id = ?');
  const qSlot = db.prepare('SELECT form_id FROM custody_sign_links WHERE assignment_id = ? AND slot = ?');
  const formQueue: number[] = [];
  const slotQueue: { assignmentId: number; slot: Slot }[] = [];
  if ('formId' in start) formQueue.push(start.formId);
  else slotQueue.push(start);
  while (formQueue.length || slotQueue.length) {
    const f = formQueue.pop();
    if (f != null && !forms.has(f)) {
      forms.add(f);
      for (const r of (qForm.all(f) as any[]).map(obj)) slotQueue.push({ assignmentId: Number(r.assignment_id), slot: r.slot });
    }
    const s = slotQueue.pop();
    if (s) {
      const k = `${s.assignmentId}:${s.slot}`;
      if (!slots.has(k)) {
        slots.set(k, s);
        for (const r of (qSlot.all(s.assignmentId, s.slot) as any[]).map(obj)) formQueue.push(Number(r.form_id));
      }
    }
  }
  return { forms: [...forms], slots: [...slots.values()] };
}

/**
 * Write one signature onto every record of the transaction that does not
 * already carry one. Call INSIDE the transaction that writes the originating
 * record. Returns what it touched, so callers can refresh form PDFs and audit.
 *
 * Only unsigned records are written: an existing signature is never replaced,
 * and a voided or superseded form is left as the correction it is.
 */
export function propagateSignature(
  start: { formId: number } | { assignmentId: number; slot: Slot },
  sig: SignatureValue,
): { forms: number[]; slots: { assignmentId: number; slot: Slot }[] } {
  const group = transactionGroup(start);
  const touchedForms: number[] = [];
  const touchedSlots: { assignmentId: number; slot: Slot }[] = [];

  const signForm = db.prepare(`
    UPDATE key_form_docs
       SET signed_at = ?, signature_data = ?, signature_hash = ?,
           signature_typed_name = COALESCE(signature_typed_name, ?),
           status = 'signed', token = NULL
     WHERE id = ? AND signed_at IS NULL AND ${PENDING_FORM}
  `);
  for (const f of group.forms) {
    if (Number(signForm.run(sig.signed_at, sig.signature_data, sig.signature_hash, sig.typed_name, f).changes)) {
      touchedForms.push(f);
    }
  }

  const signOut = db.prepare(`
    UPDATE key_assignments
       SET signed_at = ?, signature_data = ?, signature_hash = ?,
           signature_typed_name = COALESCE(signature_typed_name, ?),
           pdf_path = COALESCE(pdf_path, ?), signoff_token = NULL, signature_status = 'signed'
     WHERE id = ? AND signed_at IS NULL
  `);
  // A check-in signature settles signature_status only where that row expects
  // no other signature — a first-time record. On a genuine return the status
  // still describes the CHECK-OUT signature, which this does not supply.
  const signIn = db.prepare(`
    UPDATE key_assignments
       SET checkin_signed_at = ?, checkin_signature_data = ?, checkin_signature_hash = ?,
           checkin_signature_typed_name = COALESCE(checkin_signature_typed_name, ?),
           checkin_pdf_path = COALESCE(checkin_pdf_path, ?), checkin_signoff_token = NULL,
           signature_status = CASE WHEN origin = 'reconciled' THEN 'signed' ELSE signature_status END
     WHERE id = ? AND checkin_signed_at IS NULL
  `);
  for (const s of group.slots) {
    const stmt = s.slot === 'checkout' ? signOut : signIn;
    if (Number(stmt.run(sig.signed_at, sig.signature_data, sig.signature_hash, sig.typed_name,
      sig.pdf_path ?? null, s.assignmentId).changes)) {
      touchedSlots.push(s);
    }
  }
  return { forms: touchedForms, slots: touchedSlots };
}

/**
 * Rebuild the stored PDF of forms that were just signed through another link,
 * so the document on file carries the signature. Never throws: the signature
 * is the record, the PDF can always be regenerated on view.
 */
export async function refreshFormPdfs(formIds: number[]): Promise<void> {
  if (!formIds.length) return;
  const { generateKeyFormPdf } = await import('./keyFormPdf');
  for (const id of formIds) {
    try {
      const row = obj(db.prepare('SELECT * FROM key_form_docs WHERE id = ?').get(id));
      if (!row) continue;
      const p = await generateKeyFormPdf(row);
      db.prepare('UPDATE key_form_docs SET pdf_path = ? WHERE id = ?').run(p, id);
    } catch (e) {
      console.error('[signature-sync] PDF refresh failed for form', id, (e as Error).message);
    }
  }
}

/** The last backfill that repaired anything — for /api/_diag. */
export function signatureBackfillState(): any | null {
  try { return JSON.parse(getSetting('signature_backfill_last') ?? 'null'); } catch { return null; }
}

// ── Links for forms written before the table existed ─────────────────────────
// Derived from what each form already recorded about its source:
//   assignment forms → that row; the slot follows the event (check-out issues,
//                      check-in returns / records)
//   transfer forms   → the giving side's rows (check-in slot) for the receipt,
//                      the receiving row (check-out slot) for the other form
export function backfillSignLinks(): number {
  const forms = (db.prepare(`
    SELECT id, event_type, source_kind, source_ref, doc_kind, holder_name FROM key_form_docs
     WHERE source_ref IS NOT NULL AND source_kind IN ('assignment', 'transfer')
       AND id NOT IN (SELECT form_id FROM custody_sign_links)
  `).all() as any[]).map(obj);
  let n = 0;
  const ins = db.prepare('INSERT OR IGNORE INTO custody_sign_links (form_id, assignment_id, slot) VALUES (?, ?, ?)');
  for (const f of forms) {
    if (f.source_kind === 'assignment') {
      const id = Number(f.source_ref);
      if (!Number.isInteger(id) || !obj(db.prepare('SELECT id FROM key_assignments WHERE id = ?').get(id))) continue;
      const slot: Slot = f.event_type === 'checkout' ? 'checkout' : 'checkin';
      n += Number(ins.run(f.id, id, slot).changes);
    } else {
      const giving = f.doc_kind === 'return_receipt';
      const rows = (db.prepare(
        'SELECT id FROM key_assignments WHERE transfer_id = ? AND transfer_role = ?'
      ).all(String(f.source_ref), giving ? 'from' : 'to') as any[]).map(obj);
      for (const r of rows) n += Number(ins.run(f.id, r.id, giving ? 'checkin' : 'checkout').changes);
    }
  }
  return n;
}

export interface SignatureBackfillItem {
  record: 'key_form' | 'custody';
  id: number;
  label: string;
  slot?: Slot;
  signed_at: string;
  signed_via: string;
}

/**
 * Repair the drift already in the database: any transaction where one record
 * carries a stored signature (image + SHA-256 hash) and a linked record does
 * not. The original signed_at is copied, nothing is re-sent, and each repaired
 * record is audited 'signature_status_backfilled'. Idempotent — a second run
 * finds nothing to do.
 */
export function backfillSignatures(): { links_added: number; fixed: SignatureBackfillItem[] } {
  const fixed: SignatureBackfillItem[] = [];
  let linksAdded = 0;
  const audit = db.prepare(
    'INSERT INTO audit_log (action, account_name, account_id, manager, metadata) VALUES (?, ?, ?, ?, ?)'
  );
  db.exec('BEGIN IMMEDIATE');
  try {
    linksAdded = backfillSignLinks();

    const describe = (formIds: number[], slots: { assignmentId: number; slot: Slot }[], signedAt: string, via: string) => {
      for (const id of formIds) {
        const f = obj(db.prepare('SELECT form_no, holder_name FROM key_form_docs WHERE id = ?').get(id));
        const item: SignatureBackfillItem = {
          record: 'key_form', id, label: `${f?.form_no ?? `form #${id}`} — ${f?.holder_name ?? ''}`,
          signed_at: signedAt, signed_via: via,
        };
        fixed.push(item);
        audit.run('signature_status_backfilled', null, null, 'System', JSON.stringify(item));
      }
      for (const s of slots) {
        const a = obj(db.prepare('SELECT assignee, account_name, account_id FROM key_assignments WHERE id = ?').get(s.assignmentId));
        const item: SignatureBackfillItem = {
          record: 'custody', id: s.assignmentId, slot: s.slot,
          label: `${a?.assignee ?? ''} — ${a?.account_name ?? ''} (${s.slot === 'checkout' ? 'check-in signature' : 'check-out signature'})`,
          signed_at: signedAt, signed_via: via,
        };
        fixed.push(item);
        audit.run('signature_status_backfilled', a?.account_name ?? null, a?.account_id ?? null, 'System', JSON.stringify(item));
      }
    };

    // Signed Key Forms → their custody rows.
    const signedForms = (db.prepare(`
      SELECT id, form_no, signed_at, signature_data, signature_hash, signature_typed_name, pdf_path
        FROM key_form_docs
       WHERE signed_at IS NOT NULL AND signature_data IS NOT NULL AND signature_hash IS NOT NULL
         AND id IN (SELECT form_id FROM custody_sign_links)
    `).all() as any[]).map(obj);
    for (const f of signedForms) {
      const t = propagateSignature({ formId: f.id }, {
        signed_at: f.signed_at, signature_data: f.signature_data, signature_hash: f.signature_hash,
        typed_name: f.signature_typed_name ?? null, pdf_path: null,
      });
      describe(t.forms, t.slots, f.signed_at, `Key Form ${f.form_no}`);
    }

    // Signed custody slots → their forms (and any sibling rows).
    const signedSlots = (db.prepare(`
      SELECT l.assignment_id, l.slot,
             CASE l.slot WHEN 'checkout' THEN ka.signed_at ELSE ka.checkin_signed_at END AS at,
             CASE l.slot WHEN 'checkout' THEN ka.signature_data ELSE ka.checkin_signature_data END AS data,
             CASE l.slot WHEN 'checkout' THEN ka.signature_hash ELSE ka.checkin_signature_hash END AS hash,
             CASE l.slot WHEN 'checkout' THEN ka.signature_typed_name ELSE ka.checkin_signature_typed_name END AS typed
        FROM custody_sign_links l JOIN key_assignments ka ON ka.id = l.assignment_id
    `).all() as any[]).map(obj).filter((r) => r.at && r.data && r.hash);
    for (const s of signedSlots) {
      const t = propagateSignature({ assignmentId: Number(s.assignment_id), slot: s.slot }, {
        signed_at: s.at, signature_data: s.data, signature_hash: s.hash, typed_name: s.typed ?? null, pdf_path: null,
      });
      describe(t.forms, t.slots, s.at, `custody record #${s.assignment_id}`);
    }

    // A first-time record signed on its check-in slot before check-in
    // signatures updated signature_status.
    const stale = (db.prepare(`
      SELECT id, assignee, account_name, account_id, checkin_signed_at FROM key_assignments
       WHERE origin = 'reconciled' AND checkin_signed_at IS NOT NULL
         AND checkin_signature_data IS NOT NULL AND checkin_signature_hash IS NOT NULL
         AND COALESCE(signature_status, '') <> 'signed'
    `).all() as any[]).map(obj);
    for (const r of stale) {
      db.prepare("UPDATE key_assignments SET signature_status = 'signed' WHERE id = ?").run(r.id);
      const item: SignatureBackfillItem = {
        record: 'custody', id: r.id, slot: 'checkin',
        label: `${r.assignee} — ${r.account_name} (status only)`,
        signed_at: r.checkin_signed_at, signed_via: 'its own check-in signature',
      };
      fixed.push(item);
      audit.run('signature_status_backfilled', r.account_name, r.account_id, 'System', JSON.stringify(item));
    }

    if (fixed.length) {
      setSetting('signature_backfill_last', JSON.stringify({
        ran_at: new Date().toISOString(), count: fixed.length, links_added: linksAdded, fixed,
      }), 'System');
      audit.run('signature_backfill_summary', null, null, 'System', JSON.stringify({
        count: fixed.length, links_added: linksAdded, fixed, emailed: false,
      }));
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* */ }
    throw e;
  }
  return { links_added: linksAdded, fixed };
}
