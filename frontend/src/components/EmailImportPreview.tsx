// ── Email backfill preview + summary ─────────────────────────────────────────
// Both email sheets are previewed as a DRY RUN before anything is written, and
// applying one only ever fills blanks. The counts that matter most are the ones
// that stay a gap afterwards, so those are shown in red rather than buried.

import type {
  EmailImportKind, StaffEmailPreview, IcEmailPreview, IcResolution, HeaderReport,
} from '../lib/api';

const RED = '#C0272D';

function Stat({ label, value, tone = 'normal' }: {
  label: string; value: number; tone?: 'normal' | 'muted' | 'gap';
}) {
  const color = tone === 'gap' ? RED : tone === 'muted' ? '#6b6b68' : '#1a1a1a';
  return (
    <div className="flex-1 min-w-[7rem] text-center px-2 py-3 border border-cw-border rounded bg-white">
      <div className="text-2xl font-bold" style={{ color }}>{value}</div>
      <div className="text-[11px] uppercase tracking-wide text-cw-muted mt-1 leading-tight">{label}</div>
    </div>
  );
}

/** A collapsible list — long lists must not push the action buttons off-screen. */
function List({ title, items, tone = 'normal' }: {
  title: string; items: string[]; tone?: 'normal' | 'gap';
}) {
  if (!items.length) return null;
  const gap = tone === 'gap';
  return (
    <details className={`rounded border ${gap ? 'border-[#C0272D] bg-[#fbeaea]' : 'border-cw-border bg-[#f4f4f2]'}`}>
      <summary className={`px-3 py-2 text-sm font-medium cursor-pointer ${gap ? 'text-[#C0272D]' : 'text-cw-text'}`}>
        {title} ({items.length})
      </summary>
      <ul className="px-4 pb-3 pt-1 max-h-48 overflow-y-auto text-xs text-cw-text space-y-1">
        {items.map((t, i) => <li key={i} className="font-mono">{t}</li>)}
      </ul>
    </details>
  );
}

function isStaff(p: StaffEmailPreview | IcEmailPreview): p is StaffEmailPreview {
  return 'remainingWithoutEmail' in p;
}

function Resolution({ r, title }: { r: IcResolution; title: string }) {
  const unresolved = r.totalCustomers - r.resolved;
  const pct = r.totalCustomers ? Math.round((r.resolved / r.totalCustomers) * 100) : 0;
  return (
    <div className="border border-cw-border rounded p-3 bg-white">
      <div className="text-xs font-semibold uppercase tracking-wide text-cw-muted mb-2">{title}</div>
      <div className="flex items-baseline gap-2">
        <span className="text-2xl font-bold text-[#1a1a1a]">{r.resolved}</span>
        <span className="text-sm text-cw-muted">of {r.totalCustomers} customer sites reach a named IC contact ({pct}%)</span>
      </div>
      <div className="mt-2 h-1.5 rounded-full bg-[#f0f0ee] overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: RED }} />
      </div>
      {unresolved > 0 && (
        <ul className="mt-2 text-xs text-cw-muted space-y-0.5">
          {r.unresolvedIcHasNoEmail > 0 && <li>{r.unresolvedIcHasNoEmail} — the serving IC has no email</li>}
          {r.unresolvedNoMatchingIc > 0 && <li>{r.unresolvedNoMatchingIc} — no IC record for that vendor number</li>}
          {r.unresolvedNoVendorNo > 0 && <li>{r.unresolvedNoVendorNo} — the customer row has no vendor number</li>}
        </ul>
      )}
    </div>
  );
}

/**
 * Which sheet columns were understood, which were not, and what each one feeds.
 * Shown BEFORE confirming so a renamed column in a refreshed export reads as an
 * unrecognized header instead of a silent zero-fill import.
 */
function Headers({ h }: { h: HeaderReport }) {
  return (
    <div className="rounded border border-cw-border bg-white p-3 space-y-2">
      <div className="text-xs font-semibold uppercase tracking-wide text-cw-muted">Columns read from this sheet</div>
      <ul className="text-xs space-y-1">
        {h.recognized.map((r) => (
          <li key={r.field} className="flex items-baseline gap-2">
            <span className="text-[#2d7a3a] font-bold">✓</span>
            <span className="font-mono bg-[#f0f0ee] px-1.5 py-0.5 rounded">{r.header}</span>
            <span className="text-cw-muted">→ {r.field}</span>
          </li>
        ))}
      </ul>
      {h.unrecognized.length > 0 && (
        <div className="rounded border border-[#e8cf8a] bg-[#fff8e6] px-2.5 py-2">
          <div className="text-xs font-semibold text-[#7a5a00]">
            Not recognised — nothing from {h.unrecognized.length === 1 ? 'this column' : 'these columns'} is imported
          </div>
          <div className="text-[11px] text-[#7a5a00] mt-1 font-mono break-words">
            {h.unrecognized.join(' · ')}
          </div>
        </div>
      )}
      {h.ignoredByDesign.length > 0 && (
        <div className="text-[11px] text-cw-muted">
          Skipped on purpose: {h.ignoredByDesign.join(' · ')}
        </div>
      )}
    </div>
  );
}

