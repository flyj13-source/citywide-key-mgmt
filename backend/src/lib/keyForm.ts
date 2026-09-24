// ── Key Forms ────────────────────────────────────────────────────────────────
// A Key Form is the auditable artifact: every key one person holds, by client
// and key type, at a moment in time. One is generated on every custody event
// and on demand for an audit.
//
// SECURITY: a Key Form never carries a door or alarm code. The snapshot holds
// client names, BC numbers, key types and counts — nothing else.

import crypto from 'crypto';
import db from './db';
import { KEY_TYPES, readKeyLines, type KeyLine } from './custody';
import {
  SIGNATURE_TTL_MS, MAX_AUTO_RENEWALS, linkStateOf, linkStateWhere, linkStateParams, type LinkState,
} from './signatureLink';

export type FormEventType = 'checkin' | 'checkout' | 'transfer' | 'reassignment' | 'audit';
export type FormStatus =
  | 'draft' | 'sent' | 'signed' | 'unsigned'
  // Corrections. 'acknowledged_unsigned' is deliberately NOT 'signed': the
  // audit trail must never claim a signature that does not exist.
  | 'voided' | 'acknowledged_unsigned'
  // Replaced by a newer form. The row STAYS — it may already have been sent or
  // signed, and deleting the document somebody attested to would be worse than
  // any staleness it contains.
  | 'superseded';

export const FORM_EVENT_LABEL: Record<FormEventType, string> = {
  checkin: 'Check-out',
  checkout: 'Check-in',
  transfer: 'Transfer',
  reassignment: 'Reassignment',
  audit: 'Audit',
};

/** One client row on a form: the keys this person holds THERE. */
export interface FormLine {
  account_id: number | null;
  client: string;
  bc_client_number: string | null;
  metal: number;
  card: number;
  fob: number;
  dispenser: number;
  office: number;
  subtotal: number;
  /**
   * Where the numbers came from, kept SEPARATE rather than silently merged.
   *
   * A person's keys live in two independent places in this schema and nothing
   * keeps them in step:
   *   assigned    — the holder-grid cells on the client row (am_metal, ccm_*,
   *                 contractor_*): the standing attribution of who is
   *                 responsible for what at that site.
   *   checked_out — open key_assignments: keys transactionally issued to them.
   *
   * The form shows the sum, because both are keys in that person's possession.
   * But it also shows the split, so a key counted twice — attributed on the
   * grid AND checked out — is visible on the document instead of quietly
   * inflating a total somebody is about to sign.
   */
  assigned: number;
  checked_out: number;
  /** Which roles put them on this row: 'AM', 'CCM', 'IC', or a combination. */
  via?: string | null;
}

export interface FormScope {
  /**
   * The document's line items — whatever kind of document it is.
   *
   * On a HOLDINGS statement these are the holder's current position, queried
   * fresh. On a RETURN RECEIPT they are the keys that moved out of the
   * holder's hands in this transaction, and nothing else: the receipt is for
   * the handover, so the holder signs for what they gave back and for no
   * other claim about their position.
   */
  lines: FormLine[];
  /** Free text describing what the triggering event moved, if anything. */
  event_note?: string | null;
}

/**
 * What a form ASSERTS — the property that decides its title, its table
 * heading, its total label and what the signature means.
 *
 *   holdings        "I confirm I currently hold the following"
 *   return_receipt  "I confirm I have returned / transferred the keys above"
 */
export type DocKind = 'holdings' | 'return_receipt';

/**
 * The event → document mapping, in ONE place.
 *
 * Transfer is the reason this is a stored column rather than a function of
 * event_type: a single transfer produces BOTH kinds at once — a receipt for
 * the party handing keys over, a holdings statement for the party receiving
 * them. The kind is a property of the document, not of the event, so callers
 * that need to say which one pass `docKind` explicitly and this table is the
 * default for everything else.
 */
export const DOC_KIND_BY_EVENT: Record<FormEventType, DocKind> = {
  checkout: 'holdings',
  checkin: 'return_receipt',
  // Overridden per party at the call site: FROM gets a receipt, TO holdings.
  transfer: 'holdings',
  reassignment: 'holdings',
  audit: 'holdings',
};

export function docKindOf(row: { doc_kind?: string | null; event_type?: string } | null | undefined): DocKind {
  if (row?.doc_kind === 'return_receipt' || row?.doc_kind === 'holdings') return row.doc_kind;
  // Forms written before doc_kind existed: fall back to the event mapping so
  // an old check-in form still reads as the receipt it was always meant to be.
  return DOC_KIND_BY_EVENT[row?.event_type as FormEventType] ?? 'holdings';
}

