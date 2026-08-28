#!/usr/bin/env ts-node
/**
 * One-time backfill: independent-contractor primary contacts + emails.
 *
 *   npm run import:ic-emails -- /path/to/Active_Independent_Contractors.xlsx
 *   npm run import:ic-emails -- /path/to/file.xlsx --dry-run
 *
 * Matches on bc_vendor_number, treated as TEXT throughout so the leading zero
 * of an 11-digit number survives. Safe to run twice: populated contacts and
 * emails are never overwritten, and rows created on the first run match on the
 * second. The "hiddenSheet" and "(Do Not Modify)" columns are ignored.
 *
 * Finishes by reporting how many customer sites now resolve to a reachable IC
 * primary contact — the number that decides whether a signature form can be
 * addressed to a human.
 */
import * as fs from 'fs';
import * as XLSX from 'xlsx';
import db from '../src/lib/db';
import { logAudit } from '../src/lib/audit';
import { parseIcRows, importIcEmails, detectShape, resolveCustomerIcEmails } from '../src/lib/emailImport';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const sheetArg = (() => {
  const i = args.indexOf('--sheet');
  return i !== -1 ? args[i + 1] : null;
})();
const file = args.find((a) => !a.startsWith('--') && a !== sheetArg);

if (!file) {
  console.error('Usage: npm run import:ic-emails -- <file.xlsx> [--sheet "..."] [--dry-run]');
  process.exit(1);
}
if (!fs.existsSync(file)) {
  console.error(`File not found: ${file}`);
  process.exit(1);
}

const wb = XLSX.read(fs.readFileSync(file), { type: 'buffer' });
// The export carries a "hiddenSheet" alongside the real one — never use it.
const sheetName = sheetArg
  ?? wb.SheetNames.find((n) => n.toLowerCase().includes('active independent contractor'))
  ?? wb.SheetNames.find((n) => n.toLowerCase() !== 'hiddensheet')
  ?? wb.SheetNames[0];
if (!wb.Sheets[sheetName]) {
  console.error(`Sheet "${sheetName}" not found. Sheets: ${wb.SheetNames.join(', ')}`);
  process.exit(1);
}

// raw: true keeps vendor numbers as the strings they are wherever Excel stored
// them as text; anything it stored as a number is re-padded in vendorNo().
const raw: any[][] = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '', raw: false });
const shape = detectShape(raw[0] ?? []);
if (shape !== 'ic-emails') {
  console.error(`Sheet "${sheetName}" does not look like the IC list.`);
  console.error(`Expected DBA Name / BC Vendor No / Primary Contact / Email. Found: ${(raw[0] ?? []).join(' | ')}`);
  process.exit(1);
}

const rows = parseIcRows(raw);
const r = importIcEmails(db, rows, { dryRun });
const res = resolveCustomerIcEmails(db);

const line = (s = '') => console.log(s);
line();
line(`═══ IC CONTACT + EMAIL IMPORT ${dryRun ? '(DRY RUN — nothing written)' : ''} ═══`);
line(`file:  ${file}`);
line(`sheet: ${sheetName}`);
line(`rows:  ${r.totalRows}`);
line();
line(`  matched & filled       : ${r.matchedUpdated.length}`);
line(`  matched, already set   : ${r.matchedAlreadyPopulated.length}  (left untouched)`);
line(`  newly created          : ${r.created.length}`);
line(`  missing email (flagged): ${r.missingEmail.length}`);
line(`  missing vendor no      : ${r.missingVendorNo.length}`);
line(`  invalid email          : ${r.invalidEmail.length}`);

if (r.missingEmail.length) {
  line();
  line('IMPORTED BUT NO EMAIL — these ICs cannot receive a signature form:');
  for (const m of r.missingEmail) line(`  • row ${m.row} ${m.dba || '(no DBA)'}  vendor ${m.vendor || '(none)'}`);
}
if (r.missingVendorNo.length) {
  line();
  line('IMPORTED BUT NO BC VENDOR NO — matched by company name instead, so');
  line('no customer site can resolve to them until a vendor number is added:');
  for (const m of r.missingVendorNo) line(`  • row ${m.row} ${m.dba || '(no DBA)'}  <${m.email || 'no email'}>`);
}
if (r.invalidEmail.length) {
  line();
  line('INVALID EMAIL — imported without an address:');
  for (const e of r.invalidEmail) line(`  • row ${e.row} ${e.dba}: "${e.value}"`);
}
if (r.duplicateVendorNos.length) {
  line();
  line('DUPLICATE VENDOR NUMBERS IN THE FILE — first row won:');
  for (const d of r.duplicateVendorNos) line(`  • ${d.vendor} ×${d.count}`);
}

line();
line('═══ CUSTOMER → SERVING IC RESOLUTION ═══');
line(`  customers (active)            : ${res.totalCustomers}`);
line(`  resolve to a valid IC email   : ${res.resolved}`);
line(`  NOT resolved                  : ${res.totalCustomers - res.resolved}`);
line(`      customer has no vendor no : ${res.unresolvedNoVendorNo}`);
line(`      no IC row for that vendor : ${res.unresolvedNoMatchingIc}`);
line(`      IC row has no valid email : ${res.unresolvedIcHasNoEmail}`);
if (res.samples.length) {
  line();
  line(`  sample of the unresolved (first ${res.samples.length}):`);
  for (const s of res.samples) line(`    • ${s.customer} — ${s.reason}`);
}
line();

if (!dryRun) {
  logAudit({} as any, 'ic_emails_imported', null, null, {
    file, sheet: sheetName, rows: r.totalRows,
    updated: r.matchedUpdated.length, created: r.created.length,
    missing_email: r.missingEmail.length, missing_vendor_no: r.missingVendorNo.length,
    customers_resolved: res.resolved, customers_total: res.totalCustomers,
  });
}
