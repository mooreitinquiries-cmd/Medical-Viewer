export type AccountRole = 'admin' | 'doctor' | 'patient' | 'clinic';
export type AccountStatus = 'active' | 'suspended';

export interface AuthUser {
  username: string;
  email: string;
  name: string;
  role: AccountRole;
  status: AccountStatus;
  isSuperAdmin?: boolean;
  twoFactorEnabled: boolean;
  twoFactor?: TwoFactorStatus;
  whiteLabelAccountIds?: string[];
  primaryWhiteLabelAccountId?: string | null;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface TwoFactorStatus {
  available: boolean;
  configured: boolean;
  enabled: boolean;
  verified: boolean;
  method: string;
  email: string;
  lastChallengeAt: string | null;
}

export const ALL_ROLES: AccountRole[] = ['admin', 'doctor', 'patient', 'clinic'];
export const CREATABLE_ROLES: AccountRole[] = ['doctor', 'patient', 'clinic'];

export const ROLE_LABELS: Record<AccountRole, string> = {
  admin: 'Admin',
  doctor: 'Doctor',
  patient: 'Patient',
  clinic: 'Clinic Staff',
};

export const ACCOUNT_STATUS_LABELS: Record<AccountStatus, string> = {
  active: 'Active',
  suspended: 'Suspended',
};

export function isAccountRole(value: string): value is AccountRole {
  return ALL_ROLES.includes(value as AccountRole);
}

export function isAccountStatus(value: string): value is AccountStatus {
  return value === 'active' || value === 'suspended';
}

export function getDefaultRouteByRole(role: AccountRole): string {
  if (role === 'admin') {
    return '/admin/users';
  }

  if (role === 'patient') {
    return '/cases';
  }

  return '/dashboard';
}

export function validatePassword(value: string): string | null {
  const trimmed = value.trim();

  if (trimmed.length < 8) {
    return 'Password must be at least 8 characters';
  }

  if (!/[a-z]/.test(trimmed)) {
    return 'Password must include a lowercase letter';
  }

  if (!/[A-Z]/.test(trimmed)) {
    return 'Password must include an uppercase letter';
  }

  if (!/[0-9]/.test(trimmed)) {
    return 'Password must include a number';
  }

  return null;
}

export function validateUsername(value: string): string | null {
  const trimmed = value.trim();

  if (trimmed.length < 3) {
    return 'Username must be at least 3 characters';
  }

  if (trimmed.length > 40) {
    return 'Username must be 40 characters or fewer';
  }

  if (!/^[a-zA-Z0-9._-]+$/.test(trimmed)) {
    return 'Username can only include letters, numbers, periods, underscores, and hyphens';
  }

  return null;
}