/**
 * What a form COVERS, independent of what it asserts.
 *
 *   transaction  only the keys one custody event moved, at that one client
 *   full         every client the holder has keys at — the Audit statement
 *   client       an Audit statement for ONE chosen client
 *
 * Forms written before coverage was stored are inferred: a receipt only ever
 * listed what moved; a holdings statement was a full snapshot, except the
 * first-time record, which listed the keys it recorded.
 */
export type FormCoverage = 'transaction' | 'full' | 'client';

export function formCoverageOf(row: any): FormCoverage {
  const c = row?.form_coverage;
  if (c === 'transaction' || c === 'full' || c === 'client') return c;
  if (docKindOf(row) === 'return_receipt') return 'transaction';
  if (row?.event_type === 'checkin') return 'transaction';
  return 'full';
}

/**
 * Which acknowledgement a signer is asked to make. One place, so the PDF, the
 * signing page and the list can never word the same form differently.
 *
 *   received     "I have received the keys listed above" — an issue, or the
 *                receiving side of a transfer, listing only what was handed over
 *   held         "the keys listed above are in my possession" — an audit
 *                statement, or a first-time record of keys already held
 *   returned     a return receipt
 *   transferred  the giving side of a transfer
 */
export type AckVariant = 'received' | 'held' | 'returned' | 'transferred';

export function ackVariantOf(row: any): AckVariant {
  if (docKindOf(row) === 'return_receipt') {
    return row?.counterparty_name && String(row.counterparty_name).trim() ? 'transferred' : 'returned';
  }
  if (formCoverageOf(row) === 'transaction' && (row?.event_type === 'checkout' || row?.event_type === 'transfer')) {
    return 'received';
  }
  return 'held';
}

export function isReturnReceipt(row: { doc_kind?: string | null; event_type?: string } | null | undefined): boolean {
  return docKindOf(row) === 'return_receipt';
}

/**
 * Where the keys went decides the words, so the labels are resolved from the
 * row rather than looked up by kind alone.
 *
 * A receipt covers keys leaving the holder's hands, but there are two ways for
 * that to happen and they are not the same event. Handed back to City Wide is
 * a RETURN. Handed to a named person is a TRANSFER — the keys are still out,
 * with somebody else, and calling that "returned" tells the reader the
 * opposite of what happened. The counterparty is what distinguishes them, and
 * it is the same input the acknowledgement sentence already branches on.
 */
function receiptIsTransfer(row: { counterparty_name?: string | null } | null | undefined): boolean {
  return !!(row?.counterparty_name && String(row.counterparty_name).trim());
}

type LabelRow = { doc_kind?: string | null; event_type?: string; counterparty_name?: string | null };

export function docTitleFor(row: LabelRow): string {
  if (docKindOf(row) === 'holdings') return 'Key Form';
  return receiptIsTransfer(row) ? 'Key Transfer Receipt' : 'Key Return Receipt';
}

/** The heading over the line-item table. */
export function docTableHeadingFor(row: LabelRow): string {
  if (docKindOf(row) === 'holdings') return 'Keys held';
  return receiptIsTransfer(row) ? 'Keys transferred' : 'Keys returned';
}

/** The label on the footing total. */
export function docTotalLabelFor(row: LabelRow): string {
  // A transaction form lists ONE event's keys; calling that "keys held" would
  // read as the holder's whole position.
  if (formCoverageOf(row) === 'transaction') return 'TOTAL KEYS IN THIS TRANSACTION';
  if (docKindOf(row) === 'holdings') return 'TOTAL KEYS HELD';
  return receiptIsTransfer(row) ? 'TOTAL KEYS TRANSFERRED' : 'TOTAL KEYS RETURNED';
}

/**
 * Thrown when a form would be generated with nothing on it.
 *
 * Applies to BOTH kinds. A "currently holds" document listing zero keys has
 * nothing for the holder to attest to; so does a return receipt for no keys.
 * Signing either means signing a blank, so neither is ever built.
 */
export class EmptyHoldingsError extends Error {
  readonly code = 'NO_KEYS_ON_RECORD';
  constructor(public readonly holder: string, public readonly docKind: DocKind = 'holdings') {
    super(
      docKind === 'return_receipt'
        ? 'No keys on this return — there is nothing to sign for.'
        : 'No keys on record; generate a return receipt instead.',
    );
    this.name = 'EmptyHoldingsError';
  }
}

const TTL_MS = SIGNATURE_TTL_MS;
const cleanText = (v: any): string | null => {
  const s = v == null ? '' : String(v).trim();
  return s || null;
};

