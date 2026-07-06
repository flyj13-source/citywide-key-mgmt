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
function SyncStatusFooter() {
  const [status, setStatus] = useState<CwSyncStatus | null>(null);

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
  const color = online ? '#2d7a3a' : '#8a5c00';
  const queued = status.queuedWrites + status.queuedAi;

  let label: string;
  if (online) {
    label = status.syncing ? 'Online — syncing…' : `Online — synced ${relativeTime(status.lastPullAt)}`;
  } else {
    label = queued > 0
      ? `Offline — ${queued} change${queued === 1 ? '' : 's'} queued`
      : 'Offline';
  }

  return (
    <div className="px-4 py-2 border-t border-white/10 flex items-center gap-2" style={{ fontSize: 11 }}>
      <span style={{ color, fontSize: 9, lineHeight: 1 }}>●</span>
      <span style={{ color: online ? '#8fb89a' : '#c9a24a' }}>{label}</span>
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
