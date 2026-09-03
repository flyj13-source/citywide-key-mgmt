/**
 * Charcoal "TEST" pill. Used in two places, both meaning "this is apparatus,
 * not data": next to a manager name on an audit entry created by the test
 * account (metadata test_action:true), and next to a registry record flagged
 * is_test=1. Visible, never hidden — a fixture that looked like real data
 * would be far worse than one that is obviously labelled.
 */
export default function TestPill({
  className = '', title = 'Test fixture — excluded from counts, aggregates and exports',
}: { className?: string; title?: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border border-gray-500 text-gray-600 px-1.5 py-[1px] text-[10px] font-semibold uppercase tracking-wide leading-none mr-1.5 align-middle ${className}`}
      title={title}
    >
      Test
    </span>
  );
}
