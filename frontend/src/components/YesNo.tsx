/**
 * City Wide — Yes / No / Unset visual indicator.
 *
 * Renders a boolean-ish DB value (keys_yn / security_app_yn) as an icon so a
 * scannable column reads at a glance:
 *   truthy (1 / true)        → green check  ✓  (#2d7a3a)
 *   explicit falsy (0/false) → red X        ✕  (#C0272D)
 *   null / undefined (unset) → neutral em-dash — so "never set" stays visually
 *                              distinct from an explicit "no".
 *
 * `null !== 0`: the DB stores an INTEGER (0/1) or NULL. node:sqlite surfaces
 * NULL as JS `null`, so the three states survive all the way to render here.
 * Always carries an aria-label ("<Label>: yes/no/not set") for screen readers.
 */
export default function YesNo({
  value,
  label,
  size = 'sm',
}: {
  value: number | boolean | null | undefined;
  label: string;
  size?: 'sm' | 'lg';
}) {
  const cls = size === 'lg' ? 'text-2xl' : 'text-base';

  if (value === null || value === undefined) {
    return (
      <span className="text-gray-300" role="img" aria-label={`${label}: not set`} title={`${label}: not set`}>
        —
      </span>
    );
  }

  return value ? (
    <span
      className={`text-[#2d7a3a] font-bold ${cls}`}
      role="img"
      aria-label={`${label}: yes`}
      title={`${label}: yes`}
    >
      ✓
    </span>
  ) : (
    <span
      className={`text-[#C0272D] font-bold ${cls}`}
      role="img"
      aria-label={`${label}: no`}
      title={`${label}: no`}
    >
      ✕
    </span>
  );
}
