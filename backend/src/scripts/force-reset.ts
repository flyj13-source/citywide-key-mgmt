/**
 * Surgical password reset for cara@citywideboston.com — no DB wipe.
 *
 * Usage:
 *   npm run force-reset -- --password <newpassword>
 */

import 'dotenv/config';
import bcrypt from 'bcryptjs';
import db from '../lib/db';

const TARGET = 'cara@citywideboston.com';

function parseArgs(): string {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--password' && args[i + 1]) return args[i + 1];
  }
  console.error('Usage: npm run force-reset -- --password <newpassword>');
  process.exit(1);
}

async function main() {
  const password = parseArgs();
  const hash = await bcrypt.hash(password, 12);
  const result = db.prepare(
    'UPDATE managers SET password_hash = ? WHERE email = ?'
  ).run(hash, TARGET) as { changes: number };

  if (result.changes === 0) {
    console.error(`❌  No manager found with email: ${TARGET}`);
    process.exit(1);
  }

  console.log(`✅  Password updated for ${TARGET} (${result.changes} row affected)`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
