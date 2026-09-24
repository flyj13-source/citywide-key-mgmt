// ── City Wide's custody vocabulary ───────────────────────────────────────────
// City Wide says "Check In" for keys going OUT to a holder and "Check Out" for
// keys coming BACK — the reverse of the words this system was built with. The
// labels in the code were swapped to match; the records, statuses, routes and
// audit action names were not (checkout() still issues, 'checked_out' still
// means the holder has the keys).
//
// Text that was STORED before the swap — audit summaries and notes — still
// uses the old words. This rewrites it for display so the Audit Log reads in
// one vocabulary. It is applied at render only; nothing stored is changed.

const RE = /\b(check)(ed|ing|s)?([ -])(in|out)\b/gi;

const flip = (w: string): string => {
  const next = w.toLowerCase() === 'in' ? 'out' : 'in';
  if (w === w.toUpperCase()) return next.toUpperCase();
  if (w[0] === w[0].toUpperCase()) return next[0].toUpperCase() + next.slice(1);
  return next;
};

/** "checked out to Dana" (stored, old words) → "checked in to Dana". */
export const toCityWideWording = (s: string): string =>
  s.replace(RE, (_m, a: string, b: string | undefined, sep: string, w: string) => a + (b ?? '') + sep + flip(w));
