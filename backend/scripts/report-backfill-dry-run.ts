/**
 * DRY-RUN REPORTER — update-mode backfill, read-only.
 *
 * Uploads a real registry spreadsheet to LIVE prod (or wherever PERSIST_URL
 * points), reports which headers the server recognized vs. didn't, then reports
 * — per field — how many of the ALREADY-IMPORTED rows (matched by
 * bc_client_number) would be backfilled. Writes NOTHING to the database.
 *
 * Usage:
 *   cd backend
 *   npx ts-node scripts/report-backfill-dry-run.ts /path/to/registry.xlsx
 *   npm run report:backfill -- /path/to/registry.xlsx
 *
 * You'll be prompted for your login (password input is hidden). Credentials
 * are used only to call the live API directly — never sent anywhere else,
 * never logged, never seen by anyone but you.
 *
 * Config via env: PERSIST_URL (default the production backend).
 *
 * TO ACTUALLY APPLY the backfill after reviewing this report: use the product
 * UI — Key Registry → "Import from Excel" → upload the same file → check
 * "Also update N existing records" before confirming. That path fills only
 * empty fields and never overwrites populated values (same rule this dry-run
 * reports against), and is the one already covered by the test suite.
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';

const BASE = (process.env.PERSIST_URL || 'https://citywide-backend-0xuj.onrender.com').replace(/\/$/, '');

function ask(question: string, hidden: boolean): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    if (!hidden) {
      rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); });
      return;
    }
    // Hide password input: intercept the writable stream while this question is active.
    const stdout = process.stdout as any;
    const originalWrite = stdout.write.bind(stdout);
    let muted = false;
    stdout.write = (chunk: any, ...args: any[]) => {
      if (muted && typeof chunk === 'string' && !chunk.includes(question)) return true;
      return originalWrite(chunk, ...args);
    };
    rl.question(question, (answer) => {
      stdout.write = originalWrite;
      rl.close();
      console.log('');
      resolve(answer.trim());
    });
    muted = true;
  });
}

async function login(): Promise<string> {
  const email = process.env.CW_EMAIL || (await ask('Email: ', false));
  const password = process.env.CW_PASSWORD || (await ask('Password (hidden): ', true));
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    console.error(`\nLogin failed against ${BASE} (HTTP ${res.status}). Check email/password.`);
    process.exit(1);
  }
  return ((await res.json()) as { token: string }).token;
}

function buildMultipart(filePath: string): { body: Buffer; boundary: string } {
  const boundary = `----report${Date.now()}`;
  const fileBuf = fs.readFileSync(filePath);
  const filename = path.basename(filePath);
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { body: Buffer.concat([head, fileBuf, tail]), boundary };
}

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error('Usage: report-backfill-dry-run.ts /path/to/registry.xlsx');
    process.exit(1);
  }
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  console.log(`\nTarget: ${BASE}`);
  const token = await login();
  const auth = { Authorization: `Bearer ${token}` };

  // Step 1 — preview (this is where the hardened header mapping runs).
  const { body, boundary } = buildMultipart(filePath);
  const previewRes = await fetch(`${BASE}/api/accounts/import`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body: body as any,
  });
  const preview = (await previewRes.json()) as any;
  if (!previewRes.ok) {
    console.error(`\nPreview failed (HTTP ${previewRes.status}): ${preview.error || JSON.stringify(preview)}`);
    if (preview.unmappedHeaders?.length) {
      console.error(`Unrecognized columns: ${preview.unmappedHeaders.join(', ')}`);
    }
    process.exit(1);
  }

  console.log('\n── COLUMN MAPPING ──────────────────────────────────────');
  console.log(`Recognized (${preview.mappedHeaders.length}): ${preview.mappedHeaders.join(', ')}`);
  if (preview.unmappedHeaders.length > 0) {
    console.log(`\n⚠ NOT recognized (${preview.unmappedHeaders.length}) — these columns will be IGNORED:`);
    console.log(`  ${preview.unmappedHeaders.join(', ')}`);
    console.log('  If any of these should map to a real field, that IS the bug — tell me the exact text above.');
  } else {
    console.log('All columns recognized — no mapping gap in this file.');
  }
  if (preview.fieldCollisions?.length > 0) {
    console.log(`\n⚠ ${preview.fieldCollisions.length} field(s) claimed by more than one column (first non-blank per row wins, but disambiguate the sheet if possible):`);
    for (const c of preview.fieldCollisions) console.log(`  ${c.field}: ${c.headers.join(' + ')}`);
  }

  console.log(`\nSheet rows: ${preview.total} total | ${preview.valid.length} new | ${preview.warnings.length} match an existing bc_client_number | ${preview.errors.length} invalid`);

  // Step 2 — dry-run against rows that match an EXISTING account (that's the
  // backfill population); include `valid` too so unmatched ones show as such.
  const rowsToCheck = [...preview.warnings.map((w: any) => w.data), ...preview.valid];
  const dryRes = await fetch(`${BASE}/api/accounts/import/dry-run`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ rows: rowsToCheck }),
  });
  const dry = (await dryRes.json()) as any;
  if (!dryRes.ok) {
    console.error(`\nDry-run failed (HTTP ${dryRes.status}): ${dry.error || JSON.stringify(dry)}`);
    process.exit(1);
  }

  console.log('\n── BACKFILL DRY-RUN (writes nothing) ───────────────────');
  console.log(`Matched existing rows by bc_client_number: ${dry.matched}`);
  console.log(`Unmatched (no existing row / would be a new insert): ${dry.unmatched}`);
  console.log(`Rows that would receive at least one backfilled field: ${dry.rowsWithFills}`);
  console.log('\nWould fill (field: row count):');
  const fields = Object.keys(dry.wouldFill);
  if (fields.length === 0) {
    console.log('  (nothing — every matched row already has these fields populated)');
  } else {
    for (const f of fields.sort((a, b) => dry.wouldFill[b] - dry.wouldFill[a])) {
      console.log(`  ${f.padEnd(24)} ${dry.wouldFill[f]}`);
    }
  }

  console.log('\n── TO APPLY FOR REAL ───────────────────────────────────');
  console.log('Key Registry → "Import from Excel" → upload this same file →');
  console.log('check "Also update N existing records" → Import.');
  console.log('That path fills ONLY empty fields and never overwrites populated ones.\n');
}

main().catch((err) => {
  console.error('\nError:', err?.message || err);
  process.exit(1);
});
