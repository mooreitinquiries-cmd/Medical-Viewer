import { useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/context/AuthContext';
import { ACCOUNT_STATUS_LABELS, ROLE_LABELS, validatePassword } from '@/lib/auth';

export default function AccountSettings() {
  const { user, changePassword } = useAuth();
  const [currentPassword, setCurrentPassword] = useState('');
  const [nextPassword, setNextPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  if (!user) {
    return null;
  }

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();

    if (nextPassword !== confirmPassword) {
      toast.error('New password and confirmation do not match');
      return;
    }

    const validationMessage = validatePassword(nextPassword);
    if (validationMessage) {
      toast.error(validationMessage);
      return;
    }

    const result = await changePassword({
      currentPassword,
      nextPassword,
    });

    if (!result.ok) {
      toast.error(result.error || 'Could not update password');
      return;
    }

    setCurrentPassword('');
    setNextPassword('');
    setConfirmPassword('');
    toast.success('Password updated');
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Account Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Review your role and update your local password policy-compliantly.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-[0.95fr_1.05fr]">
        <div className="rounded-xl border bg-card p-4 shadow-sm">
          <div className="mb-4 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Profile
          </div>
          <div className="space-y-3 text-sm">
            <div>
              <div className="text-muted-foreground">Name</div>
              <div className="font-medium">{user.name}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Username</div>
              <div className="font-medium">{user.username}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Email</div>
              <div className="font-medium">{user.email}</div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge variant="secondary">{ROLE_LABELS[user.role]}</Badge>
              <Badge variant={user.status === 'active' ? 'outline' : 'destructive'}>
                {ACCOUNT_STATUS_LABELS[user.status]}
              </Badge>
              <Badge variant={user.twoFactorEnabled ? 'outline' : 'secondary'}>
                {user.twoFactorEnabled ? '2FA enabled' : '2FA disabled'}
              </Badge>
            </div>
            <div className="rounded-lg border border-border/70 bg-muted/20 px-3 py-3 text-xs text-muted-foreground">
              Created: {new Date(user.createdAt).toLocaleString()}
              <br />
              Last login: {user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString() : 'Never'}
            </div>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 rounded-xl border bg-card p-4 shadow-sm">
          <div>
            <div className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Change Password
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Passwords must contain uppercase, lowercase, and numeric characters and be at least
              8 characters long.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="current-password">Current password</Label>
            <Input
              id="current-password"
              type="password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              placeholder="Enter current password"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="next-password">New password</Label>
            <Input
              id="next-password"
              type="password"
              value={nextPassword}
              onChange={(event) => setNextPassword(event.target.value)}
              placeholder="Enter new password"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="confirm-password">Confirm new password</Label>
            <Input
              id="confirm-password"
              type="password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              placeholder="Repeat new password"
            />
          </div>

          <Button type="submit">Update Password</Button>
        </form>
      </div>
    </div>
  );
}
