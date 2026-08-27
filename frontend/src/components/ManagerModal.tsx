import { useState } from 'react';
import Modal from './Modal';
import { createStaffManager, updateStaffManager, type StaffManager } from '../lib/api';

// Shared Add / Edit modal for the staff manager roster. Used by the Dashboard
// "+ Add Manager" button, the roster page, and the manager detail page.

const TYPE_OPTIONS: { value: StaffManager['manager_type']; label: string }[] = [
  { value: 'account_manager', label: 'Account Manager' },
  { value: 'ccm', label: 'Contract Compliance Manager' },
  { value: 'both', label: 'Both' },
];
const SHIFT_OPTIONS = ['1st', '2nd', '3rd'] as const;
const DAY_NIGHT_OPTIONS = ['day', 'night'] as const;

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="text-[10px] font-bold uppercase tracking-widest text-[#1a1a1a] border-b border-gray-200 pb-1 mb-3">{children}</div>;
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-[#C0272D] focus:ring-offset-1 ${checked ? 'bg-[#C0272D]' : 'bg-gray-300'}`}
    >
      <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-6' : 'translate-x-1'}`} />
    </button>
  );
}

interface FormState {
  name: string;
  manager_type: StaffManager['manager_type'] | '';
  shift: string;
  day_night: string;
  email: string;
  phone: string;
  active: boolean;
}

export default function ManagerModal({
  mode, initial, onClose, onSaved,
}: {
  mode: 'add' | 'edit';
  initial?: StaffManager;
  onClose: () => void;
  onSaved: (m: StaffManager) => void;
}) {
  const [form, setForm] = useState<FormState>(() => ({
    name: initial?.name ?? '',
    manager_type: initial?.manager_type ?? '',
    shift: initial?.shift ?? '',
    day_night: initial?.day_night ?? '',
    email: initial?.email ?? '',
    phone: initial?.phone ?? '',
    active: initial ? initial.active === 1 : true,
  }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const f = <K extends keyof FormState>(key: K, val: FormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: val }));

  const valid = form.name.trim() !== '' && form.manager_type !== '';

  const save = async () => {
    if (!valid) return;
    setSaving(true); setError('');
    try {
      const payload = {
        name: form.name.trim(),
        manager_type: form.manager_type as StaffManager['manager_type'],
        shift: (form.shift || null) as any,
        day_night: (form.day_night || null) as any,
        email: form.email.trim() || null,
        phone: form.phone.trim() || null,
        active: form.active ? 1 : 0,
      };
      const res = mode === 'add'
        ? await createStaffManager(payload)
        : await updateStaffManager(initial!.id, payload);
      onSaved(res.manager);
    } catch (err: any) {
      setError(err?.message || 'Could not save');
    } finally {
      setSaving(false);
    }
  };

  const title = mode === 'add' ? 'Add Manager' : `Edit: ${initial?.name}`;

  return (
    <Modal title={title} onClose={onClose} width="max-w-md">
      <div className="space-y-5">
        <div>
          <SectionLabel>Manager</SectionLabel>
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Name *</label>
              <input
                className="input focus:ring-[#C0272D] focus:border-[#C0272D]"
                value={form.name}
                onChange={(e) => f('name', e.target.value)}
                placeholder="Full name"
                autoFocus
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Manager Type *</label>
              <div className="flex flex-col gap-1.5">
                {TYPE_OPTIONS.map((opt) => (
                  <label key={opt.value} className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                    <input
                      type="radio"
                      name="manager_type"
                      className="accent-[#C0272D]"
                      checked={form.manager_type === opt.value}
                      onChange={() => f('manager_type', opt.value)}
                    />
                    {opt.label}
                  </label>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div>
          <SectionLabel>Schedule</SectionLabel>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Shift</label>
              <select
                className="input focus:ring-[#C0272D] focus:border-[#C0272D]"
                value={form.shift}
                onChange={(e) => f('shift', e.target.value)}
              >
                <option value="">—</option>
                {SHIFT_OPTIONS.map((s) => <option key={s} value={s}>{s} shift</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Day or Night</label>
              <select
                className="input focus:ring-[#C0272D] focus:border-[#C0272D]"
                value={form.day_night}
                onChange={(e) => f('day_night', e.target.value)}
              >
                <option value="">—</option>
                {DAY_NIGHT_OPTIONS.map((d) => <option key={d} value={d}>{d[0].toUpperCase() + d.slice(1)}</option>)}
              </select>
            </div>
          </div>
        </div>

        <div>
          <SectionLabel>Contact</SectionLabel>
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">
                Email
                <span className="ml-1 font-normal text-[#C0272D]">
                  — required for signature forms and notifications
                </span>
              </label>
              <input
                type="email"
                className={`input focus:ring-[#C0272D] focus:border-[#C0272D] ${
                  form.email.trim() ? '' : 'border-[#C0272D] bg-[#fbeaea]'}`}
                value={form.email}
                onChange={(e) => f('email', e.target.value)}
                placeholder="name@citywideboston.com"
              />
              {/* Not blocked — a manager can exist without one — but never let
                  it be left blank silently: it is what a key sign-off needs. */}
              {!form.email.trim() && (
                <p className="text-[11px] text-[#C0272D] mt-1">
                  Without an email this person cannot be sent a key signature request, and
                  check-outs to them will be flagged “No signature — no email on file”.
                </p>
              )}
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Phone</label>
              <input
                className="input focus:ring-[#C0272D] focus:border-[#C0272D]"
                value={form.phone}
                onChange={(e) => f('phone', e.target.value)}
                placeholder="(617) 555-0100"
              />
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-gray-700">Active</span>
          <Toggle checked={form.active} onChange={(v) => f('active', v)} />
        </div>

        {error && (
          <p className="text-sm text-[#C0272D] bg-[#fbeaea] border border-[#f0c9cb] rounded px-3 py-2">{error}</p>
        )}
      </div>

      <div className="flex gap-2 pt-4 border-t border-gray-200 mt-4">
        <button
          onClick={save}
          disabled={saving || !valid}
          className="px-4 py-2 bg-[#C0272D] text-white text-sm font-medium rounded hover:bg-[#a82227] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {saving ? 'Saving…' : mode === 'add' ? 'Add Manager' : 'Save Changes'}
        </button>
        <button onClick={onClose} className="px-4 py-2 border border-[#1a1a1a] text-[#1a1a1a] text-sm font-medium rounded hover:bg-gray-50 transition-colors">Cancel</button>
      </div>
    </Modal>
  );
}

export { TYPE_OPTIONS };
