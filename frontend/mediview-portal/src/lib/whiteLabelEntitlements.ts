import type { AuthUser } from '@/lib/auth';
import type { WhiteLabelAccount } from '@/lib/sessionApi';

export type WhiteLabelFeature = keyof WhiteLabelAccount['features'];
export type WhiteLabelAccessLevel = 'owner' | 'admin' | 'uploader' | 'viewer';
export type WhiteLabelPermission =
  | 'manageAccount'
  | 'manageBilling'
  | 'manageUsers'
  | 'configureBranding'
  | 'uploadStudies'
  | 'editStudies'
  | 'createReports'
  | 'exportData'
  | 'deleteStudies'
  | 'viewStudies';

export const DEFAULT_WHITE_LABEL_FEATURES: WhiteLabelAccount['features'] = {
  reportGeneration: true,
  soapNotes: true,
  nextcloudReports: true,
  customBranding: true,
  delegatedAccess: true,
  videoConsults: false,
  patientPortal: false,
  governedDataExports: false,
};

export function canUseWhiteLabelFeature(
  user: AuthUser | null,
  account: WhiteLabelAccount | null,
  feature: WhiteLabelFeature
) {
  if (!user) return false;
  if (user.isSuperAdmin) return true;
  if (!account) return true;
  return Boolean((account.features || DEFAULT_WHITE_LABEL_FEATURES)[feature]);
}

export function canUseAnyWhiteLabelFeature(
  user: AuthUser | null,
  account: WhiteLabelAccount | null,
  features: WhiteLabelFeature[]
) {
  return features.some((feature) => canUseWhiteLabelFeature(user, account, feature));
}

export function getWhiteLabelAccessLevel(
  user: AuthUser | null,
  account: WhiteLabelAccount | null
): WhiteLabelAccessLevel | null {
  if (!user || !account) return null;
  if (user.isSuperAdmin) return 'owner';
  const email = user.email.trim().toLowerCase();
  const member = (account.members || []).find((entry) => entry.email.trim().toLowerCase() === email);
  if (!member) return null;
  const level = String(member.accessLevel || '').toLowerCase();
  if (level === 'owner' || level === 'admin' || level === 'uploader' || level === 'viewer') return level;
  return 'viewer';
}

export function canUseWhiteLabelPermission(
  user: AuthUser | null,
  account: WhiteLabelAccount | null,
  permission: WhiteLabelPermission
) {
  if (!user) return false;
  if (user.isSuperAdmin) return true;
  if (!account) return true;

  const level = getWhiteLabelAccessLevel(user, account);
  if (level === 'owner') return true;
  if (level === 'admin') {
    return [
      'manageUsers',
      'configureBranding',
      'uploadStudies',
      'editStudies',
      'createReports',
      'exportData',
      'deleteStudies',
      'viewStudies',
    ].includes(permission);
  }
  if (level === 'uploader') {
    return ['uploadStudies', 'editStudies', 'createReports', 'exportData', 'viewStudies'].includes(permission);
  }
  if (level === 'viewer') {
    return permission === 'viewStudies';
  }
  return false;
}
