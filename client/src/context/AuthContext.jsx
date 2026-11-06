import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, json } from '../lib/api';

const AuthContext = createContext(null);
export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const data = await api('/api/auth/me');
      setUser(data.user);
      return data.user;
    } catch {
      setUser(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const login = useCallback(async (email, password) => {
    const data = await api('/api/auth/login', { method: 'POST', body: json({ email, password }) });
    setUser(data.user);
    return data.user;
  }, []);
  const register = useCallback(async (email, password, name) => {
    const data = await api('/api/auth/register', { method: 'POST', body: json({ email, password, name }) });
    setUser(data.user);
    return data.user;
  }, []);
  const logout = useCallback(async () => {
    try { await api('/api/auth/logout', { method: 'POST', body: json({}) }); }
    finally { setUser(null); }
  }, []);
  const value = useMemo(() => ({ user, loading, login, register, logout, refresh }), [user, loading, login, register, logout, refresh]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider');
  return context;
}
