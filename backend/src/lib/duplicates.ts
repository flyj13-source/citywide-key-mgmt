// ── Possible duplicates ──────────────────────────────────────────────────────
// STRICTLY READ-ONLY. Nothing in this file writes, merges, archives or edits
// anything, and nothing that calls it may either. It reports candidate pairs
// and the evidence attached to each side, so a person can decide.
//
// That constraint is the whole design. "Ben Pritchard" and "Ben Pritchardq"
// look like an obvious typo until you find that the second one holds keys at
// four sites and the first holds none — at which point the interesting record
// is the one that looks wrong. An automatic merge would have destroyed exactly
// the evidence needed to make that call. So: surface, never act.
//
// The matching is deliberately loose enough to catch real typos and tight
// enough not to bury the list. Everything it finds is a CANDIDATE.

import db from './db';

export type DuplicateKind =
  | 'staff_name'        // same person, spelled differently
  | 'staff_email'       // one address, two names
  | 'ic_vendor_number'  // same vendor number on two records
  | 'ic_name'           // near-identical company, different vendor numbers
  | 'customer_number';  // same BC client number on two records

export type Population = 'staff' | 'ic' | 'customer';

export interface DuplicateSide {
  id: number;
  name: string;
  email: string | null;
  /** AM / CCM / Crew for staff; "IC Vendor" or "Customer" otherwise. */
  role: string;
  /** BC vendor or client number, where the record has one. */
  number: string | null;
  active: number;
  is_test: number;
  /** Clients this person is named on (staff), or sites linked (IC). */
  clients_linked: number;
  /** Keys attributed to them on the holder grid. */
  keys_held: number;
  /** Open custody records naming them. */
  active_custody: number;
  created_at: string | null;
}

export interface DuplicatePair {
  kind: DuplicateKind;
  population: Population;
  /** Why these two are on the list, in words a person can check. */
  reason: string;
  /** 'exact' when the match is unambiguous, 'near' when it is a judgement. */
  confidence: 'exact' | 'near';
  a: DuplicateSide;
  b: DuplicateSide;
}

// ── Normalization and distance ───────────────────────────────────────────────

/** Case, whitespace and punctuation stripped — "O'Brien, J." → "obrienj". */
export function normalizeName(raw: any): string {
  return String(raw ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')   // accents: "Tomás" and "Tomas" are one person
    .replace(/[^a-z0-9]+/g, '');
}

/**
 * Levenshtein distance, capped. The cap matters: this runs over every pair
 * within a bucket, and a full matrix on 600 long strings is wasted work when
 * anything past 2 is not a candidate anyway.
 */
export function levenshtein(a: string, b: string, cap = 3): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  const prev = new Array(b.length + 1);
  const cur = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let best = cur[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < best) best = cur[j];
    }
    // Every path through the rest of the matrix only grows, so once the whole
    // row exceeds the cap the answer cannot come back under it.
    if (best > cap) return cap + 1;
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
  }
  return prev[b.length];
}

/** Near-match threshold. Distance ≤ 2 catches "Pritchard" / "Pritchardq". */
const NEAR_DISTANCE = 2;

/**
 * Short names are not eligible for near-matching. At four characters a
 * distance of 2 is half the word — "Dan" and "Ben" would pair, and a list full
 * of false pairs is a list nobody reads.
 */
const MIN_NEAR_LENGTH = 5;

// ── Evidence ─────────────────────────────────────────────────────────────────

const one = (sql: string, ...p: any[]): any => {
  try {
    const raw = db.prepare(sql).get(...p) as any;
    return raw ? Object.assign({}, raw) : null;
  } catch { return null; }
};

const count = (sql: string, ...p: any[]): number => {
  const row = one(sql, ...p);
  return row ? Number(row.c) || 0 : 0;
};

/**
 * What is actually attached to a staff record. This is the column set that
 * decides which of two near-identical rows is the real one, so it is computed
 * per record rather than guessed from the name.
 */
