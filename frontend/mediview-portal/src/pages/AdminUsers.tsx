import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/context/AuthContext';
import {
  ACCOUNT_STATUS_LABELS,
  CREATABLE_ROLES,
  ROLE_LABELS,
  validatePassword,
  validateUsername,
  type AccountRole,
} from '@/lib/auth';
import { showErrorToast } from '@/lib/errorToast';

const QUICK_ACCESS_LINKS = [
  { to: '/dashboard', label: 'Open Dashboard', description: 'Study volume, modalities, and recent activity.' },
  { to: '/care-desk', label: 'Open Care Desk', description: 'Doctor-to-patient case handoff workspace.' },
  { to: '/upload', label: 'Open New Case', description: 'Create a new case and submit imaging into the portal.' },
  { to: '/studies', label: 'Open Studies', description: 'Browse uploaded studies and drill into details.' },
  { to: '/cases', label: 'Open Patient Cases', description: 'Review the patient-facing case inbox.' },
  { to: '/messages', label: 'Open Messages', description: 'Access the messaging area.' },
  { to: '/video', label: 'Open Video Calls', description: 'Jump into the video consultation area.' },
  { to: '/account', label: 'Open Account', description: 'Review account status and password controls.' },
];

export default function AdminUsers() {
  const { users, createUser, updateUserStatus, resetUserPassword, isLoading } = useAuth();
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<AccountRole>('doctor');
  const [search, setSearch] = useState('');
  const [resetPasswordDrafts, setResetPasswordDrafts] = useState<Record<string, string>>({});

  const sortedUsers = useMemo(() => {
    const filtered = users.filter((currentUser) => {
      if (!search.trim()) {
        return true;
      }

      const haystack =
        `${currentUser.name} ${currentUser.username} ${currentUser.email} ${currentUser.role} ${currentUser.status}`.toLowerCase();
      return haystack.includes(search.trim().toLowerCase());
    });

    return [...filtered].sort((a, b) => a.name.localeCompare(b.name));
  }, [search, users]);

  const handleCreate = async (event: React.FormEvent) => {
    event.preventDefault();

    const cleanedName = name.trim();
    const cleanedUsername = username.trim().toLowerCase();
    const cleanedEmail = email.trim().toLowerCase();

    if (!cleanedName || !cleanedUsername || !cleanedEmail || !password.trim()) {
      toast.error('Name, username, email, and password are required');
      return;
    }

    const usernameMessage = validateUsername(cleanedUsername);
    if (usernameMessage) {
      toast.error(usernameMessage);
      return;
    }

    const result = await createUser({
      name: cleanedName,
      username: cleanedUsername,
      email: cleanedEmail,
      password,
      role,
    });

    if (!result.ok) {
      showErrorToast(result.error, 'Could not create user');
      return;
    }

    toast.success('User profile created');
    setName('');
    setUsername('');
    setEmail('');
    setPassword('');
    setRole('doctor');
  };

  const handleStatusToggle = async (emailAddress: string, nextStatus: 'active' | 'suspended') => {
    const result = await updateUserStatus({ email: emailAddress, status: nextStatus });

    if (!result.ok) {
      showErrorToast(result.error, 'Could not update account status');
      return;
    }

    toast.success(nextStatus === 'active' ? 'Account reactivated' : 'Account suspended');
  };

  const handlePasswordReset = async (emailAddress: string) => {
    const nextPassword = resetPasswordDrafts[emailAddress]?.trim() || '';
    const validationMessage = validatePassword(nextPassword);

    if (validationMessage) {
      toast.error(validationMessage);
      return;
    }

    const result = await resetUserPassword({ email: emailAddress, nextPassword });

    if (!result.ok) {
      showErrorToast(result.error, 'Could not reset password');
      return;
    }

    setResetPasswordDrafts((current) => ({
      ...current,
      [emailAddress]: '',
    }));
    toast.success('Password reset saved');
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">User Profile Admin</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Create accounts, suspend access, and reset temporary passwords from the master admin
          profile.
        </p>
      </div>

      <div className="rounded-xl border bg-card p-4 shadow-sm">
        <div className="mb-1 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Quick Access
        </div>
        <p className="mb-4 text-sm text-muted-foreground">
          Use this page as the launch point for the rest of the portal.
        </p>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {QUICK_ACCESS_LINKS.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className="rounded-lg border p-4 transition-colors hover:border-primary hover:bg-muted/40"
            >
              <div className="font-medium">{item.label}</div>
              <div className="mt-1 text-sm text-muted-foreground">{item.description}</div>
            </Link>
          ))}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[420px_1fr]">
        <form onSubmit={handleCreate} className="space-y-4 rounded-xl border bg-card p-4 shadow-sm">
          <div className="space-y-2">
            <Label htmlFor="new-name">Full name</Label>
            <Input
              id="new-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Jane Foster"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="new-email">Email</Label>
            <Input
              id="new-email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="jane@mediview.local"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="new-username">Username</Label>
            <Input
              id="new-username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="dr.jane.foster"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="new-role">Role</Label>
            <select
              id="new-role"
              value={role}
              onChange={(event) => setRole(event.target.value as AccountRole)}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              {CREATABLE_ROLES.map((option) => (
                <option key={option} value={option}>
                  {ROLE_LABELS[option]}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="new-password">Password</Label>
            <Input
              id="new-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Set temporary password"
            />
          </div>

          <div className="rounded-md border border-border/70 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
            Password rules: minimum 8 characters with uppercase, lowercase, and a number.
          </div>

          <Button type="submit" className="w-full">
            Create User Profile
          </Button>
        </form>

        <div className="rounded-xl border bg-card p-4 shadow-sm">
          <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                Existing Profiles
              </div>
              <div className="text-xs text-muted-foreground">
                Search by name, username, email, role, or status.
              </div>
            </div>
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search profiles..."
              className="sm:max-w-xs"
            />
          </div>

          <div className="space-y-2">
            {sortedUsers.map((currentUser) => (
              <div key={currentUser.email} className="rounded-lg border p-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="font-medium">{currentUser.name}</div>
                    <div className="text-xs text-muted-foreground">Username: {currentUser.username}</div>
                    <div className="text-xs text-muted-foreground">{currentUser.email}</div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      Created {new Date(currentUser.createdAt).toLocaleString()}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Last login:{' '}
                      {currentUser.lastLoginAt
                        ? new Date(currentUser.lastLoginAt).toLocaleString()
                        : 'Never'}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={currentUser.role === 'admin' ? 'default' : 'secondary'}>
                      {ROLE_LABELS[currentUser.role]}
                    </Badge>
                    <Badge variant={currentUser.status === 'active' ? 'outline' : 'destructive'}>
                      {ACCOUNT_STATUS_LABELS[currentUser.status]}
                    </Badge>
                    <Badge variant={currentUser.twoFactorEnabled ? 'outline' : 'secondary'}>
                      {currentUser.twoFactorEnabled ? '2FA on' : '2FA off'}
                    </Badge>
                  </div>
                </div>

                {currentUser.role === 'admin' ? (
                  <div className="mt-3 border-t pt-3 text-xs text-muted-foreground">
                    The master admin account cannot be suspended from this panel.
                  </div>
                ) : (
                  <div className="mt-3 grid gap-3 border-t pt-3 xl:grid-cols-[1fr_auto]">
                    <div className="space-y-2">
                      <Label htmlFor={`reset-${currentUser.email}`}>Temporary password</Label>
                      <Input
                        id={`reset-${currentUser.email}`}
                        type="password"
                        value={resetPasswordDrafts[currentUser.email] || ''}
                        onChange={(event) =>
                          setResetPasswordDrafts((current) => ({
                            ...current,
                            [currentUser.email]: event.target.value,
                          }))
                        }
                        placeholder="New temporary password"
                      />
                    </div>
                    <div className="flex flex-wrap items-end gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() =>
                          handleStatusToggle(
                            currentUser.email,
                            currentUser.status === 'active' ? 'suspended' : 'active'
                          )
                        }
                      >
                        {currentUser.status === 'active' ? 'Suspend' : 'Reactivate'}
                      </Button>
                      <Button type="button" onClick={() => handlePasswordReset(currentUser.email)}>
                        Reset Password
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            ))}

            {sortedUsers.length === 0 ? (
              <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                {isLoading ? 'Loading profiles...' : 'No profiles matched the current search.'}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
