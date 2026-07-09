import { useEffect, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { clearAuth, getManager } from '../lib/auth';
import { CWLogoSidebar } from './CWLogo';
import type { CwSyncStatus } from '../cwSync';

function relativeTime(iso: string | null): string {
  if (!iso) return 'not yet';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return 'just now';
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/**
 * Sidebar sync footer (desktop only). Reads window.cwSync from the Electron
 * preload; renders nothing in the plain web build.
 *   ● Online — synced 2 min ago     (green)
 *   ● Offline — 4 changes queued    (amber)
 */
/** ti-refresh icon (inline SVG — no icon font is bundled). Spins while syncing. */
function RefreshIcon({ spinning }: { spinning: boolean }) {
  return (
    <svg
      className={`ti-refresh${spinning ? ' cw-spin' : ''}`}
      width="12" height="12" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M3 21v-5h5" />
    </svg>
  );
}

function SyncStatusFooter() {
  const [status, setStatus] = useState<CwSyncStatus | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!window.cwSync) return;
    window.cwSync.getStatus().then(setStatus);
    const off = window.cwSync.onStatus(setStatus);
    // Re-render "synced N min ago" every 30s even without a status push.
    const tick = setInterval(() => setStatus((s) => (s ? { ...s } : s)), 30_000);
    return () => { off?.(); clearInterval(tick); };
  }, []);

  if (!window.cwSync || !status) return null;

  const online = status.online;
  const syncing = status.syncing || busy;
  const queued = status.queuedWrites + status.queuedAi;

  // Status line: green when healthy online, amber when offline or failed.
  let dotColor = '#2d7a3a';
  let textColor = '#8fb89a';
  let label: string;
  if (!online) {
    dotColor = '#8a5c00';
    textColor = '#c9a24a';
    label = queued > 0 ? `Offline — ${queued} change${queued === 1 ? '' : 's'} queued` : 'Offline';
  } else if (syncing) {
    label = 'Online — syncing…';
  } else if (status.lastError) {
    dotColor = '#8a5c00';
    textColor = '#c9a24a';
    label = 'Sync failed — retrying in 30s';
  } else {
    label = `Online — synced ${relativeTime(status.lastPullAt)}`;
  }

  const handleSync = async () => {
    if (!online || syncing) return;
    setBusy(true);
    try { await window.cwSync?.syncNow(); } finally { setBusy(false); }
  };

  const disabled = !online || syncing;

  return (
    <div className="px-4 py-2 border-t border-white/10" style={{ fontSize: 11 }}>
      <div className="flex items-center gap-2">
        <span style={{ color: dotColor, fontSize: 9, lineHeight: 1 }}>●</span>
        <span style={{ color: textColor }}>{label}</span>
      </div>
      <button
        onClick={handleSync}
        disabled={disabled}
        title={!online ? 'Unavailable offline — changes are queued automatically' : undefined}
        className="mt-1.5 -ml-1 flex items-center gap-1.5 rounded px-1.5 py-1 bg-transparent transition-colors disabled:cursor-not-allowed enabled:hover:bg-[#fdf2f2]"
        style={{ fontSize: 11, color: disabled ? '#6b6b68' : '#C0272D', opacity: !online ? 0.5 : 1 }}
      >
        <RefreshIcon spinning={syncing} />
        <span>{syncing ? 'Syncing…' : 'Sync now'}</span>
      </button>
    </div>
  );
}

const mainNavItems = [
  { path: '/dashboard', label: 'Dashboard', icon: '⊞' },
  { path: '/registry', label: 'Key Registry', icon: '🔑' },
  { path: '/checkout', label: 'Check Out / In', icon: '↕' },
  { path: '/vault', label: 'Code Vault', icon: '🔒' },
  { path: '/assistant', label: 'AI Assistant', icon: '✦' },
  { path: '/audit', label: 'Audit Log', icon: '📋' },
  { path: '/reports', label: 'Reports', icon: '📊' },
  { path: '/contractors', label: 'Contractors', icon: '📝' },
  { path: '/settings', label: 'Settings', icon: '⚙' },
];

const formsNavItems = [
  { path: '/ic-change', label: 'IC Change', icon: '✎' },
  { path: '/customer-lookup', label: 'Customer Lookup', icon: '⊡' },
];

function NavItem({ path, label, icon }: { path: string; label: string; icon: string }) {
  return (
    <NavLink
      to={path}
      end={path === '/registry'}
      className={({ isActive }) =>
        `flex items-center gap-3 px-4 py-2.5 text-sm transition-colors relative ${
          isActive
            ? 'text-white bg-white/10 border-l-[3px] border-cw-red pl-[13px]'
            : 'text-gray-400 hover:text-white hover:bg-white/5 border-l-[3px] border-transparent pl-[13px]'
        }`
      }
    >
      <span className="text-base w-5 text-center flex-shrink-0">{icon}</span>
      <span>{label}</span>
    </NavLink>
  );
}

export default function Layout({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const manager = getManager();

  const handleLogout = () => {
    clearAuth();
    navigate('/login');
  };

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Sidebar */}
      <aside className="w-56 flex-shrink-0 bg-cw-black flex flex-col">
        <div className="px-4 py-4 border-b border-white/10">
          <div className="bg-white rounded-md p-2 flex items-center justify-center">
            <CWLogoSidebar className="w-32 h-auto" />
          </div>
        </div>

        <nav className="flex-1 py-3 overflow-y-auto">
          {mainNavItems.map((item) => (
            <NavItem key={item.path} {...item} />
          ))}

          <div className="px-4 pt-4 pb-1">
            <div className="text-[10px] font-semibold uppercase tracking-widest text-gray-600">Forms</div>
          </div>
          {formsNavItems.map((item) => (
            <NavItem key={item.path} {...item} />
          ))}
        </nav>

        <SyncStatusFooter />

        <div className="px-4 py-4 border-t border-white/10">
          <div className="text-xs text-gray-500 mb-1">{manager?.name}</div>
          <div className="text-xs text-gray-600 mb-3 truncate">{manager?.email}</div>
          <button
            onClick={handleLogout}
            className="text-xs text-gray-500 hover:text-white transition-colors"
          >
            Sign out →
          </button>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 overflow-y-auto bg-cw-bg">
        {children}
      </main>
    </div>
  );
}
