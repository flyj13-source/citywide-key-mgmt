const TOKEN_KEY = 'cw_token';
const MANAGER_KEY = 'cw_manager';

export interface Manager {
  id: number;
  name: string;
  email: string;
  role: string;
  is_test?: boolean;
  can_delete?: boolean;
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function getManager(): Manager | null {
  const raw = localStorage.getItem(MANAGER_KEY);
  return raw ? JSON.parse(raw) : null;
}

export function setAuth(token: string, manager: Manager) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(MANAGER_KEY, JSON.stringify(manager));
}

export function clearAuth() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(MANAGER_KEY);
}

export function isAuthenticated(): boolean {
  return !!getToken();
}
