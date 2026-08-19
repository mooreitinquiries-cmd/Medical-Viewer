import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  Building2,
  CheckCircle2,
  Clipboard,
  CreditCard,
  ImageUp,
  Link as LinkIcon,
  Palette,
  Rocket,
  Settings2,
  ShieldCheck,
  UserPlus,
  Users,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ROLE_LABELS, validatePassword, validateUsername, type AccountRole } from '@/lib/auth';
import { useAuth } from '@/context/AuthContext';
import {
  createWhiteLabelAccount,
  createWhiteLabelSignupInvite,
  delegateWhiteLabelUser,
  listWhiteLabelAccounts,
  revokeWhiteLabelUser,
  updateWhiteLabelAccount,
  type ApiAuthUser,
  type WhiteLabelAccount,
  type WhiteLabelSignupInvite,
  type WhiteLabelSignupPlan,
} from '@/lib/sessionApi';
import { showErrorToast } from '@/lib/errorToast';

const SUPER_ADMIN_ACCESS_LEVELS = ['owner', 'admin', 'uploader', 'viewer'];
const DOCTOR_ACCESS_LEVELS = ['uploader', 'viewer'];
const PLAN_OPTIONS = [
  {
    id: 'self_download_7_day',
    label: 'Self-Download 7-Day Storage',
    description: 'Customer uses the PACS and must download their files within 7 days.',
  },
  {
    id: 'hosted_retention',
    label: 'Hosted Data Retention',
    description: 'OCTELERAD keeps the customer data hosted on this infrastructure.',
  },
];
const BILLING_STATUS_OPTIONS = ['trial', 'pending_payment', 'active', 'past_due', 'paused', 'cancelled'];
const LAUNCH_STATUS_OPTIONS = ['draft', 'setup', 'ready', 'live', 'paused'];
const FEATURE_OPTIONS: Array<{ key: keyof WhiteLabelAccount['features']; label: string }> = [
  { key: 'reportGeneration', label: 'Report generation' },
  { key: 'soapNotes', label: 'SOAP notes' },
  { key: 'nextcloudReports', label: 'Nextcloud document workflow' },
  { key: 'customBranding', label: 'Customer branding' },
  { key: 'delegatedAccess', label: 'Delegated outside access' },
  { key: 'videoConsults', label: 'Video consults' },
  { key: 'patientPortal', label: 'Patient portal' },
  { key: 'governedDataExports', label: 'Governed de-identified exports' },
];
const ONBOARDING_CHECKS: Array<{ key: keyof Omit<WhiteLabelAccount['onboarding'], 'launchStatus' | 'notes'>; label: string }> = [
  { key: 'brandingComplete', label: 'Branding complete' },
  { key: 'primaryDoctorAssigned', label: 'Primary doctor assigned' },
  { key: 'usersInvited', label: 'Initial users invited' },
  { key: 'nextcloudProvisioned', label: 'Nextcloud folder provisioned' },
  { key: 'reportTemplatesConfigured', label: 'Report templates configured' },
  { key: 'customDomainConfigured', label: 'Custom domain configured' },
  { key: 'billingConfigured', label: 'Billing configured' },
  { key: 'complianceAcknowledged', label: 'Compliance acknowledged' },
];

function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '');
}

function readLogoFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (file.size > 750000) {
      reject(new Error('Logo image is too large. Use an image under 750 KB.'));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Could not read logo file.'));
    reader.readAsDataURL(file);
  });
}

function defaultCustomerProfile(name = ''): WhiteLabelAccount['customerProfile'] {
  return {
    legalName: name,
    contactName: '',
    contactEmail: '',
    contactPhone: '',
    billingEmail: '',
    serviceAddress: '',
  };
}

function defaultSubscription(): WhiteLabelAccount['subscription'] {
  return {
    billingStatus: 'trial',
    monthlyPrice: '',
    trialEndsAt: '',
    contractSignedAt: '',
  };
}

function defaultFeatures(): WhiteLabelAccount['features'] {
  return {
    reportGeneration: true,
    soapNotes: true,
    nextcloudReports: true,
    customBranding: true,
    delegatedAccess: true,
    videoConsults: false,
    patientPortal: false,
    governedDataExports: false,
  };
}

function defaultOnboarding(): WhiteLabelAccount['onboarding'] {
  return {
    launchStatus: 'draft',
    brandingComplete: false,
    primaryDoctorAssigned: false,
    usersInvited: false,
    nextcloudProvisioned: true,
    reportTemplatesConfigured: false,
    customDomainConfigured: false,
    billingConfigured: false,
    complianceAcknowledged: false,
    notes: '',
  };
}

