// ── Email backfill importers ─────────────────────────────────────────────────
// Two source files, two match strategies, one goal: give every signature
// recipient a reachable address so check-outs stop landing as
// "No signature — no email on file".
//
//   CW employees  → staff_managers, matched on full name
//   ICs           → accounts (record_type='ic'), matched on bc_vendor_number
//
// Both importers are IDEMPOTENT. Re-running is a no-op: a row that already has
// an email is never overwritten, and a row created on the first run matches on
// the second. Neither importer ever clears a value.

import type { DatabaseSync } from 'node:sqlite';

/** Every cell in these sheets may carry trailing spaces. Trim everything. */
export function cell(v: any): string {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

/** BC vendor numbers are zero-padded 11-digit TEXT. */
export const VENDOR_NO_LENGTH = 11;

/**
 * '02014100437' must stay eleven characters. A spreadsheet that stores it as a
 * NUMBER hands back 2014100437 with the leading zero gone, and a stripped zero
 * fails every match — so an all-digit value shorter than eleven is re-padded.
 *
 * CSV read with raw:false already preserves the text, so the padding path
 * normally does nothing. When it DOES fire it is a repair of lossy input, not a
 * fact from the file, so `padded` is reported and surfaced in the preview
 * rather than applied silently.
 */
export function vendorNoDetail(v: any): { value: string; padded: boolean } {
  const s = cell(v);
  if (!s) return { value: '', padded: false };
  if (/^\d+$/.test(s) && s.length < VENDOR_NO_LENGTH) {
    return { value: s.padStart(VENDOR_NO_LENGTH, '0'), padded: true };
  }
  return { value: s, padded: false };
}

export function vendorNo(v: any): string {
  return vendorNoDetail(v).value;
}

/** Deliberately permissive — this rejects blanks and obvious junk, not TLDs. */
export function isValidEmail(v: any): boolean {
  const s = cell(v);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

/** Case-insensitive, whitespace-collapsed key for name matching. */
export function nameKey(v: any): string {
  return cell(v).toLowerCase().replace(/\s+/g, ' ');
}

// ── Header recognition ───────────────────────────────────────────────────────
// Both sheets are identified by their header row alone, so the same shapes work
// from the CLI scripts and from the registry's Import from Excel.

const STAFF_HEADERS = {
  // A Full Name column, when present, is the authoritative match key — the
  // roster stores one name string, so splitting and re-joining first/last is a
  // needless round trip that loses middle names and suffixes.
  fullName: ['full name', 'fullname', 'name', 'employee name', 'staff name'],
  first: ['first name', 'firstname', 'first'],
  last: ['last name', 'lastname', 'last'],
  email: ['email address', 'email', 'e-mail', 'email addresss'],
};

const IC_HEADERS = {
  dba: ['ic company name', 'dba name', 'dba', 'company name', 'vendor name', 'ic name'],
  vendor: ['bc vendor no', 'bc vendor no.', 'bc vendor number', 'bc vendor #', 'vendor no', 'vendor number'],
  contact: ['primary contact', 'primary contact name', 'contact'],
  email: [
    'email (primary contact) (contact)',
    'email (primary contact)',
    'primary contact email',
    'email',
  ],
};

function headerIndex(headers: string[], names: string[]): number {
  for (const n of names) {
    const i = headers.indexOf(n);
    if (i !== -1) return i;
  }
  return -1;
}

/** Lowercase + trim a header cell. Also drops the Dynamics "(Do Not Modify)". */
export function normalizeHeaderCell(v: any): string {
  return cell(v).toLowerCase().replace(/\s+/g, ' ');
}

export type SheetShape = 'staff-emails' | 'ic-emails' | null;

export interface HeaderReport {
  /** Sheet columns this importer understood, with the field each one feeds. */
  recognized: { header: string; field: string }[];
  /** Sheet columns it did NOT understand — surfaced so a mapping gap is
   *  visible instead of silently landing as blank for every row. */
  unrecognized: string[];
  /** Columns skipped on purpose (the Dynamics "(Do Not Modify)" bookkeeping),
   *  listed separately so they don't read as a problem. */
  ignoredByDesign: string[];
}

/** Header cells that are Dynamics bookkeeping, never data. */
const IGNORED_HEADER = /^\(do not modify\)/i;

/**
 * Which sheet columns fed which field, and which were left on the floor. The
 * preview shows this BEFORE anything is written, so a renamed column in a
 * refreshed export shows up as an unrecognized header rather than as a silent
 * zero-fill import.
 */
export function describeHeaders(headerRow: any[], shape: Exclude<SheetShape, null>): HeaderReport {
  const raw = headerRow.map((h) => cell(h));
  const norm = headerRow.map(normalizeHeaderCell);
  const map = shape === 'staff-emails'
    ? {
        full_name: STAFF_HEADERS.fullName,
        first: STAFF_HEADERS.first, last: STAFF_HEADERS.last, email: STAFF_HEADERS.email,
      }
    : {
        dba: IC_HEADERS.dba, bc_vendor_number: IC_HEADERS.vendor,
        ic_primary_contact: IC_HEADERS.contact, ic_email: IC_HEADERS.email,
      };

  const recognized: { header: string; field: string }[] = [];
  const claimed = new Set<number>();
  for (const [field, names] of Object.entries(map)) {
    const i = headerIndex(norm, names as string[]);
    if (i !== -1) { recognized.push({ header: raw[i], field }); claimed.add(i); }
  }

  const unrecognized: string[] = [];
  const ignoredByDesign: string[] = [];
  raw.forEach((h, i) => {
    if (claimed.has(i) || !h) return;
    if (IGNORED_HEADER.test(h)) ignoredByDesign.push(h);
    else unrecognized.push(h);
  });

  return { recognized, unrecognized, ignoredByDesign };
}

/**
 * Which of the two email sheets is this, if either? Returns null for anything
 * else (including the customer registry sheet) so the caller falls through to
 * its existing handling.
 */
export function detectShape(headerRow: any[]): SheetShape {
  const h = headerRow.map(normalizeHeaderCell);
  // "(Do Not Modify)" columns from the Dynamics export are ignored outright.
  // A staff sheet needs an email column plus SOME way to name the person:
  // either a Full Name column or a first/last pair.
  const hasEmail = headerIndex(h, STAFF_HEADERS.email) !== -1;
  const hasFull = headerIndex(h, STAFF_HEADERS.fullName) !== -1;
  const hasFirstLast =
    headerIndex(h, STAFF_HEADERS.first) !== -1 && headerIndex(h, STAFF_HEADERS.last) !== -1;
  // Guard against the IC sheet, which also carries a name and an email: a
  // vendor-number column means it is not the staff list.
  const looksIc = headerIndex(h, IC_HEADERS.vendor) !== -1;
  if (hasEmail && (hasFull || hasFirstLast) && !looksIc) return 'staff-emails';

  // The IC sheet is identified by a vendor-number column PLUS a contact column;
  // requiring both keeps it from swallowing the customer registry sheet, which
  // also carries a BC Vendor Number.
  const icOk =
    headerIndex(h, IC_HEADERS.vendor) !== -1 &&
    (headerIndex(h, IC_HEADERS.contact) !== -1 || headerIndex(h, IC_HEADERS.email) !== -1) &&
    headerIndex(h, IC_HEADERS.dba) !== -1;
  if (icOk) return 'ic-emails';

  return null;
}

// ── Row parsing ──────────────────────────────────────────────────────────────

export interface StaffEmailRow { row: number; first: string; last: string; name: string; email: string }
export interface IcEmailRow {
  row: number; dba: string; vendor: string; contact: string; email: string;
  /** True when a lost leading zero was repaired — surfaced, never silent. */
  vendorPadded?: boolean;
}

export function parseStaffRows(raw: any[][]): StaffEmailRow[] {
  if (raw.length < 2) return [];
  const h = raw[0].map(normalizeHeaderCell);
  const iN = headerIndex(h, STAFF_HEADERS.fullName);
  const iF = headerIndex(h, STAFF_HEADERS.first);
  const iL = headerIndex(h, STAFF_HEADERS.last);
  const iE = headerIndex(h, STAFF_HEADERS.email);
  const out: StaffEmailRow[] = [];
  raw.slice(1).forEach((r, i) => {
    const first = cell(iF === -1 ? '' : r[iF]);
    const last = cell(iL === -1 ? '' : r[iL]);
    const full = cell(iN === -1 ? '' : r[iN]);
    const email = cell(iE === -1 ? '' : r[iE]);
    if (!first && !last && !full && !email) return; // blank spacer row
    // Full Name wins when the file supplies it — it is what the roster stores,
    // and rebuilding it from first+last would drop middle names and suffixes.
    const name = full || `${first} ${last}`.trim();
    out.push({ row: i + 2, first, last, name, email });
  });
  return out;
}

export function parseIcRows(raw: any[][]): IcEmailRow[] {
  if (raw.length < 2) return [];
  const h = raw[0].map(normalizeHeaderCell);
  const iD = headerIndex(h, IC_HEADERS.dba);
  const iV = headerIndex(h, IC_HEADERS.vendor);
  const iC = headerIndex(h, IC_HEADERS.contact);
  const iE = headerIndex(h, IC_HEADERS.email);
  const out: IcEmailRow[] = [];
  raw.slice(1).forEach((r, i) => {
    const dba = cell(iD === -1 ? '' : r[iD]);
    const v = vendorNoDetail(iV === -1 ? '' : r[iV]);
    const contact = cell(iC === -1 ? '' : r[iC]);
    const email = cell(iE === -1 ? '' : r[iE]);
    if (!dba && !v.value && !contact && !email) return;
    out.push({ row: i + 2, dba, vendor: v.value, contact, email, vendorPadded: v.padded });
  });
  return out;
}

// ── Staff email import ───────────────────────────────────────────────────────

export interface StaffImportReport {
  totalRows: number;
  matchedUpdated: { name: string; email: string }[];
  matchedAlreadyHadEmail: { name: string; existing: string; incoming: string }[];
  created: { name: string; email: string; role_category: string; manager_type: string }[];
  ambiguous: { name: string; ids: number[] }[];
  invalidEmail: { row: number; name: string; value: string }[];
  /** staff_managers rows STILL without an email after the run — the residual gap. */
  remainingWithoutEmail: { id: number; name: string; role_category: string }[];
  /** Per DESTINATION FIELD, how many rows this run would fill. Zero against a
   *  non-empty sheet is the signal that something is wrong, so it is stated
   *  rather than left to be inferred from the other counts. */
  fieldFills: Record<string, number>;
}

/**
 * Does this person appear as a manager on any client row? Decides whether an
 * unmatched name lands as 'manager' or 'crew', and which manager_type.
 */
function managerRoleFor(db: DatabaseSync, name: string): { role_category: string; manager_type: string } {
  const key = nameKey(name);
  const hit = db.prepare(`
    SELECT
      SUM(CASE WHEN LOWER(TRIM(account_manager)) = ? THEN 1 ELSE 0 END) AS as_am,
      SUM(CASE WHEN LOWER(TRIM(ccm_manager))     = ? THEN 1 ELSE 0 END) AS as_ccm
    FROM accounts
  `).get(key, key) as any;
  const asAm = Number(hit?.as_am ?? 0) > 0;
  const asCcm = Number(hit?.as_ccm ?? 0) > 0;
  if (asAm && asCcm) return { role_category: 'manager', manager_type: 'both' };
  if (asAm) return { role_category: 'manager', manager_type: 'account_manager' };
  if (asCcm) return { role_category: 'manager', manager_type: 'ccm' };
  // manager_type is NOT NULL and predates crew; 'crew' is the documented
  // sentinel, surfaced to the API as null.
  return { role_category: 'crew', manager_type: 'crew' };
}

export function importStaffEmails(
  db: DatabaseSync,
  rows: StaffEmailRow[],
  opts: { dryRun?: boolean } = {}
): StaffImportReport {
  const report: StaffImportReport = {
    totalRows: rows.length,
    matchedUpdated: [], matchedAlreadyHadEmail: [], created: [],
    ambiguous: [], invalidEmail: [], remainingWithoutEmail: [], fieldFills: {},
  };

  // Index the roster once, by normalized name. A name held by two rows is
  // AMBIGUOUS: we refuse to guess which person owns the address.
  const byName = new Map<string, any[]>();
  for (const r of db.prepare('SELECT * FROM staff_managers').all() as any[]) {
    const rec = Object.assign({}, r);
    const k = nameKey(rec.name);
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k)!.push(rec);
  }

  const updateEmail = db.prepare('UPDATE staff_managers SET email = ? WHERE id = ?');
  const insertStaff = db.prepare(`
    INSERT INTO staff_managers (name, manager_type, role_category, shift, day_night, email, active)
    VALUES (?, ?, ?, NULL, NULL, ?, 1)
  `);

  for (const r of rows) {
    if (!r.name) continue;
    if (r.email && !isValidEmail(r.email)) {
      report.invalidEmail.push({ row: r.row, name: r.name, value: r.email });
      continue;
    }

    const matches = byName.get(nameKey(r.name)) ?? [];

    if (matches.length > 1) {
      report.ambiguous.push({ name: r.name, ids: matches.map((m) => m.id) });
      continue;
    }

    if (matches.length === 1) {
      const existing = cell(matches[0].email);
      if (existing) {
        // Never overwrite a populated address, even with a different one.
        report.matchedAlreadyHadEmail.push({ name: r.name, existing, incoming: r.email });
        continue;
      }
      if (!r.email) continue;
      if (!opts.dryRun) updateEmail.run(r.email, matches[0].id);
      matches[0].email = r.email; // keep the in-memory index truthful
      report.matchedUpdated.push({ name: r.name, email: r.email });
      continue;
    }

    // No roster record at all — create one for Cara to finish (shift/day_night
    // stay NULL deliberately).
    const role = managerRoleFor(db, r.name);
    if (!opts.dryRun) {
      insertStaff.run(r.name, role.manager_type, role.role_category, r.email || null);
    }
    // Register it so a duplicate later in the same file matches instead of
    // inserting twice.
    byName.set(nameKey(r.name), [{ id: -1, name: r.name, email: r.email }]);
    report.created.push({ name: r.name, email: r.email, ...role });
  }

  report.fieldFills = {
    'staff_managers.email': report.matchedUpdated.length
      + report.created.filter((c) => !!c.email).length,
    'staff_managers (new rows)': report.created.length,
  };

  report.remainingWithoutEmail = (db.prepare(`
    SELECT id, name, COALESCE(role_category, 'manager') AS role_category
      FROM staff_managers
     WHERE (email IS NULL OR TRIM(email) = '') AND COALESCE(active, 1) = 1
     ORDER BY name ASC
  `).all() as any[]).map((r) => Object.assign({}, r) as any);

  return report;
}

// ── IC email import ──────────────────────────────────────────────────────────

export interface IcImportReport {
  totalRows: number;
  matchedUpdated: { vendor: string; dba: string; contact: string; email: string }[];
  matchedAlreadyPopulated: { vendor: string; dba: string }[];
  created: { vendor: string; dba: string; contact: string; email: string }[];
  missingEmail: { row: number; dba: string; vendor: string }[];
  missingVendorNo: { row: number; dba: string; email: string }[];
  invalidEmail: { row: number; dba: string; value: string }[];
  duplicateVendorNos: { vendor: string; count: number }[];
  /** Rows whose vendor number had a lost leading zero repaired. Reported so a
   *  value the file did not literally contain is never applied invisibly. */
  vendorPadded: { row: number; dba: string; vendor: string }[];
  /** Per DESTINATION FIELD, how many rows this run would fill. */
  fieldFills: Record<string, number>;
}

export function importIcEmails(
  db: DatabaseSync,
  rows: IcEmailRow[],
  opts: { dryRun?: boolean } = {}
): IcImportReport {
  const report: IcImportReport = {
    totalRows: rows.length,
    matchedUpdated: [], matchedAlreadyPopulated: [], created: [],
    missingEmail: [], missingVendorNo: [], invalidEmail: [], duplicateVendorNos: [],
    vendorPadded: [], fieldFills: {},
  };

  for (const r of rows) {
    if (r.vendorPadded) report.vendorPadded.push({ row: r.row, dba: r.dba, vendor: r.vendor });
  }

  // Duplicate vendor numbers WITHIN the source file — reported, first wins.
  const seen = new Map<string, number>();
  for (const r of rows) {
    if (!r.vendor) continue;
    seen.set(r.vendor, (seen.get(r.vendor) ?? 0) + 1);
  }
  for (const [vendor, count] of seen) {
    if (count > 1) report.duplicateVendorNos.push({ vendor, count });
  }

  const icRows = (db.prepare(`
    SELECT id, ic_company_name, bc_vendor_number, ic_primary_contact, ic_email
      FROM accounts
     WHERE (record_type = 'ic' OR record_type IS NULL)
  `).all() as any[]).map((r) => Object.assign({}, r));

  const byVendor = new Map<string, any>();
  const byName = new Map<string, any>();
  for (const r of icRows) {
    const v = cell(r.bc_vendor_number);
    if (v && !byVendor.has(v)) byVendor.set(v, r);
    const n = nameKey(r.ic_company_name);
    if (n && !byName.has(n)) byName.set(n, r);
  }

  // Fill ONLY where empty — a populated contact or email is never overwritten.
  const update = db.prepare(`
    UPDATE accounts SET
      ic_primary_contact = CASE WHEN (ic_primary_contact IS NULL OR TRIM(ic_primary_contact) = '')
                                THEN ? ELSE ic_primary_contact END,
      ic_email           = CASE WHEN (ic_email IS NULL OR TRIM(ic_email) = '')
                                THEN ? ELSE ic_email END
    WHERE id = ?
  `);
  const insert = db.prepare(`
    INSERT INTO accounts (ic_company_name, bc_vendor_number, ic_primary_contact, ic_email,
                          record_type, status, archived)
    VALUES (?, ?, ?, ?, 'ic', 'active', 0)
  `);

  for (const r of rows) {
    if (!r.dba && !r.vendor) continue;

    if (r.email && !isValidEmail(r.email)) {
      report.invalidEmail.push({ row: r.row, dba: r.dba, value: r.email });
    }
    const email = r.email && isValidEmail(r.email) ? r.email : '';

    if (!email) report.missingEmail.push({ row: r.row, dba: r.dba, vendor: r.vendor });
    if (!r.vendor) report.missingVendorNo.push({ row: r.row, dba: r.dba, email });

    // Vendor number is the match key. Rows without one fall back to an exact
    // company-name match so re-running still finds them instead of duplicating.
    const existing = r.vendor ? byVendor.get(r.vendor) : byName.get(nameKey(r.dba));

    if (existing) {
      const hadContact = !!cell(existing.ic_primary_contact);
      const hadEmail = !!cell(existing.ic_email);
      if ((hadContact || !r.contact) && (hadEmail || !email)) {
        report.matchedAlreadyPopulated.push({ vendor: r.vendor, dba: r.dba });
        continue;
      }
      if (!opts.dryRun) update.run(r.contact || null, email || null, existing.id);
      if (!hadContact && r.contact) existing.ic_primary_contact = r.contact;
      if (!hadEmail && email) existing.ic_email = email;
      report.matchedUpdated.push({ vendor: r.vendor, dba: r.dba, contact: r.contact, email });
      continue;
    }

    if (!opts.dryRun) {
      insert.run(r.dba || null, r.vendor || null, r.contact || null, email || null);
    }
    const created = {
      id: -1, ic_company_name: r.dba, bc_vendor_number: r.vendor,
      ic_primary_contact: r.contact, ic_email: email,
    };
    if (r.vendor) byVendor.set(r.vendor, created);
    if (r.dba) byName.set(nameKey(r.dba), created);
    report.created.push({ vendor: r.vendor, dba: r.dba, contact: r.contact, email });
  }

  report.fieldFills = {
    'accounts.ic_email':
      report.matchedUpdated.filter((m) => !!m.email).length
      + report.created.filter((c) => !!c.email).length,
    'accounts.ic_primary_contact':
      report.matchedUpdated.filter((m) => !!m.contact).length
      + report.created.filter((c) => !!c.contact).length,
    'accounts (new IC rows)': report.created.length,
  };

  return report;
}

// ── Customer → serving IC resolution ─────────────────────────────────────────

export interface ResolutionReport {
  totalCustomers: number;
  resolved: number;
  unresolvedNoVendorNo: number;
  unresolvedNoMatchingIc: number;
  unresolvedIcHasNoEmail: number;
  /** A sample of the unresolved, so the gap is actionable rather than a number. */
  samples: { customer: string; bc_vendor_number: string; reason: string }[];
}

/**
 * Every customer row carries the bc_vendor_number of the IC that serves it.
 * A signature form for that site can only reach a human if that vendor number
 * resolves to an IC record carrying a valid primary-contact email.
 */
export function resolveCustomerIcEmails(db: DatabaseSync, sampleLimit = 25): ResolutionReport {
  const customers = (db.prepare(`
    SELECT id, ic_company_name, bc_vendor_number
      FROM accounts
     WHERE record_type = 'customer' AND COALESCE(archived, 0) = 0
  `).all() as any[]).map((r) => Object.assign({}, r));

  const icByVendor = new Map<string, any>();
  for (const r of db.prepare(`
    SELECT bc_vendor_number, ic_email, ic_company_name FROM accounts
     WHERE (record_type = 'ic' OR record_type IS NULL) AND COALESCE(archived, 0) = 0
  `).all() as any[]) {
    const rec = Object.assign({}, r);
    const v = cell(rec.bc_vendor_number);
    if (!v) continue;
    // Prefer an IC that actually has an email if the vendor number repeats.
    const prev = icByVendor.get(v);
    if (!prev || (!isValidEmail(prev.ic_email) && isValidEmail(rec.ic_email))) {
      icByVendor.set(v, rec);
    }
  }

  const report: ResolutionReport = {
    totalCustomers: customers.length,
    resolved: 0, unresolvedNoVendorNo: 0,
    unresolvedNoMatchingIc: 0, unresolvedIcHasNoEmail: 0, samples: [],
  };

  for (const c of customers) {
    const v = cell(c.bc_vendor_number);
    let reason = '';
    if (!v) { report.unresolvedNoVendorNo++; reason = 'customer row has no BC vendor number'; }
    else {
      const ic = icByVendor.get(v);
      if (!ic) { report.unresolvedNoMatchingIc++; reason = `no IC record for vendor ${v}`; }
      else if (!isValidEmail(ic.ic_email)) {
        report.unresolvedIcHasNoEmail++;
        reason = `IC "${cell(ic.ic_company_name)}" has no valid email`;
      } else { report.resolved++; continue; }
    }
    if (report.samples.length < sampleLimit) {
      report.samples.push({ customer: cell(c.ic_company_name), bc_vendor_number: v, reason });
    }
  }

  return report;
}
