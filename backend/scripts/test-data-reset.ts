#!/usr/bin/env ts-node
/**
 * Wipe every trace of test activity and re-seed the three fixtures clean, so
 * the same end-to-end test can be run again and again.
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
  TEST_CLIENT_NAME, TEST_IC_NAME, TEST_MANAGER_NAME, TEST_EMAIL,
} from '../src/lib/testFixtures';

const seedOnly = process.argv.includes('--seed-only');
const line = (s = '') => console.log(s);

const realCustomers = () => Object.assign({}, db.prepare(
  "SELECT COUNT(*) AS c FROM accounts WHERE record_type='customer' AND COALESCE(archived,0)=0 AND COALESCE(is_test,0)=0"
).get() as any).c as number;

const before = realCustomers();

line();
if (seedOnly) {
  const f = seedTestFixtures();
  line('═══ TEST FIXTURES SEEDED ═══');
  line(`  created : ${f.created.length ? f.created.join(', ') : 'nothing — all three already existed'}`);
  line(`  existing: ${f.existing.length ? f.existing.join(', ') : 'none'}`);
  line();
  line(`  client  #${f.client}  ${TEST_CLIENT_NAME}`);
  line(`  ic      #${f.ic}      ${TEST_IC_NAME}`);
  line(`  staff   #${f.manager}  ${TEST_MANAGER_NAME}  <${TEST_EMAIL}>`);
} else {
  const r = resetTestData();
  line('═══ TEST DATA RESET ═══');
  line(`  assignments deleted : ${r.assignments}`);
  line(`  key forms deleted   : ${r.forms}`);
  line(`  audit rows deleted  : ${r.audit}`);
  line();
  line('  fixtures re-seeded:');
  line(`    client  #${r.fixtures.client}  ${TEST_CLIENT_NAME}`);
  line(`    ic      #${r.fixtures.ic}      ${TEST_IC_NAME}`);
  line(`    staff   #${r.fixtures.manager}  ${TEST_MANAGER_NAME}  <${TEST_EMAIL}>`);
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
