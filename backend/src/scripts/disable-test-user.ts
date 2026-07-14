/**
 * Soft-revoke the test/troubleshooting account.
 *
 *   npm run test-user:disable
 *
 * Sets a random, unknown bcrypt hash on the test user so nobody can log in as
 * it — WITHOUT deleting the row, so its audit history stays intact. To re-enable,
 * set TEST_USER_PASSWORD in the environment and redeploy (autoSeed leaves an
 * existing row's password alone, so use this script's counterpart or reset-password
 * to set a known one again).
 */

import 'dotenv/config';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import db from '../lib/db';

const email = process.env.TEST_USER_EMAIL || 'test@citywideboston.com';

const row = db.prepare('SELECT id, name, is_test FROM managers WHERE email = ?').get(email) as any;
if (!row) {
  console.log(`• No account found for ${email} — nothing to disable.`);
  process.exit(0);
}
if (!row.is_test) {
  console.error(`❌  Refusing to disable ${email}: it is not flagged is_test=1. This tool only revokes the test account.`);
  process.exit(1);
}

// Hash of 64 random bytes nobody knows → account can never authenticate again.
const randomHash = bcrypt.hashSync(crypto.randomBytes(64).toString('hex'), 10);
db.prepare('UPDATE managers SET password_hash = ? WHERE id = ?').run(randomHash, row.id);

console.log(`✅  Test user ${email} disabled (soft revoke). Audit history preserved.`);
console.log('   Re-enable: set TEST_USER_PASSWORD and redeploy, or run reset-password for this email.');
process.exit(0);
