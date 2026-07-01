import { NavLink, useNavigate } from 'react-router-dom';
import { clearAuth, getManager } from '../lib/auth';
import { CWLogoSidebar } from './CWLogo';

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
