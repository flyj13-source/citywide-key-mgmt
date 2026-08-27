// ── Key Registry action row ──────────────────────────────────────────────────
// Every action stays on the page — nothing hides behind an overflow menu. The
// row is organised by WEIGHT instead: filled red for the daily custody moves,
// charcoal outline for record-keeping, borderless for reports and admin. Three
// groups, thin dividers between them, wrapping as whole groups on narrow
// screens rather than collapsing into a menu.

import type { ReactNode } from 'react';

/** 34px tall, 8px gaps — dense enough that eleven buttons stay one glance. */
const BASE =
  'inline-flex items-center gap-1.5 h-[34px] px-3 rounded text-sm font-medium ' +
  'whitespace-nowrap transition-colors disabled:cursor-not-allowed';

export type ActionWeight = 'primary' | 'secondary' | 'tertiary';

const WEIGHT: Record<ActionWeight, string> = {
  // Group 1 — the daily custody actions. Only these are filled.
  primary: 'bg-[#C0272D] text-white hover:bg-[#a82227] disabled:opacity-50',
  // Group 2 — records. Present, outlined, not shouting.
  secondary:
    'bg-white border border-[#1a1a1a] text-[#1a1a1a] ' +
    'hover:border-[#C0272D] hover:text-[#C0272D] disabled:opacity-50',
  // Group 3 — reports and admin. Text with an icon, no border at all.
  tertiary:
    'bg-transparent text-[#6b6b68] hover:bg-[#f0f0ee] hover:text-[#1a1a1a] ' +
    'disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-[#6b6b68]',
};

/** Tertiary, but red on HOVER only — never sitting there red at rest. */
const DANGER =
  'bg-transparent text-[#6b6b68] hover:bg-[#fbeaea] hover:text-[#C0272D] ' +
  'disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-[#6b6b68]';

export function ActionButton({
  icon, label, onClick, weight, disabled, danger, title,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  weight: ActionWeight;
  disabled?: boolean;
  danger?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`${BASE} ${danger ? DANGER : WEIGHT[weight]}`}
    >
      {icon}
      {/* Never icon-only: at eleven buttons the labels are what make the row
          scannable, so they are not hidden at any breakpoint. */}
      <span>{label}</span>
    </button>
  );
}

/** A hairline between groups. Purely decorative, so it is hidden from AT. */
export function ActionDivider() {
  return (
    <span
      aria-hidden="true"
      className="self-center h-[22px] w-px shrink-0 mx-1"
      style={{ background: 'var(--cw-border)', transform: 'scaleX(0.5)' }}
    />
  );
}

/**
 * One weight group. `flex-nowrap` keeps its own buttons together, so wrapping
 * happens BETWEEN groups — the row breaks into tidy lines instead of orphaning
 * a single button onto the next row.
 */
export function ActionGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="group" aria-label={label} className="flex flex-nowrap items-center gap-2">
      {children}
    </div>
  );
}

export function ActionRow({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-y-2 justify-end">{children}</div>
  );
}
