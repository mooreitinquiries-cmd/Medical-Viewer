import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import type { AccountRole } from '@/lib/auth';
import { getDefaultRouteByRole } from '@/lib/auth';
import type { WhiteLabelFeature } from '@/lib/whiteLabelEntitlements';

interface AccessRouteProps {
  roles?: AccountRole[];
  features?: WhiteLabelFeature[];
  children: ReactNode;
}

export default function AccessRoute({ roles, features, children }: AccessRouteProps) {
  const { user, isAuthenticated, isLoading, hasAnyFeature } = useAuth();
  const location = useLocation();

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

  if (features?.length && !hasAnyFeature(features)) {
    const fallback = getDefaultRouteByRole(user.role);
    return <Navigate to={fallback === location.pathname ? '/account' : fallback} replace />;
  }

  return <>{children}</>;
}
