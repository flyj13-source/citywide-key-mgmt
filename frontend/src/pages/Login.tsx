import { useState, FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { login } from '../lib/api';
import { setAuth } from '../lib/auth';
import { CWLogoFull } from '../components/CWLogo';

export default function Login() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('cara@citywideboston.com');
  const [password, setPassword] = useState('demo1234');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const data = await login(email, password);
      setAuth(data.token, data.manager);
      navigate('/dashboard');
    } catch (err: any) {
      setError(err.message || 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-cw-bg flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        {/* Logo card */}
        <div className="bg-white border border-cw-border rounded-lg p-8 mb-4 flex items-center justify-center">
          <CWLogoFull className="w-64 h-auto" />
        </div>

        <div className="card p-6">
          <p className="text-xs text-cw-muted text-center mb-5 uppercase tracking-widest font-medium">
            Key Management System
          </p>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-cw-muted mb-1">Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="input"
                required
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-cw-muted mb-1">Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="input"
                required
              />
            </div>
            {error && (
              <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2">
                {error}
              </div>
            )}
            <button type="submit" disabled={loading} className="btn-primary w-full">
              {loading ? 'Signing in…' : 'Sign In'}
            </button>
          </form>
        </div>

        <p className="text-center text-xs text-cw-muted mt-4">
          City Wide Facility Solutions · Boston, MA
        </p>
      </div>
    </div>
  );
}
