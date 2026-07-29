import { BrowserRouter, HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import { isAuthenticated } from './lib/auth';

// Under Electron the app is loaded via file:// — HashRouter avoids broken deep
// links. The web build keeps clean BrowserRouter URLs.
const Router = import.meta.env.VITE_DESKTOP === '1' ? HashRouter : BrowserRouter;
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Registry from './pages/Registry';
import AccountDetail from './pages/AccountDetail';
import Checkout from './pages/Checkout';
import CodeVault from './pages/CodeVault';
import ClaudeAssistant from './pages/ClaudeAssistant';
import AuditLog from './pages/AuditLog';
import Reports from './pages/Reports';
import Contractors from './pages/Contractors';
import Settings from './pages/Settings';
import ContractorPortal from './pages/ContractorPortal';
import ICChange from './pages/ICChange';
import CustomerLookup from './pages/CustomerLookup';
import Forms from './pages/Forms';
import ManagerRoster from './pages/ManagerRoster';
import ManagerDetail from './pages/ManagerDetail';
import StaffDetail from './pages/StaffDetail';

function RequireAuth({ children }: { children: React.ReactNode }) {
  return isAuthenticated() ? <>{children}</> : <Navigate to="/login" replace />;
}

export default function App() {
  return (
    <Router>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/contractor/:token" element={<ContractorPortal />} />
        <Route path="/dashboard" element={<RequireAuth><Dashboard /></RequireAuth>} />
        <Route path="/registry" element={<RequireAuth><Registry /></RequireAuth>} />
        <Route path="/registry/:accountId" element={<RequireAuth><AccountDetail /></RequireAuth>} />
        <Route path="/managers" element={<RequireAuth><ManagerRoster /></RequireAuth>} />
        <Route path="/managers/:id" element={<RequireAuth><ManagerDetail /></RequireAuth>} />
        <Route path="/staff/:id" element={<RequireAuth><StaffDetail /></RequireAuth>} />
        <Route path="/checkout" element={<RequireAuth><Checkout /></RequireAuth>} />
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
