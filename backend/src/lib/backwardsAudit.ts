// ── Backwards-entry audit (READ ONLY) ────────────────────────────────────────
// City Wide says "Check In" for issuing keys and "Check Out" for taking them
// back — the reverse of the labels this system shipped with. Until the labels
// were swapped, Cara's team pressed the button whose NAME matched their words,
// which recorded the opposite transaction.
//
// This finds the entries that pattern most likely produced. It changes nothing:
// every query is a SELECT, and the output is a list for a person to review.
//
//   A  RETURN LOGGED AS AN ISSUE — a check-out (issue) recorded while the same
//      holder already had an open record for the same key types at the same
//      client. Nobody is handed keys they are already holding; this is far more
//      likely to be those keys coming back.
//
//   B  HOLDERS SHOWING KEYS THEY LIKELY HANDED BACK — current open custody, per
//      holder per client, that is either (1) split across several overlapping
//      open records, or (2) more than the holder's own role cells on the client
//      grid say they hold.
//
//   C  THE MIRROR IMAGE, for context — first-time records ("Record Keys Held",
//      origin 'reconciled'), which is what pressing the old "Check In" button
//      to ISSUE keys produced when the holder had nothing open. Not flagged as
//      wrong: these are also exactly what a correct first-time record looks
//      like. Listed so the reviewer can check the ones they recognise.
//
// Transfers and voided records are excluded throughout: a transfer is its own
// two-sided transaction, and a voided record has already been dealt with.

import db from './db';
import { readKeyLines, summarizeKeys, KEY_TYPES, type KeyLine, type KeyTypeKey } from './custody';
import { holderKeysAtClient, hasGrid } from './roleScope';

const when = (v: any): number => {
  if (v == null || v === '') return NaN;
  const s = String(v);
  return new Date(/[TZ]|[+-]\d{2}:\d{2}$/.test(s) ? s : `${s.replace(' ', 'T')}Z`).getTime();
};
const who = (s: any) => String(s ?? '').trim().toLowerCase();

interface Rec {
  id: number; account_id: number | null; client: string; holder: string; holder_type: string;
  status: string; origin: string; checked_out_at: string; returned_at: string | null;
  recorded_by: string | null; checkin_recorded_by: string | null; lines: KeyLine[];
}

function loadRecords(includeTest: boolean): Rec[] {
  return (db.prepare(`
    SELECT ka.*, COALESCE(a.ic_company_name, ka.account_name) AS client_name
      FROM key_assignments ka
      LEFT JOIN accounts a ON a.id = ka.account_id
     WHERE ka.voided_at IS NULL
       AND COALESCE(ka.status, '') <> 'voided'
       AND ka.transfer_role IS NULL
       AND (? = 1 OR COALESCE(a.is_test, 0) = 0)
     ORDER BY ka.id ASC
  `).all(includeTest ? 1 : 0) as any[]).map((raw) => {
    const r = Object.assign({}, raw);
    return {
      id: Number(r.id), account_id: r.account_id ?? null, client: r.client_name ?? '—',
      holder: r.assignee, holder_type: r.holder_type ?? 'employee',
      status: r.status, origin: r.origin ?? 'checked_out',
      checked_out_at: r.checked_out_at, returned_at: r.returned_at ?? null,
      recorded_by: r.recorded_by ?? null, checkin_recorded_by: r.checkin_recorded_by ?? null,
      lines: readKeyLines(r),
    };
  });
}

const overlap = (a: KeyLine[], b: KeyLine[]): KeyLine[] => {
  const bq = new Map(b.map((l) => [l.type, l.qty]));
  return a.filter((l) => bq.has(l.type))
    .map((l) => ({ ...l, qty: Math.min(l.qty, bq.get(l.type)!) }));
};

export interface ReturnLoggedAsIssue {
  record_id: number; holder: string; client: string; account_id: number | null;
  keys: string; date: string; recorded_by: string | null; status_now: string;
  already_open: { record_id: number; since: string; keys: string; recorded_by: string | null };
}
export interface LikelyReturnedHolding {
  holder: string; client: string; account_id: number | null;
  open_keys: string; role_keys: string | null; excess: string | null;
  reason: string; records: { record_id: number; date: string; keys: string; recorded_by: string | null }[];
}
export interface FirstTimeRecord {
  record_id: number; holder: string; client: string; keys: string; date: string; recorded_by: string | null;
}