/** Per destination field, how many rows this run would fill. Zero against a
 *  non-empty sheet is stated in red rather than left to be inferred. */
function FieldFills({ fills, rowCount }: { fills: Record<string, number>; rowCount: number }) {
  const entries = Object.entries(fills || {});
  if (!entries.length) return null;
  const allZero = entries.every(([, n]) => n === 0);
  return (
    <div className={`rounded border p-3 ${allZero && rowCount > 0 ? 'border-[#C0272D] bg-[#fbeaea]' : 'border-cw-border bg-white'}`}>
      <div className="text-xs font-semibold uppercase tracking-wide text-cw-muted mb-2">
        What this would write
      </div>
      <ul className="text-xs space-y-1">
        {entries.map(([field, n]) => (
          <li key={field} className="flex items-baseline justify-between gap-3">
            <span className="font-mono text-cw-text">{field}</span>
            <span className={`font-bold ${n > 0 ? 'text-[#1a1a1a]' : 'text-[#C0272D]'}`}>{n}</span>
          </li>
        ))}
      </ul>
      {allZero && rowCount > 0 && (
        <div className="text-[11px] text-[#C0272D] mt-2">
          This sheet has {rowCount} rows but would write nothing. Either every value is already
          on record, or the columns did not match — check the recognised columns above before confirming.
        </div>
      )}
    </div>
  );
}

