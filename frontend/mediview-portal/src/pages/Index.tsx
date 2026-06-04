import { Navigate } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import { getDefaultRouteByRole } from '@/lib/auth';

export default function Index() {
  const { user, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
        Loading session...
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  return <Navigate to={getDefaultRouteByRole(user.role)} replace />;
}
