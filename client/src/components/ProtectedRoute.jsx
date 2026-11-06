import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { Loading } from './UI';

export function ProtectedRoute() {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <Loading label="正在检查登录状态…" />;
  return user ? <Outlet /> : <Navigate to="/login" replace state={{ from: location }} />;
}
export function AdminRoute() {
  const { user, loading } = useAuth();
  if (loading) return <Loading label="正在检查权限…" />;
  if (!user) return <Navigate to="/login" replace />;
  return user.role === 'admin' ? <Outlet /> : <Navigate to="/account" replace />;
}