function staffSide(row: any): DuplicateSide {
  const r = Object.assign({}, row);
  const name = String(r.name ?? '');
  const role = r.role_category === 'crew' || r.manager_type === 'crew' ? 'Crew'
    : r.manager_type === 'both' ? 'AM + CCM'
      : r.manager_type === 'ccm' ? 'CCM'
        : r.manager_type === 'account_manager' ? 'AM' : 'Staff';

  const clients = count(
    "SELECT COUNT(*) AS c FROM accounts WHERE record_type='customer' AND COALESCE(archived,0)=0 " +
    'AND (TRIM(account_manager) = TRIM(?) OR TRIM(ccm_manager) = TRIM(?))', name, name,
  );
  const keys = one(
    'SELECT COALESCE(SUM(CASE WHEN TRIM(account_manager) = TRIM(?) THEN COALESCE(am_keys,0) ELSE 0 END),0) ' +
    '+ COALESCE(SUM(CASE WHEN TRIM(ccm_manager) = TRIM(?) THEN COALESCE(ccm_keys,0) ELSE 0 END),0) AS c ' +
    "FROM accounts WHERE record_type='customer' AND COALESCE(archived,0)=0", name, name,
  );

  return {
    id: r.id, name, email: r.email ?? null, role, number: null,
    active: r.active === 0 ? 0 : 1,
    is_test: Number(r.is_test) === 1 ? 1 : 0,
    clients_linked: clients,
    keys_held: keys ? Number(keys.c) || 0 : 0,
    active_custody: count(
      "SELECT COUNT(*) AS c FROM key_assignments WHERE status='checked_out' AND LOWER(TRIM(assignee)) = LOWER(TRIM(?))",
      name,
    ),
    created_at: r.created_at ?? null,
  };
}

function accountSide(row: any, population: Population): DuplicateSide {
  const r = Object.assign({}, row);
  const name = String(r.ic_company_name ?? '');
  const isIc = population === 'ic';
  return {
    id: r.id,
    name,
    email: isIc ? (r.ic_email ?? null) : null,
    role: isIc ? 'IC Vendor' : 'Customer',
    number: (isIc ? r.bc_vendor_number : r.bc_client_number) ?? null,
    active: r.archived === 1 ? 0 : 1,
    is_test: Number(r.is_test) === 1 ? 1 : 0,
    // For a vendor, the clients that name it as their contractor.
    clients_linked: isIc
      ? count(
        "SELECT COUNT(*) AS c FROM accounts WHERE record_type='customer' AND COALESCE(archived,0)=0 " +
        'AND (TRIM(COALESCE(ic_name,\'\')) = TRIM(?) OR TRIM(COALESCE(bc_vendor_number,\'\')) = TRIM(?))',
        name, r.bc_vendor_number ?? '',
      )
      : 0,
    keys_held: Number(r.metal_keys ?? 0) + Number(r.key_cards ?? 0)
      + Number(r.has_fob ?? 0) + Number(r.dispenser_keys ?? 0),
    active_custody: count(
      "SELECT COUNT(*) AS c FROM key_assignments WHERE status='checked_out' AND (account_id = ? OR LOWER(TRIM(assignee)) = LOWER(TRIM(?)))",
      r.id, name,
    ),
    created_at: r.created_at ?? null,
  };
}

// ── Detection ────────────────────────────────────────────────────────────────

/** Pair key that does not depend on which side came first. */
const pairKey = (kind: string, a: number, b: number) =>
  `${kind}:${Math.min(a, b)}:${Math.max(a, b)}`;