/** Turn key lines into the five per-type columns a form row carries. */
function tally(lines: KeyLine[]): Pick<FormLine, 'metal' | 'card' | 'fob' | 'dispenser' | 'office' | 'subtotal'> {
  const out = { metal: 0, card: 0, fob: 0, dispenser: 0, office: 0, subtotal: 0 };
  for (const l of lines) {
    const key = l.type as keyof typeof out;
    if (key in out && key !== 'subtotal') out[key] += l.qty;
    out.subtotal += l.qty;
  }
  return out;
}

/** A blank row for one client, ready to accumulate into. */
function blankLine(account_id: number | null, client: string, bc: string | null): FormLine {
  return {
    account_id, client, bc_client_number: bc,
    metal: 0, card: 0, fob: 0, dispenser: 0, office: 0,
    subtotal: 0, assigned: 0, checked_out: 0, via: null,
  };
}

const num = (v: any): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

/**
 * CURRENT STATE — every key this person holds right now, queried fresh.
 *
 * This is what makes a Key Form an audit document rather than a receipt: it
 * answers "what do they have?", not "what just moved?". So it is computed from
 * the database at the moment of generation and NEVER from anything the caller
 * hands in — a total supplied by a frontend is a total nobody recomputed.
 *
 * TWO SOURCES, because a person's keys live in two independent places:
 *
 *   1. THE HOLDER GRID on each client row. am_metal/am_card/… when they are
 *      that client's Account Manager, ccm_* when they are its CCM,
 *      contractor_* when they are its IC. This is the standing attribution the
 *      registry and the roster tabs report, and it was previously invisible to
 *      Key Forms entirely — an AM responsible for three keys got a form saying
 *      they held none.
 *
 *   2. OPEN CUSTODY RECORDS — keys transactionally checked out to them and not
 *      yet returned.
 *
 * Archived clients are excluded from both: a site that is no longer live must
 * not inflate what someone is said to be holding on a document they sign.
 * Voided records are excluded too — a voided record is not custody.
 */
export function snapshotHolder(holderName: string, holderType?: string | null): FormLine[] {
  const name = String(holderName ?? '').trim();
  if (!name) return [];

  const byClient = new Map<string, FormLine>();
  const lineFor = (id: number | null, client: string, bc: string | null): FormLine => {
    const key = String(id ?? client);
    let line = byClient.get(key);
    if (!line) { line = blankLine(id, client, bc); byClient.set(key, line); }
    return line;
  };
  const addVia = (line: FormLine, role: string) => {
    const parts = new Set((line.via ?? '').split(' + ').filter(Boolean));
    parts.add(role);
    line.via = [...parts].join(' + ');
  };

  // ── 1. The holder grid ─────────────────────────────────────────────────────
  // One query per role rather than a single OR: a person can be BOTH the AM
  // and the CCM of the same client, and each role carries its own cells.
  const gridRoles: { role: string; where: string; prefix: string; params: (n: string) => any[] }[] = [
    // Case-insensitive, matching roleScope.ts exactly. A form that resolved a
    // role differently from the check-in that produced it is the one way the
    // document and the transaction can disagree about what somebody holds.
    { role: 'AM', where: "LOWER(TRIM(COALESCE(account_manager,''))) = LOWER(TRIM(?))", prefix: 'am', params: (n) => [n] },
    { role: 'CCM', where: "LOWER(TRIM(COALESCE(ccm_manager,''))) = LOWER(TRIM(?))", prefix: 'ccm', params: (n) => [n] },
  ];
  // An IC holds keys as the contractor on the sites that name it — matched on
  // the company name, and on the vendor number where the roster carries one,
  // because the name on a client row is free text and drifts.
  if (holderType === 'ic') {
    const vendorRaw = db.prepare(
      "SELECT bc_vendor_number FROM accounts WHERE (record_type='ic' OR record_type IS NULL) " +
      'AND LOWER(TRIM(ic_company_name)) = LOWER(TRIM(?)) LIMIT 1'
    ).get(name) as any;
    const vendor = vendorRaw ? cleanText(Object.assign({}, vendorRaw).bc_vendor_number) : null;
    gridRoles.push({
      role: 'IC',
      where: vendor
        ? '(LOWER(TRIM(COALESCE(ic_name, \'\'))) = LOWER(TRIM(?)) OR TRIM(COALESCE(bc_vendor_number, \'\')) = TRIM(?))'
        : 'LOWER(TRIM(COALESCE(ic_name, \'\'))) = LOWER(TRIM(?))',
      prefix: 'contractor',
      params: (n) => (vendor ? [n, vendor] : [n]),
    });
  }

  for (const g of gridRoles) {
    const rows = (db.prepare(`
      SELECT id, ic_company_name, bc_client_number,
             ${g.prefix}_metal AS m, ${g.prefix}_card AS c,
             ${g.prefix}_fob AS f, ${g.prefix}_dispenser AS d
        FROM accounts
       WHERE record_type = 'customer'
         AND COALESCE(archived, 0) = 0
         AND ${g.where}
       ORDER BY ic_company_name ASC
    `).all(...g.params(name)) as any[]).map((r) => Object.assign({}, r));

    for (const r of rows) {
      const m = num(r.m); const c = num(r.c); const f = num(r.f); const d = num(r.d);
      const sub = m + c + f + d;
      if (sub === 0) continue;   // named on the row but holding nothing there
      const line = lineFor(r.id ?? null, r.ic_company_name, r.bc_client_number ?? null);
      line.metal += m; line.card += c; line.fob += f; line.dispenser += d;
      line.subtotal += sub; line.assigned += sub;
      addVia(line, g.role);
    }
  }

  // ── 2. Open custody records ────────────────────────────────────────────────
  const rows = (db.prepare(`
    SELECT a.id AS assignment_id, a.account_id, a.account_name, a.keys_json, a.keys_held, a.key_type,
           acc.bc_client_number
      FROM key_assignments a
      LEFT JOIN accounts acc ON acc.id = a.account_id
     WHERE a.status = 'checked_out'
       AND LOWER(TRIM(a.assignee)) = LOWER(TRIM(?))
       -- An archived site is not a live holding, and a voided record never was
       -- custody at all.
       AND COALESCE(acc.archived, 0) = 0
     ORDER BY a.account_name ASC
  `).all(name) as any[]).map((r) => Object.assign({}, r));

  for (const r of rows) {
    const t = tally(readKeyLines(r));
    if (t.subtotal === 0) continue;
    const line = lineFor(r.account_id ?? null, r.account_name, r.bc_client_number ?? null);
    line.metal += t.metal; line.card += t.card; line.fob += t.fob;
    line.dispenser += t.dispenser; line.office += t.office;
    line.subtotal += t.subtotal; line.checked_out += t.subtotal;
    addVia(line, 'Checked in');
  }

  return [...byClient.values()].sort((a, b) => a.client.localeCompare(b.client));
}

