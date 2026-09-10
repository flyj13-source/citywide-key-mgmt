#!/usr/bin/env ts-node
/**
 * Wipe every trace of test activity and re-seed the fixtures clean, so the same
 * end-to-end test can be run again and again.
 *
 *   npm run test-data:reset
 *   npm run test-data:seed    (seed only — never deletes)
 *
 * Deletes ONLY rows reachable from a record flagged is_test=1: its custody
 * assignments, its key forms and its audit entries. Real data is never touched.
 */
import db from '../src/lib/db';
import {
  seedTestFixtures, resetTestData, testAccountIds,
  TEST_CLIENT_A_NAME, TEST_CLIENT_B_NAME, TEST_CLIENT_C_NAME,
  TEST_IC_NAME, TEST_EMAIL, TEST_AM_ONE, TEST_AM_TWO, TEST_CCM_ONE, TEST_CCM_TWO,
  TEST_NO_EMAIL_STAFF_NAME, EXPECTED_FIXTURE_COUNT,
  type FixtureIds,
} from '../src/lib/testFixtures';

const seedOnly = process.argv.includes('--seed-only');
const line = (s = '') => console.log(s);

const realCustomers = () => Object.assign({}, db.prepare(
  "SELECT COUNT(*) AS c FROM accounts WHERE record_type='customer' AND COALESCE(archived,0)=0 AND COALESCE(is_test,0)=0"
).get() as any).c as number;

const before = realCustomers();

line();
/** The whole set, one line each, so a missing record is visible at a glance. */
const report = (f: FixtureIds, indent = '  ') => {
  const row = (label: string, id: number, name: string, contact = '') =>
    line(`${indent}${label.padEnd(8)} #${String(id).padEnd(5)} ${name}${contact}`);
  row('client A', f.clients.a, TEST_CLIENT_A_NAME);
  row('client B', f.clients.b, TEST_CLIENT_B_NAME);
  row('client C', f.clients.c, TEST_CLIENT_C_NAME);
  row('ic', f.ic, TEST_IC_NAME);
  row('AM 1', f.staff.amOne, TEST_AM_ONE, `  <${TEST_EMAIL}>`);
  row('AM 2', f.staff.amTwo, TEST_AM_TWO, `  <${TEST_EMAIL}>`);
  row('CCM 1', f.staff.ccmOne, TEST_CCM_ONE, `  <${TEST_EMAIL}>`);
  row('CCM 2', f.staff.ccmTwo, TEST_CCM_TWO, `  <${TEST_EMAIL}>`);
  row('crew', f.staff.noEmail, TEST_NO_EMAIL_STAFF_NAME, '  <no email — on purpose>');
  if (f.migrated.length) {
    line();
    line(`${indent}migrated:`);
    for (const m of f.migrated) line(`${indent}  · ${m}`);
  }
};

if (seedOnly) {
  const f = seedTestFixtures();
  line('═══ TEST FIXTURES SEEDED ═══');
  line(`  created : ${f.created.length ? f.created.join(', ') : `nothing — all ${EXPECTED_FIXTURE_COUNT} already existed`}`);
  line(`  existing: ${f.existing.length ? f.existing.join(', ') : 'none'}`);
  line();
  report(f);
} else {
  const r = resetTestData();
  line('═══ TEST DATA RESET ═══');
  line(`  assignments deleted : ${r.assignments}`);
  line(`  key forms deleted   : ${r.forms}`);
  line(`  audit rows deleted  : ${r.audit}`);
  line();
  line('  fixtures re-seeded:');
  report(r.fixtures, '    ');
}

const after = realCustomers();
line();
line('═══ REAL DATA UNCHANGED ═══');
line(`  customers (excluding fixtures): ${before} before → ${after} after`);
line(`  test records flagged is_test=1 : ${testAccountIds().length} account row(s)`);
if (before !== after) {
  line();
  line('  ** WARNING: the real customer count changed. Investigate before proceeding. **');
  process.exitCode = 1;
}
line();
