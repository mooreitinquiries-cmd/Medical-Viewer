import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Activity, LoaderCircle } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import { getDefaultRouteByRole } from '@/lib/auth';
import { toast } from 'sonner';

export default function Login() {
  const navigate = useNavigate();
  const { signIn, user, isLoading } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (!isLoading && user) {
    return <Navigate to={getDefaultRouteByRole(user.role)} replace />;
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);

    const result = await signIn({
      email: username,
      password,
    });

    if (!result.ok) {
      setIsSubmitting(false);
      toast.error(result.error || 'Sign in failed');
      return;
    }

    navigate(getDefaultRouteByRole(result.user?.role ?? 'doctor'), { replace: true });
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="w-full max-w-sm animate-fade-up">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-primary">
            <Activity className="h-6 w-6 text-primary-foreground" />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">OCTELERAD PACS</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Sign in to access clinical messaging, video calls, and case workflows.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 rounded-xl border bg-card p-6 shadow-sm">
          <div className="space-y-2">
            <Label htmlFor="username">Username</Label>
            <Input
              id="username"
              type="text"
              placeholder="Enter username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          <Button
            type="submit"
            disabled={isSubmitting || isLoading}
            className="w-full active:scale-[0.98] transition-transform"
          >
            {isSubmitting ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : null}
            {isSubmitting ? 'Signing In...' : 'Sign In'}
          </Button>

          <div className="rounded-md border border-border/70 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
            Production portal: pacs.octelerad.com
          </div>
        </form>
      </div>
    </div>
  );
}
