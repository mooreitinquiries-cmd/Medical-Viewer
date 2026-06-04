import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { AuthUser } from '@/lib/auth';
import type { AccountRole } from '@/lib/auth';
import {
  changeSessionPassword,
  createUserAccount,
  getSession,
  listUsers,
  resetUserAccountPassword,
  signInWithSession,
  signOutOfSession,
  updateUserAccountStatus,
} from '@/lib/sessionApi';

interface SignInPayload {
  email: string;
  password: string;
}

interface CreateUserPayload {
  name: string;
  username: string;
  email: string;
  password: string;
  role: AccountRole;
  twoFactorEnabled?: boolean;
}

interface UpdateUserStatusPayload {
  email: string;
  status: AuthUser['status'];
}

interface ResetUserPasswordPayload {
  email: string;
  nextPassword: string;
}

interface ChangePasswordPayload {
  currentPassword: string;
  nextPassword: string;
}

interface AuthContextValue {
  user: AuthUser | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  users: AuthUser[];
  signIn: (payload: SignInPayload) => Promise<{ ok: boolean; error?: string; user?: AuthUser }>;
  signOut: () => Promise<void>;
  refreshUsers: () => Promise<void>;
  createUser: (
    payload: CreateUserPayload
  ) => Promise<{
    ok: boolean;
    error?: string;
    twoFactorSetup?: { secret: string; otpauthUrl: string } | null;
  }>;
  updateUserStatus: (payload: UpdateUserStatusPayload) => Promise<{ ok: boolean; error?: string }>;
  resetUserPassword: (
    payload: ResetUserPasswordPayload
  ) => Promise<{ ok: boolean; error?: string }>;
  changePassword: (payload: ChangePasswordPayload) => Promise<{ ok: boolean; error?: string }>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [users, setUsers] = useState<AuthUser[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let isMounted = true;

    async function bootstrap() {
      try {
        const session = await getSession();
        if (!isMounted) return;
        setUser(session.user);

        if (session.user.role === 'admin') {
          const allUsers = await listUsers();
          if (!isMounted) return;
          setUsers(allUsers.users);
        } else {
          setUsers([]);
        }
      } catch {
        if (!isMounted) return;
        setUser(null);
        setUsers([]);
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    }

    bootstrap();

    return () => {
      isMounted = false;
    };
  }, []);

  const value = useMemo<AuthContextValue>(() => {
    const refreshUsers = async () => {
      if (!user || user.role !== 'admin') {
        setUsers([]);
        return;
      }

      const nextUsers = await listUsers();
      setUsers(nextUsers.users);
    };

    return {
      user,
      isAuthenticated: Boolean(user),
      isLoading,
      users,
      signIn: async ({ email, password }) => {
        try {
          const session = await signInWithSession({ email, password });
          setUser(session.user);

          if (session.user.role === 'admin') {
            const allUsers = await listUsers();
            setUsers(allUsers.users);
          } else {
            setUsers([]);
          }

          return { ok: true, user: session.user };
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : 'Sign in failed',
          };
        }
      },
      signOut: async () => {
        await signOutOfSession().catch(() => undefined);
        setUser(null);
        setUsers([]);
      },
      refreshUsers,
      createUser: async (payload) => {
        try {
          const response = await createUserAccount(payload);
          await refreshUsers();
          return { ok: true, twoFactorSetup: response.twoFactorSetup };
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : 'Could not create user',
          };
        }
      },
      updateUserStatus: async (payload) => {
        try {
          const response = await updateUserAccountStatus(payload);
          await refreshUsers();

          if (user?.email === response.user.email) {
            setUser(response.user);
          }

          return { ok: true };
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : 'Could not update account status',
          };
        }
      },
      resetUserPassword: async (payload) => {
        try {
          await resetUserAccountPassword(payload);
          await refreshUsers();
          return { ok: true };
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : 'Could not reset password',
          };
        }
      },
      changePassword: async (payload) => {
        try {
          await changeSessionPassword(payload);
          return { ok: true };
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : 'Could not update password',
          };
        }
      },
    };
  }, [isLoading, user, users]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }

  return ctx;
}
