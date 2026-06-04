import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import type { AccountRole } from '@/lib/auth';
import { getDefaultRouteByRole } from '@/lib/auth';

interface AccessRouteProps {
  roles?: AccountRole[];
  children: ReactNode;
}

export default function AccessRoute({ roles, children }: AccessRouteProps) {
  const { user, isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
        Loading session...
      </div>
    );
  }

  if (!isAuthenticated || !user) {
    return <Navigate to="/login" replace />;
  }

  if (roles && !roles.includes(user.role)) {
    return <Navigate to={getDefaultRouteByRole(user.role)} replace />;
  }

  return <>{children}</>;
}
