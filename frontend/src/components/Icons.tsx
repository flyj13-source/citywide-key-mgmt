// ── Tabler icons, inline ─────────────────────────────────────────────────────
// No icon font is bundled, so each glyph is the Tabler outline path data drawn
// straight into an SVG. Every icon shares the Tabler geometry: 24×24 viewBox,
// 2px stroke, round caps and joins, no fill — so they sit on a text baseline
// at any size without looking heavier than the label beside them.

type IconProps = { size?: number; className?: string };

function Svg({ size = 16, className, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/** ti-logout — keys leaving the cabinet. */
export const IconCheckOut = (p: IconProps) => (
  <Svg {...p}>
    <path d="M14 8v-2a2 2 0 0 0 -2 -2h-7a2 2 0 0 0 -2 2v12a2 2 0 0 0 2 2h7a2 2 0 0 0 2 -2v-2" />
    <path d="M9 12h12l-3 -3" />
    <path d="M18 15l3 -3" />
  </Svg>
);

/** ti-login — keys coming back in. */
export const IconCheckIn = (p: IconProps) => (
  <Svg {...p}>
    <path d="M15 8v-2a2 2 0 0 0 -2 -2h-7a2 2 0 0 0 -2 2v12a2 2 0 0 0 2 2h7a2 2 0 0 0 2 -2v-2" />
    <path d="M21 12h-13l3 -3" />
    <path d="M11 15l-3 -3" />
  </Svg>
);

/** ti-arrows-exchange — one holder straight to another. */
export const IconTransfer = (p: IconProps) => (
  <Svg {...p}>
    <path d="M7 10h14l-4 -4" />
    <path d="M17 14h-14l4 4" />
  </Svg>
);

/** ti-building — a customer site. */
export const IconCustomer = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 21h18" />
    <path d="M5 21v-16a2 2 0 0 1 2 -2h10a2 2 0 0 1 2 2v16" />
    <path d="M9 8h1" />
    <path d="M9 12h1" />
    <path d="M9 16h1" />
    <path d="M14 8h1" />
    <path d="M14 12h1" />
    <path d="M14 16h1" />
  </Svg>
);

/** ti-briefcase — an IC vendor. */
export const IconIC = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 9a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v9a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2z" />
    <path d="M8 7v-2a2 2 0 0 1 2 -2h4a2 2 0 0 1 2 2v2" />
    <path d="M12 12v.01" />
    <path d="M3 13a20 20 0 0 0 18 0" />
  </Svg>
);

/** ti-user-plus — a new manager on the roster. */
export const IconManagerAdd = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 7a4 4 0 1 0 8 0a4 4 0 0 0 -8 0" />
    <path d="M16 19h6" />
    <path d="M19 16v6" />
    <path d="M6 21v-2a4 4 0 0 1 4 -4h4" />
  </Svg>
);

/** ti-file-spreadsheet — the Excel import. */
export const IconImport = (p: IconProps) => (
  <Svg {...p}>
    <path d="M14 3v4a1 1 0 0 0 1 1h4" />
    <path d="M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2z" />
    <path d="M8 11h8v7h-8z" />
    <path d="M8 15h8" />
    <path d="M12 11v7" />
  </Svg>
);

/** ti-clipboard-list — the custody report. */
export const IconReport = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 5h-2a2 2 0 0 0 -2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-12a2 2 0 0 0 -2 -2h-2" />
    <path d="M9 5a2 2 0 0 1 2 -2h2a2 2 0 0 1 2 2a2 2 0 0 1 -2 2h-2a2 2 0 0 1 -2 -2" />
    <path d="M9 12h.01" />
    <path d="M13 12h2" />
    <path d="M9 16h.01" />
    <path d="M13 16h2" />
  </Svg>
);

/** ti-download — export to a file. */
export const IconExport = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-2" />
    <path d="M7 11l5 5l5 -5" />
    <path d="M12 4v12" />
  </Svg>
);

/** ti-arrows-left-right — a book of clients moving between managers. */
export const IconReassign = (p: IconProps) => (
  <Svg {...p}>
    <path d="M21 7h-18" />
    <path d="M18 10l3 -3l-3 -3" />
    <path d="M6 20l-3 -3l3 -3" />
    <path d="M3 17h18" />
  </Svg>
);

/** ti-trash — archive/delete an account. */
export const IconDelete = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 7h16" />
    <path d="M10 11v6" />
    <path d="M14 11v6" />
    <path d="M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2 -2l1 -12" />
    <path d="M9 7v-3a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v3" />
  </Svg>
);

/** ti-check — the contextual physical-handover confirmation. */
export const IconCheck = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 12l5 5l10 -10" />
  </Svg>
);

/** ti-checkbox — enter/leave multi-row picking mode. */
export const IconSelect = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 11l3 3l8 -8" />
    <path d="M20 12v6a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2v-12a2 2 0 0 1 2 -2h9" />
  </Svg>
);
