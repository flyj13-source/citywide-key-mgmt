// ── Establish Custody ────────────────────────────────────────────────────────
// Opening balances. People held keys long before this system existed, so a
// check-IN had nothing to close against and simply failed. This records what
// someone ALREADY holds and asks them to confirm it.
//
// It is deliberately not a check-out, and the wording says so everywhere: the
// holder is asked to confirm they CURRENTLY HOLD these keys, never that they
// are receiving them. Signing a receipt would date the custody to today.
//
// One modal serves both the single-client case and the bulk rollout (one
// holder, many clients, ONE acknowledgement) — Cara has hundreds of these to
// do, and asking a contractor to sign eleven separate forms is not a rollout.

import { useEffect, useMemo, useState } from 'react';
import Modal from './Modal';
import {
  ClientPicker, HolderPicker, KeyPickerList, MailBanner, MissingEmailWarning,
  selectedLines, type Pick,
} from './CustodyModals';
import {
  establishCustody, getKeyAvailability,
  type HolderOption, type KeyAvailability, type KeyTypeKey,
  type MailOutcome, type SignatureStatus,
} from '../lib/api';
import { getManager } from '../lib/auth';

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] font-bold uppercase tracking-widest text-[#1a1a1a] border-b border-gray-200 pb-1 mb-3">
      {children}
    </div>
  );
}

interface SiteState {
  id: number;
  name: string;
  avail: KeyAvailability[];
  loading: boolean;
  picks: Record<string, Pick>;
}

