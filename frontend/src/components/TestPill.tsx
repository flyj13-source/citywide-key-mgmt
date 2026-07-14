/**
 * Neutral charcoal-outline "TEST" pill shown next to the manager name for any
 * audit/activity entry created by the dedicated test account (metadata
 * test_action:true). Visible, never hidden — it flags troubleshooting noise
 * without deleting or dimming the record.
 */
export default function TestPill({ className = '' }: { className?: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border border-gray-500 text-gray-600 px-1.5 py-[1px] text-[10px] font-semibold uppercase tracking-wide leading-none ${className}`}
      title="Action performed by the test account"
    >
      Test
    </span>
  );
}
