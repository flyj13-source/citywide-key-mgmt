import { useMemo } from 'react';
import type { HolderOption } from '../lib/api';
import TestPill from './TestPill';

// ── Holder list ──────────────────────────────────────────────────────────────
// Who is taking the keys. Deliberately SEPARATE from the account picker: an
// account is a place, a holder is a person, and collapsing the two is how a
// vendor company ends up recorded as having personally signed for a key.
//
// Grouped by what the person DOES — AM, CCM, AM + CCM, Crew, then the IC
// vendors and their named contacts — because a flat alphabetical list of 260
// names put the person standing in front of you in the middle of a scroll.
//
// A list, not a <select>: a native <option> cannot carry the red "no email"
// flag, and that flag is the one thing here that changes what happens next.
// No address means no signature link, and finding that out after submitting is
// far worse than seeing it while choosing.

export const ROLE_ORDER = ['AM', 'CCM', 'AM + CCM', 'Crew', 'IC Vendor', 'IC Contact'];

const ROLE_LABEL: Record<string, string> = {
  AM: 'Account Managers',
  CCM: 'Contract Compliance Managers',
  'AM + CCM': 'AM + CCM',
  Crew: 'Field Crew',
  'IC Vendor': 'Independent Contractors',
  'IC Contact': 'IC Primary Contacts',
};

/**
 * Stable option identity. A vendor and its named contact share one account id,
 * so anything matching on id alone makes the contact unselectable.
 */
export const holderKey = (o: HolderOption) => o.key ?? `${o.type}:${o.id ?? 'unlinked'}`;

export const sameHolder = (a: HolderOption | null, b: HolderOption | null) =>
  !!a && !!b && a.type === b.type && a.name === b.name;

export function groupHolders(
  options: { employees: HolderOption[]; ics: HolderOption[] },
  query: string,
  exclude?: string,
) {
  const q = query.trim().toLowerCase();
  const skip = (exclude ?? '').trim().toLowerCase();
  const match = (o: HolderOption) =>
    (!q || o.name.toLowerCase().includes(q) || (o.email || '').toLowerCase().includes(q)
      || (o.detail || '').toLowerCase().includes(q))
    && (!skip || o.name.trim().toLowerCase() !== skip);

  const by = new Map<string, HolderOption[]>();
  for (const o of [...options.employees, ...options.ics].filter(match)) {
    const role = o.role ?? (o.type === 'ic' ? 'IC Vendor' : 'Crew');
    if (!by.has(role)) by.set(role, []);
    by.get(role)!.push(o);
  }
  return ROLE_ORDER.filter((r) => by.get(r)?.length)
    .map((r) => ({ role: r, label: ROLE_LABEL[r] ?? r, items: by.get(r)! }));
}

export default function HolderList({
  options, query, value, onSelect, loading = false, exclude, emptyNote,
}: {
  options: { employees: HolderOption[]; ics: HolderOption[] };
  query: string;
  value: HolderOption | null;
  onSelect: (h: HolderOption) => void;
  loading?: boolean;
  /** A name to leave out — the FROM holder on a transfer cannot also be the TO. */
  exclude?: string;
  emptyNote: string;
}) {
  const groups = useMemo(() => groupHolders(options, query, exclude), [options, query, exclude]);
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  const noEmail = flat.filter((o) => !o.email).length;

  return (
    <>
      <div className="border border-cw-border rounded max-h-56 overflow-y-auto divide-y divide-gray-100">
        {loading ? (
          <div className="px-3 py-3 text-sm text-cw-muted">Loading roster…</div>
        ) : flat.length === 0 ? (
          <div className="px-3 py-3 text-sm text-cw-muted">
            {query.trim() ? `Nobody matches “${query.trim()}”` : emptyNote}
          </div>
        ) : groups.map((g) => (
          <div key={g.role}>
            <div className="sticky top-0 z-10 px-3 py-1.5 bg-[#1a1a1a] text-white text-[10px] font-bold uppercase tracking-wider">
              {g.label}
            </div>
            {g.items.map((o) => {
              const selected = !!value && holderKey(value) === holderKey(o);
              return (
                <button
                  key={holderKey(o)}
                  type="button"
                  onClick={() => onSelect(o)}
                  className={`w-full text-left px-3 py-2 text-sm flex items-center gap-2 ${
                    selected ? 'bg-[#fbeaea]' : o.is_test === 1 ? 'bg-[#fefaed]' : 'hover:bg-gray-50'
                  }`}
                >
                  {o.is_test === 1 && <TestPill className="mr-0" />}
                  <span className="truncate text-[#1a1a1a]">{o.name}</span>
                  {o.email ? (
                    <span className="ml-auto shrink-0 text-[11px] text-cw-muted truncate max-w-[13rem]">{o.email}</span>
                  ) : (
                    <span
                      className="ml-auto shrink-0 inline-flex items-center rounded-full border border-[#C0272D] bg-[#fbeaea] text-[#C0272D] px-2 py-[1px] text-[10px] font-semibold whitespace-nowrap"
                      title="No address on file — the sign-off link cannot be delivered"
                    >
                      no email — signature cannot be sent
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </div>
      {/* Said once, up front: the gap is a roster problem, and knowing how many
          people carry it is what gets it fixed. */}
      {!loading && noEmail > 0 && (
        <p className="text-[11px] text-cw-muted">
          {noEmail} of {flat.length} shown {noEmail === 1 ? 'has' : 'have'} no email on file.
        </p>
      )}
    </>
  );
}