export default function EstablishCustodyModal({
  presetAccount, presetClients, onClose, onDone,
}: {
  /** Single-client entry — the selected registry row, if any. */
  presetAccount?: { id: number; name: string } | null;
  /** Bulk entry — every client ticked in the registry. */
  presetClients?: { id: number; name: string }[];
  onClose: () => void;
  onDone: () => void;
}) {
  const me = getManager();
  const bulk = !!(presetClients && presetClients.length > 1);

  const [sites, setSites] = useState<SiteState[]>(() => {
    const seed = presetClients?.length
      ? presetClients
      : presetAccount ? [presetAccount] : [];
    return seed.map((c) => ({ id: c.id, name: c.name, avail: [], loading: true, picks: {} }));
  });
  const [singlePick, setSinglePick] = useState<{ id: number; name: string } | null>(
    presetClients?.length ? null : presetAccount ?? null,
  );

  const [mode, setMode] = useState<'self' | 'other'>('other');
  const [holder, setHolder] = useState<HolderOption | null>(null);
  const [email, setEmail] = useState('');
  // "Approximate is fine" — this is a recollection, not a transaction time.
  const [heldSince, setHeldSince] = useState(new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [proceedUnsigned, setProceedUnsigned] = useState(false);
  const [noEmailReason, setNoEmailReason] = useState('');
  const [done, setDone] = useState<{
    mail: MailOutcome; link: string | null; holder: string;
    status: SignatureStatus; clients: number; totalKeys: number;
  } | null>(null);

  // Single-client mode: the picker drives the one site in the list.
  useEffect(() => {
    if (bulk) return;
    if (!singlePick) { setSites([]); return; }
    setSites([{ id: singlePick.id, name: singlePick.name, avail: [], loading: true, picks: {} }]);
  }, [bulk, singlePick]);

  // Load each site's key inventory. Availability still applies: an opening
  // balance cannot claim more keys than the site is recorded as having.
  useEffect(() => {
    let cancelled = false;
    for (const s of sites) {
      if (!s.loading) continue;
      getKeyAvailability(s.id)
        .then((d) => {
          if (cancelled) return;
          setSites((cur) => cur.map((x) => (x.id === s.id ? { ...x, avail: d.types, loading: false } : x)));
        })
        .catch(() => {
          if (cancelled) return;
          setSites((cur) => cur.map((x) => (x.id === s.id ? { ...x, avail: [], loading: false } : x)));
        });
    }
    return () => { cancelled = true; };
  }, [sites]);

  useEffect(() => {
    setEmail(mode === 'self' ? (me?.email ?? '') : (holder?.email ?? ''));
    setProceedUnsigned(false);
    setNoEmailReason('');
  }, [mode, holder, me?.email]);

  const setPicksFor = (id: number, picks: Record<string, Pick>) =>
    setSites((cur) => cur.map((s) => (s.id === id ? { ...s, picks } : s)));

  const holderName = mode === 'self' ? (me?.name ?? '') : (holder?.name ?? '');
  const holderType: 'employee' | 'ic' = mode === 'self' ? 'employee' : (holder?.type ?? 'employee');

  const withKeys = useMemo(
    () => sites.map((s) => ({ site: s, lines: selectedLines(s.picks) })).filter((x) => x.lines.length > 0),
    [sites],
  );
  const totalKeys = withKeys.reduce((n, x) => n + x.lines.reduce((m, l) => m + l.qty, 0), 0);

  const holderChosen = mode === 'self' || !!holder;
  const missingEmail = holderChosen && !email.trim();
  const emailResolved = !missingEmail || (proceedUnsigned && noEmailReason.trim().length > 0);
  const canSubmit = withKeys.length > 0 && !!holderName && emailResolved && !saving;

  const submit = async () => {
    if (!canSubmit) return;
    setSaving(true); setError('');
    try {
      const r = await establishCustody({
        holder: holderName,
        holder_email: email.trim() || null,
        holder_type: holderType,
        holder_id: mode === 'other' ? holder?.id ?? null : null,
        clients: withKeys.map((x) => ({ account_id: x.site.id, keys: x.lines })),
        held_since: heldSince || null,
        notes: notes.trim() || null,
        no_email_reason: proceedUnsigned ? noEmailReason.trim() : null,
      });
      setDone({
        mail: r.email, link: r.signoff_link, holder: holderName,
        status: r.signature_status, clients: r.clients, totalKeys: r.total_keys,
      });
      onDone();
    } catch (e: any) {
      setError(e?.message || 'Could not record this custody');
    } finally {
      setSaving(false);
    }
  };

  if (done) {
    return (
      <Modal title="Custody recorded" onClose={onClose} width="max-w-lg">
        <div className="space-y-4">
          <p className="text-sm text-cw-text">
            Recorded that <span className="font-semibold">{done.holder}</span> currently holds{' '}
            <span className="font-semibold">{done.totalKeys}</span> key{done.totalKeys === 1 ? '' : 's'} across{' '}
            <span className="font-semibold">{done.clients}</span> client{done.clients === 1 ? '' : 's'}.
          </p>
          <div className="rounded border border-cw-border bg-[#f4f4f2] px-3 py-2 text-sm text-cw-text">
            These now appear under <strong>Checked Out</strong> and can be checked in normally.
          </div>
          <MailBanner mail={done.mail} kind="checkout" />
          {done.link && (
            <div className="text-xs text-cw-muted break-all">
              Acknowledgement link (48 hours): <span className="font-mono">{done.link}</span>
            </div>
          )}
          <div className="flex justify-end pt-1">
            <button onClick={onClose} className="btn-primary">Done</button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      title={bulk ? `Establish custody — ${sites.length} clients` : 'Establish custody'}
      onClose={onClose}
      width="max-w-2xl"
    >
      <div className="space-y-5">
        {/* Say what this is, up front. It is easy to mistake for a check-out. */}
        <div className="rounded border-l-4 border-[#C0272D] bg-[#f4f4f2] px-3 py-2.5">
          <div className="text-sm font-semibold text-[#1a1a1a]">This is an opening balance</div>
          <p className="text-xs text-cw-muted mt-0.5">
            Use this when someone <strong>already holds</strong> keys from before the system existed.
            No keys change hands today, and the acknowledgement asks them to confirm they currently
            hold these keys — not that they are receiving them.
          </p>
        </div>

        <div>
          <SectionLabel>Who holds the keys</SectionLabel>
          {/* Nobody is "receiving" anything here — these keys are already held. */}
          <HolderPicker
            mode={mode} setMode={setMode} holder={holder} setHolder={setHolder}
            placeholder="— Select the person who already holds the keys —"
          />
          <div className="mt-3">
            <label className="block text-xs font-medium text-gray-600 mb-1">
              Holder email <span className="text-gray-400 font-normal">— receives the acknowledgement link</span>
            </label>
            <input
              type="email"
              className="input focus:ring-[#C0272D] focus:border-[#C0272D]"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@example.com"
            />
          </div>
          {missingEmail && (
            <div className="mt-3">
              <MissingEmailWarning
                holder={holderName}
                holderType={holderType}
                holderId={mode === 'other' ? holder?.id ?? null : null}
                onEmailSaved={(saved) => { setEmail(saved); setProceedUnsigned(false); setNoEmailReason(''); }}
                proceeding={proceedUnsigned}
                setProceeding={setProceedUnsigned}
                reason={noEmailReason}
                setReason={setNoEmailReason}
              />
            </div>
          )}
        </div>

        {!bulk && (
          <div>
            <SectionLabel>Client</SectionLabel>
            <ClientPicker value={singlePick} onSelect={(v: any) => setSinglePick(v)} />
          </div>
        )}

        <div>
          <SectionLabel>{bulk ? 'Keys held at each client' : 'Keys currently held'}</SectionLabel>
          {sites.length === 0 ? (
            <p className="text-sm text-cw-muted">Choose a client to record the keys they hold.</p>
          ) : (
            <div className={bulk ? 'space-y-4 max-h-[22rem] overflow-y-auto pr-1' : ''}>
              {sites.map((s) => (
                <div key={s.id}>
                  {bulk && (
                    <div className="text-xs font-semibold text-[#C0272D] mb-1.5">{s.name}</div>
                  )}
                  {s.loading ? (
                    <p className="text-sm text-cw-muted">Loading key inventory…</p>
                  ) : (
                    <KeyPickerList
                      rows={s.avail.map((k) => ({
                        type: k.type as KeyTypeKey, label: k.label, available: k.available,
                      }))}
                      picks={s.picks}
                      setPicks={(p) => setPicksFor(s.id, p)}
                      availableLabel="on record"
                      emptyNote="No key inventory recorded for this client."
                    />
                  )}
                </div>
              ))}
            </div>
          )}
          {bulk && (
            <p className="text-[11px] text-gray-400 mt-2">
              Leave a client with no keys ticked to skip it — only clients with keys are recorded.
            </p>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">
              Keys held since <span className="text-gray-400 font-normal">— approximate is fine</span>
            </label>
            <input
              type="date"
              className="input focus:ring-[#C0272D] focus:border-[#C0272D]"
              value={heldSince}
              onChange={(e) => setHeldSince(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Notes</label>
            <input
              className="input focus:ring-[#C0272D] focus:border-[#C0272D]"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Optional context"
            />
          </div>
        </div>

        {withKeys.length > 0 && (
          <div className="rounded border border-cw-border bg-white px-3 py-2 text-sm text-cw-text">
            Recording <span className="font-semibold">{totalKeys}</span> key{totalKeys === 1 ? '' : 's'} across{' '}
            <span className="font-semibold">{withKeys.length}</span> client{withKeys.length === 1 ? '' : 's'}
            {bulk && <> — <strong>one acknowledgement</strong> covering all of them.</>}
          </div>
        )}

        {error && (
          <div className="rounded border border-[#C0272D] bg-[#fbeaea] px-3 py-2 text-sm text-[#C0272D]">{error}</div>
        )}
      </div>

      <div className="flex gap-2 pt-4 border-t border-gray-200 mt-4">
        <button onClick={submit} disabled={!canSubmit} className="btn-primary">
          {saving ? 'Recording…' : 'Establish custody'}
        </button>
        <button onClick={onClose} className="btn-secondary">Cancel</button>
      </div>
    </Modal>
  );
}