export function findDuplicates(): DuplicatePair[] {
  const pairs: DuplicatePair[] = [];
  const seen = new Set<string>();
  const add = (p: DuplicatePair) => {
    const k = pairKey(p.kind, p.a.id, p.b.id);
    if (seen.has(k)) return;
    seen.add(k);
    pairs.push(p);
  };

  // ── Staff ──────────────────────────────────────────────────────────────────
  const staff = (db.prepare('SELECT * FROM staff_managers ORDER BY id ASC').all() as any[])
    .map((r) => Object.assign({}, r));
  const staffSides = new Map<number, DuplicateSide>();
  const sideOf = (row: any): DuplicateSide => {
    let s = staffSides.get(row.id);
    if (!s) { s = staffSide(row); staffSides.set(row.id, s); }
    return s;
  };

  // Exact after normalization — "Ben  Pritchard" and "ben pritchard".
  const byNorm = new Map<string, any[]>();
  for (const row of staff) {
    const n = normalizeName(row.name);
    if (!n) continue;
    if (!byNorm.has(n)) byNorm.set(n, []);
    byNorm.get(n)!.push(row);
  }
  for (const [, group] of byNorm) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        add({
          kind: 'staff_name', population: 'staff', confidence: 'exact',
          reason: 'Same name once case, spacing and punctuation are ignored',
          a: sideOf(group[i]), b: sideOf(group[j]),
        });
      }
    }
  }

  // Near-match. O(n²) over the roster, which is hundreds of rows, not the 578
  // client records — and the length guard rejects most pairs before the
  // distance is computed at all.
  const norms = staff
    .map((row) => ({ row, n: normalizeName(row.name) }))
    .filter((x) => x.n.length >= MIN_NEAR_LENGTH);
  for (let i = 0; i < norms.length; i++) {
    for (let j = i + 1; j < norms.length; j++) {
      const d = levenshtein(norms[i].n, norms[j].n, NEAR_DISTANCE);
      if (d === 0 || d > NEAR_DISTANCE) continue;
      add({
        kind: 'staff_name', population: 'staff', confidence: 'near',
        reason: `Names differ by ${d} character${d === 1 ? '' : 's'}`,
        a: sideOf(norms[i].row), b: sideOf(norms[j].row),
      });
    }
  }

  // One address on two different names. Often a shared mailbox rather than a
  // duplicate, which is exactly why this reports rather than merges.
  const byEmail = new Map<string, any[]>();
  for (const row of staff) {
    const e = String(row.email ?? '').trim().toLowerCase();
    if (!e) continue;
    if (!byEmail.has(e)) byEmail.set(e, []);
    byEmail.get(e)!.push(row);
  }
  for (const [email, group] of byEmail) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        if (normalizeName(group[i].name) === normalizeName(group[j].name)) continue; // already paired by name
        add({
          kind: 'staff_email', population: 'staff', confidence: 'exact',
          reason: `Both use ${email}`,
          a: sideOf(group[i]), b: sideOf(group[j]),
        });
      }
    }
  }

  // ── IC vendors ─────────────────────────────────────────────────────────────
  const ics = (db.prepare(
    "SELECT * FROM accounts WHERE (record_type='ic' OR record_type IS NULL) ORDER BY id ASC"
  ).all() as any[]).map((r) => Object.assign({}, r));
  const icSides = new Map<number, DuplicateSide>();
  const icSide = (row: any) => {
    let s = icSides.get(row.id);
    if (!s) { s = accountSide(row, 'ic'); icSides.set(row.id, s); }
    return s;
  };

  const byVendor = new Map<string, any[]>();
  for (const row of ics) {
    const v = String(row.bc_vendor_number ?? '').trim();
    if (!v) continue;
    if (!byVendor.has(v)) byVendor.set(v, []);
    byVendor.get(v)!.push(row);
  }
  for (const [vendor, group] of byVendor) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        add({
          kind: 'ic_vendor_number', population: 'ic', confidence: 'exact',
          reason: `Both carry vendor number ${vendor}`,
          a: icSide(group[i]), b: icSide(group[j]),
        });
      }
    }
  }

  // Near-identical company names on DIFFERENT vendor numbers — the case a
  // vendor-number check cannot see.
  const icNorms = ics
    .map((row) => ({ row, n: normalizeName(row.ic_company_name) }))
    .filter((x) => x.n.length >= MIN_NEAR_LENGTH);
  for (let i = 0; i < icNorms.length; i++) {
    for (let j = i + 1; j < icNorms.length; j++) {
      const va = String(icNorms[i].row.bc_vendor_number ?? '').trim();
      const vb = String(icNorms[j].row.bc_vendor_number ?? '').trim();
      if (va && vb && va === vb) continue;   // already reported above
      const d = levenshtein(icNorms[i].n, icNorms[j].n, NEAR_DISTANCE);
      if (d > NEAR_DISTANCE) continue;
      add({
        kind: 'ic_name', population: 'ic', confidence: d === 0 ? 'exact' : 'near',
        reason: d === 0
          ? 'Same company name, different vendor numbers'
          : `Company names differ by ${d} character${d === 1 ? '' : 's'}, and the vendor numbers differ`,
        a: icSide(icNorms[i].row), b: icSide(icNorms[j].row),
      });
    }
  }

  // ── Customers ──────────────────────────────────────────────────────────────
  const byClient = new Map<string, any[]>();
  const customers = (db.prepare(
    "SELECT * FROM accounts WHERE record_type='customer' ORDER BY id ASC"
  ).all() as any[]).map((r) => Object.assign({}, r));
  for (const row of customers) {
    const c = String(row.bc_client_number ?? '').trim();
    if (!c) continue;
    if (!byClient.has(c)) byClient.set(c, []);
    byClient.get(c)!.push(row);
  }
  for (const [num, group] of byClient) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        add({
          kind: 'customer_number', population: 'customer', confidence: 'exact',
          reason: `Both carry BC client number ${num}`,
          a: accountSide(group[i], 'customer'), b: accountSide(group[j], 'customer'),
        });
      }
    }
  }

  // Exact matches first — they need the least judgement — then by name so the
  // two halves of a pair are read together.
  return pairs.sort((x, y) => {
    if (x.confidence !== y.confidence) return x.confidence === 'exact' ? -1 : 1;
    if (x.population !== y.population) return x.population.localeCompare(y.population);
    return x.a.name.localeCompare(y.a.name);
  });
}