export default function WhiteLabelAdmin() {
  const { user, hasPermission } = useAuth();
  const canManageAccount = hasPermission('manageAccount');
  const canManageUsers = hasPermission('manageUsers');
  const [accounts, setAccounts] = useState<WhiteLabelAccount[]>([]);
  const [doctors, setDoctors] = useState<ApiAuthUser[]>([]);
  const [allUsers, setAllUsers] = useState<ApiAuthUser[]>([]);
  const [signupInvites, setSignupInvites] = useState<WhiteLabelSignupInvite[]>([]);
  const [signupPlans, setSignupPlans] = useState<WhiteLabelSignupPlan[]>([]);
  const [customQuoteEmail, setCustomQuoteEmail] = useState('operations@octelerad.com');
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);
  const [selectedId, setSelectedId] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [accountName, setAccountName] = useState('');
  const [slug, setSlug] = useState('');
  const [accountStatus, setAccountStatus] = useState('draft');
  const [primaryColor, setPrimaryColor] = useState('#2563eb');
  const [plan, setPlan] = useState('self_download_7_day');
  const [logoDataUrl, setLogoDataUrl] = useState<string | null>(null);
  const [primaryDoctorEmail, setPrimaryDoctorEmail] = useState('');
  const [deidentifiedExportsAllowed, setDeidentifiedExportsAllowed] = useState(false);
  const [customerProfile, setCustomerProfile] = useState<WhiteLabelAccount['customerProfile']>(() =>
    defaultCustomerProfile()
  );
  const [subscription, setSubscription] = useState<WhiteLabelAccount['subscription']>(() => defaultSubscription());
  const [features, setFeatures] = useState<WhiteLabelAccount['features']>(() => defaultFeatures());
  const [onboarding, setOnboarding] = useState<WhiteLabelAccount['onboarding']>(() => defaultOnboarding());
  const [customDomain, setCustomDomain] = useState('');
  const [delegateEmail, setDelegateEmail] = useState('');
  const [delegateName, setDelegateName] = useState('');
  const [delegateUsername, setDelegateUsername] = useState('');
  const [delegatePassword, setDelegatePassword] = useState('');
  const [delegateRole, setDelegateRole] = useState<AccountRole>('clinic');
  const [delegateAccess, setDelegateAccess] = useState('viewer');
  const [inviteRecipientEmail, setInviteRecipientEmail] = useState('');
  const [inviteRecipientName, setInviteRecipientName] = useState('');
  const [inviteOrganizationName, setInviteOrganizationName] = useState('');

  const selectedAccount = useMemo(
    () => (selectedId ? accounts.find((account) => account.id === selectedId) || null : null),
    [accounts, selectedId]
  );
  const accessLevelOptions = isSuperAdmin ? SUPER_ADMIN_ACCESS_LEVELS : DOCTOR_ACCESS_LEVELS;
  const completedOnboardingChecks = ONBOARDING_CHECKS.filter((check) => onboarding[check.key]).length;
  const onboardingReady = completedOnboardingChecks === ONBOARDING_CHECKS.length;
  const setCustomerProfileField = (key: keyof WhiteLabelAccount['customerProfile'], value: string) => {
    setCustomerProfile((current) => ({ ...current, [key]: value }));
  };
  const setSubscriptionField = (key: keyof WhiteLabelAccount['subscription'], value: string) => {
    setSubscription((current) => ({ ...current, [key]: value }));
  };
  const setFeatureFlag = (key: keyof WhiteLabelAccount['features'], value: boolean) => {
    setFeatures((current) => ({ ...current, [key]: value }));
    if (key === 'governedDataExports') setDeidentifiedExportsAllowed(value);
  };
  const setOnboardingCheck = (
    key: keyof Omit<WhiteLabelAccount['onboarding'], 'launchStatus' | 'notes'>,
    value: boolean
  ) => {
    setOnboarding((current) => ({ ...current, [key]: value }));
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await listWhiteLabelAccounts();
      setAccounts(result.accounts);
      setDoctors(result.doctors);
      setAllUsers(result.users);
      setSignupInvites(result.signupInvites || []);
      setSignupPlans(result.signupPlans || []);
      setCustomQuoteEmail(result.customQuoteEmail || 'operations@octelerad.com');
      setIsSuperAdmin(Boolean(result.isSuperAdmin));
      setSelectedId((current) =>
        current && result.accounts.some((account) => account.id === current)
          ? current
          : result.accounts[0]?.id || ''
      );
    } catch (error) {
      showErrorToast(error, 'Could not load white-label accounts');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!accessLevelOptions.includes(delegateAccess)) {
      setDelegateAccess('viewer');
    }
  }, [accessLevelOptions, delegateAccess]);

  useEffect(() => {
    if (!selectedAccount) {
      setAccountName('');
      setSlug('');
      setAccountStatus('draft');
      setPrimaryColor('#2563eb');
      setPlan('self_download_7_day');
      setLogoDataUrl(null);
      setPrimaryDoctorEmail(user?.role === 'doctor' ? user.email : '');
      setDeidentifiedExportsAllowed(false);
      setCustomerProfile(defaultCustomerProfile());
      setSubscription(defaultSubscription());
      setFeatures(defaultFeatures());
      setOnboarding(defaultOnboarding());
      setCustomDomain('');
      return;
    }
    setAccountName(selectedAccount.name);
    setSlug(selectedAccount.slug);
    setAccountStatus(selectedAccount.status || 'draft');
    setPrimaryColor(selectedAccount.branding.primaryColor || '#2563eb');
    setPlan(selectedAccount.plan?.id || 'self_download_7_day');
    setLogoDataUrl(selectedAccount.branding.logoDataUrl || null);
    setPrimaryDoctorEmail(selectedAccount.primaryDoctorEmail || '');
    setDeidentifiedExportsAllowed(selectedAccount.dataGovernance.deidentifiedExportsAllowed);
    setCustomerProfile(selectedAccount.customerProfile || defaultCustomerProfile(selectedAccount.name));
    setSubscription(selectedAccount.subscription || defaultSubscription());
    setFeatures(selectedAccount.features || defaultFeatures());
    setOnboarding(selectedAccount.onboarding || defaultOnboarding());
    setCustomDomain(selectedAccount.clonePlan.customDomain || '');
  }, [selectedAccount, user?.email, user?.role]);

  const saveAccount = async () => {
    if (!canManageAccount) {
      toast.error('Your account cannot change white-label setup.');
      return;
    }
    const cleanName = accountName.trim();
    if (!cleanName) {
      toast.error('Account name is required');
      return;
    }

    setSaving(true);
    try {
      const payload = {
        name: cleanName,
        slug: slugify(slug || cleanName),
        status: accountStatus,
        deploymentMode: selectedAccount?.deploymentMode || 'shared-server',
        plan,
        primaryDoctorEmail: primaryDoctorEmail || null,
        appName: cleanName,
        primaryColor,
        logoDataUrl,
        deidentifiedExportsAllowed,
        dataGovernanceNotes: deidentifiedExportsAllowed
          ? 'Eligible only for governed, de-identified data export workflows.'
          : '',
        clonePlan: {
          isolatedAuthStore: true,
          isolatedPacsStore: true,
          isolatedNextcloudFolder: true,
          tenantScopedSharedInfra: true,
          customDomain,
        },
        customerProfile: {
          ...customerProfile,
          legalName: customerProfile.legalName || cleanName,
          billingEmail: customerProfile.billingEmail || customerProfile.contactEmail,
        },
        subscription,
        features: {
          ...features,
          governedDataExports: deidentifiedExportsAllowed || features.governedDataExports,
        },
        onboarding: {
          ...onboarding,
          brandingComplete: onboarding.brandingComplete || Boolean(logoDataUrl),
          primaryDoctorAssigned: onboarding.primaryDoctorAssigned || Boolean(primaryDoctorEmail),
          usersInvited: onboarding.usersInvited || Boolean(selectedAccount?.members.length),
          customDomainConfigured: onboarding.customDomainConfigured || Boolean(customDomain),
        },
      };
      const result = selectedAccount
        ? await updateWhiteLabelAccount(selectedAccount.id, payload)
        : await createWhiteLabelAccount(payload);
      await load();
      setSelectedId(result.account.id);
      toast.success(selectedAccount ? 'White-label account updated' : 'White-label account created');
    } catch (error) {
      showErrorToast(error, 'Could not save white-label account');
    } finally {
      setSaving(false);
    }
  };

  const addDelegatedUser = async () => {
    if (!selectedAccount) return;
    if (!canManageUsers) {
      toast.error('Your account cannot delegate white-label access.');
      return;
    }
    const email = delegateEmail.trim().toLowerCase();
    const existingUser = allUsers.find((user) => user.email === email);
    if (!email) {
      toast.error('Email is required');
      return;
    }

    if (!existingUser) {
      const usernameMessage = validateUsername(delegateUsername);
      const passwordMessage = validatePassword(delegatePassword);
      if (!delegateName.trim() || usernameMessage || passwordMessage) {
        toast.error(usernameMessage || passwordMessage || 'New delegated users require a name');
        return;
      }
    }

    try {
      const result = await delegateWhiteLabelUser(selectedAccount.id, {
        email,
        name: delegateName.trim(),
        username: delegateUsername.trim().toLowerCase(),
        password: delegatePassword,
        role: delegateRole,
        accessLevel: delegateAccess,
      });
      setAccounts((current) =>
        current.map((account) => (account.id === result.account.id ? result.account : account))
      );
      setDelegateEmail('');
      setDelegateName('');
      setDelegateUsername('');
      setDelegatePassword('');
      setDelegateAccess('viewer');
      toast.success('Delegated access saved');
    } catch (error) {
      showErrorToast(error, 'Could not delegate access');
    }
  };

  const revokeUser = async (email: string) => {
    if (!selectedAccount) return;
    if (!canManageUsers) {
      toast.error('Your account cannot revoke white-label access.');
      return;
    }
    try {
      const result = await revokeWhiteLabelUser(selectedAccount.id, email);
      setAccounts((current) =>
        current.map((account) => (account.id === result.account.id ? result.account : account))
      );
      toast.success('Access revoked');
    } catch (error) {
      showErrorToast(error, 'Could not revoke access');
    }
  };

  const makeSignupUrl = (invite: WhiteLabelSignupInvite) => {
    if (typeof window === 'undefined') return invite.signupUrl;
    return new URL(invite.signupUrl, window.location.origin).toString();
  };

  const createSignupInvite = async () => {
    if (!isSuperAdmin) {
      toast.error('Only OCTELERAD admins can create private signup links.');
      return;
    }
    if (!inviteRecipientEmail.trim()) {
      toast.error('Recipient email is required');
      return;
    }

    try {
      const result = await createWhiteLabelSignupInvite({
        recipientEmail: inviteRecipientEmail.trim().toLowerCase(),
        recipientName: inviteRecipientName.trim(),
        organizationName: inviteOrganizationName.trim(),
      });
      setSignupInvites((current) => [result.invite, ...current]);
      setInviteRecipientEmail('');
      setInviteRecipientName('');
      setInviteOrganizationName('');
      toast.success('Private signup link created');
    } catch (error) {
      showErrorToast(error, 'Could not create signup link');
    }
  };

  const copySignupInvite = async (invite: WhiteLabelSignupInvite) => {
    const url = makeSignupUrl(invite);
    try {
      if (!navigator.clipboard) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(url);
      toast.success('Signup link copied');
    } catch {
      toast.error(url);
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-4">
          <div className="flex items-center gap-3">
            <Link
              to={user?.role === 'admin' ? '/admin/users' : '/dashboard'}
              className="rounded-md border p-2 text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="h-4 w-4" />
            </Link>
            <div>
              <h1 className="text-xl font-semibold">White-Label Control Center</h1>
              <div className="text-sm text-muted-foreground">
                Customer onboarding, branding, plan, retention, and delegated access.
              </div>
            </div>
          </div>
          <Button type="button" variant="outline" onClick={() => void load()} disabled={loading}>
            Refresh
          </Button>
        </div>
      </header>

      <main className="mx-auto grid max-w-7xl gap-4 px-4 py-6 lg:grid-cols-[320px_1fr]">
        <aside className="space-y-3 rounded-lg border bg-card p-3">
          <Button type="button" className="w-full" onClick={() => setSelectedId('')}>
            <Building2 className="mr-2 h-4 w-4" />
            New Account
          </Button>
          {accounts.length === 0 ? (
            <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
              {loading ? 'Loading accounts...' : 'No white-label accounts yet.'}
            </div>
          ) : (
            accounts.map((account) => (
              <button
                key={account.id}
                type="button"
                onClick={() => setSelectedId(account.id)}
                className={`w-full rounded-md border p-3 text-left ${
                  selectedAccount?.id === account.id ? 'border-primary bg-primary/5' : 'hover:bg-muted/50'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="truncate font-medium preserve-case">{account.name}</div>
                  <Badge variant={account.status === 'active' ? 'default' : 'secondary'}>{account.status}</Badge>
                </div>
                <div className="mt-1 truncate text-xs text-muted-foreground preserve-case">/{account.slug}</div>
              </button>
            ))
          )}
        </aside>

        <section className="space-y-4">
          {isSuperAdmin && (
            <div className="rounded-lg border bg-card p-4">
              <div className="mb-4 flex items-center gap-2">
                <LinkIcon className="h-4 w-4 text-primary" />
                <h2 className="font-semibold">Private Subscription Links</h2>
              </div>
              <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
                <div className="grid gap-3 md:grid-cols-3">
                  <div className="space-y-2">
                    <Label htmlFor="invite-email">Recipient email</Label>
                    <Input
                      id="invite-email"
                      type="email"
                      value={inviteRecipientEmail}
                      onChange={(event) => setInviteRecipientEmail(event.target.value)}
                      placeholder="doctor@hospital.org"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="invite-name">Recipient name</Label>
                    <Input
                      id="invite-name"
                      value={inviteRecipientName}
                      onChange={(event) => setInviteRecipientName(event.target.value)}
                      placeholder="Dr. Reader"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="invite-org">Organization</Label>
                    <Input
                      id="invite-org"
                      value={inviteOrganizationName}
                      onChange={(event) => setInviteOrganizationName(event.target.value)}
                      placeholder="Hospital PACS"
                    />
                  </div>
                  <div className="md:col-span-3">
                    <Button type="button" onClick={() => void createSignupInvite()}>
                      <LinkIcon className="mr-2 h-4 w-4" />
                      Create Private Link
                    </Button>
                  </div>
                </div>
                <div className="rounded-md border bg-muted/20 p-3 text-sm">
                  <div className="font-medium">Self-service plans</div>
                  <div className="mt-2 space-y-2">
                    {signupPlans.length > 0 ? signupPlans.map((option) => (
                      <div key={option.id} className="flex justify-between gap-3">
                        <span>{option.label}</span>
                        <span className="font-medium">${option.pricePerDoctorMonthly}/doctor</span>
                      </div>
                    )) : (
                      <div className="text-muted-foreground">Plan pricing loads with account data.</div>
                    )}
                  </div>
                  <div className="mt-3 text-xs text-muted-foreground">
                    Custom quote requests route to {customQuoteEmail}.
                  </div>
                </div>
              </div>
              {signupInvites.length > 0 && (
                <div className="mt-4 space-y-2">
                  {signupInvites.slice(0, 5).map((invite) => (
                    <div key={invite.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3 text-sm">
                      <div>
                        <div className="font-medium preserve-case">
                          {invite.organizationName || invite.recipientEmail}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {invite.recipientEmail} · {invite.status} · expires {new Date(invite.expiresAt).toLocaleDateString()}
                        </div>
                      </div>
                      <Button type="button" size="sm" variant="outline" onClick={() => void copySignupInvite(invite)}>
                        <Clipboard className="mr-2 h-4 w-4" />
                        Copy Link
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="grid gap-4 xl:grid-cols-[1fr_340px]">
            <div className="rounded-lg border bg-card p-4">
              <div className="mb-4 flex items-center gap-2">
                <Palette className="h-4 w-4 text-primary" />
                <h2 className="font-semibold">Account, Branding, and Doctor</h2>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="wl-name">Account name</Label>
                  <Input
                    id="wl-name"
                    value={accountName}
                    onChange={(event) => {
                      setAccountName(event.target.value);
                      if (!selectedAccount) setSlug(slugify(event.target.value));
                    }}
                    placeholder="Partner Radiology Group"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="wl-slug">Clone slug</Label>
                  <Input id="wl-slug" value={slug} onChange={(event) => setSlug(event.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="wl-status">Account status</Label>
                  <select
                    id="wl-status"
                    value={accountStatus}
                    onChange={(event) => setAccountStatus(event.target.value)}
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  >
                    {['draft', 'active', 'paused'].map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="wl-domain">Custom domain</Label>
                  <Input
                    id="wl-domain"
                    value={customDomain}
                    onChange={(event) => setCustomDomain(event.target.value)}
                    placeholder="pacs.partnerclinic.com"
                  />
                </div>
                <div className="space-y-2 md:col-span-2">
                  <Label htmlFor="wl-plan">Sales plan</Label>
                  <select
                    id="wl-plan"
                    value={plan}
                    onChange={(event) => setPlan(event.target.value)}
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  >
                    {PLAN_OPTIONS.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <div className="rounded-md border bg-muted/20 p-3 text-xs text-muted-foreground">
                    {PLAN_OPTIONS.find((option) => option.id === plan)?.description}
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="wl-doctor">Primary doctor</Label>
                  <select
                    id="wl-doctor"
                    value={primaryDoctorEmail}
                    onChange={(event) => setPrimaryDoctorEmail(event.target.value)}
                    disabled={!isSuperAdmin}
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  >
                    <option value="">Unassigned</option>
                    {doctors.map((doctor) => (
                      <option key={doctor.email} value={doctor.email}>
                        {doctor.name} ({doctor.email})
                      </option>
                    ))}
                  </select>
                  {!isSuperAdmin && (
                    <div className="text-xs text-muted-foreground">
                      Doctor-onboarded accounts are assigned to the onboarding doctor.
                    </div>
                  )}
                </div>
                <div className="space-y-2">
                  <Label htmlFor="wl-color">Software color</Label>
                  <div className="flex gap-2">
                    <Input
                      id="wl-color"
                      type="color"
                      value={primaryColor}
                      onChange={(event) => setPrimaryColor(event.target.value)}
                      className="w-16 px-1"
                    />
                    <Input value={primaryColor} onChange={(event) => setPrimaryColor(event.target.value)} />
                  </div>
                </div>
                <div className="space-y-2 md:col-span-2">
                  <Label htmlFor="wl-logo">Logo</Label>
                  <div className="flex flex-wrap items-center gap-3">
                    <Input
                      id="wl-logo"
                      type="file"
                      accept="image/png,image/jpeg,image/webp,image/svg+xml"
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (!file) return;
                        readLogoFile(file).then(setLogoDataUrl).catch((error) => toast.error(error.message));
                      }}
                    />
                    {logoDataUrl ? (
                      <img src={logoDataUrl} alt="" className="h-12 max-w-40 rounded border object-contain p-1" />
                    ) : (
                      <div className="flex h-12 items-center gap-2 rounded border px-3 text-sm text-muted-foreground">
                        <ImageUp className="h-4 w-4" />
                        No logo
                      </div>
                    )}
                  </div>
                </div>
                <label className="flex items-start gap-3 rounded-md border p-3 md:col-span-2">
                  <input
                    type="checkbox"
                    checked={deidentifiedExportsAllowed}
                    onChange={(event) => {
                      setDeidentifiedExportsAllowed(event.target.checked);
                      setFeatureFlag('governedDataExports', event.target.checked);
                    }}
                    className="mt-1"
                  />
                  <span>
                    <span className="block text-sm font-medium">Allow governed de-identified data exports</span>
                    <span className="block text-xs text-muted-foreground">
                      Identifiable patient-data sale remains disabled. This flag is for future compliance-reviewed data
                      licensing workflows only.
                    </span>
                  </span>
                </label>
              </div>
      <Button type="button" className="mt-4" onClick={() => void saveAccount()} disabled={saving || !canManageAccount}>
                {saving ? 'Saving...' : selectedAccount ? 'Save Account' : 'Create Account'}
              </Button>
            </div>

            <div className="rounded-lg border bg-card p-4">
              <div className="mb-4 flex items-center gap-2">
                <ShieldCheck className="h-4 w-4 text-primary" />
                <h2 className="font-semibold">Clone Readiness</h2>
              </div>
              <div className="space-y-3 text-sm">
                <div className="rounded-md border p-3">
                  <div className="font-medium">Plan</div>
                  <div className="mt-1 text-muted-foreground preserve-case">
                    {selectedAccount?.plan?.label || PLAN_OPTIONS.find((option) => option.id === plan)?.label}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {(selectedAccount?.plan?.id || plan) === 'self_download_7_day'
                      ? 'Customer files should be downloaded within 7 days.'
                      : 'Customer data remains hosted by OCTELERAD.'}
                  </div>
                </div>
                <div className="rounded-md border p-3">
                  <div className="font-medium">Launch status</div>
                  <div className="mt-1 text-muted-foreground preserve-case">{onboarding.launchStatus}</div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {completedOnboardingChecks} of {ONBOARDING_CHECKS.length} onboarding items complete.
                  </div>
                </div>
                <div className="rounded-md border p-3">
                  <div className="font-medium">Deployment mode</div>
                  <div className="mt-1 text-muted-foreground preserve-case">
                    {selectedAccount?.deploymentMode || 'shared-server'}
                  </div>
                </div>
                <div className="rounded-md border p-3">
                  <div className="font-medium">Isolation targets</div>
                  <div className="mt-1 text-muted-foreground">
                    Shared infrastructure with tenant-scoped auth, PACS data, and Nextcloud folders is marked as the efficient default.
                  </div>
                </div>
                <div className="rounded-md border p-3">
                  <div className="font-medium">Custom domain</div>
                  <div className="mt-1 break-all text-muted-foreground preserve-case">
                    {customDomain || 'Not configured'}
                  </div>
                </div>
                <div className="rounded-md border p-3">
                  <div className="font-medium">Payment</div>
                  <div className="mt-1 text-muted-foreground preserve-case">
                    {selectedAccount?.subscription?.billingStatus || subscription.billingStatus}
                  </div>
                  {selectedAccount?.subscription?.wordpressPaymentId && (
                    <div className="mt-1 break-all text-xs text-muted-foreground">
                      WordPress order {selectedAccount.subscription.wordpressPaymentId}
                    </div>
                  )}
                </div>
                <div className="rounded-md border p-3">
                  <div className="font-medium">Current account ID</div>
                  <div className="mt-1 break-all text-muted-foreground preserve-case">
                    {selectedAccount?.id || 'Not created yet'}
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            <div className="rounded-lg border bg-card p-4">
              <div className="mb-4 flex items-center gap-2">
                <CreditCard className="h-4 w-4 text-primary" />
                <h2 className="font-semibold">Customer and Billing</h2>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="wl-legal">Legal customer name</Label>
                  <Input
                    id="wl-legal"
                    value={customerProfile.legalName}
                    onChange={(event) => setCustomerProfileField('legalName', event.target.value)}
                    placeholder="Partner Radiology LLC"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="wl-contact-name">Customer contact</Label>
                  <Input
                    id="wl-contact-name"
                    value={customerProfile.contactName}
                    onChange={(event) => setCustomerProfileField('contactName', event.target.value)}
                    placeholder="Office manager"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="wl-contact-email">Contact email</Label>
                  <Input
                    id="wl-contact-email"
                    value={customerProfile.contactEmail}
                    onChange={(event) => setCustomerProfileField('contactEmail', event.target.value)}
                    placeholder="contact@partnerclinic.com"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="wl-phone">Contact phone</Label>
                  <Input
                    id="wl-phone"
                    value={customerProfile.contactPhone}
                    onChange={(event) => setCustomerProfileField('contactPhone', event.target.value)}
                    placeholder="555-555-5555"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="wl-billing-email">Billing email</Label>
                  <Input
                    id="wl-billing-email"
                    value={customerProfile.billingEmail}
                    onChange={(event) => setCustomerProfileField('billingEmail', event.target.value)}
                    placeholder="billing@partnerclinic.com"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="wl-price">Monthly price</Label>
                  <Input
                    id="wl-price"
                    value={subscription.monthlyPrice}
                    onChange={(event) => setSubscriptionField('monthlyPrice', event.target.value)}
                    placeholder="499"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="wl-billing-status">Billing status</Label>
                  <select
                    id="wl-billing-status"
                    value={subscription.billingStatus}
                    onChange={(event) => setSubscriptionField('billingStatus', event.target.value)}
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  >
                    {BILLING_STATUS_OPTIONS.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="wl-trial-end">Trial ends</Label>
                  <Input
                    id="wl-trial-end"
                    type="date"
                    value={subscription.trialEndsAt}
                    onChange={(event) => setSubscriptionField('trialEndsAt', event.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="wl-contract">Contract signed</Label>
                  <Input
                    id="wl-contract"
                    type="date"
                    value={subscription.contractSignedAt}
                    onChange={(event) => setSubscriptionField('contractSignedAt', event.target.value)}
                  />
                </div>
                <div className="space-y-2 md:col-span-2">
                  <Label htmlFor="wl-address">Service address</Label>
                  <Input
                    id="wl-address"
                    value={customerProfile.serviceAddress}
                    onChange={(event) => setCustomerProfileField('serviceAddress', event.target.value)}
                    placeholder="Clinic mailing or service address"
                  />
                </div>
              </div>
            </div>

            <div className="rounded-lg border bg-card p-4">
              <div className="mb-4 flex items-center gap-2">
                <Settings2 className="h-4 w-4 text-primary" />
                <h2 className="font-semibold">Feature Entitlements</h2>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {FEATURE_OPTIONS.map((option) => (
                  <label key={option.key} className="flex items-center gap-3 rounded-md border p-3 text-sm">
                    <input
                      type="checkbox"
                      checked={features[option.key]}
                      onChange={(event) => setFeatureFlag(option.key, event.target.checked)}
                    />
                    <span>{option.label}</span>
                  </label>
                ))}
              </div>
              <div className="mt-4 rounded-md border bg-muted/20 p-3 text-xs text-muted-foreground">
                Feature flags define what a cloned or tenant-scoped customer portal should expose as modules are built out.
              </div>
            </div>
          </div>

          <div className="rounded-lg border bg-card p-4">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Rocket className="h-4 w-4 text-primary" />
                <h2 className="font-semibold">Onboarding Readiness</h2>
              </div>
              <Badge variant={onboardingReady ? 'default' : 'secondary'}>
                {onboardingReady ? 'Ready for launch' : `${completedOnboardingChecks}/${ONBOARDING_CHECKS.length} complete`}
              </Badge>
            </div>
            <div className="grid gap-4 lg:grid-cols-[240px_1fr]">
              <div className="space-y-2">
                <Label htmlFor="wl-launch">Launch status</Label>
                <select
                  id="wl-launch"
                  value={onboarding.launchStatus}
                  onChange={(event) =>
                    setOnboarding((current) => ({ ...current, launchStatus: event.target.value }))
                  }
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                >
                  {LAUNCH_STATUS_OPTIONS.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </div>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                {ONBOARDING_CHECKS.map((check) => (
                  <label key={check.key} className="flex items-center gap-3 rounded-md border p-3 text-sm">
                    <input
                      type="checkbox"
                      checked={onboarding[check.key]}
                      onChange={(event) => setOnboardingCheck(check.key, event.target.checked)}
                    />
                    <span className="flex items-center gap-2">
                      {onboarding[check.key] && <CheckCircle2 className="h-4 w-4 text-primary" />}
                      {check.label}
                    </span>
                  </label>
                ))}
              </div>
              <div className="space-y-2 lg:col-span-2">
                <Label htmlFor="wl-onboarding-notes">Onboarding notes</Label>
                <textarea
                  id="wl-onboarding-notes"
                  value={onboarding.notes}
                  onChange={(event) => setOnboarding((current) => ({ ...current, notes: event.target.value }))}
                  rows={3}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  placeholder="Implementation notes, customer preferences, launch blockers"
                />
              </div>
            </div>
            <Button type="button" className="mt-4" onClick={() => void saveAccount()} disabled={saving || !canManageAccount}>
              {saving ? 'Saving...' : selectedAccount ? 'Save White-Label Setup' : 'Create White-Label Setup'}
            </Button>
          </div>

          <div className="rounded-lg border bg-card p-4">
            <div className="mb-4 flex items-center gap-2">
              <Users className="h-4 w-4 text-primary" />
              <h2 className="font-semibold">Delegated Outside Access</h2>
            </div>
            {!selectedAccount ? (
              <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                Create or select an account before delegating users.
              </div>
            ) : (
              <div className="grid gap-4 lg:grid-cols-[360px_1fr]">
                <div className="space-y-3 rounded-md border p-3">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <UserPlus className="h-4 w-4" />
                    Add user
                  </div>
                  <Input value={delegateEmail} onChange={(event) => setDelegateEmail(event.target.value)} placeholder="email" />
                  <Input value={delegateName} onChange={(event) => setDelegateName(event.target.value)} placeholder="name for new user" />
                  <Input value={delegateUsername} onChange={(event) => setDelegateUsername(event.target.value)} placeholder="username for new user" />
                  <Input
                    type="password"
                    value={delegatePassword}
                    onChange={(event) => setDelegatePassword(event.target.value)}
                    placeholder="temporary password for new user"
                  />
                  <div className="grid grid-cols-2 gap-2">
                    <select
                      value={delegateRole}
                      onChange={(event) => setDelegateRole(event.target.value as AccountRole)}
                      className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    >
                      {(['clinic', 'doctor', 'patient'] as AccountRole[]).map((option) => (
                        <option key={option} value={option}>
                          {ROLE_LABELS[option]}
                        </option>
                      ))}
                    </select>
                    <select
                      value={delegateAccess}
                      onChange={(event) => setDelegateAccess(event.target.value)}
                      className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    >
                      {accessLevelOptions.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  </div>
                    <Button type="button" className="w-full" onClick={() => void addDelegatedUser()} disabled={!canManageUsers}>
                    Delegate Access
                  </Button>
                </div>

                <div className="space-y-2">
                  {selectedAccount.members.length === 0 ? (
                    <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                      No delegated users yet.
                    </div>
                  ) : (
                    selectedAccount.members.map((member) => (
                      <div key={member.email} className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3">
                        <div>
                          <div className="font-medium preserve-case">{member.name}</div>
                          <div className="text-xs text-muted-foreground preserve-case">{member.email}</div>
                        </div>
                        <div className="flex items-center gap-2">
                          <Badge variant="secondary">{ROLE_LABELS[member.role] || member.role}</Badge>
                          <Badge variant="outline">{member.accessLevel}</Badge>
                          <Button type="button" variant="outline" size="sm" onClick={() => void revokeUser(member.email)} disabled={!canManageUsers}>
                            Revoke
                          </Button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
