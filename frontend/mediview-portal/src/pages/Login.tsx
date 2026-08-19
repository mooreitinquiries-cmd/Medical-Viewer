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
  const { signIn, verifyTwoFactorSignIn, user, isLoading } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [twoFactorChallengeId, setTwoFactorChallengeId] = useState('');
  const [twoFactorEmail, setTwoFactorEmail] = useState('');
  const [twoFactorCode, setTwoFactorCode] = useState('');
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

    if (result.twoFactorRequired) {
      setTwoFactorChallengeId(result.twoFactorRequired.challengeId);
      setTwoFactorEmail(result.twoFactorRequired.email);
      setTwoFactorCode('');
      setIsSubmitting(false);
      toast.success('Verification code sent');
      return;
    }

    navigate(getDefaultRouteByRole(result.user?.role ?? 'doctor'), { replace: true });
  };

  const handleTwoFactorSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);

    const result = await verifyTwoFactorSignIn({
      email: twoFactorEmail || username,
      challengeId: twoFactorChallengeId,
      code: twoFactorCode,
    });

    if (!result.ok) {
      setIsSubmitting(false);
      toast.error(result.error || 'Could not verify code');
      return;
    }

    navigate(getDefaultRouteByRole(result.user?.role ?? 'doctor'), { replace: true });
  };

  const resetTwoFactorStep = () => {
    setTwoFactorChallengeId('');
    setTwoFactorEmail('');
    setTwoFactorCode('');
    setPassword('');
  };

  const isTwoFactorStep = Boolean(twoFactorChallengeId);

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

        <form onSubmit={isTwoFactorStep ? handleTwoFactorSubmit : handleSubmit} className="space-y-4 rounded-xl border bg-card p-6 shadow-sm">
          {!isTwoFactorStep ? (
            <>
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
            </>
          ) : (
            <>
              <div className="space-y-1">
                <div className="text-sm font-medium">Verification code</div>
                <p className="text-sm text-muted-foreground">
                  Enter the 6-digit code sent to {twoFactorEmail || username}.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="two-factor-code">Code</Label>
                <Input
                  id="two-factor-code"
                  inputMode="numeric"
                  maxLength={6}
                  placeholder="000000"
                  value={twoFactorCode}
                  onChange={(e) => setTwoFactorCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  required
                />
              </div>
            </>
          )}
          <Button
            type="submit"
            disabled={isSubmitting || isLoading || (isTwoFactorStep && twoFactorCode.length !== 6)}
            className="w-full active:scale-[0.98] transition-transform"
          >
            {isSubmitting ? <LoaderCircle className="mr-2 h-4 w-4 animate-spin" /> : null}
            {isSubmitting ? 'Signing In...' : isTwoFactorStep ? 'Verify Code' : 'Sign In'}
          </Button>

          {isTwoFactorStep ? (
            <Button type="button" variant="ghost" className="w-full" onClick={resetTwoFactorStep}>
              Use a different account
            </Button>
          ) : null}

          <div className="rounded-md border border-border/70 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
            Production portal: pacs.octelerad.com
          </div>
        </form>
      </div>
    </div>
  );
}
