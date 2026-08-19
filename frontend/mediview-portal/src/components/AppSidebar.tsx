import { Link, useLocation } from 'react-router-dom';
import { useEffect, useState } from 'react';
import {
  LayoutDashboard,
  Upload,
  FolderOpen,
  Library,
  MessageCircle,
  Video,
  BriefcaseMedical,
  Inbox,
  Users,
  UserRound,
  Building2,
  Shield,
  ClipboardList,
  UserCheck,
  Calculator,
  ChevronDown,
  ChevronRight,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/context/AuthContext';
import { ACCOUNT_STATUS_LABELS, type AccountRole } from '@/lib/auth';
import { listActiveLiveCases } from '@/lib/api';
import type { WhiteLabelFeature } from '@/lib/whiteLabelEntitlements';

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  features?: WhiteLabelFeature[];
  internalOnly?: boolean;
}

const PRIMARY_NAV_BY_ROLE: Record<AccountRole, NavItem[]> = {
  admin: [
    { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { to: '/patients', label: 'Patients', icon: UserRound, features: ['patientPortal'] },
    { to: '/clients', label: 'Clients', icon: Building2 },
    { to: '/submissions', label: 'SUBMISSIONS', icon: ClipboardList },
    { to: '/studies', label: 'Studies', icon: FolderOpen },
    { to: '/assigned-streams', label: 'Assigned Streams', icon: UserCheck },
    { to: '/streams', label: 'Streams', icon: Library },
  ],
  doctor: [
    { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { to: '/patients', label: 'Patients', icon: UserRound, features: ['patientPortal'] },
    { to: '/studies', label: 'Studies', icon: FolderOpen },
    { to: '/assigned-streams', label: 'Assigned Streams', icon: UserCheck },
    { to: '/streams', label: 'Streams', icon: Library },
  ],
  clinic: [
    { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { to: '/patients', label: 'Patients', icon: UserRound, features: ['patientPortal'] },
    { to: '/studies', label: 'Studies', icon: FolderOpen },
    { to: '/assigned-streams', label: 'Assigned Streams', icon: UserCheck },
    { to: '/streams', label: 'Streams', icon: Library },
  ],
  patient: [
    { to: '/cases', label: 'My Cases', icon: Inbox },
  ],
};

const OTHER_NAV_BY_ROLE: Record<AccountRole, NavItem[]> = {
  admin: [
    { to: '/admin/users', label: 'User Profiles', icon: Users },
    { to: '/white-label', label: 'White Label', icon: Building2 },
    { to: '/tenant-governance', label: 'Governance', icon: Shield, features: ['nextcloudReports', 'governedDataExports'] },
    { to: '/care-desk', label: 'Care Desk', icon: BriefcaseMedical },
    { to: '/soap-notes', label: 'SOAP Notes', icon: ClipboardList, features: ['soapNotes'] },
    { to: '/revenue', label: 'Revenue Calculator', icon: Calculator, internalOnly: true },
    { to: '/cases', label: 'Patient Cases', icon: Inbox, features: ['patientPortal'] },
    { to: '/messages', label: 'Messages', icon: MessageCircle },
    { to: '/video', label: 'Video Calls', icon: Video, features: ['videoConsults'] },
    { to: '/account', label: 'Account', icon: Shield },
  ],
  doctor: [
    { to: '/white-label', label: 'White Label', icon: Building2 },
    { to: '/tenant-governance', label: 'Governance', icon: Shield, features: ['nextcloudReports', 'governedDataExports'] },
    { to: '/care-desk', label: 'Care Desk', icon: BriefcaseMedical, features: ['patientPortal', 'soapNotes', 'nextcloudReports'] },
    { to: '/soap-notes', label: 'SOAP Notes', icon: ClipboardList, features: ['soapNotes'] },
    { to: '/revenue', label: 'Revenue Calculator', icon: Calculator, internalOnly: true },
    { to: '/messages', label: 'Messages', icon: MessageCircle },
    { to: '/video', label: 'Video Calls', icon: Video, features: ['videoConsults'] },
    { to: '/account', label: 'Account', icon: Shield },
  ],
  clinic: [
    { to: '/tenant-governance', label: 'Governance', icon: Shield, features: ['nextcloudReports', 'governedDataExports'] },
    { to: '/soap-notes', label: 'SOAP Notes', icon: ClipboardList, features: ['soapNotes'] },
    { to: '/revenue', label: 'Revenue Calculator', icon: Calculator, internalOnly: true },
    { to: '/messages', label: 'Messages', icon: MessageCircle },
    { to: '/video', label: 'Video Calls', icon: Video, features: ['videoConsults'] },
    { to: '/account', label: 'Account', icon: Shield },
  ],
  patient: [
    { to: '/messages', label: 'Messages', icon: MessageCircle },
    { to: '/video', label: 'Video Calls', icon: Video, features: ['videoConsults'] },
    { to: '/account', label: 'Account', icon: Shield },
  ],
};

export default function AppSidebar() {
  const { pathname } = useLocation();
  const { user, whiteLabelAccount, hasAnyFeature, hasPermission } = useAuth();
  const [hasActiveLive, setHasActiveLive] = useState(false);
  const [otherOpen, setOtherOpen] = useState(false);

  useEffect(() => {
    if (!user?.email || !['admin', 'doctor', 'clinic'].includes(user.role)) return;
    let cancelled = false;
    const check = () => {
      listActiveLiveCases(user.email)
        .then((sessions) => {
          if (!cancelled) setHasActiveLive(sessions.length > 0);
        })
        .catch(() => {
          if (!cancelled) setHasActiveLive(false);
        });
    };
    check();
    const intervalId = window.setInterval(check, 10000);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [user?.email, user?.role]);

  if (!user) {
    return null;
  }

  const shouldShowItem = (item: NavItem) => {
    if (item.internalOnly && whiteLabelAccount && !user.isSuperAdmin) return false;
    if (item.features?.length && !hasAnyFeature(item.features)) return false;
    return true;
  };
  const navItems = (PRIMARY_NAV_BY_ROLE[user.role] ?? []).filter(shouldShowItem);
  const otherItems = (OTHER_NAV_BY_ROLE[user.role] ?? []).filter(shouldShowItem);
  const canCreateCase = ['admin', 'doctor', 'clinic'].includes(user.role) && hasPermission('uploadStudies');
  const newCaseActive = pathname.startsWith('/upload');
  const otherActive = otherItems.some((item) => pathname.startsWith(item.to));
  const showOtherItems = otherOpen || otherActive;

  const renderNavItem = (item: NavItem, nested = false) => {
    const active = pathname.startsWith(item.to);
    if (item.to === '/video') {
      return (
        <a
          key={item.to}
          href="https://call.octelerad.com"
          target="_blank"
          rel="noopener noreferrer"
          className={cn(
            'flex items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium transition-colors',
            nested && 'ml-3 px-3 py-2 text-xs',
            'text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground'
          )}
        >
          <item.icon className={cn('h-4 w-4', nested && 'h-3.5 w-3.5')} />
          {item.label}
        </a>
      );
    }

    return (
      <Link
        key={item.to}
        to={item.to}
        className={cn(
          'flex items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium transition-colors',
          nested && 'ml-3 px-3 py-2 text-xs',
          active
            ? 'bg-sidebar-accent text-sidebar-primary'
            : 'text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground'
        )}
      >
        <item.icon className={cn('h-4 w-4', nested && 'h-3.5 w-3.5')} />
        {item.label}
      </Link>
    );
  };

  return (
    <aside className="fixed inset-y-0 left-0 z-30 flex w-64 flex-col bg-sidebar text-sidebar-foreground">
      <div className="flex h-16 items-center gap-3 border-b border-sidebar-border px-6">
        <img
          src="/octelerad-logo.jpg"
          alt=""
          className="h-8 w-8 rounded-full border border-sidebar-border bg-white object-contain"
        />
        <span className="text-lg font-semibold tracking-tight">OCTELERAD PACS</span>
      </div>

      <nav className="flex-1 space-y-1 px-3 py-4">
        {canCreateCase && (
          <Link
            to="/upload"
            className={cn(
              'mb-3 flex min-h-14 items-center gap-3 rounded-lg border px-4 py-3 text-base font-semibold transition-colors',
              newCaseActive
                ? 'border-sidebar-primary bg-sidebar-primary text-sidebar-primary-foreground'
                : 'border-sidebar-primary/50 bg-sidebar-primary/15 text-sidebar-primary hover:bg-sidebar-primary hover:text-sidebar-primary-foreground'
            )}
          >
            <Upload className="h-5 w-5" />
            New Case
          </Link>
        )}
        {hasActiveLive && (
          <Link
            to="/upload?resumeLive=1"
            className="mb-2 flex items-center gap-3 rounded-md border border-red-400/50 bg-red-500/10 px-3 py-2.5 text-sm font-medium text-red-300 hover:bg-red-500/20"
          >
            <span className="inline-block h-2.5 w-2.5 rounded-full bg-red-400 animate-pulse" />
            Resume Live
          </Link>
        )}
        {navItems.map((item) => renderNavItem(item))}
        {otherItems.length > 0 && (
          <div className="pt-2">
            <button
              type="button"
              onClick={() => setOtherOpen((open) => !open)}
              className={cn(
                'flex w-full items-center justify-between rounded-md px-3 py-2.5 text-sm font-medium transition-colors',
                otherActive
                  ? 'bg-sidebar-accent text-sidebar-primary'
                  : 'text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground'
              )}
              aria-expanded={showOtherItems}
            >
              <span>Other</span>
              {showOtherItems ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            </button>
            {showOtherItems && (
              <div className="mt-1 space-y-1 border-l border-sidebar-border/70 pl-1">
                {otherItems.map((item) => renderNavItem(item, true))}
              </div>
            )}
          </div>
        )}
      </nav>

      <div className="border-t border-sidebar-border p-3 space-y-3">
        <div className="rounded-md border border-sidebar-border px-3 py-2 text-xs text-sidebar-foreground/80">
          <div className="font-medium text-sidebar-foreground">{user.name}</div>
          <div className="mt-0.5">{user.email}</div>
          <div className="mt-1 uppercase tracking-wide">{user.role}</div>
          <div className="mt-1">{ACCOUNT_STATUS_LABELS[user.status]}</div>
        </div>
      </div>
    </aside>
  );
}
