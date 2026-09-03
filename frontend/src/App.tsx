import { BrowserRouter, HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import { isAuthenticated } from './lib/auth';

// Under Electron the app is loaded via file:// — HashRouter avoids broken deep
// links. The web build keeps clean BrowserRouter URLs.
const Router = import.meta.env.VITE_DESKTOP === '1' ? HashRouter : BrowserRouter;
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Registry from './pages/Registry';
import AccountDetail from './pages/AccountDetail';
import CodeVault from './pages/CodeVault';
import ClaudeAssistant from './pages/ClaudeAssistant';
import AuditLog from './pages/AuditLog';
import Reports from './pages/Reports';
import Contractors from './pages/Contractors';
import Settings from './pages/Settings';
import ContractorPortal from './pages/ContractorPortal';
import KeySignoff from './pages/KeySignoff';
import KeyFormSignoff from './pages/KeyFormSignoff';
import ICChange from './pages/ICChange';
import CustomerLookup from './pages/CustomerLookup';
import Forms from './pages/Forms';
import StaffDetail from './pages/StaffDetail';
import CustodyReport from './pages/CustodyReport';

function RequireAuth({ children }: { children: React.ReactNode }) {
  return isAuthenticated() ? <>{children}</> : <Navigate to="/login" replace />;
}

export default function App() {
  return (
    <Router>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/contractor/:token" element={<ContractorPortal />} />
        {/* Public, login-free key sign-off (48h token from the check-out email) */}
        <Route path="/key-signoff/:token" element={<KeySignoff />} />
        {/* Public, login-free Key Form acknowledgement (48h token). */}
        <Route path="/key-form/:token" element={<KeyFormSignoff />} />
        <Route path="/dashboard" element={<RequireAuth><Dashboard /></RequireAuth>} />
        <Route path="/registry" element={<RequireAuth><Registry /></RequireAuth>} />
        {/* Declared BEFORE /registry/:accountId so the literal path wins over
            the id parameter. */}
        <Route path="/registry/custody-report" element={<RequireAuth><CustodyReport /></RequireAuth>} />
        <Route path="/registry/:accountId" element={<RequireAuth><AccountDetail /></RequireAuth>} />
        {/* The Manager Roster now lives INSIDE the Key Registry. Old links and
            bookmarks land on the right tab instead of 404ing. */}
        <Route path="/managers" element={<Navigate to="/registry?tab=account-managers" replace />} />
        <Route path="/managers/:id" element={<Navigate to="/registry?tab=account-managers" replace />} />
        <Route path="/staff/:id" element={<RequireAuth><StaffDetail /></RequireAuth>} />
        {/* Check Out / In now lives INSIDE the Key Registry — old links land on
            the Checked Out tab rather than 404ing. */}
        <Route path="/checkout" element={<Navigate to="/registry?tab=checkedout" replace />} />
        <Route path="/vault" element={<RequireAuth><CodeVault /></RequireAuth>} />
        <Route path="/assistant" element={<RequireAuth><ClaudeAssistant /></RequireAuth>} />
        <Route path="/audit" element={<RequireAuth><AuditLog /></RequireAuth>} />
        <Route path="/reports" element={<RequireAuth><Reports /></RequireAuth>} />
        <Route path="/contractors" element={<RequireAuth><Contractors /></RequireAuth>} />
        <Route path="/settings" element={<RequireAuth><Settings /></RequireAuth>} />
        <Route path="/ic-change" element={<RequireAuth><ICChange /></RequireAuth>} />
        <Route path="/customer-lookup" element={<RequireAuth><CustomerLookup /></RequireAuth>} />
        <Route path="/forms" element={<RequireAuth><Forms /></RequireAuth>} />
        <Route path="*" element={<Navigate to={isAuthenticated() ? '/dashboard' : '/login'} replace />} />
      </Routes>
    </Router>
  );
}
