// ── Door Codes tab ───────────────────────────────────────────────────────────
// Every labeled access code in the system, one row per code.
//
// A code's value is never in the data this component receives. `Reveal` fetches
// it through the single audited endpoint, shows it for five seconds and drops
// it — the value is held in state only for that window and is never written
// anywhere. Add / Edit / Move / Archive are gated on can_delete, the same
// permission as deleting an account, because all four change who can open a
// client's door.

import { useCallback, useEffect, useMemo, useState } from 'react';
import Modal from './Modal';
import AccountPicker, { type PickedAccount } from './AccountPicker';
import { getManager } from '../lib/auth';
import {
  getAccessCodes, revealAccessCode, createAccessCode, updateAccessCode,
  moveAccessCode, archiveAccessCode, restoreAccessCode,
  type AccessCode, type AccessCodeType,
} from '../lib/api';

const REVEAL_MS = 5000;

const fmt = (iso: string | null): string => {
  if (!iso) return '—';
  const d = new Date(/[Tt]|[Zz]$/.test(iso) ? iso : `${iso.replace(' ', 'T')}Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', {
    timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric',
  });
};

const TYPES: { key: AccessCodeType; label: string }[] = [
  { key: 'front_door', label: 'Front Door' },
  { key: 'back_door', label: 'Back Door' },
  { key: 'supply_closet', label: 'Supply Closet' },
  { key: 'gate', label: 'Gate' },
  { key: 'alarm', label: 'Alarm' },
  { key: 'lockbox', label: 'Lockbox' },
  { key: 'other', label: 'Other' },
];

/**
 * The masked cell. Holds a revealed value for five seconds, then clears it —
 * the timer is owned here so leaving the row, or a re-render, cannot strand a
 * code on screen.
 */
function CodeCell({ id, onError }: { id: number; onError: (m: string) => void }) {
  const [code, setCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (code === null) return;
    const t = setTimeout(() => setCode(null), REVEAL_MS);
    return () => clearTimeout(t);
  }, [code]);

  if (code !== null) {
    return (
      <span className="inline-flex items-center gap-1.5">
        <span className="font-mono text-sm bg-[#fff8e6] border border-[#e8cf8a] px-2 py-0.5 rounded select-all">
          {code}
        </span>
        <button
          onClick={() => setCode(null)}
          className="text-[10px] text-cw-muted hover:text-cw-text"
          title="Hide now"
        >
          hide
        </button>
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-2">
      <span className="font-mono text-gray-400 tracking-widest select-none">••••</span>
      <button
        onClick={async () => {
          setBusy(true);
          try { setCode((await revealAccessCode(id)).code); }
          catch (e: any) { onError(e?.message || 'Could not reveal this code'); }
          finally { setBusy(false); }
        }}
        disabled={busy}
        className="text-xs border border-[#C0272D] text-[#C0272D] rounded px-2 py-0.5 hover:bg-[#C0272D] hover:text-white transition-colors disabled:opacity-50"
      >
        {busy ? '…' : 'Reveal'}
      </button>
    </span>
  );
}

// ── Add / Edit ───────────────────────────────────────────────────────────────
function CodeModal({
  editing, onClose, onDone, onError,
}: {
  editing: AccessCode | null;
  onClose: () => void;
  onDone: (msg: string) => void;
  onError: (m: string) => void;
}) {
  const [client, setClient] = useState<PickedAccount | null>(
    editing ? { id: editing.account_id, name: editing.client ?? '', number: editing.bc_client_number, record_type: 'customer' } as PickedAccount : null,
  );
  const [codeType, setCodeType] = useState<AccessCodeType>(editing?.code_type ?? 'front_door');
  const [customLabel, setCustomLabel] = useState(editing?.custom_label ?? '');
  const [code, setCode] = useState('');
  const [notes, setNotes] = useState(editing?.notes ?? '');
  const [busy, setBusy] = useState(false);

  const isEdit = !!editing;
  // On an edit the stored code cannot be shown, so an empty field means "leave
  // it"; on an add there is nothing to leave, so it is required.
  const canSave = isEdit
    ? (codeType !== 'other' || customLabel.trim().length > 0)
    : (!!client && code.trim().length > 0 && (codeType !== 'other' || customLabel.trim().length > 0));

  const save = async () => {
    setBusy(true);
    try {
      if (isEdit) {
        await updateAccessCode(editing!.id, {
          code_type: codeType,
          custom_label: codeType === 'other' ? customLabel.trim() : '',
          ...(code.trim() ? { code: code.trim() } : {}),
          notes: notes.trim(),
        });
        onDone('Code updated.');
      } else {
        await createAccessCode({
          account_id: client!.id,
          code_type: codeType,
          ...(codeType === 'other' ? { custom_label: customLabel.trim() } : {}),
          code: code.trim(),
          notes: notes.trim(),
        });
        onDone('Code added.');
      }
      onClose();
    } catch (e: any) { onError(e?.message || 'Could not save this code'); }
    finally { setBusy(false); }
  };

  return (
    <Modal title={isEdit ? `Edit code — ${editing!.client}` : 'Add Access Code'} onClose={onClose} width="max-w-lg">
      <div className="space-y-4">
        {!isEdit && (
          <div>
            <label className="block text-xs font-medium text-cw-muted mb-1">Client</label>
            <AccountPicker value={client} onSelect={setClient} placeholder="Search customers…" />
          </div>
        )}

        <div>
          <label className="block text-xs font-medium text-cw-muted mb-1">Type</label>
          <select
            className="input focus:ring-[#C0272D] focus:border-[#C0272D]"
            value={codeType}
            onChange={(e) => setCodeType(e.target.value as AccessCodeType)}
          >
            {TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
          </select>
        </div>

        {codeType === 'other' && (
          <div>
            <label className="block text-xs font-medium text-cw-muted mb-1">
              Label <span className="text-[#C0272D]">*</span>
            </label>
            <input
              className="input focus:ring-[#C0272D] focus:border-[#C0272D]"
              placeholder="e.g. Roof Hatch"
              value={customLabel}
              onChange={(e) => setCustomLabel(e.target.value)}
            />
          </div>
        )}

        <div>
          <label className="block text-xs font-medium text-cw-muted mb-1">
            Code {!isEdit && <span className="text-[#C0272D]">*</span>}
            <span className="ml-1 font-normal text-gray-400">— stored encrypted</span>
          </label>
          <input
            className="input font-mono focus:ring-[#C0272D] focus:border-[#C0272D]"
            placeholder={isEdit ? 'Leave blank to keep the current code' : 'e.g. 4821#'}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoComplete="off"
          />
          {isEdit && (
            <p className="mt-1 text-[11px] text-cw-muted">
              The stored code is never shown here. Type a new one only to replace it.
            </p>
          )}
        </div>

        <div>
          <label className="block text-xs font-medium text-cw-muted mb-1">Notes</label>
          <textarea
            className="input h-16 resize-none focus:ring-[#C0272D] focus:border-[#C0272D]"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>

        <div className="flex gap-2 pt-1">
          <button onClick={save} disabled={busy || !canSave} className="btn-primary">
            {busy ? 'Saving…' : isEdit ? 'Save Changes' : 'Add Code'}
          </button>
          <button onClick={onClose} className="btn-secondary">Cancel</button>
        </div>
      </div>
    </Modal>
  );
}

// ── Move ─────────────────────────────────────────────────────────────────────
function MoveModal({
  code, onClose, onDone, onError,
}: {
  code: AccessCode;
  onClose: () => void;
  onDone: (msg: string) => void;
  onError: (m: string) => void;
}) {
  const [dest, setDest] = useState<PickedAccount | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <Modal title="Move code to a different client" onClose={onClose} width="max-w-lg">
      <div className="space-y-4">
        <div className="rounded border border-cw-border bg-[#f4f4f2] px-3 py-2 text-sm">
          <div className="font-medium text-[#1a1a1a]">{code.label}</div>
          <div className="text-xs text-cw-muted">
            currently on <strong>{code.client}</strong>
            {code.bc_client_number ? ` · ${code.bc_client_number}` : ''}
          </div>
        </div>
        <div>
          <label className="block text-xs font-medium text-cw-muted mb-1">Move to</label>
          <AccountPicker value={dest} onSelect={setDest} placeholder="Search clients…" />
        </div>
        <p className="text-xs text-cw-muted">
          The code itself is unchanged — only which client it belongs to. The move is recorded
          in the audit log naming both clients.
        </p>
        <div className="flex gap-2">
          <button
            onClick={async () => {
              if (!dest) return;
              setBusy(true);
              try {
                const r = await moveAccessCode(code.id, dest.id);
                onDone(`${code.label} moved from ${r.from} to ${r.to}.`);
                onClose();
              } catch (e: any) { onError(e?.message || 'Could not move this code'); }
              finally { setBusy(false); }
            }}
            disabled={busy || !dest || dest.id === code.account_id}
            className="btn-primary"
          >
            {busy ? 'Moving…' : 'Move Code'}
          </button>
          <button onClick={onClose} className="btn-secondary">Cancel</button>
        </div>
      </div>
    </Modal>
  );
}

// ── The tab ──────────────────────────────────────────────────────────────────
export default function DoorCodesTab({ notify }: { notify: (m: string) => void }) {
  const canManage = !!getManager()?.can_delete;

  const [feed, setFeed] = useState<{ codes: AccessCode[]; byType: Record<string, number>; total: number }>({
    codes: [], byType: {}, total: 0,
  });
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [chip, setChip] = useState<'all' | AccessCodeType>('all');
  const [showArchived, setShowArchived] = useState(false);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<AccessCode | null>(null);
  const [moving, setMoving] = useState<AccessCode | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, string> = {};
      if (debounced.trim()) params.search = debounced.trim();
      if (chip !== 'all') params.code_type = chip;
      if (showArchived) params.archived = '1';
      const r = await getAccessCodes(params);
      setFeed({ codes: r.codes, byType: r.counts.by_type, total: r.counts.total });
    } catch (e: any) {
      setError(e?.message || 'Could not load access codes');
    } finally { setLoading(false); }
  }, [debounced, chip, showArchived]);

  useEffect(() => { load(); }, [load]);

  const done = (msg: string) => { notify(msg); setError(''); load(); };

  const chips = useMemo(() => ([
    { key: 'all' as const, label: 'All', n: feed.total },
    ...TYPES.map((t) => ({ key: t.key, label: t.label, n: feed.byType[t.key] ?? 0 })),
  ]), [feed]);

  const archive = async (c: AccessCode) => {
    if (!window.confirm(`Archive the ${c.label} code for ${c.client}?\n\nThe code is kept for the audit history and can be restored.`)) return;
    try { await archiveAccessCode(c.id); done(`${c.label} archived.`); }
    catch (e: any) { setError(e?.message || 'Could not archive this code'); }
  };
  const restore = async (c: AccessCode) => {
    try { await restoreAccessCode(c.id); done(`${c.label} restored.`); }
    catch (e: any) { setError(e?.message || 'Could not restore this code'); }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-[#1a1a1a]">
            Door Codes {showArchived ? '· archived' : ''}
          </h2>
          <p className="text-xs text-cw-muted">
            Every code is encrypted at rest. Revealing one is recorded in the audit log.
          </p>
        </div>
        {canManage ? (
          <button onClick={() => setAdding(true)} className="btn-primary text-sm">+ Add Code</button>
        ) : (
          <span
            className="text-xs text-cw-muted"
            title="Adding, editing, moving and archiving codes require delete access"
          >
            View only — contact Cara Angeloni for access to manage codes
          </span>
        )}
      </div>

      {error && (
        <div className="rounded border border-[#C0272D] bg-[#fbeaea] px-3 py-2 text-sm text-[#C0272D] flex items-center justify-between">
          <span>{error}</span>
          <button onClick={() => setError('')} className="text-[#C0272D]">×</button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <input
          className="input max-w-xs focus:ring-[#C0272D] focus:border-[#C0272D]"
          placeholder="Search client, BC #, or code type…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <label className="flex items-center gap-1.5 text-xs text-cw-muted cursor-pointer select-none">
          <input
            type="checkbox"
            className="accent-[#C0272D]"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
          />
          Show archived
        </label>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {chips.map((c) => (
          <button
            key={c.key}
            onClick={() => setChip(c.key as any)}
            className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
              chip === c.key
                ? 'bg-[#1a1a1a] text-white border-[#1a1a1a]'
                : 'bg-white text-cw-muted border-cw-border hover:border-[#1a1a1a]'
            }`}
          >
            {c.label} ({c.n})
          </button>
        ))}
      </div>

      <div className="card overflow-x-auto max-w-full">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="bg-[#1a1a1a] text-white text-xs">
              <th className="text-left px-4 py-3 font-medium whitespace-nowrap sticky left-0 z-20 bg-[#1a1a1a] min-w-[200px]">Client</th>
              <th className="text-left px-3 py-3 font-medium whitespace-nowrap sticky left-[200px] z-20 bg-[#1a1a1a] min-w-[150px]">BC Client #</th>
              <th className="text-left px-3 py-3 font-medium whitespace-nowrap">Code Type</th>
              <th className="text-left px-3 py-3 font-medium whitespace-nowrap">Label</th>
              <th className="text-left px-3 py-3 font-medium whitespace-nowrap">Code</th>
              <th className="text-left px-3 py-3 font-medium whitespace-nowrap">Added By</th>
              <th className="text-left px-3 py-3 font-medium whitespace-nowrap">Added</th>
              <th className="px-3 py-3 text-right font-medium whitespace-nowrap">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={8} className="px-4 py-8 text-center text-cw-muted">Loading…</td></tr>
            ) : feed.codes.length === 0 ? (
              <tr><td colSpan={8} className="px-4 py-8 text-center text-cw-muted">
                {showArchived ? 'No archived codes' : 'No access codes yet'}
              </td></tr>
            ) : feed.codes.map((c, i) => {
              const rowBg = i % 2 === 0 ? 'bg-white' : 'bg-[#f4f4f2]';
              return (
                <tr key={c.id} className={`border-b border-gray-100 ${rowBg}`}>
                  <td className={`px-4 py-3 font-medium text-[#1a1a1a] whitespace-nowrap max-w-[200px] truncate sticky left-0 z-10 ${rowBg}`}>
                    {c.client}
                    {c.is_test === 1 && (
                      <span className="ml-1.5 text-[9px] font-bold text-[#7a6a45] bg-[#f2efe6] border border-[#ddd2b6] rounded px-1">TEST</span>
                    )}
                  </td>
                  <td className={`px-3 py-3 font-mono text-xs text-gray-600 whitespace-nowrap sticky left-[200px] z-10 ${rowBg}`}>
                    {c.bc_client_number || '—'}
                  </td>
                  <td className="px-3 py-3 text-xs text-gray-700 whitespace-nowrap">{c.type_label}</td>
                  <td className="px-3 py-3 text-xs text-gray-700 whitespace-nowrap max-w-[160px] truncate">{c.label}</td>
                  <td className="px-3 py-3 whitespace-nowrap"><CodeCell id={c.id} onError={setError} /></td>
                  <td className="px-3 py-3 text-xs text-gray-600 whitespace-nowrap">{c.created_by || '—'}</td>
                  <td className="px-3 py-3 text-xs text-gray-600 whitespace-nowrap">{fmt(c.created_at)}</td>
                  <td className="px-3 py-3 text-right whitespace-nowrap">
                    {canManage ? (
                      <div className="flex gap-2 justify-end">
                        {c.archived === 1 ? (
                          <button onClick={() => restore(c)} className="text-xs text-[#2d7a3a] hover:underline">Restore</button>
                        ) : (
                          <>
                            <button onClick={() => setEditing(c)} className="text-xs text-[#C0272D] hover:underline">Edit</button>
                            <button onClick={() => setMoving(c)} className="text-xs text-[#C0272D] hover:underline">Move</button>
                            <button onClick={() => archive(c)} className="text-xs text-cw-muted hover:underline">Delete</button>
                          </>
                        )}
                      </div>
                    ) : (
                      <span className="text-xs text-gray-300">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {adding && <CodeModal editing={null} onClose={() => setAdding(false)} onDone={done} onError={setError} />}
      {editing && <CodeModal editing={editing} onClose={() => setEditing(null)} onDone={done} onError={setError} />}
      {moving && <MoveModal code={moving} onClose={() => setMoving(null)} onDone={done} onError={setError} />}
    </div>
  );
}
