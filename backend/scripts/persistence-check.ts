/**
 * TIER 2 — PERSISTENCE GAUNTLET (runs against LIVE production)
 *
 * Proves a record written to prod survives a Render deploy / spin-down cycle.
 *
 *   npm run persist:check      → write a sentinel customer, then deploy/restart
 *   npm run persist:verify     → confirm it survived, then delete it
 *   npm run persist:snapshot   → record the current customer count
 *   npm run persist:verify -- --full   → also compare total count to snapshot
 *
 * Config via env:
 *   PERSIST_URL       base URL (default https://citywide-backend.onrender.com)
 *   PERSIST_EMAIL     login email (default cara@citywideboston.com)
 *   PERSIST_PASSWORD  login password (default demo1234)
 */

import fs from 'fs';
import path from 'path';

const BASE = (process.env.PERSIST_URL || 'https://citywide-backend.onrender.com').replace(/\/$/, '');
const EMAIL = process.env.PERSIST_EMAIL || 'cara@citywideboston.com';
const PASSWORD = process.env.PERSIST_PASSWORD || 'demo1234';

const SENTINEL_FILE = path.join(__dirname, '..', '.persist-sentinel.json');
const SNAPSHOT_FILE = path.join(__dirname, '..', '.persist-snapshot.json');
const SENTINEL_NAME = 'PERSIST-CHECK';
const SENTINEL_CLIENT_NO = '99999';

function die(msg: string): never {
  console.error(`\n\x1b[41m\x1b[97m FAIL \x1b[0m ${msg}\n`);
  process.exit(1);
}
function pass(msg: string) {
  console.log(`\n\x1b[42m\x1b[30m PASS \x1b[0m ${msg}\n`);
}

async function login(): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) die(`Login failed against ${BASE} (HTTP ${res.status}). Check PERSIST_* env.`);
  return ((await res.json()) as { token: string }).token;
}

async function findSentinels(token: string): Promise<any[]> {
  const res = await fetch(`${BASE}/api/accounts?search=${encodeURIComponent(SENTINEL_NAME)}&limit=1000`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) die(`GET /api/accounts failed (HTTP ${res.status})`);
  const body = (await res.json()) as { accounts: any[] };
  return body.accounts.filter((a) => a.ic_company_name === SENTINEL_NAME);
}

async function customerCount(token: string): Promise<number> {
  const res = await fetch(`${BASE}/api/accounts?type=customer&limit=1`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) die(`GET customer count failed (HTTP ${res.status})`);
  return ((await res.json()) as { total: number }).total;
}

async function write() {
  const token = await login();
  const timestamp = new Date().toISOString();
  const res = await fetch(`${BASE}/api/accounts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      record_type: 'customer',
      ic_company_name: SENTINEL_NAME,
      bc_client_number: SENTINEL_CLIENT_NO,
      notes: `persist-check ts=${timestamp}`,
    }),
  });
  if (!res.ok) die(`Failed to write sentinel (HTTP ${res.status})`);
  const body = (await res.json()) as { id: number };
  fs.writeFileSync(SENTINEL_FILE, JSON.stringify({ id: body.id, timestamp, base: BASE }, null, 2));

  console.log(`\nSentinel written to ${BASE} (id=${body.id}, ts=${timestamp}).`);
  console.log('Now trigger a Render deploy (or wait for a spin-down cycle), then run:');
  console.log('\n    npm run persist:verify\n');
}

async function verify(full: boolean) {
  if (!fs.existsSync(SENTINEL_FILE)) {
    die(`No sentinel record found (${SENTINEL_FILE}). Run "npm run persist:check" first.`);
  }
  const sentinel = JSON.parse(fs.readFileSync(SENTINEL_FILE, 'utf8')) as {
    id: number; timestamp: string; base: string;
  };
  const token = await login();

  const matches = await findSentinels(token);
  const survivor = matches.find((a) => (a.notes || '').includes(`ts=${sentinel.timestamp}`));

  if (!survivor) {
    die(
      `Sentinel with ts=${sentinel.timestamp} is MISSING after restart/deploy. ` +
      `DATA DID NOT PERSIST. (${matches.length} PERSIST-CHECK rows present, none matching.)`
    );
  }

  if (full) {
    if (!fs.existsSync(SNAPSHOT_FILE)) {
      die('--full requested but no snapshot. Run "npm run persist:snapshot" before the deploy.');
    }
    const snap = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8')) as { customers: number };
    const now = await customerCount(token);
    // The sentinel itself adds 1 to the count captured after the snapshot.
    if (now < snap.customers) {
      die(`Customer count dropped: snapshot=${snap.customers} now=${now}. Records were lost.`);
    }
    console.log(`✓ Count check: snapshot=${snap.customers}, now=${now} (>= snapshot).`);
  }

  // Clean up: delete every PERSIST-CHECK row so prod stays clean.
  for (const row of matches) {
    const del = await fetch(`${BASE}/api/accounts/${row.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!del.ok) console.warn(`  ! could not delete sentinel id=${row.id} (HTTP ${del.status})`);
  }
  fs.rmSync(SENTINEL_FILE, { force: true });

  pass(`Sentinel survived (ts=${sentinel.timestamp}). Data persisted across the cycle. Prod cleaned up.`);
}

async function snapshot() {
  const token = await login();
  const customers = await customerCount(token);
  fs.writeFileSync(
    SNAPSHOT_FILE,
    JSON.stringify({ customers, at: new Date().toISOString(), base: BASE }, null, 2)
  );
  console.log(`\nSnapshot saved: ${customers} customers (${BASE}) → ${SNAPSHOT_FILE}\n`);
}

async function main() {
  const mode = process.argv[2];
  const full = process.argv.includes('--full');
  switch (mode) {
    case 'write': return write();
    case 'verify': return verify(full);
    case 'snapshot': return snapshot();
    default:
      console.error('Usage: persistence-check.ts <write|verify|snapshot> [--full]');
      process.exit(1);
  }
}

main().catch((err) => die(err?.message || String(err)));
