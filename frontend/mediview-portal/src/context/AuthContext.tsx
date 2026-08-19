import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { AuthUser } from '@/lib/auth';
import type { AccountRole } from '@/lib/auth';
import {
  changeSessionPassword,
  createUserAccount,
  getMyWhiteLabelAccount,
  getSession,
  isAuthSessionError,
  listUsers,
  resetUserAccountPassword,
  signInWithSession,
  signOutOfSession,
  updateUserAccountStatus,
  verifyTwoFactorLogin,
  type WhiteLabelAccount,
} from '@/lib/sessionApi';
import {
  canUseAnyWhiteLabelFeature,
  canUseWhiteLabelPermission,
  canUseWhiteLabelFeature,
  getWhiteLabelAccessLevel,
  type WhiteLabelPermission,
  type WhiteLabelFeature,
} from '@/lib/whiteLabelEntitlements';
import type { StudyApiAuthContext } from '@/lib/api';

interface SignInPayload {
  email: string;
  password: string;
}

interface TwoFactorSignInPayload {
  email: string;
  challengeId: string;
  code: string;
}

interface TwoFactorRequiredResult {
  challengeId: string;
  expiresAt: string;
  method: string;
  email: string;
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
  whiteLabelAccount: WhiteLabelAccount | null;
  whiteLabelAccessLevel: string | null;
  studyApiAuth: StudyApiAuthContext | undefined;
  hasFeature: (feature: WhiteLabelFeature) => boolean;
  hasAnyFeature: (features: WhiteLabelFeature[]) => boolean;
  hasPermission: (permission: WhiteLabelPermission) => boolean;
  signIn: (
    payload: SignInPayload
  ) => Promise<{ ok: boolean; error?: string; user?: AuthUser; twoFactorRequired?: TwoFactorRequiredResult }>;
  verifyTwoFactorSignIn: (
    payload: TwoFactorSignInPayload
  ) => Promise<{ ok: boolean; error?: string; user?: AuthUser }>;
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
  const [whiteLabelAccount, setWhiteLabelAccount] = useState<WhiteLabelAccount | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const loadWhiteLabelAccount = async (nextUser: AuthUser | null) => {
    if (!nextUser) {
      setWhiteLabelAccount(null);
      return;
    }

    try {
      const result = await getMyWhiteLabelAccount();
      setWhiteLabelAccount(result.account);
    } catch (error) {
      if (isAuthSessionError(error)) {
        setWhiteLabelAccount(null);
        throw error;
      }
      setWhiteLabelAccount(null);
    }
  };

  useEffect(() => {
    let isMounted = true;

    async function bootstrap() {
      try {
        const session = await getSession();
        if (!isMounted) return;
        setUser(session.user);
        await loadWhiteLabelAccount(session.user);
        if (!isMounted) return;

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
        setWhiteLabelAccount(null);
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
    const whiteLabelAccessLevel = getWhiteLabelAccessLevel(user, whiteLabelAccount);
    const studyApiAuth = user
      ? {
          email: user.email,
          role: user.role,
          name: user.name,
          isSuperAdmin: user.isSuperAdmin,
          whiteLabelAccountIds: user.whiteLabelAccountIds,
          primaryWhiteLabelAccountId: user.primaryWhiteLabelAccountId,
          whiteLabelAccessLevel,
        }
      : undefined;
    const clearExpiredSession = (error: unknown) => {
      if (!isAuthSessionError(error)) return;
      setUser(null);
      setUsers([]);
      setWhiteLabelAccount(null);
    };

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
          if ('twoFactorRequired' in session && session.twoFactorRequired) {
            return {
              ok: true,
              twoFactorRequired: {
                challengeId: session.challengeId,
                expiresAt: session.expiresAt,
                method: session.method,
                email: session.email,
              },
            };
          }
          setUser(session.user);
          await loadWhiteLabelAccount(session.user);

          if (session.user.role === 'admin') {
            const allUsers = await listUsers();
            setUsers(allUsers.users);
          } else {
            setUsers([]);
          }

          return { ok: true, user: session.user };
        } catch (error) {
          clearExpiredSession(error);
          return {
            ok: false,
            error: error instanceof Error ? error.message : 'Sign in failed',
          };
        }
      },
      verifyTwoFactorSignIn: async ({ email, challengeId, code }) => {
        try {
          const session = await verifyTwoFactorLogin({ email, challengeId, code });
          setUser(session.user);
          await loadWhiteLabelAccount(session.user);

          if (session.user.role === 'admin') {
            const allUsers = await listUsers();
            setUsers(allUsers.users);
          } else {
            setUsers([]);
          }

          return { ok: true, user: session.user };
        } catch (error) {
          clearExpiredSession(error);
          return {
            ok: false,
            error: error instanceof Error ? error.message : 'Could not verify code',
          };
        }
      },
      signOut: async () => {
        await signOutOfSession().catch(() => undefined);
        setUser(null);
        setUsers([]);
        setWhiteLabelAccount(null);
      },
      refreshUsers,
      createUser: async (payload) => {
        try {
          const response = await createUserAccount(payload);
          await refreshUsers();
          return { ok: true, twoFactorSetup: response.twoFactorSetup };
        } catch (error) {
          clearExpiredSession(error);
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
          clearExpiredSession(error);
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
          clearExpiredSession(error);
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
          clearExpiredSession(error);
          return {
            ok: false,
            error: error instanceof Error ? error.message : 'Could not update password',
          };
        }
      },
      whiteLabelAccount,
      whiteLabelAccessLevel,
      studyApiAuth,
      hasFeature: (feature) => canUseWhiteLabelFeature(user, whiteLabelAccount, feature),
      hasAnyFeature: (features) => canUseAnyWhiteLabelFeature(user, whiteLabelAccount, features),
      hasPermission: (permission) => canUseWhiteLabelPermission(user, whiteLabelAccount, permission),
    };
  }, [isLoading, user, users, whiteLabelAccount]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }

  return ctx;
}
