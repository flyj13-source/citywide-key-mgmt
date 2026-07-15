/**
 * PRODUCTION DATA-SURVIVAL GAUNTLET (Layer 3)
 *
 * Proves data written to LIVE prod survives a real deploy.
 *
 *   npm run gauntlet:write   → login as the test user, write a sentinel
 *                              customer, snapshot total counts, print next step.
 *   npm run gauntlet:verify  → fresh login, confirm the sentinel survived with a
 *                              matching timestamp + counts, PASS/FAIL loudly,
 *                              then delete the sentinel.
 *   npm run gauntlet:full    → write → trigger the deploy via the Render API →
 *                              poll until the new build is live → verify. One shot.
 *   npm run gauntlet:cleanup → find + delete ANY stray sentinel (current or
 *                              legacy PERSIST-CHECK naming), no snapshot needed.
 *                              Use this if a write/full ran but verify never did.
 *
 * Auth: ALWAYS the test account (never Cara). Config via env:
 *   PERSIST_URL         base URL (default https://citywide-backend-0xuj.onrender.com)
 *   TEST_USER_EMAIL     default test@citywideboston.com
 *   TEST_USER_PASSWORD  required
 *   RENDER_API_KEY      (full mode) read from env or citywide-key-mgmt/.env.render
 *   RENDER_SERVICE_ID   default srv-d8kd6cbbc2fs73cesejg
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';

const BASE = (process.env.PERSIST_URL || 'https://citywide-backend-0xuj.onrender.com').replace(/\/$/, '');
const EMAIL = process.env.TEST_USER_EMAIL || 'test@citywideboston.com';
const PASSWORD = process.env.TEST_USER_PASSWORD || '';
const SERVICE_ID = process.env.RENDER_SERVICE_ID || 'srv-d8kd6cbbc2fs73cesejg';

const SNAPSHOT_FILE = path.join(__dirname, '..', 'gauntlet-snapshot.json');
const SENTINEL_NAME = 'GAUNTLET-SENTINEL';
const SENTINEL_BC = '99901';

function die(msg: string): never {
  console.error(`\n\x1b[41m\x1b[97m FAIL \x1b[0m ${msg}\n`);
  process.exit(1);
}
function pass(msg: string) {
  console.log(`\n\x1b[42m\x1b[30m PASS \x1b[0m ${msg}\n`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function renderKey(): string {
  if (process.env.RENDER_API_KEY) return process.env.RENDER_API_KEY;
  for (const p of [path.join(__dirname, '..', '..', '.env.render'), path.join(__dirname, '..', '.env.render')]) {
    if (fs.existsSync(p)) {
      const m = fs.readFileSync(p, 'utf8').match(/rnd_[A-Za-z0-9]+/);
      if (m) return m[0];
    }
  }
  die('RENDER_API_KEY not found (env or .env.render). Needed for gauntlet:full.');
}

async function login(): Promise<string> {
  if (!PASSWORD) die('TEST_USER_PASSWORD is not set. The gauntlet authenticates as the test user only.');
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) die(`Login as ${EMAIL} failed against ${BASE} (HTTP ${res.status}).`);
  return ((await res.json()) as { token: string }).token;
}

async function count(token: string, type: 'customer' | 'ic'): Promise<number> {
  const res = await fetch(`${BASE}/api/accounts?type=${type}&limit=1`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) die(`Count (${type}) failed (HTTP ${res.status}).`);
  return ((await res.json()) as { total: number }).total;
}

async function findSentinel(token: string): Promise<any | null> {
  const res = await fetch(`${BASE}/api/accounts?search=${encodeURIComponent(SENTINEL_NAME)}&limit=50`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) die(`Sentinel search failed (HTTP ${res.status}).`);
  const body = (await res.json()) as { accounts: any[] };
  return body.accounts.find((a) => a.ic_company_name === SENTINEL_NAME) || null;
}

// Names used by this script AND its now-superseded predecessor
// (scripts/persistence-check.ts, which wrote ic_company_name='PERSIST-CHECK').
// A sentinel is orphaned whenever `write` ran but `verify` never got to its
// cleanup step (crash, forgotten follow-up, or a `full` that failed mid-poll).
const KNOWN_SENTINEL_NAMES = [SENTINEL_NAME, 'PERSIST-CHECK'];

async function findAllSentinels(token: string): Promise<any[]> {
  const found: any[] = [];
  for (const name of KNOWN_SENTINEL_NAMES) {
    const res = await fetch(`${BASE}/api/accounts?search=${encodeURIComponent(name)}&limit=100`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) die(`Sentinel search failed (HTTP ${res.status}).`);
    const body = (await res.json()) as { accounts: any[] };
    found.push(...body.accounts.filter((a) => a.ic_company_name === name));
  }
  return found;
}

async function deleteAccount(token: string, id: number): Promise<boolean> {
  const res = await fetch(`${BASE}/api/accounts/${id}`, {
    method: 'DELETE', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ confirm: 'DELETE' }),
  });
  return res.ok;
}

// ── Standalone cleanup — no snapshot required. Finds every stray sentinel
// (current + legacy naming) and deletes it. Safe to run any time; safe to run
// repeatedly (no-op once prod is clean). This is the fix for the class of bug
// where `write` ran but a matching `verify` never did. ─────────────────────
async function cleanup() {
  const token = await login();
  const strays = await findAllSentinels(token);
  if (strays.length === 0) {
    pass('No stray sentinels found — prod is clean.');
    return;
  }
  console.log(`Found ${strays.length} stray sentinel(s):`);
  for (const s of strays) console.log(`  id=${s.id} name="${s.ic_company_name}" bc_client_number=${s.bc_client_number} notes="${s.notes}"`);
  let deleted = 0;
  for (const s of strays) {
    if (await deleteAccount(token, s.id)) deleted++;
    else console.warn(`  ! could not delete id=${s.id}`);
  }
  if (deleted === strays.length) pass(`Deleted ${deleted} stray sentinel(s). Prod is clean.`);
  else die(`Deleted ${deleted}/${strays.length} — some could not be removed, check above.`);
}

async function write() {
  const token = await login();
  // Warn (don't block) if a previous write's sentinel was never cleaned up —
  // re-running write would otherwise leave TWO orphans instead of one.
  const stale = await findAllSentinels(token);
  if (stale.length > 0) {
    console.warn(`⚠ ${stale.length} pre-existing sentinel(s) found before this write — a prior verify/cleanup never ran. Run "npm run gauntlet:cleanup" after this to sweep them all.`);
  }
  const timestamp = new Date().toISOString();
  const res = await fetch(`${BASE}/api/accounts`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      record_type: 'customer', ic_company_name: SENTINEL_NAME,
      bc_client_number: SENTINEL_BC, notes: `gauntlet ts=${timestamp}`,
    }),
  });
  if (!res.ok) die(`Failed to write sentinel (HTTP ${res.status}).`);
  const { id } = (await res.json()) as { id: number };

  const snap = { id, timestamp, base: BASE, customers: await count(token, 'customer'), ics: await count(token, 'ic') };
  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(snap, null, 2));

  console.log(`\nSentinel written to ${BASE} (id=${id}, ts=${timestamp}).`);
  console.log(`Snapshot: ${snap.customers} customers, ${snap.ics} ICs → ${SNAPSHOT_FILE}`);
  console.log('\nNow trigger a deploy, then run:  npm run gauntlet:verify\n');
  return snap;
}

async function verify(): Promise<void> {
  if (!fs.existsSync(SNAPSHOT_FILE)) die(`No snapshot (${SNAPSHOT_FILE}). Run gauntlet:write first.`);
  const snap = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8')) as any;
  const token = await login();

  const sentinel = await findSentinel(token);
  if (!sentinel) {
    die(`Sentinel is GONE after the deploy. DATA DID NOT SURVIVE. (expected ts=${snap.timestamp})`);
  }
  if (!(sentinel.notes || '').includes(`ts=${snap.timestamp}`)) {
    die(`Sentinel present but timestamp mismatch — the row was re-seeded, not persisted.\n` +
        `  expected ts=${snap.timestamp}\n  got notes="${sentinel.notes}"`);
  }
  const nowCustomers = await count(token, 'customer');
  const nowIcs = await count(token, 'ic');
  if (nowCustomers < snap.customers || nowIcs < snap.ics) {
    die(`Counts dropped — records were lost. snapshot(${snap.customers}c/${snap.ics}i) now(${nowCustomers}c/${nowIcs}i).`);
  }

  // Clean up: delete the sentinel so prod stays tidy.
  await fetch(`${BASE}/api/accounts/${sentinel.id}`, {
    method: 'DELETE', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ confirm: 'DELETE' }),
  }).catch(() => undefined);
  fs.rmSync(SNAPSHOT_FILE, { force: true });

  pass(`Sentinel survived (ts=${snap.timestamp}); counts held (${nowCustomers}c/${nowIcs}i). Data persists across deploys. Sentinel cleaned up.`);
}

async function triggerDeploy(): Promise<string> {
  const key = renderKey();
  console.log(`\nTriggering Render deploy for ${SERVICE_ID}…`);
  const res = await fetch(`https://api.render.com/v1/services/${SERVICE_ID}/deploys`, {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ clearCache: 'do_not_clear' }),
  });
  if (!res.ok) die(`Render deploy trigger failed (HTTP ${res.status}): ${await res.text()}`);
  const dep = (await res.json()) as { id: string };
  console.log(`Deploy ${dep.id} created. Waiting for it to go live…`);
  return dep.id;
}

async function waitForLive(deployId: string): Promise<void> {
  const key = renderKey();
  const deadline = Date.now() + 20 * 60 * 1000; // 20 min cap
  const dead = new Set(['build_failed', 'update_failed', 'canceled', 'deactivated', 'pre_deploy_failed']);
  while (Date.now() < deadline) {
    await sleep(10_000);
    const res = await fetch(`https://api.render.com/v1/services/${SERVICE_ID}/deploys/${deployId}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!res.ok) { console.log(`  …deploy status check HTTP ${res.status}, retrying`); continue; }
    const status = ((await res.json()) as any).status as string;
    console.log(`  …deploy status: ${status}`);
    if (status === 'live') break;
    if (dead.has(status)) die(`Deploy ${deployId} ended as "${status}" — cannot verify.`);
  }
  // Confirm the app is actually answering after the restart.
  for (let i = 0; i < 30; i++) {
    try {
      const h = await fetch(`${BASE}/api/health`);
      if (h.ok) { console.log('Health check OK — new build is serving.'); return; }
    } catch { /* service still restarting */ }
    await sleep(5_000);
  }
  die('New build went live but /api/health never responded.');
}

async function full() {
  await write();
  const deployId = await triggerDeploy();
  await waitForLive(deployId);
  await verify();
}

async function main() {
  const mode = process.argv[2];
  switch (mode) {
    case 'write': await write(); return;
    case 'verify': await verify(); return;
    case 'full': await full(); return;
    case 'cleanup': await cleanup(); return;
    default:
      console.error('Usage: gauntlet.ts <write|verify|full|cleanup>');
      process.exit(1);
  }
}

main().catch((err) => die(err?.message || String(err)));
