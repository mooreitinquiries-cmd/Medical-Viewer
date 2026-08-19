import { useEffect, useMemo, useState } from 'react';
import { Building2, KeyRound, UserPlus } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/context/AuthContext';
import { ACCOUNT_STATUS_LABELS, validatePassword, validateUsername } from '@/lib/auth';
import { createCareClient, listCareClients, type CareClient } from '@/lib/careApi';
import { getVisibleErrorMessage } from '@/lib/sessionApi';
import { showErrorToast } from '@/lib/errorToast';

export default function Clients() {
  const { updateUserStatus, resetUserPassword, refreshUsers } = useAuth();
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [search, setSearch] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [isLoadingClients, setIsLoadingClients] = useState(true);
  const [clients, setClients] = useState<CareClient[]>([]);
  const [createdTemporaryPassword, setCreatedTemporaryPassword] = useState('');
  const [resetPasswordDrafts, setResetPasswordDrafts] = useState<Record<string, string>>({});

  const refreshClients = async () => {
    const result = await listCareClients();
    setClients(result.clients || []);
  };

  useEffect(() => {
    let isMounted = true;

    listCareClients()
      .then((result) => {
        if (!isMounted) return;
        setClients(result.clients || []);
      })
      .catch((error) => {
        if (!isMounted) return;
        const message = getVisibleErrorMessage(error, 'Could not load clients');
        if (message) toast.error(message);
      })
      .finally(() => {
        if (isMounted) setIsLoadingClients(false);
      });

    return () => {
      isMounted = false;
    };
  }, []);

  const filteredClients = useMemo(() => {
    const query = search.trim().toLowerCase();
    return clients
      .filter((client) => {
        if (!query) return true;
        return `${client.name} ${client.username} ${client.email} ${client.status}`.toLowerCase().includes(query);
      })
      .sort((left, right) => left.name.localeCompare(right.name));
  }, [clients, search]);

  const handleCreate = async (event: React.FormEvent) => {
    event.preventDefault();

    const cleanedName = name.trim();
    const cleanedUsername = username.trim().toLowerCase();
    const cleanedEmail = email.trim().toLowerCase();
    const cleanedPassword = password.trim();

    if (!cleanedName || !cleanedEmail) {
      toast.error('Client name and email are required');
      return;
    }

    const usernameMessage = cleanedUsername ? validateUsername(cleanedUsername) : null;
    if (usernameMessage) {
      toast.error(usernameMessage);
      return;
    }

    const passwordMessage = cleanedPassword ? validatePassword(cleanedPassword) : null;
    if (passwordMessage) {
      toast.error(passwordMessage);
      return;
    }

    try {
      setSubmitting(true);
      const result = await createCareClient({
        name: cleanedName,
        email: cleanedEmail,
        username: cleanedUsername || undefined,
        password: cleanedPassword || undefined,
      });

      toast.success('Client account created');
      setCreatedTemporaryPassword(result.temporaryPassword);
      setName('');
      setUsername('');
      setEmail('');
      setPassword('');
      await Promise.all([refreshClients(), refreshUsers()]);
    } catch (error) {
      const message = getVisibleErrorMessage(error, 'Could not create client');
      if (message) toast.error(message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleStatusToggle = async (emailAddress: string, nextStatus: 'active' | 'suspended') => {
    const result = await updateUserStatus({ email: emailAddress, status: nextStatus });

    if (!result.ok) {
      showErrorToast(result.error, 'Could not update client status');
      return;
    }

    await refreshClients();
    toast.success(nextStatus === 'active' ? 'Client reactivated' : 'Client suspended');
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
    await refreshClients();
    toast.success('Client password reset saved');
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Clients</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Add and manage client accounts that can upload studies, manage patients, create SOAP notes, and use portal messaging.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-[380px_1fr]">
        <form onSubmit={handleCreate} className="space-y-4 rounded-xl border bg-card p-4 shadow-sm">
          <div className="flex items-center gap-2 text-sm font-medium">
            <UserPlus className="h-4 w-4" />
            Add Client
          </div>

          <div className="space-y-2">
            <Label htmlFor="clientName">Client name</Label>
            <Input id="clientName" value={name} onChange={(event) => setName(event.target.value)} />
          </div>

          <div className="space-y-2">
            <Label htmlFor="clientEmail">Email</Label>
            <Input id="clientEmail" type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
          </div>

          <div className="space-y-2">
            <Label htmlFor="clientUsername">Username</Label>
            <Input
              id="clientUsername"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="Auto-generated if blank"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="clientPassword">Temporary password</Label>
            <Input
              id="clientPassword"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Auto-generated if blank"
            />
          </div>

          <div className="rounded-md border border-border/70 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
            Leave username or password blank to auto-generate them. Custom passwords need 8 characters with uppercase,
            lowercase, and a number.
          </div>

          {createdTemporaryPassword ? (
            <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
              Temporary password: <span className="font-mono font-semibold">{createdTemporaryPassword}</span>
            </div>
          ) : null}

          <Button type="submit" className="w-full" disabled={submitting}>
            {submitting ? 'Creating...' : 'Create Client'}
          </Button>
        </form>

        <div className="rounded-xl border bg-card p-4 shadow-sm">
          <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-sm font-medium">Client Records</div>
              <div className="text-xs text-muted-foreground">Client accounts use the clinic access level.</div>
            </div>
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search clients..."
              className="sm:max-w-xs"
            />
          </div>

          <div className="space-y-2">
            {filteredClients.length === 0 ? (
              <div className="rounded border border-dashed p-6 text-center text-sm text-muted-foreground">
                {isLoadingClients ? 'Loading clients...' : 'No client records found.'}
              </div>
            ) : (
              filteredClients.map((client) => (
                <div key={client.email} className="rounded-lg border p-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 font-medium">
                        <Building2 className="h-4 w-4 text-muted-foreground" />
                        <span className="preserve-case">{client.name}</span>
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground preserve-case">Username: {client.username}</div>
                      <div className="text-xs text-muted-foreground preserve-case">{client.email}</div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        Created {new Date(client.createdAt).toLocaleString()}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        Last login: {client.lastLoginAt ? new Date(client.lastLoginAt).toLocaleString() : 'Never'}
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="secondary">Client</Badge>
                      <Badge variant={client.status === 'active' ? 'outline' : 'destructive'}>
                        {ACCOUNT_STATUS_LABELS[client.status]}
                      </Badge>
                    </div>
                  </div>

                  <div className="mt-3 grid gap-3 border-t pt-3 xl:grid-cols-[1fr_auto]">
                    <div className="space-y-2">
                      <Label htmlFor={`client-reset-${client.email}`}>Temporary password</Label>
                      <div className="relative">
                        <KeyRound className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                        <Input
                          id={`client-reset-${client.email}`}
                          type="password"
                          value={resetPasswordDrafts[client.email] || ''}
                          onChange={(event) =>
                            setResetPasswordDrafts((current) => ({
                              ...current,
                              [client.email]: event.target.value,
                            }))
                          }
                          placeholder="New temporary password"
                          className="pl-9"
                        />
                      </div>
                    </div>
                    <div className="flex flex-wrap items-end gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() =>
                          handleStatusToggle(client.email, client.status === 'active' ? 'suspended' : 'active')
                        }
                      >
                        {client.status === 'active' ? 'Suspend' : 'Reactivate'}
                      </Button>
                      <Button type="button" onClick={() => handlePasswordReset(client.email)}>
                        Reset Password
                      </Button>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