/**
 * A data-version marker for a holder position.
 *
 * Deliberately a CONTENT HASH of the snapshot rather than a timestamp. Neither
 * key_assignments nor accounts carries an updated_at, and accounts.created_at
 * does not move when the holder grid is edited — so a timestamp would be a
 * marker that fails to change precisely when the data does, which is worse
 * than no marker at all.
 *
 * A hash has the property the marker is for: two forms carrying the same
 * data_version describe the same holdings, and any difference in the position
 * produces a different marker.
 */
export function dataVersionFor(lines: FormLine[]): string {
  const canonical = lines
    .map((l) => [
      l.account_id ?? l.client, l.metal, l.card, l.fob, l.dispenser, l.office,
      l.assigned, l.checked_out,
    ].join(':'))
    .sort()
    .join('|');
  return `v1:${crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 16)}`;
}

/** The keys a single event moved, as form lines. Used for transfer forms. */
export function linesFromEvent(
  entries: { account_id: number | null; client: string; bc_client_number?: string | null; keys: KeyLine[] }[]
): FormLine[] {
  return entries.map((e) => {
    const t = tally(e.keys);
    return {
      account_id: e.account_id ?? null,
      client: e.client,
      bc_client_number: e.bc_client_number ?? null,
      ...t,
      // Event lines describe keys that MOVED, not a standing attribution.
      assigned: 0,
      checked_out: t.subtotal,
      via: 'Moved by this event',
    };
  });
}

/** Who is this person on the roster? Drives the role on the form header. */
export function holderProfile(holderName: string, holderType?: string | null): {
  role: string; email: string | null; phone: string | null; id: number | null;
} {
  if (holderType === 'ic') {
    const raw = db.prepare(
      "SELECT id, ic_primary_contact, ic_email FROM accounts WHERE (record_type='ic' OR record_type IS NULL) AND LOWER(TRIM(ic_company_name)) = LOWER(TRIM(?)) LIMIT 1"
    ).get(holderName) as any;
    const r = raw ? Object.assign({}, raw) : null;
    return { role: 'Independent Contractor', email: r?.ic_email ?? null, phone: null, id: r?.id ?? null };
  }
  const raw = db.prepare(
    'SELECT id, manager_type, role_category, email, phone FROM staff_managers WHERE LOWER(TRIM(name)) = LOWER(TRIM(?)) LIMIT 1'
  ).get(holderName) as any;
  if (!raw) return { role: 'City Wide Staff', email: null, phone: null, id: null };
  const r = Object.assign({}, raw);
  const role = r.role_category === 'crew' ? 'Crew'
    : r.manager_type === 'both' ? 'AM + CCM'
    : r.manager_type === 'ccm' ? 'CCM'
    : r.manager_type === 'account_manager' ? 'AM'
    : 'City Wide Staff';
  return { role, email: r.email ?? null, phone: r.phone ?? null, id: r.id ?? null };
}

