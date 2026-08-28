// ── Bulk archive confirmation ────────────────────────────────────────────────
// Destructive and multi-row, so the count is stated exactly and the records are
// named — first five plus "and N more" — before anything is archived. A
// selection promoted to the whole filtered set is a different order of risk, so
// that case additionally requires typing the number.

import { useState } from 'react';
import Modal from './Modal';
import type { AccountIdItem } from '../lib/api';

/** Above this many records, a promoted selection must be typed to confirm. */
const TYPE_TO_CONFIRM_OVER = 25;

export default function BulkArchiveModal({
  items, allMatching, busy, error, onCancel, onConfirm,
}: {
  items: AccountIdItem[];
  allMatching: boolean;
  busy: boolean;
  error: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [typed, setTyped] = useState('');
  const n = items.length;
  const shown = items.slice(0, 5);
  const more = n - shown.length;
  const alreadyArchived = items.filter((i) => i.archived === 1).length;
  const willArchive = n - alreadyArchived;

  // A whole-filter selection is the case where someone can archive far more
  // than they looked at, so make them write the number.
  const needsTyping = allMatching && willArchive > TYPE_TO_CONFIRM_OVER;
  const canConfirm = !busy && willArchive > 0 && (!needsTyping || typed.trim() === String(willArchive));

  return (
    <Modal title={`Archive ${willArchive} record${willArchive !== 1 ? 's' : ''}?`} onClose={onCancel}>
      <div className="space-y-4">
        {allMatching && (
          <div className="rounded border border-[#C0272D] bg-[#fbeaea] px-3 py-2 text-sm text-[#C0272D]">
            <strong>This is every record matching the current filter</strong>, not just the page
            you were looking at.
          </div>
        )}

        <p className="text-sm text-cw-text">
          Archiving hides {willArchive === 1 ? 'this record' : `these ${willArchive} records`} from
          every normal view. It is reversible from the Archived tab — nothing is deleted.
        </p>

        <div className="rounded border border-cw-border bg-[#f4f4f2] px-3 py-2">
          <ul className="text-sm text-cw-text space-y-0.5">
            {shown.map((i) => (
              <li key={i.id} className="truncate">
                • {i.ic_company_name}
                {i.archived === 1 && <span className="text-cw-muted text-xs"> (already archived)</span>}
              </li>
            ))}
          </ul>
          {more > 0 && (
            <div className="text-sm text-cw-muted mt-1">and {more} more</div>
          )}
        </div>

        {alreadyArchived > 0 && (
          <div className="text-xs text-cw-muted">
            {alreadyArchived} of the {n} selected {alreadyArchived === 1 ? 'is' : 'are'} already
            archived and will be left alone.
          </div>
        )}

        <div className="text-xs text-cw-muted">
          Any record still holding checked-out keys is refused and named back — archiving one
          would orphan live custody.
        </div>

        {needsTyping && (
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">
              Type <span className="font-mono font-bold text-[#C0272D]">{willArchive}</span> to confirm
            </label>
            <input
              className="input focus:ring-[#C0272D] focus:border-[#C0272D]"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={String(willArchive)}
              autoFocus
            />
          </div>
        )}

        {error && (
          <div className="rounded border border-[#C0272D] bg-[#fbeaea] px-3 py-2 text-sm text-[#C0272D]">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onCancel} disabled={busy} className="btn-secondary">Cancel</button>
          <button onClick={onConfirm} disabled={!canConfirm} className="btn-primary">
            {busy ? 'Archiving…' : `Archive ${willArchive}`}
          </button>
        </div>
      </div>
    </Modal>
  );
}
