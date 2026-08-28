#!/usr/bin/env ts-node
/**
 * One-time backfill: CW employee email addresses → staff_managers.
 *
 *   npm run import:staff-emails -- /path/to/Cinch_-_KM_List.xlsx
 *   npm run import:staff-emails -- /path/to/file.xlsx --sheet "Current Employees"
 *   npm run import:staff-emails -- /path/to/file.xlsx --dry-run
 *
 * Safe to run twice: a populated email is never overwritten, and a row created
 * on the first run matches by name on the second.
 */
import * as fs from 'fs';
import * as XLSX from 'xlsx';
import db from '../src/lib/db';
import { logAudit } from '../src/lib/audit';
import { parseStaffRows, importStaffEmails, detectShape } from '../src/lib/emailImport';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const sheetArg = (() => {
  const i = args.indexOf('--sheet');
  return i !== -1 ? args[i + 1] : null;
})();
const file = args.find((a) => !a.startsWith('--') && a !== sheetArg);

if (!file) {
  console.error('Usage: npm run import:staff-emails -- <file.xlsx> [--sheet "Current Employees"] [--dry-run]');
  process.exit(1);
}
if (!fs.existsSync(file)) {
  console.error(`File not found: ${file}`);
  process.exit(1);
}

const wb = XLSX.read(fs.readFileSync(file), { type: 'buffer' });
const sheetName = sheetArg
  ?? wb.SheetNames.find((n) => n.toLowerCase().includes('current employee'))
  ?? wb.SheetNames[0];
if (!wb.Sheets[sheetName]) {
  console.error(`Sheet "${sheetName}" not found. Sheets: ${wb.SheetNames.join(', ')}`);
  process.exit(1);
}

const raw: any[][] = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '' });
const shape = detectShape(raw[0] ?? []);
if (shape !== 'staff-emails') {
  console.error(`Sheet "${sheetName}" does not look like the employee list.`);
  console.error(`Expected First Name / Last Name / Email Address. Found: ${(raw[0] ?? []).join(' | ')}`);
  process.exit(1);
}

const rows = parseStaffRows(raw);
const r = importStaffEmails(db, rows, { dryRun });

const line = (s = '') => console.log(s);
line();
line(`═══ CW EMPLOYEE EMAIL IMPORT ${dryRun ? '(DRY RUN — nothing written)' : ''} ═══`);
line(`file:  ${file}`);
line(`sheet: ${sheetName}`);
line(`rows:  ${r.totalRows}`);
line();
line(`  matched & email filled : ${r.matchedUpdated.length}`);
line(`  matched, already had   : ${r.matchedAlreadyHadEmail.length}  (left untouched)`);
line(`  newly created          : ${r.created.length}`);
line(`  ambiguous (skipped)    : ${r.ambiguous.length}`);
line(`  invalid email (skipped): ${r.invalidEmail.length}`);

if (r.ambiguous.length) {
  line();
  line('AMBIGUOUS — two roster rows share this name, so no email was applied:');
  for (const a of r.ambiguous) line(`  • ${a.name}  (staff_managers ids ${a.ids.join(', ')})`);
}
if (r.matchedAlreadyHadEmail.length) {
  line();
  line('ALREADY HAD AN EMAIL — kept the existing value:');
  for (const m of r.matchedAlreadyHadEmail) {
    const differs = m.incoming && m.incoming.toLowerCase() !== m.existing.toLowerCase();
    line(`  • ${m.name}: kept ${m.existing}${differs ? `  (file said ${m.incoming})` : ''}`);
  }
}
if (r.created.length) {
  line();
  line('CREATED — new roster rows (shift/day_night left blank for Cara):');
  for (const c of r.created) line(`  • ${c.name} <${c.email}>  ${c.role_category}/${c.manager_type}`);
}
if (r.invalidEmail.length) {
  line();
  line('INVALID EMAIL — skipped, value left as-is in the sheet:');
  for (const e of r.invalidEmail) line(`  • row ${e.row} ${e.name}: "${e.value}"`);
}

line();
line(`RESIDUAL GAP — ${r.remainingWithoutEmail.length} active staff_managers row(s) still have no email.`);
line('These show the red "No email on file" flag until an address is added:');
for (const g of r.remainingWithoutEmail) line(`  • ${g.name} (${g.role_category})`);
line();

if (!dryRun) {
  logAudit({} as any, 'staff_emails_imported', null, null, {
    file, sheet: sheetName, rows: r.totalRows,
    updated: r.matchedUpdated.length, created: r.created.length,
    ambiguous: r.ambiguous.map((a) => a.name),
    still_missing: r.remainingWithoutEmail.length,
  });
}
