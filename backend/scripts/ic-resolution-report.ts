#!/usr/bin/env ts-node
/**
 * Read-only: how many customer sites currently resolve to a reachable IC
 * primary-contact email, and why the rest do not.
 *
 *   npm run report:ic-resolution
 *   npm run report:ic-resolution -- --all      (list every unresolved site)
 *
 * Writes nothing. Run it before and after an import to see the gap close.
 */
import db from '../src/lib/db';
import { resolveCustomerIcEmails } from '../src/lib/emailImport';

const all = process.argv.includes('--all');
const res = resolveCustomerIcEmails(db, all ? Number.MAX_SAFE_INTEGER : 25);

const pct = res.totalCustomers ? Math.round((res.resolved / res.totalCustomers) * 1000) / 10 : 0;
const line = (s = '') => console.log(s);

line();
line('═══ CUSTOMER → SERVING IC RESOLUTION ═══');
line(`  customers (active)            : ${res.totalCustomers}`);
line(`  resolve to a valid IC email   : ${res.resolved}  (${pct}%)`);
line(`  NOT resolved                  : ${res.totalCustomers - res.resolved}`);
line(`      customer has no vendor no : ${res.unresolvedNoVendorNo}`);
line(`      no IC row for that vendor : ${res.unresolvedNoMatchingIc}`);
line(`      IC row has no valid email : ${res.unresolvedIcHasNoEmail}`);

const staffGap = (db.prepare(`
  SELECT name, COALESCE(role_category, 'manager') AS role_category
    FROM staff_managers
   WHERE (email IS NULL OR TRIM(email) = '') AND COALESCE(active, 1) = 1
   ORDER BY name ASC
`).all() as any[]).map((r) => Object.assign({}, r) as any);

line();
line(`═══ STAFF EMAIL GAP — ${staffGap.length} active roster row(s) with no email ═══`);
for (const g of staffGap) line(`  • ${g.name} (${g.role_category})`);

if (res.samples.length) {
  line();
  line(`  unresolved sites${all ? '' : ' (first 25 — pass --all for the full list)'}:`);
  for (const s of res.samples) line(`    • ${s.customer} — ${s.reason}`);
}
line();
