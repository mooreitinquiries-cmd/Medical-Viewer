import type { AccountRole, AccountStatus, AuthUser } from '@/lib/auth';

const configuredAuthApiBase = import.meta.env.VITE_AUTH_API?.trim();
const DEFAULT_FRONTEND_ORIGIN = 'http://192.168.4.249:8080';
const DEFAULT_AUTH_API_BASE = 'http://192.168.4.249:8788';

function getCurrentOrigin() {
  if (typeof window === 'undefined') {
    return DEFAULT_FRONTEND_ORIGIN;
  }

  return window.location.origin;
}

function unique<T>(values: T[]) {
  return [...new Set(values)];
}

function getPortBaseCandidates(port: number) {
  if (typeof window === 'undefined') {
    return [`http://192.168.4.249:${port}`];
  }

  const { hostname, protocol } = window.location;
  const candidates = [`${protocol}//${hostname}:${port}`];

  if (protocol !== 'http:') {
    candidates.push(`http://${hostname}:${port}`);
  }

  return unique(candidates);
}

function getProxyBaseCandidates() {
  const currentOrigin = getCurrentOrigin();
  return ['/auth-api', `${currentOrigin}/auth-api`];
}

export function getAuthApiBaseCandidates(): string[] {
  const candidates = [
    configuredAuthApiBase,
    ...getProxyBaseCandidates(),
    ...getPortBaseCandidates(8788),
    DEFAULT_AUTH_API_BASE,
  ].filter((value): value is string => Boolean(value));

  return unique(candidates.map((value) => value.replace(/\/+$/, '')));
}

function isProxyLikeApiBase(baseUrl: string) {
  if (baseUrl.startsWith('/')) {
    return true;
  }

  try {
    return new URL(baseUrl, getCurrentOrigin()).origin === getCurrentOrigin();
  } catch {
    return false;
  }
}

function isJsonResponse(res: Response) {
  const contentType = res.headers.get('content-type') || '';
  return contentType.toLowerCase().includes('application/json');
}

function toErrorMessage(data: unknown, status: number) {
  if (data && typeof data === 'object' && 'error' in data) {
    const error = (data as { error?: unknown }).error;

    if (typeof error === 'string' && error.trim()) {
      return error;
    }
  }

  return `Auth request failed (${status})`;
}

function formatAuthNetworkError(attemptedBaseUrls: string[]) {
  const hostList = attemptedBaseUrls.join(', ');
  return new Error(
    `Unable to reach the auth API. Checked ${hostList}. Verify the auth server is running or set VITE_AUTH_API.`
  );
}

async function handleResponse(res: Response) {
  const data = await res.json().catch(() => null);

  if (!res.ok) {
    throw new Error(toErrorMessage(data, res.status));
  }

  if (data === null) {
    throw new Error('Auth API returned an invalid JSON response.');
  }

  return data;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let lastError: Error | null = null;
  const attemptedBaseUrls: string[] = [];
  const baseCandidates = getAuthApiBaseCandidates();

  for (let index = 0; index < baseCandidates.length; index += 1) {
    const baseUrl = baseCandidates[index];
    const hasNextCandidate = index < baseCandidates.length - 1;
    attemptedBaseUrls.push(baseUrl);

    try {
      const res = await fetch(`${baseUrl}${path}`, {
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          ...(init?.headers || {}),
        },
        ...init,
      });

      if (res.ok && !isJsonResponse(res)) {
        if (hasNextCandidate && isProxyLikeApiBase(baseUrl)) {
          lastError = new Error(`Auth API at ${baseUrl} returned a non-JSON response`);
          continue;
        }
      }

      if (!res.ok && hasNextCandidate && isProxyLikeApiBase(baseUrl) && res.status === 404) {
        lastError = new Error(`Auth API at ${baseUrl} returned 404`);
        continue;
      }

      return (await handleResponse(res)) as T;
    } catch (error) {
      if (error instanceof TypeError) {
        lastError = formatAuthNetworkError(attemptedBaseUrls);
        continue;
      }

      throw error instanceof Error ? error : new Error('Auth request failed');
    }
  }

  throw lastError || formatAuthNetworkError(attemptedBaseUrls);
}

export type ApiAuthUser = AuthUser;

export interface SignInPayload {
  email: string;
  password: string;
}

export interface CreateUserPayload {
  name: string;
  username: string;
  email: string;
  password: string;
  role: AccountRole;
  twoFactorEnabled?: boolean;
}

export interface UpdateUserStatusPayload {
  email: string;
  status: AccountStatus;
}

export interface ResetUserPasswordPayload {
  email: string;
  nextPassword: string;
}

export interface ChangePasswordPayload {
  currentPassword: string;
  nextPassword: string;
}

export async function getSession(): Promise<{ user: ApiAuthUser }> {
  return request<{ user: ApiAuthUser }>('/auth/session', {
    method: 'GET',
  });
}

export async function signInWithSession(
  payload: SignInPayload
): Promise<{ user: ApiAuthUser }> {
  return request<{ user: ApiAuthUser }>('/auth/login', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function signOutOfSession(): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>('/auth/logout', {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export async function listUsers(): Promise<{ users: ApiAuthUser[] }> {
  return request<{ users: ApiAuthUser[] }>('/auth/users', {
    method: 'GET',
  });
}

export async function createUserAccount(
  payload: CreateUserPayload
): Promise<{ user: ApiAuthUser; twoFactorSetup: { secret: string; otpauthUrl: string } | null }> {
  return request<{ user: ApiAuthUser; twoFactorSetup: { secret: string; otpauthUrl: string } | null }>('/auth/users', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function updateUserAccountStatus(
  payload: UpdateUserStatusPayload
): Promise<{ user: ApiAuthUser }> {
  return request<{ user: ApiAuthUser }>(`/auth/users/${encodeURIComponent(payload.email)}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status: payload.status }),
  });
}

export async function resetUserAccountPassword(
  payload: ResetUserPasswordPayload
): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/auth/users/${encodeURIComponent(payload.email)}/reset-password`, {
    method: 'POST',
    body: JSON.stringify({ nextPassword: payload.nextPassword }),
  });
}

export async function changeSessionPassword(
  payload: ChangePasswordPayload
): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>('/auth/change-password', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}
