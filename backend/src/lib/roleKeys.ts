// Role key totals are COMPUTED from the per-type breakdown:
//   am_keys = am_metal_keys + am_key_cards + am_key_fobs   (office tracked separately)
// …but legacy rows have a flat total with a zero breakdown, and must never be
// silently zeroed. roleTotal() encodes that rule.

export const num = (v: any): number =>
  v === undefined || v === null || v === '' ? 0 : Math.max(0, parseInt(String(v), 10) || 0);

/**
 * @param metal/cards/fobs  the per-type breakdown from the request
 * @param providedTotal     an explicit role total in the request (may be undefined)
 * @param prevBreakdownSum  sum of the row's stored breakdown before this write (PUT only)
 * @param existingTotal     the row's stored role total before this write (PUT only)
 */
export function roleTotal(
  metal: any, cards: any, fobs: any,
  providedTotal?: any, prevBreakdownSum = 0, existingTotal = 0,
): number {
  const sum = num(metal) + num(cards) + num(fobs);
  if (sum > 0) return sum;                 // a breakdown was entered → authoritative
  if (prevBreakdownSum > 0) return 0;      // had a breakdown, now cleared → honor 0
  // legacy / untouched → preserve whatever total came in (or the stored one)
  return providedTotal !== undefined && providedTotal !== null ? num(providedTotal) : num(existingTotal);
}
