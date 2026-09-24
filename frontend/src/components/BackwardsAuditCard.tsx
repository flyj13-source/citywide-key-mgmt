// ── Backwards-entry review ───────────────────────────────────────────────────
// Until the custody labels were swapped to City Wide's usage, the button named
// "Check Out" issued keys and "Check In" took them back — the reverse of how
// the team talks. This lists the entries that most likely came from pressing
// the button whose name matched. READ ONLY: nothing here edits a record.
//
// Wording below is City Wide's: Check In = keys issued, Check Out = returned.

import { useEffect, useState } from 'react';
import { getBackwardsAudit, type BackwardsAudit } from '../lib/api';

const day = (iso: string) => {
  const d = new Date(/[TZ]|[+-]\d{2}:\d{2}$/.test(iso) ? iso : `${iso.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? iso
    : d.toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric' });
};

const th = 'px-3 py-2 text-left text-[10px] font-bold uppercase tracking-wider text-cw-muted';
const td = 'px-3 py-2 align-top';

export default function BackwardsAuditCard() {
  const [data, setData] = useState<BackwardsAudit | null>(null);
  const [error, setError] = useState('');
  const [includeTest, setIncludeTest] = useState(false);

  useEffect(() => {
    setData(null); setError('');
    getBackwardsAudit(includeTest).then(setData).catch((e) => setError(e?.message || 'Could not load'));
  }, [includeTest]);

  const A = data?.returns_logged_as_issues ?? [];
  const B = data?.holdings_likely_returned ?? [];
  const C = data?.first_time_records ?? [];

  return (
    <div className="card p-5 space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="font-semibold text-sm">Possible backwards entries</h2>
          <p className="text-xs text-cw-muted mt-1 max-w-2xl">
            Entries likely recorded with the Check In / Check Out buttons reversed, before the labels
            were changed to match City Wide's usage. <strong>Review only — nothing here changes a
            record.</strong> Correct any you confirm from the record itself.
          </p>
        </div>
        <label className="text-xs text-cw-muted whitespace-nowrap flex items-center gap-1.5">
          <input type="checkbox" checked={includeTest} onChange={(e) => setIncludeTest(e.target.checked)} />
          Include ZZ TEST
        </label>
      </div>

      {error && <p className="text-sm text-[#C0272D]">{error}</p>}
      {!data && !error && <p className="text-sm text-cw-muted">Checking custody history…</p>}

      {data && (
        <>
          <section>
            <h3 className="text-xs font-semibold text-[#1a1a1a] mb-1">
              Returns logged as a Check In <span className="text-cw-muted font-normal">({A.length})</span>
            </h3>
            <p className="text-[11px] text-cw-muted mb-2">
              Keys were checked in to someone who already had the same keys checked in at that client.
              Nobody is issued keys they are holding — these are most likely the keys coming back.
            </p>
            {A.length === 0 ? <p className="text-xs text-green-700">None found.</p> : (
              <div className="overflow-x-auto border border-cw-border rounded">
                <table className="w-full text-xs">
                  <thead className="bg-gray-50"><tr>
                    <th className={th}>Holder</th><th className={th}>Client</th><th className={th}>Keys</th>
                    <th className={th}>Date</th><th className={th}>Recorded by</th><th className={th}>Already checked in</th>
                  </tr></thead>
                  <tbody className="divide-y divide-cw-border">
                    {A.map((r) => (
                      <tr key={r.record_id}>
                        <td className={`${td} font-medium`}>{r.holder}</td>
                        <td className={td}>{r.client}</td>
                        <td className={td}>{r.keys}</td>
                        <td className={`${td} whitespace-nowrap`}>{day(r.date)}</td>
                        <td className={td}>{r.recorded_by ?? '—'}</td>
                        <td className={`${td} text-cw-muted`}>
                          #{r.already_open.record_id} since {day(r.already_open.since)} ({r.already_open.keys})
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section>
            <h3 className="text-xs font-semibold text-[#1a1a1a] mb-1">
              Holders showing keys they likely handed back <span className="text-cw-muted font-normal">({B.length})</span>
            </h3>
            <p className="text-[11px] text-cw-muted mb-2">
              Keys currently checked in that are split across overlapping records, or that exceed what the
              holder's role carries on the client's key grid.
            </p>
            {B.length === 0 ? <p className="text-xs text-green-700">None found.</p> : (
              <div className="overflow-x-auto border border-cw-border rounded">
                <table className="w-full text-xs">
                  <thead className="bg-gray-50"><tr>
                    <th className={th}>Holder</th><th className={th}>Client</th><th className={th}>Checked in now</th>
                    <th className={th}>Role holds</th><th className={th}>Why</th><th className={th}>Records (date · recorded by)</th>
                  </tr></thead>
                  <tbody className="divide-y divide-cw-border">
                    {B.map((g) => (
                      <tr key={`${g.holder}|${g.client}`}>
                        <td className={`${td} font-medium`}>{g.holder}</td>
                        <td className={td}>{g.client}</td>
                        <td className={td}>{g.open_keys}{g.excess && <div className="text-[#C0272D]">+{g.excess} over</div>}</td>
                        <td className={td}>{g.role_keys ?? '—'}</td>
                        <td className={`${td} text-cw-muted`}>{g.reason}</td>
                        <td className={td}>
                          {g.records.map((r) => (
                            <div key={r.record_id} className="whitespace-nowrap">
                              #{r.record_id} {r.keys} · {day(r.date)} · {r.recorded_by ?? '—'}
                            </div>
                          ))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section>
            <h3 className="text-xs font-semibold text-[#1a1a1a] mb-1">
              For context — Record Keys Held entries <span className="text-cw-muted font-normal">({C.length})</span>
            </h3>
            <p className="text-[11px] text-cw-muted mb-2">
              The mirror case: pressing the old return button to issue keys, when the holder had nothing open,
              produced one of these. Most are likely correct — check the ones that look like an issue.
            </p>
            {C.length === 0 ? <p className="text-xs text-cw-muted">None.</p> : (
              <div className="overflow-x-auto border border-cw-border rounded max-h-64 overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="bg-gray-50 sticky top-0"><tr>
                    <th className={th}>Holder</th><th className={th}>Client</th><th className={th}>Keys</th>
                    <th className={th}>Date</th><th className={th}>Recorded by</th>
                  </tr></thead>
                  <tbody className="divide-y divide-cw-border">
                    {C.map((r) => (
                      <tr key={r.record_id}>
                        <td className={`${td} font-medium`}>{r.holder}</td>
                        <td className={td}>{r.client}</td>
                        <td className={td}>{r.keys}</td>
                        <td className={`${td} whitespace-nowrap`}>{day(r.date)}</td>
                        <td className={td}>{r.recorded_by ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
