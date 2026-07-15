// Holder × type grid — TRANSPOSED model. Rows are key TYPES (Metal, Key Card,
// Key Fob, Dispenser); columns are HOLDERS (AM, CCM, Contractor/IC, Office —
// Office is a holder, not a type). Two kinds of computed-and-stored totals:
//
//   COLUMN totals (am_keys, ccm_keys, contractor_keys, office_keys_held):
//     sum of that holder's 4 type cells.
//   ROW totals (metal_keys, key_cards, has_fob, dispenser_keys — the
//     client-site "Key Inventory" fields): sum of that type's 4 holder cells.
//
// Both follow the same "never silently zero existing data" rule: if the grid
// has data, the grid is authoritative; if the grid is empty (all 4 cells 0),
// preserve whatever total was already there (a legacy import, or a value the
// caller is passing through unchanged).

export const num = (v: any): number =>
  v === undefined || v === null || v === '' ? 0 : Math.max(0, parseInt(String(v), 10) || 0);

/**
 * @param a/b/c/d          the four grid cells for this total (any order, as
 *                         long as callers are consistent)
 * @param providedTotal    an explicit total in the request (may be undefined)
 * @param prevCellSum      sum of the row's stored cells before this write (PUT only)
 * @param existingTotal    the row's stored total before this write (PUT only)
 */
export function gridTotal(
  a: any, b: any, c: any, d: any,
  providedTotal?: any, prevCellSum = 0, existingTotal = 0,
): number {
  const sum = num(a) + num(b) + num(c) + num(d);
  if (sum > 0) return sum;                 // cells were entered → authoritative
  if (prevCellSum > 0) return 0;           // had cells, now cleared → honor 0
  // legacy / untouched → preserve whatever total came in (or the stored one)
  return providedTotal !== undefined && providedTotal !== null ? num(providedTotal) : num(existingTotal);
}

// Back-compat alias: the 3-cell (metal+card+fob) role total, used before
// dispenser was added to the per-holder breakdown. Equivalent to gridTotal
// with a 0 dispenser cell.
export function roleTotal(
  metal: any, cards: any, fobs: any,
  providedTotal?: any, prevBreakdownSum = 0, existingTotal = 0,
): number {
  return gridTotal(metal, cards, fobs, 0, providedTotal, prevBreakdownSum, existingTotal);
}