export interface CreateFormInput {
  eventType: FormEventType;
  holderName: string;
  holderType?: 'employee' | 'ic' | null;
  holderEmail?: string | null;
  /**
   * The document's line items. Omit on a HOLDINGS form to snapshot the
   * holder's current state; REQUIRED on a return receipt, where the subject
   * is the keys that moved and there is nothing to snapshot.
   */
  lines?: FormLine[];
  /** Overrides the event's default kind — transfer needs both at once. */
  docKind?: DocKind;
  eventNote?: string | null;
  holderId?: number | null;
  generatedBy: string;
  sourceKind?: string | null;
  sourceRef?: string | null;
  counterpartyName?: string | null;
  /** Set when this form replaces an earlier one. */
  supersedes?: number | null;
  /**
   * What the form covers. Defaults to 'transaction' for every custody event
   * and 'full' for an Audit. A transaction form MUST be given its lines — it
   * lists what moved, and there is no snapshot to fall back on.
   */
  coverage?: FormCoverage;
  /** For coverage 'client': the one account the audit statement covers. */
  clientAccountId?: number | null;
}

/**
 * Create a Key Form row. It starts as a draft; a token is minted only when
 * there is somewhere to send it, because an unusable link makes a form look
 * like it is waiting for something it is not.
 */
