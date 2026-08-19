import type { AccountRole, AccountStatus, AuthUser, TwoFactorStatus } from '@/lib/auth';

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

export class AuthSessionError extends Error {
  constructor(message = 'No active session') {
    super(message);
    this.name = 'AuthSessionError';
  }
}

export function isAuthSessionError(error: unknown): boolean {
  if (error instanceof AuthSessionError) return true;
  const rawMessage = typeof error === 'string' ? error : error instanceof Error ? error.message : '';
  if (!rawMessage) return false;

  const message = rawMessage.trim().toLowerCase();
  return [
    'no active session',
    'authentication required',
    'unauthorized',
    'auth request failed (401)',
    'care request failed (401)',
    'study api request failed (401)',
    'request failed (401)',
  ].includes(message);
}

export function getVisibleErrorMessage(error: unknown, fallback: string): string | null {
  if (isAuthSessionError(error)) return null;
  return error instanceof Error && error.message ? error.message : fallback;
}

function formatAuthNetworkError(attemptedBaseUrls: string[]) {
  const hostList = attemptedBaseUrls.join(', ');
  return new Error(
    `Unable to reach the auth API. Checked ${hostList}. Verify the auth server is running or set VITE_AUTH_API.`
  );
}

async function handleResponse(res: Response, path: string) {
  const data = await res.json().catch(() => null);

  if (!res.ok) {
    if (res.status === 401 && path !== '/auth/login') {
      throw new AuthSessionError(toErrorMessage(data, res.status));
    }

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

      return (await handleResponse(res, path)) as T;
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

export interface TwoFactorChallengeResponse {
  challengeId: string;
  expiresAt: string;
  method: string;
  email: string;
}

export interface TwoFactorLoginChallengeResponse extends TwoFactorChallengeResponse {
  twoFactorRequired: true;
}

export interface WhiteLabelMember {
  email: string;
  name: string;
  role: AccountRole;
  accessLevel: 'owner' | 'admin' | 'uploader' | 'viewer' | string;
  invitedByEmail?: string;
  createdAt: string;
}

export interface WhiteLabelSignupPlan {
  id: 'self_download_7_day' | 'hosted_retention' | string;
  label: string;
  description: string;
  retentionDays: number;
  pricePerDoctorMonthly: number;
  customQuote: boolean;
}

export interface WhiteLabelSignupInvite {
  id: string;
  token: string;
  signupUrl: string;
  recipientEmail: string;
  recipientName: string;
  organizationName: string;
  status: 'active' | 'used' | 'expired' | string;
  createdByEmail: string;
  createdAt: string;
  expiresAt: string;
  usedAt?: string | null;
  accountId?: string | null;
}

export interface WhiteLabelAccount {
  id: string;
  name: string;
  slug: string;
  status: 'draft' | 'active' | 'paused' | string;
  deploymentMode: 'shared-server' | 'dedicated-clone' | string;
  plan: {
    id: 'self_download_7_day' | 'hosted_retention' | string;
    label: string;
    retentionDays: number | null;
    customerDownloadRequiredDays: number | null;
    hostedByOctelerad: boolean;
    requiresCustomerDownload: boolean;
  };
  ownerEmail?: string | null;
  ownerName?: string | null;
  primaryDoctorEmail?: string | null;
  primaryDoctorName?: string | null;
  branding: {
    logoDataUrl?: string | null;
    primaryColor: string;
    appName: string;
  };
  members: WhiteLabelMember[];
  dataGovernance: {
    deidentifiedExportsAllowed: boolean;
    identifiableDataSaleAllowed: false;
    notes: string;
  };
  customerProfile: {
    legalName: string;
    contactName: string;
    contactEmail: string;
    contactPhone: string;
    billingEmail: string;
    serviceAddress: string;
  };
  subscription: {
    billingStatus: 'trial' | 'pending_payment' | 'active' | 'past_due' | 'paused' | 'cancelled' | string;
    monthlyPrice: string;
    pricePerDoctorMonthly?: string;
    doctorSeats?: number;
    paymentSetupUrl?: string;
    paymentProvider?: string;
    wordpressPaymentId?: string;
    paidAt?: string;
    trialEndsAt: string;
    contractSignedAt: string;
  };
  features: {
    reportGeneration: boolean;
    soapNotes: boolean;
    nextcloudReports: boolean;
    customBranding: boolean;
    delegatedAccess: boolean;
    videoConsults: boolean;
    patientPortal: boolean;
    governedDataExports: boolean;
  };
  onboarding: {
    launchStatus: 'draft' | 'setup' | 'ready' | 'live' | 'paused' | string;
    brandingComplete: boolean;
    primaryDoctorAssigned: boolean;
    usersInvited: boolean;
    nextcloudProvisioned: boolean;
    reportTemplatesConfigured: boolean;
    customDomainConfigured: boolean;
    billingConfigured: boolean;
    complianceAcknowledged: boolean;
    notes: string;
  };
  clonePlan: {
    isolatedAuthStore: boolean;
    isolatedPacsStore: boolean;
    isolatedNextcloudFolder: boolean;
    tenantScopedSharedInfra: boolean;
    customDomain: string;
  };
  createdAt: string;
  updatedAt: string;
}

export interface WhiteLabelAccountPayload {
  name: string;
  slug?: string;
  status?: string;
  deploymentMode?: string;
  plan?: string;
  primaryDoctorEmail?: string | null;
  appName?: string;
  primaryColor?: string;
  logoDataUrl?: string | null;
  deidentifiedExportsAllowed?: boolean;
  dataGovernanceNotes?: string;
  customerProfile?: Partial<WhiteLabelAccount['customerProfile']>;
  subscription?: Partial<WhiteLabelAccount['subscription']>;
  features?: Partial<WhiteLabelAccount['features']>;
  onboarding?: Partial<WhiteLabelAccount['onboarding']>;
  clonePlan?: Partial<WhiteLabelAccount['clonePlan']>;
}

export interface WhiteLabelSignupDetails {
  invite: {
    recipientEmail: string;
    recipientName: string;
    organizationName: string;
    expiresAt: string;
  };
  plans: WhiteLabelSignupPlan[];
  customQuoteEmail: string;
}

export interface WhiteLabelSignupPayload {
  organizationName: string;
  contactName: string;
  contactEmail: string;
  contactPhone?: string;
  billingEmail: string;
  serviceAddress?: string;
  username: string;
  password: string;
  plan: string;
  doctorSeats: number;
  complianceAcknowledged: boolean;
}

export interface DelegateWhiteLabelUserPayload {
  email: string;
  name?: string;
  username?: string;
  password?: string;
  role: AccountRole;
  accessLevel: WhiteLabelMember['accessLevel'];
}

export async function getSession(): Promise<{ user: ApiAuthUser }> {
  return request<{ user: ApiAuthUser }>('/auth/session', {
    method: 'GET',
  });
}

export async function signInWithSession(
  payload: SignInPayload
): Promise<{ user: ApiAuthUser } | TwoFactorLoginChallengeResponse> {
  return request<{ user: ApiAuthUser } | TwoFactorLoginChallengeResponse>('/auth/login', {
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

export async function getTwoFactorStatus(): Promise<{ twoFactor: TwoFactorStatus }> {
  return request<{ twoFactor: TwoFactorStatus }>('/auth/2fa/status', {
    method: 'GET',
  });
}

export async function startTwoFactorSetup(): Promise<TwoFactorChallengeResponse> {
  return request<TwoFactorChallengeResponse>('/auth/2fa/setup/start', {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export async function verifyTwoFactorSetup(payload: {
  challengeId: string;
  code: string;
}): Promise<{ user: ApiAuthUser; twoFactor: TwoFactorStatus }> {
  return request<{ user: ApiAuthUser; twoFactor: TwoFactorStatus }>('/auth/2fa/setup/verify', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function startTwoFactorDisable(): Promise<TwoFactorChallengeResponse> {
  return request<TwoFactorChallengeResponse>('/auth/2fa/disable/start', {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export async function disableTwoFactor(payload: {
  challengeId: string;
  code: string;
}): Promise<{ user: ApiAuthUser; twoFactor: TwoFactorStatus }> {
  return request<{ user: ApiAuthUser; twoFactor: TwoFactorStatus }>('/auth/2fa/disable', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function verifyTwoFactorLogin(payload: {
  email: string;
  challengeId: string;
  code: string;
}): Promise<{ user: ApiAuthUser }> {
  return request<{ user: ApiAuthUser }>('/auth/2fa/challenge/verify', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function listWhiteLabelAccounts(): Promise<{
  accounts: WhiteLabelAccount[];
  doctors: ApiAuthUser[];
  users: ApiAuthUser[];
  signupInvites?: WhiteLabelSignupInvite[];
  signupPlans?: WhiteLabelSignupPlan[];
  customQuoteEmail?: string;
  isSuperAdmin?: boolean;
}> {
  return request<{
    accounts: WhiteLabelAccount[];
    doctors: ApiAuthUser[];
    users: ApiAuthUser[];
    signupInvites?: WhiteLabelSignupInvite[];
    signupPlans?: WhiteLabelSignupPlan[];
    customQuoteEmail?: string;
    isSuperAdmin?: boolean;
  }>('/white-label/accounts', {
    method: 'GET',
  });
}

export async function getMyWhiteLabelAccount(): Promise<{ account: WhiteLabelAccount | null }> {
  return request<{ account: WhiteLabelAccount | null }>('/white-label/my-account', {
    method: 'GET',
  });
}

export async function createWhiteLabelAccount(
  payload: WhiteLabelAccountPayload
): Promise<{ account: WhiteLabelAccount }> {
  return request<{ account: WhiteLabelAccount }>('/white-label/accounts', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function createWhiteLabelSignupInvite(payload: {
  recipientEmail: string;
  recipientName?: string;
  organizationName?: string;
}): Promise<{ invite: WhiteLabelSignupInvite; plans: WhiteLabelSignupPlan[]; customQuoteEmail: string }> {
  return request<{ invite: WhiteLabelSignupInvite; plans: WhiteLabelSignupPlan[]; customQuoteEmail: string }>(
    '/white-label/signup-invites',
    {
      method: 'POST',
      body: JSON.stringify(payload),
    }
  );
}

export async function getWhiteLabelSignupDetails(token: string): Promise<WhiteLabelSignupDetails> {
  return request<WhiteLabelSignupDetails>(`/white-label/signup/${encodeURIComponent(token)}`, {
    method: 'GET',
  });
}

export async function completeWhiteLabelSignup(
  token: string,
  payload: WhiteLabelSignupPayload
): Promise<{ account: WhiteLabelAccount; user: ApiAuthUser; paymentSetupUrl?: string }> {
  return request<{ account: WhiteLabelAccount; user: ApiAuthUser; paymentSetupUrl?: string }>(
    `/white-label/signup/${encodeURIComponent(token)}`,
    {
      method: 'POST',
      body: JSON.stringify(payload),
    }
  );
}

export async function updateWhiteLabelAccount(
  accountId: string,
  payload: Partial<WhiteLabelAccountPayload>
): Promise<{ account: WhiteLabelAccount }> {
  return request<{ account: WhiteLabelAccount }>(`/white-label/accounts/${encodeURIComponent(accountId)}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}

export async function delegateWhiteLabelUser(
  accountId: string,
  payload: DelegateWhiteLabelUserPayload
): Promise<{ account: WhiteLabelAccount; user: ApiAuthUser }> {
  return request<{ account: WhiteLabelAccount; user: ApiAuthUser }>(
    `/white-label/accounts/${encodeURIComponent(accountId)}/members`,
    {
      method: 'POST',
      body: JSON.stringify(payload),
    }
  );
}

export async function revokeWhiteLabelUser(
  accountId: string,
  email: string
): Promise<{ account: WhiteLabelAccount }> {
  return request<{ account: WhiteLabelAccount }>(
    `/white-label/accounts/${encodeURIComponent(accountId)}/members/remove`,
    {
      method: 'POST',
      body: JSON.stringify({ email }),
    }
  );
}