// ── The other half of the ask: who has no address ────────────────────────────

export interface NoEmailRecord {
  id: number;
  name: string;
  role: string;
  population: Population;
  active: number;
  is_test: number;
  clients_linked: number;
  keys_held: number;
  active_custody: number;
  created_at: string | null;
}

/**
 * Everyone a signature link cannot reach. Staff and IC vendors together,
 * because the consequence is identical: a custody event they can never sign.
 */
export function findMissingEmail(): NoEmailRecord[] {
  const out: NoEmailRecord[] = [];

  for (const raw of db.prepare(
    "SELECT * FROM staff_managers WHERE COALESCE(TRIM(email), '') = '' ORDER BY name ASC"
  ).all() as any[]) {
    const s = staffSide(raw);
    out.push({
      id: s.id, name: s.name, role: s.role, population: 'staff',
      active: s.active, is_test: s.is_test, clients_linked: s.clients_linked,
      keys_held: s.keys_held, active_custody: s.active_custody, created_at: s.created_at,
    });
  }

  for (const raw of db.prepare(
    "SELECT * FROM accounts WHERE (record_type='ic' OR record_type IS NULL) " +
    "AND COALESCE(archived,0)=0 AND COALESCE(TRIM(ic_email), '') = '' ORDER BY ic_company_name ASC"
  ).all() as any[]) {
    const s = accountSide(raw, 'ic');
    out.push({
      id: s.id, name: s.name, role: s.role, population: 'ic',
      active: s.active, is_test: s.is_test, clients_linked: s.clients_linked,
      keys_held: s.keys_held, active_custody: s.active_custody, created_at: s.created_at,
    });
  }

  return out;
}

/**
 * Totals for the chips and for the button that opens the view.
 *
 * Takes the SAME includeTest flag the list does, and must: a chip promising
 * ten pairs over a list showing two is worse than no chip at all. The fixtures
 * are a rich source of near-matches by design — "ZZ Test AM One" and "ZZ Test
 * AM Two" differ by two characters and four of them share one mailbox — so the
 * two numbers diverge sharply if the filters ever drift apart.
 */
export function duplicateSummary(includeTest = false): {
  pairs: number; exact: number; near: number;
  by_population: Record<Population, number>;
  no_email: number; staff_total: number; ic_total: number;
} {
  const testFree = (p: DuplicatePair) => includeTest || !(p.a.is_test === 1 || p.b.is_test === 1);
  const pairs = findDuplicates().filter(testFree);
  const by_population: Record<Population, number> = { staff: 0, ic: 0, customer: 0 };
  for (const p of pairs) by_population[p.population] += 1;

  const testClause = includeTest ? '' : 'AND COALESCE(is_test, 0) = 0';
  return {
    pairs: pairs.length,
    exact: pairs.filter((p) => p.confidence === 'exact').length,
    near: pairs.filter((p) => p.confidence === 'near').length,
    by_population,
    no_email: findMissingEmail().filter((r) => includeTest || r.is_test !== 1).length,
    staff_total: count(`SELECT COUNT(*) AS c FROM staff_managers WHERE 1=1 ${testClause}`),
    ic_total: count(
      "SELECT COUNT(*) AS c FROM accounts WHERE (record_type='ic' OR record_type IS NULL) " +
      `AND COALESCE(archived,0)=0 ${testClause}`,
    ),
  };
}