export function backwardsAudit(opts: { includeTest?: boolean } = {}): {
  generated_at: string;
  returns_logged_as_issues: ReturnLoggedAsIssue[];
  holdings_likely_returned: LikelyReturnedHolding[];
  first_time_records: FirstTimeRecord[];
} {
  // ZZ TEST fixtures are left out unless asked for — they are exercised on
  // purpose and would bury the real entries.
  const recs = loadRecords(!!opts.includeTest);
  // Issues only: a first-time record did not hand anyone anything.
  const issues = recs.filter((r) => r.origin !== 'reconciled' && r.lines.length);

  // ── A ──────────────────────────────────────────────────────────────────
  const A: ReturnLoggedAsIssue[] = [];
  for (const r2 of issues) {
    const t2 = when(r2.checked_out_at);
    const prior = issues.find((r1) =>
      r1.id !== r2.id
      && r1.account_id === r2.account_id
      && who(r1.holder) === who(r2.holder)
      && (when(r1.checked_out_at) < t2 || (when(r1.checked_out_at) === t2 && r1.id < r2.id))
      // still open at the moment r2 was recorded
      && (r1.returned_at == null || when(r1.returned_at) > t2)
      && overlap(r2.lines, r1.lines).length > 0);
    if (!prior) continue;
    A.push({
      record_id: r2.id, holder: r2.holder, client: r2.client, account_id: r2.account_id,
      keys: summarizeKeys(overlap(r2.lines, prior.lines)),
      date: r2.checked_out_at, recorded_by: r2.recorded_by, status_now: r2.status,
      already_open: {
        record_id: prior.id, since: prior.checked_out_at,
        keys: summarizeKeys(prior.lines), recorded_by: prior.recorded_by,
      },
    });
  }

  // ── B ──────────────────────────────────────────────────────────────────
  const open = issues.filter((r) => r.status === 'checked_out');
  const groups = new Map<string, Rec[]>();
  for (const r of open) {
    const k = `${r.account_id}|${who(r.holder)}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const B: LikelyReturnedHolding[] = [];
  for (const g of groups.values()) {
    const first = g[0];
    const byType = new Map<KeyTypeKey, number>();
    for (const r of g) for (const l of r.lines) byType.set(l.type, (byType.get(l.type) ?? 0) + l.qty);
    const openLines: KeyLine[] = KEY_TYPES.filter((t) => byType.get(t.key))
      .map((t) => ({ type: t.key, label: t.label, qty: byType.get(t.key)! }));

    const reasons: string[] = [];
    const overlapping = g.length > 1 && g.some((a, i) => g.slice(i + 1).some((b) => overlap(a.lines, b.lines).length));
    if (overlapping) reasons.push(`${g.length} open records for the same key types`);

    let roleText: string | null = null;
    let excessText: string | null = null;
    if (first.account_id && hasGrid(first.account_id)) {
      const role = holderKeysAtClient(first.account_id, first.holder, first.holder_type).filter((k) => k.qty > 0);
      roleText = role.length ? summarizeKeys(role) : 'none';
      const roleBy = new Map(role.map((k) => [k.type, k.qty]));
      const excess = openLines
        .map((l) => ({ ...l, qty: l.qty - (roleBy.get(l.type) ?? 0) }))
        .filter((l) => l.qty > 0);
      if (excess.length) {
        excessText = summarizeKeys(excess);
        reasons.push(`open custody is more than their role holds on the client grid (${roleText})`);
      }
    }
    if (!reasons.length) continue;
    B.push({
      holder: first.holder, client: first.client, account_id: first.account_id,
      open_keys: summarizeKeys(openLines), role_keys: roleText, excess: excessText,
      reason: reasons.join('; '),
      records: g.map((r) => ({
        record_id: r.id, date: r.checked_out_at, keys: summarizeKeys(r.lines), recorded_by: r.recorded_by,
      })),
    });
  }

  // ── C ──────────────────────────────────────────────────────────────────
  const C: FirstTimeRecord[] = recs
    .filter((r) => r.origin === 'reconciled' && r.lines.length)
    .map((r) => ({
      record_id: r.id, holder: r.holder, client: r.client, keys: summarizeKeys(r.lines),
      date: r.returned_at ?? r.checked_out_at, recorded_by: r.checkin_recorded_by ?? r.recorded_by,
    }));

  const newestFirst = <T extends { date: string }>(xs: T[]) => xs.sort((a, b) => when(b.date) - when(a.date));
  return {
    generated_at: new Date().toISOString(),
    returns_logged_as_issues: newestFirst(A),
    holdings_likely_returned: B.sort((a, b) => a.holder.localeCompare(b.holder)),
    first_time_records: newestFirst(C),
  };
}
