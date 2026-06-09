/**
 * CLI script — reset a manager's password
 *
 * Usage:
 *   npm run reset-password -- --email cara@citywideboston.com --password newpassword
 */

import 'dotenv/config';
import bcrypt from 'bcryptjs';
import db from '../lib/db';

function parseArgs(): { email: string; password: string } {
  const args = process.argv.slice(2);
  let email = '';
  let password = '';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--email' && args[i + 1]) email = args[++i];
    if (args[i] === '--password' && args[i + 1]) password = args[++i];
  }

  if (!email || !password) {
    console.error('Usage: npm run reset-password -- --email <email> --password <newpassword>');
    process.exit(1);
  }

  return { email, password };
}

async function main() {
  const { email, password } = parseArgs();

  // Check manager exists
  const manager = db.prepare('SELECT id, name FROM managers WHERE email = ?').get(email) as any;
  if (!manager) {
    console.error(`❌  No manager found with email: ${email}`);
    process.exit(1);
  }

  const hash = await bcrypt.hash(password, 12);
  db.prepare('UPDATE managers SET password_hash = ? WHERE email = ?').run(hash, email);

  console.log(`✅  Password updated for ${manager.name} (${email})`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
