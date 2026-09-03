// ── Bulk selection toolbar ───────────────────────────────────────────────────
// Sits directly ABOVE the table and never replaces the main action row —
// everything stays visible. Charcoal bar, red primary actions, matching the
// weights of the action row above it.
//
// Two lines of state, in priority order:
//   • the promotion offer — "16 selected on this page. Select all 577 matching"
//   • the promoted state  — "All 577 selected. Clear selection"
// These are deliberately different sentences: a user must never be able to
// confuse a page selection with the whole filtered set.

import type { ReactNode } from 'react';
import type { AccountIdItem } from '../lib/api';
import { IconCheckOut, IconExport, IconReassign, IconDelete } from './Icons';

const BTN =
  'inline-flex items-center gap-1.5 h-[30px] px-2.5 rounded text-xs font-medium ' +
  'whitespace-nowrap transition-colors disabled:cursor-not-allowed';

function BarButton({
  icon, label, onClick, disabled, reason, primary,
}: {
  icon: ReactNode; label: string; onClick: () => void;
  disabled?: boolean; reason?: string; primary?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      // A disabled action always says WHY, so a greyed button is never a dead end.
      title={disabled ? reason : label}
      className={`${BTN} ${
        primary
          ? 'bg-[#C0272D] text-white hover:bg-[#a82227] disabled:opacity-40'
          : 'bg-transparent text-white/85 border border-white/25 hover:bg-white/10 hover:text-white disabled:opacity-35 disabled:hover:bg-transparent'
      }`}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

/**
 * What can this selection legally do? Every rule returns a reason string when
 * it says no, so the toolbar can explain the greyed button rather than just
 * disabling it.
 */
export function selectionCapabilities(items: AccountIdItem[]) {
  const n = items.length;
  const customers = items.filter((i) => i.record_type === 'customer');
  const allCustomers = n > 0 && customers.length === n;

  // Check Out is deliberately SINGLE-record. A check-out records specific key
  // types, quantities, a holder, a due date and a signature — all of which
  // differ per client. Applying one form to N clients would invent quantities
  // nobody entered; queueing N modals is worse than saying "one at a time".
  const checkOut = n === 1 && allCustomers
    ? { ok: true as const, reason: '' }
    : {
        ok: false as const,
        reason: n === 0 ? 'Select a customer first'
          : !allCustomers ? 'Check Out applies to customer sites only'
          : `Check Out handles one site at a time — ${n} are selected, and key types and quantities differ per site`,
      };

  // Reassign moves a manager's book. It only makes sense when every selected
  // client currently shares the same manager.
  const managers = new Set(items.map((i) => (i.account_manager || '').trim()).filter(Boolean));
  const reassign = !allCustomers
    ? { ok: false as const, reason: 'Reassign applies to customer sites only', shared: null as string | null }
    : managers.size === 1
      ? { ok: true as const, reason: '', shared: [...managers][0] }
      : {
          ok: false as const,
          shared: null as string | null,
          reason: managers.size === 0
            ? 'None of the selected sites has an account manager'
            : `The selected sites span ${managers.size} different account managers — reassign works on one manager's clients at a time`,
        };

  const alreadyArchived = items.filter((i) => i.archived === 1).length;
  const archive = n === 0
    ? { ok: false as const, reason: 'Select at least one record' }
    : alreadyArchived === n
      ? { ok: false as const, reason: 'Every selected record is already archived' }
      : { ok: true as const, reason: '' };

  return { checkOut, reassign, archive, allCustomers, alreadyArchived, customers };
}

export default function SelectionToolbar({
  count, total, pageCount, allMatching, items, canDelete,
  promoting, promoteError,
  onPromote, onClear, onExport, onReassign, onCheckOut, onArchive,
}: {
  count: number;
  total: number;
  pageCount: number;
  allMatching: boolean;
  items: AccountIdItem[];
  canDelete: boolean;
  promoting: boolean;
  promoteError: string;
  onPromote: () => void;
  onClear: () => void;
  onExport: () => void;
  onReassign: (sharedManager: string | null) => void;
  onCheckOut: () => void;
  onArchive: () => void;
}) {
  const cap = selectionCapabilities(items);
  // Offer the promotion only when the whole loaded page is taken and there is
  // genuinely more behind it.
  const offerPromotion = !allMatching && count > 0 && count >= pageCount && total > pageCount;

  return (
    <div className="rounded-t border-t-2 border-[#C0272D] bg-[#1a1a1a] text-white px-3 py-2 space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-sm font-semibold whitespace-nowrap">
          {allMatching ? `All ${count} selected` : `${count} selected`}
        </span>

        {/* The promotion offer and the promoted state are different sentences
            on purpose — page selection must never read as the whole set. */}
        {offerPromotion && (
          <span className="text-xs text-white/70 whitespace-nowrap">
            on this page.{' '}
            <button
              onClick={onPromote}
              disabled={promoting}
              className="underline underline-offset-2 text-white hover:text-[#ff9ba0] disabled:opacity-50"
            >
              {promoting ? 'Selecting…' : `Select all ${total} matching`}
            </button>
          </span>
        )}
        {allMatching && (
          <span className="text-xs text-white/70 whitespace-nowrap">
            across every page of this filter.
          </span>
        )}

        <span className="flex-1" />

        <div className="flex flex-wrap items-center gap-2 justify-end">
          <BarButton icon={<IconExport size={14} />} label="Export selected" onClick={onExport} primary />
          <BarButton
            icon={<IconCheckOut size={14} />} label="Check Out"
            onClick={onCheckOut} disabled={!cap.checkOut.ok} reason={cap.checkOut.reason}
          />
          <BarButton
            icon={<IconReassign size={14} />} label="Reassign Manager"
            onClick={() => onReassign(cap.reassign.shared)}
            disabled={!cap.reassign.ok} reason={cap.reassign.reason}
          />
          {canDelete && (
            <BarButton
              icon={<IconDelete size={14} />} label="Archive"
              onClick={onArchive} disabled={!cap.archive.ok} reason={cap.archive.reason}
            />
          )}
          <button
            onClick={onClear}
            className={`${BTN} bg-transparent text-white/70 hover:text-white hover:bg-white/10`}
          >
            {allMatching ? 'Clear selection' : 'Clear'}
          </button>
        </div>
      </div>

      {/* Persistent hint — while the table is in picking mode, say so. */}
      <div className="text-[11px] text-white/45">
        Click rows to select · Shift-click for a range · Esc to exit
      </div>

      {promoteError && (
        <div className="text-[11px] text-[#ff9ba0]">{promoteError}</div>
      )}
    </div>
  );
}