export function createKeyForm(input: CreateFormInput): any {
  const profile = holderProfile(input.holderName, input.holderType);
  const email = cleanText(input.holderEmail) ?? profile.email;
  // Recomputed here, always. `lines` is only ever supplied for event forms
  // that describe what MOVED — never as a holder position from a caller.
  const docKind: DocKind = input.docKind ?? DOC_KIND_BY_EVENT[input.eventType] ?? 'holdings';

  // A receipt's lines are the keys that moved and must be supplied — there is
  // no current state to fall back on, and snapshotting here is exactly the bug
  // that made a return read as "you hold nothing".
  const coverage: FormCoverage = input.coverage
    ?? (input.eventType === 'audit' ? 'full' : 'transaction');
  if (coverage === 'transaction' && !input.lines) {
    // A programming error, not a user one: a custody event that forgot to say
    // what moved would otherwise silently print the holder's whole position.
    throw new Error(`A ${input.eventType} form lists only the keys it moved — lines are required.`);
  }
  const lines = input.lines
    ?? (coverage === 'client'
      ? snapshotHolder(input.holderName, input.holderType)
        .filter((l) => Number(l.account_id) === Number(input.clientAccountId))
      : snapshotHolder(input.holderName, input.holderType));

  // Neither kind is ever built empty: a holdings statement with no holdings and
  // a receipt for no keys are both a blank to sign. Enforced here, at the one
  // place every form is born, so no route can route around it.
  if (lines.length === 0) throw new EmptyHoldingsError(input.holderName, docKind);

  const dataVersion = dataVersionFor(lines);
  const scope: FormScope = { lines, event_note: input.eventNote ?? null };
  const totalKeys = lines.reduce((n, l) => n + l.subtotal, 0);
  // Mirrors total_keys on a receipt so a list can report what the form is FOR
  // without reading the scope blob; 0 on a holdings statement.
  const returnedKeys = docKind === 'return_receipt' ? totalKeys : 0;

  // EVERY form is signable. A token is minted unconditionally — including for a
  // holder with no address on file.
  //
  // The link used to be withheld in that case on the reasoning that an unusable
  // link makes a form look like it is waiting for something it is not. That was
  // backwards: the link is not unusable, it is merely unsendable BY EMAIL. It
  // still opens on a phone handed across a counter, which is how a signature
  // gets collected from someone who has no address in the first place.
  // Withholding it removed the only route those holders had.
  //
  // `no_email` is still recorded, because "we could not email this" remains
  // true and worth showing — but it now describes a DELIVERY problem, not the
  // absence of a signature path.
  const hasEmail = !!email;
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + TTL_MS).toISOString();

  const r = db.prepare(`
    INSERT INTO key_form_docs
      (event_type, holder_name, holder_type, holder_role, holder_id,
       holder_email, holder_phone, scope_json, clients_covered, total_keys,
       status, token, token_expires_at, generated_by, source_kind, source_ref,
       counterparty_name, no_email, data_version, supersedes, returned_keys, doc_kind, form_coverage)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.eventType, input.holderName, input.holderType ?? 'employee',
    profile.role, input.holderId ?? profile.id,
    email, profile.phone, JSON.stringify(scope), lines.length, totalKeys,
    token, expires, input.generatedBy,
    input.sourceKind ?? null, input.sourceRef ?? null,
    input.counterpartyName ?? null, hasEmail ? 0 : 1,
    dataVersion, input.supersedes ?? null, returnedKeys, docKind, coverage,
  );
  const id = Number(r.lastInsertRowid);
  // Which clients this form covers, as rows — the search and the Client filter
  // read these rather than the scope blob.
  const link = db.prepare('INSERT OR IGNORE INTO form_clients (form_id, account_id) VALUES (?, ?)');
  for (const l of lines) if (l.account_id != null) link.run(id, Number(l.account_id));
  // Human-readable identifier, assigned after insert so it matches the row id.
  db.prepare('UPDATE key_form_docs SET form_no = ? WHERE id = ?').run(`KF-${String(id).padStart(5, '0')}`, id);
  return getKeyForm(id);
}

export function getKeyForm(id: number): any | null {
  const raw = db.prepare('SELECT * FROM key_form_docs WHERE id = ?').get(id) as any;
  return raw ? Object.assign({}, raw) : null;
}

export function getKeyFormByToken(token: string): any | null {
  const raw = db.prepare('SELECT * FROM key_form_docs WHERE token = ?').get(token) as any;
  return raw ? Object.assign({}, raw) : null;
}

export function parseScope(row: any): FormScope {
  try {
    const s = JSON.parse(row.scope_json || '{}');
    return {
      lines: Array.isArray(s.lines) ? s.lines : [],
      event_note: s.event_note ?? null,
    };
  } catch {
    return { lines: [], event_note: null };
  }
}

/** The list view's shape — never the raw scope blob. */
export function serializeForm(row: any): any {
  const scope = parseScope(row);
  let sentTo: string[] = [];
  try { sentTo = JSON.parse(row.sent_to || '[]'); } catch { sentTo = []; }
  return {
    id: row.id,
    form_no: row.form_no,
    event_type: row.event_type,
    event_label: FORM_EVENT_LABEL[row.event_type as FormEventType] ?? row.event_type,
    // What KIND of document this is, resolved once here so every renderer —
    // PDF, sign-off page, Forms tab, email — agrees rather than each
    // re-deriving it and drifting apart.
    doc_kind: docKindOf(row),
    doc_title: docTitleFor(row),
    table_heading: docTableHeadingFor(row),
    total_label: docTotalLabelFor(row),
    form_coverage: formCoverageOf(row),
    ack_variant: ackVariantOf(row),
    // Past the 12-month retention window and not tied to open custody.
    archived: !!row.is_archived,
    holder_name: row.holder_name,
    holder_type: row.holder_type,
    holder_role: row.holder_role,
    holder_email: row.holder_email,
    clients_covered: row.clients_covered,
    total_keys: row.total_keys,
    status: row.status,
    // Correction state, so the row can say why it left the ordinary flow.
    voided_at: row.voided_at ?? null,
    voided_by: row.voided_by ?? null,
    void_reason: row.void_reason ?? null,
    acknowledged_at: row.acknowledged_at ?? null,
    acknowledged_by: row.acknowledged_by ?? null,
    acknowledge_reason: row.acknowledge_reason ?? null,
    generated_at: row.created_at,
    generated_by: row.generated_by,
    // Which position this form states — the marker that makes a stale document
    // provable rather than arguable.
    data_version: row.data_version ?? null,
    supersedes: row.supersedes ?? null,
    superseded_by: row.superseded_by ?? null,
    superseded_at: row.superseded_at ?? null,
    returned_keys: row.returned_keys ?? 0,
    sent_to: sentTo,
    last_sent_at: row.last_sent_at,
    send_count: row.send_count ?? 0,
    send_error: row.send_error ?? null,
    signed_at: row.signed_at,
    signature_typed_name: row.signature_typed_name,
    // The signature link's lifecycle, evaluated NOW rather than stored, so the
    // pill is right the moment the list loads. null = outside the cycle
    // (voided, acknowledged, superseded).
    link_state: linkStateOf(row),
    link_expires_at: row.token_expires_at ?? null,
    link_renewals: Number(row.link_renewals) || 0,
    link_max_renewals: MAX_AUTO_RENEWALS,
    link_renewed_at: row.link_renewed_at ?? null,
    link_exhausted_at: row.link_exhausted_at ?? null,
    has_pdf: !!row.pdf_path,
    no_email: !!row.no_email,
    counterparty_name: row.counterparty_name,
    clients: scope.lines,
    event_note: scope.event_note,
  };
}

// ── Retention ─────────────────────────────────────────────────────────────────
// Forms are NEVER deleted. After 12 months a form leaves the default Key Forms
// view for the "Archived forms" filter — still searchable, still downloadable,
// still in every backup (it is the same row in the same table; archiving is a
// query, not a move). A form tied to custody that is still open stays active
// at any age: those keys are still out, and so is the document about them.
export const RETENTION_MONTHS = 12;

/** SQL: is this key_form_docs row tied to custody that is still open? */
const TIED_TO_OPEN_CUSTODY = `(
  (key_form_docs.source_kind = 'assignment' AND EXISTS (
     SELECT 1 FROM key_assignments ka
      WHERE ka.id = CAST(key_form_docs.source_ref AS INTEGER) AND ka.status = 'checked_out'))
  OR (key_form_docs.source_kind = 'transfer' AND EXISTS (
     SELECT 1 FROM key_assignments ka
      WHERE ka.transfer_id = key_form_docs.source_ref AND ka.transfer_role = 'to'
        AND ka.status = 'checked_out'))
  OR (key_form_docs.event_type IN ('audit', 'reassignment') AND EXISTS (
     SELECT 1 FROM key_assignments ka
       JOIN form_clients fc ON fc.account_id = ka.account_id
      WHERE fc.form_id = key_form_docs.id AND ka.status = 'checked_out'
        AND LOWER(TRIM(ka.assignee)) = LOWER(TRIM(key_form_docs.holder_name))))
)`;

/** SQL: this row is archived — past retention AND not tied to open custody. */
export const FORM_ARCHIVED_SQL = `(
  datetime(key_form_docs.created_at) < datetime('now', '-${RETENTION_MONTHS} months')
  AND NOT ${TIED_TO_OPEN_CUSTODY}
)`;

export interface FormFilters {
  search?: string;
  /** Only forms covering this client (via form_clients). */
  account_id?: number;
  /**
   * 'active' (default) hides archived forms; 'archived' shows only them; 'all'
   * shows both — the contextual lists on a client or holder page use 'all', so
   * the history there is never cut off at 12 months.
   */
  archived?: 'active' | 'archived' | 'all';
  event_type?: string;
  status?: string;
  from?: string;
  to?: string;
  holder?: string;
  limit?: number;
  offset?: number;
}

export function listKeyForms(f: FormFilters): { rows: any[]; total: number } {
  let where = '1=1';
  const params: any[] = [];

  if (f.search) {
    // ONE box, any of: form ID, holder name, IC company, client name, BC
    // Client #, BC Vendor #. Clients are matched through form_clients →
    // accounts, so a renamed client or a BC number (which never appears in
    // the scope blob) still finds its forms. scope_json is kept as a fallback
    // for older lines that could not be linked to an account.
    const s = `%${f.search.trim()}%`;
    const digits = f.search.replace(/\D/g, '');
    where += ` AND (
      form_no LIKE ? OR CAST(key_form_docs.id AS TEXT) = ? OR holder_name LIKE ? OR scope_json LIKE ?
      OR key_form_docs.id IN (
        SELECT fc.form_id FROM form_clients fc JOIN accounts a ON a.id = fc.account_id
         WHERE a.ic_company_name LIKE ? OR a.ic_name LIKE ?
            OR a.bc_client_number LIKE ? OR a.bc_vendor_number LIKE ?)
      OR LOWER(TRIM(holder_name)) IN (
        SELECT LOWER(TRIM(ic_company_name)) FROM accounts
         WHERE (record_type = 'ic' OR record_type IS NULL) AND bc_vendor_number LIKE ?)
    )`;
    params.push(s, digits || f.search.trim(), s, s, s, s, s, s, s);
  }
  if (f.account_id) {
    where += ' AND key_form_docs.id IN (SELECT form_id FROM form_clients WHERE account_id = ?)';
    params.push(f.account_id);
  }
  const arch = f.archived ?? (f.status === 'archived' ? 'archived' : 'active');
  if (arch === 'active') where += ` AND NOT ${FORM_ARCHIVED_SQL}`;
  else if (arch === 'archived') where += ` AND ${FORM_ARCHIVED_SQL}`;
  if (f.holder) { where += ' AND LOWER(TRIM(holder_name)) = LOWER(TRIM(?))'; params.push(f.holder); }
  if (f.event_type && f.event_type !== 'all') { where += ' AND event_type = ?'; params.push(f.event_type); }
  // 'send_failed' is not a stored status — a failed send leaves the form
  // 'unsigned', which is also what a never-sent form reads as. The thing that
  // actually distinguishes them is send_error, so the filter asks for that.
  const LINK_FILTERS: LinkState[] = ['awaiting', 'expiring_soon', 'expired'];
  if (f.status && (LINK_FILTERS as string[]).includes(f.status)) {
    // Link-state chips ask the same question linkStateOf answers per row.
    const st = f.status as LinkState;
    where += ` AND ${linkStateWhere(st)}`;
    params.push(...linkStateParams(st));
  } else if (f.status === 'send_failed') {
    where += " AND send_error IS NOT NULL AND TRIM(send_error) <> ''";
  } else if (f.status === 'archived') {
    // Handled above as a retention filter, not a stored status.
  } else if (f.status && f.status !== 'all') {
    where += ' AND status = ?'; params.push(f.status);
  } else {
    // Voided forms are corrections, not history to scroll past. They are one
    // filter click away and never gone — asking for them by name shows them.
    where += " AND COALESCE(status, '') <> 'voided'";
  }
  if (f.from) { where += ' AND created_at >= ?'; params.push(f.from); }
  if (f.to) { where += ' AND created_at <= ?'; params.push(`${f.to} 23:59:59`); }

  const countRow = db.prepare(`SELECT COUNT(*) AS c FROM key_form_docs WHERE ${where}`).get(...params) as any;
  const rows = db.prepare(
    `SELECT *, ${FORM_ARCHIVED_SQL} AS is_archived FROM key_form_docs WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`
  ).all(...params, f.limit ?? 50, f.offset ?? 0) as any[];

  return {
    rows: rows.map((r) => serializeForm(Object.assign({}, r))),
    total: Object.assign({}, countRow).c as number,
  };
}

/** How many forms sit in the Archived filter right now. */
export function archivedFormCount(): number {
  try {
    const r = db.prepare(`SELECT COUNT(*) AS c FROM key_form_docs WHERE ${FORM_ARCHIVED_SQL}`).get() as any;
    return Number(Object.assign({}, r).c) || 0;
  } catch { return 0; }
}

/** Voided and acknowledged form counts, for the filter chips. */
export function correctionFormCounts(): { voided: number; acknowledged_unsigned: number } {
  const n = (sql: string): number => {
    try { return (Object.assign({}, db.prepare(sql).get()) as any).c as number; } catch { return 0; }
  };
  return {
    voided: n("SELECT COUNT(*) AS c FROM key_form_docs WHERE status = 'voided'"),
    acknowledged_unsigned: n("SELECT COUNT(*) AS c FROM key_form_docs WHERE status = 'acknowledged_unsigned'"),
  };
}

/** How many forms are sitting on a failed send right now. Drives the chip. */
export function failedSendCount(): number {
  const row = db.prepare(
    "SELECT COUNT(*) AS c FROM key_form_docs WHERE send_error IS NOT NULL AND TRIM(send_error) <> ''"
  ).get() as any;
  return Object.assign({}, row).c as number;
}

/** Every form whose last send failed, oldest first so a retry replays in order. */
export function failedSendIds(limit = 200): number[] {
  return (db.prepare(
    "SELECT id FROM key_form_docs WHERE send_error IS NOT NULL AND TRIM(send_error) <> '' " +
    'ORDER BY id ASC LIMIT ?'
  ).all(limit) as any[]).map((r) => Object.assign({}, r).id as number);
}

/** Record a send. Idempotent by design: re-sending is allowed and counted. */
export function markSent(id: number, recipients: string[], ok: boolean, error?: string | null): void {
  const row = getKeyForm(id);
  if (!row) return;
  let prior: string[] = [];
  try { prior = JSON.parse(row.sent_to || '[]'); } catch { prior = []; }
  const merged = [...new Set([...prior, ...recipients.filter(Boolean)])];
  db.prepare(`
    UPDATE key_form_docs
       SET sent_to = ?, last_sent_at = ?, send_count = COALESCE(send_count, 0) + 1,
           send_error = ?,
           status = CASE WHEN status = 'signed' THEN 'signed'
                         WHEN ? = 1 THEN 'sent' ELSE 'unsigned' END
     WHERE id = ?
  `).run(JSON.stringify(merged), new Date().toISOString(), ok ? null : (error ?? 'send failed'), ok ? 1 : 0, id);
}

/**
 * The five columns a Key Form body carries. NOTE: 'office' is a HOLDER in this
 * system (office_keys_held), not a key type a person can be handed — the
 * picker offers metal/card/fob/dispenser. The column is kept because the form
 * layout calls for it, and it fills whenever a line of that type exists.
 */
export const FORM_COLUMNS = [
  { key: 'metal', label: 'Metal' },
  { key: 'card', label: 'Key Card' },
  { key: 'fob', label: 'Key Fob' },
  { key: 'dispenser', label: 'Dispenser' },
  { key: 'office', label: 'Office' },
] as const;