export default function EmailImportPreview({
  kind, sheet, headers, preview, resolutionBefore, loading, error, onCancel, onConfirm,
}: {
  kind: EmailImportKind;
  sheet: string;
  headers: HeaderReport;
  preview: StaffEmailPreview | IcEmailPreview;
  resolutionBefore?: IcResolution;
  loading: boolean;
  error: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const staff = isStaff(preview);
  return (
    <div className="space-y-4">
      <div className="text-sm text-cw-text">
        Recognised <strong>{staff ? 'the CW employee list' : 'the independent-contractor list'}</strong> on
        sheet <span className="font-mono text-xs bg-[#f0f0ee] px-1.5 py-0.5 rounded">{sheet}</span> — {preview.totalRows} rows.
        Nothing has been written yet.
      </div>

      {staff ? (
        <div className="flex flex-wrap gap-2">
          <Stat label="emails filled in" value={preview.matchedUpdated.length} />
          <Stat label="new roster rows" value={preview.created.length} />
          <Stat label="already had one" value={preview.matchedAlreadyHadEmail.length} tone="muted" />
          <Stat label="ambiguous" value={preview.ambiguous.length} tone={preview.ambiguous.length ? 'gap' : 'muted'} />
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Stat label="contacts filled in" value={preview.matchedUpdated.length} />
          <Stat label="new IC records" value={preview.created.length} />
          <Stat label="already set" value={preview.matchedAlreadyPopulated.length} tone="muted" />
          <Stat label="no email" value={preview.missingEmail.length} tone={preview.missingEmail.length ? 'gap' : 'muted'} />
          <Stat label="no vendor no." value={preview.missingVendorNo.length} tone={preview.missingVendorNo.length ? 'gap' : 'muted'} />
        </div>
      )}

      <Headers h={headers} />
      <FieldFills fills={preview.fieldFills} rowCount={preview.totalRows} />

      {resolutionBefore && <Resolution r={resolutionBefore} title="Before this import" />}

      <div className="space-y-2">
        {staff ? (
          <>
            <List title="Ambiguous — two roster rows share the name, so nothing is applied"
                  tone="gap"
                  items={preview.ambiguous.map((a) => `${a.name}  (ids ${a.ids.join(', ')})`)} />
            <List title="Emails to be filled in"
                  items={preview.matchedUpdated.map((m) => `${m.name} → ${m.email}`)} />
            <List title="New roster rows to create (shift left blank for you to fill)"
                  items={preview.created.map((c) => `${c.name} <${c.email}>  ${c.role_category}`)} />
            <List title="Already had an email — keeping the existing value"
                  items={preview.matchedAlreadyHadEmail.map((m) => `${m.name}: keeping ${m.existing}`)} />
            <List title="Unreadable address — skipped" tone="gap"
                  items={preview.invalidEmail.map((e) => `row ${e.row} ${e.name}: "${e.value}"`)} />
            <List title="Still no email after this import — the visible gap" tone="gap"
                  items={preview.remainingWithoutEmail.map((g) => `${g.name} (${g.role_category})`)} />
          </>
        ) : (
          <>
            <List title="Imported but NO EMAIL — cannot receive a signature form" tone="gap"
                  items={preview.missingEmail.map((m) => `row ${m.row} ${m.dba || '(no DBA)'} — vendor ${m.vendor || 'none'}`)} />
            <List title="Imported but NO BC VENDOR NO — no customer site can resolve to them" tone="gap"
                  items={preview.missingVendorNo.map((m) => `row ${m.row} ${m.dba || '(no DBA)'} <${m.email || 'no email'}>`)} />
            <List title="Contacts to be filled in"
                  items={preview.matchedUpdated.map((m) => `${m.dba} → ${m.contact || '(no contact)'} <${m.email || 'no email'}>`)} />
            <List title="New IC records to create"
                  items={preview.created.map((c) => `${c.dba} [${c.vendor || 'no vendor no'}] ${c.contact} <${c.email || 'no email'}>`)} />
            <List title="Already set — keeping the existing values"
                  items={preview.matchedAlreadyPopulated.map((m) => `${m.dba} [${m.vendor}]`)} />
            <List title="Duplicate vendor numbers in the file — the first row wins" tone="gap"
                  items={preview.duplicateVendorNos.map((d) => `${d.vendor} ×${d.count}`)} />
          </>
        )}
      </div>

      {error && <div className="text-sm text-[#C0272D] bg-[#fbeaea] border border-[#C0272D] rounded px-3 py-2">{error}</div>}

      <div className="flex items-center justify-between pt-1">
        <span className="text-xs text-cw-muted">
          Safe to run twice — existing values are never overwritten.
        </span>
        <div className="flex gap-2">
          <button onClick={onCancel} className="btn-secondary" disabled={loading}>Cancel</button>
          <button onClick={onConfirm} className="btn-primary" disabled={loading}>
            {loading ? 'Importing…' : 'Apply import'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function EmailImportSummary({
  kind, report, resolution, onDone, onAnother,
}: {
  kind: EmailImportKind;
  report: any;
  resolution?: IcResolution;
  onDone: () => void;
  onAnother: () => void;
}) {
  const staff = kind === 'staff-emails';
  const filled = report.matchedUpdated?.length ?? 0;
  const created = report.created?.length ?? 0;
  const gap = staff ? (report.remainingWithoutEmail?.length ?? 0) : (report.missingEmail?.length ?? 0);

  return (
    <div className="space-y-4">
      <div className="text-center py-2">
        <div className="text-4xl">{filled + created > 0 ? '✅' : 'ℹ️'}</div>
        <div className="text-lg font-bold text-cw-text mt-2">
          {filled} {staff ? 'email' : 'contact'}{filled !== 1 ? 's' : ''} filled in, {created} record{created !== 1 ? 's' : ''} created
        </div>
        {filled + created === 0 && (
          <div className="text-sm text-cw-muted mt-1">
            Everything in this file was already on record — nothing needed changing.
          </div>
        )}
      </div>

      {resolution && <Resolution r={resolution} title="After this import" />}

      {gap > 0 && (
        <div className="rounded border border-[#C0272D] bg-[#fbeaea] px-3 py-2">
          <div className="text-sm font-semibold text-[#C0272D]">
            {gap} {staff ? 'staff member' : 'IC'}{gap !== 1 ? 's' : ''} still without an email
          </div>
          <div className="text-xs text-[#C0272D] mt-0.5">
            They show the red “No email on file” flag until an address is added. That is the visible gap, not an error.
          </div>
        </div>
      )}

      {staff && report.ambiguous?.length > 0 && (
        <List title="Ambiguous names — resolve these by hand" tone="gap"
              items={report.ambiguous.map((a: any) => `${a.name} (ids ${a.ids.join(', ')})`)} />
      )}

      <div className="flex gap-2 justify-center pt-1">
        <button onClick={onDone} className="btn-primary">View Registry →</button>
        <button onClick={onAnother} className="btn-secondary">Import another file</button>
      </div>
    </div>
  );
}
