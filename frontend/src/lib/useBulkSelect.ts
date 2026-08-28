// ── Bulk selection state ─────────────────────────────────────────────────────
// The registry table has THREE modes, and the whole point of this hook is that
// they never blur into each other:
//
//   1. SINGLE   — default. No checkboxes. A row click opens its detail.
//   2. BULK     — toggled on. Row clicks TOGGLE selection instead of opening.
//   3. ALL      — inside bulk mode only: the header checkbox takes the loaded
//                 page, and "Select all N matching" promotes to the entire
//                 filtered set server-side.
//
// Mode 3 exists because of the classic bug it prevents: the header checkbox on
// a paginated table selects the PAGE, and a user who then hits Archive believes
// they acted on all 577. Here the page selection and the full-set selection are
// different states that say different things on screen.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getAccountIds, type AccountIdItem } from './api';

export interface BulkSelection {
  bulkMode: boolean;
  enterBulk: () => void;
  exitBulk: () => void;
  toggleBulk: () => void;

  /** Ids explicitly selected. When `allMatching` is on this holds the full set. */
  selected: Set<number>;
  /** True once the selection has been promoted past the loaded page. */
  allMatching: boolean;
  /** Capability rows for the selection — record_type, managers, handover flags. */
  selectedItems: AccountIdItem[];
  count: number;

  /** Every row on the current page is selected. */
  allOnPageSelected: boolean;
  /** Some but not all — drives the header checkbox's indeterminate dash. */
  someOnPageSelected: boolean;

  toggleRow: (id: number, mods?: { shift?: boolean; meta?: boolean }) => void;
  toggleAllOnPage: () => void;
  promoteToAllMatching: () => Promise<void>;
  promoting: boolean;
  promoteError: string;
  clear: () => void;
}

export function useBulkSelect({
  rows, total, params, resetKey,
}: {
  /** The rows currently rendered (the loaded page). */
  rows: { id: number }[];
  /** Total matching the active filter, server-side. */
  total: number;
  /** The exact filter params the list was loaded with — reused for select-all. */
  params: Record<string, string>;
  /** Any change to this string exits bulk mode: tab, search, filter, page. */
  resetKey: string;
}): BulkSelection {
  const [bulkMode, setBulkMode] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [allMatching, setAllMatching] = useState(false);
  const [items, setItems] = useState<Map<number, AccountIdItem>>(new Map());
  const [promoting, setPromoting] = useState(false);
  const [promoteError, setPromoteError] = useState('');
  // Anchor for shift-click ranges — the last row toggled WITHOUT shift.
  const anchorRef = useRef<number | null>(null);

  const clear = useCallback(() => {
    setSelected(new Set());
    setAllMatching(false);
    setItems(new Map());
    setPromoteError('');
    anchorRef.current = null;
  }, []);

  const exitBulk = useCallback(() => { setBulkMode(false); clear(); }, [clear]);
  const enterBulk = useCallback(() => setBulkMode(true), []);
  const toggleBulk = useCallback(() => {
    setBulkMode((on) => { if (on) clear(); return !on; });
  }, [clear]);

  // A stale selection must never survive into a different view. Changing tab,
  // search, filter or page leaves bulk mode entirely rather than silently
  // carrying ids the user can no longer see.
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return; }
    setBulkMode(false);
    clear();
  }, [resetKey, clear]);

  // Escape exits bulk mode completely — mode and selection together, so one
  // key always returns the table to plain browsing.
  useEffect(() => {
    if (!bulkMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Don't steal Escape from an open modal or a focused text field.
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')) return;
      if (document.querySelector('[data-modal-open="true"]')) return;
      exitBulk();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [bulkMode, exitBulk]);

  const rowIds = useMemo(() => rows.map((r) => r.id), [rows]);

  const toggleRow = useCallback((id: number, mods?: { shift?: boolean; meta?: boolean }) => {
    setPromoteError('');
    setSelected((prev) => {
      const next = new Set(prev);

      // Shift-click: take the contiguous range from the anchor to here. The
      // range is ADDED, matching how file managers behave — it never clears
      // what is already picked elsewhere.
      if (mods?.shift && anchorRef.current !== null) {
        const a = rowIds.indexOf(anchorRef.current);
        const b = rowIds.indexOf(id);
        if (a !== -1 && b !== -1) {
          const [lo, hi] = a < b ? [a, b] : [b, a];
          for (let i = lo; i <= hi; i++) next.add(rowIds[i]);
          return next;
        }
      }

      // Plain click and Cmd/Ctrl-click both toggle just this row without
      // disturbing the rest; the modifier matters only for the anchor.
      if (next.has(id)) next.delete(id); else next.add(id);
      anchorRef.current = id;
      return next;
    });
    // Selecting by hand steps back out of "all matching" — the set is no
    // longer the whole filtered result, and the bar must stop claiming it is.
    setAllMatching(false);
  }, [rowIds]);

  const allOnPageSelected = rowIds.length > 0 && rowIds.every((id) => selected.has(id));
  const someOnPageSelected = !allOnPageSelected && rowIds.some((id) => selected.has(id));

  const toggleAllOnPage = useCallback(() => {
    setPromoteError('');
    setAllMatching(false);
    setSelected((prev) => {
      const every = rowIds.length > 0 && rowIds.every((id) => prev.has(id));
      const next = new Set(prev);
      // Only ever touches the VISIBLE rows — hidden and filtered-out rows are
      // not in rowIds, so they can't be swept up.
      if (every) rowIds.forEach((id) => next.delete(id));
      else rowIds.forEach((id) => next.add(id));
      return next;
    });
    anchorRef.current = null;
  }, [rowIds]);

  const promoteToAllMatching = useCallback(async () => {
    setPromoting(true);
    setPromoteError('');
    try {
      // Resolved server-side through the SAME filter builder the list uses, so
      // the promoted set is exactly what the user is looking at.
      const data = await getAccountIds(params);
      setSelected(new Set(data.ids));
      setItems(new Map(data.items.map((i) => [i.id, i])));
      setAllMatching(true);
      anchorRef.current = null;
    } catch (e: any) {
      setPromoteError(e.message || 'Could not select all matching records');
    } finally {
      setPromoting(false);
    }
  }, [params]);

  // Capability data for the toolbar: the promoted set carries its own items;
  // otherwise the loaded rows are the source.
  const selectedItems = useMemo(() => {
    if (allMatching && items.size) {
      return [...selected].map((id) => items.get(id)).filter(Boolean) as AccountIdItem[];
    }
    return (rows as any[])
      .filter((r) => selected.has(r.id))
      .map((r) => ({
        id: r.id, ic_company_name: r.ic_company_name, record_type: r.record_type,
        account_manager: r.account_manager, ccm_manager: r.ccm_manager,
        archived: r.archived ?? 0, pending_handover: r.pending_handover ?? 0,
      }));
  }, [allMatching, items, rows, selected]);

  return {
    bulkMode, enterBulk, exitBulk, toggleBulk,
    selected, allMatching, selectedItems, count: selected.size,
    allOnPageSelected, someOnPageSelected,
    toggleRow, toggleAllOnPage, promoteToAllMatching, promoting, promoteError,
    clear,
  };
}

/** Total matching the filter, for the "Select all N matching" offer. */
export function shouldOfferPromotion(count: number, pageCount: number, total: number): boolean {
  return count > 0 && count >= pageCount && total > pageCount;
}
