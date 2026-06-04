import { Link, useLocation } from 'react-router-dom';
import { useEffect, useState } from 'react';
import {
  LayoutDashboard,
  Upload,
  FolderOpen,
  Library,
  Activity,
  MessageCircle,
  Video,
  BriefcaseMedical,
  Inbox,
  Users,
  Shield,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAuth } from '@/context/AuthContext';
import { ACCOUNT_STATUS_LABELS, type AccountRole } from '@/lib/auth';
import { listActiveLiveCases } from '@/lib/api';

const NAV_BY_ROLE: Record<AccountRole, { to: string; label: string; icon: LucideIcon }[]> = {
  admin: [
    { to: '/admin/users', label: 'User Profiles', icon: Users },
    { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { to: '/care-desk', label: 'Care Desk', icon: BriefcaseMedical },
    { to: '/upload', label: 'Upload Study', icon: Upload },
    { to: '/studies', label: 'Studies', icon: FolderOpen },
    { to: '/streams', label: 'Streams', icon: Library },
    { to: '/cases', label: 'Patient Cases', icon: Inbox },
    { to: '/messages', label: 'Messages', icon: MessageCircle },
    { to: '/video', label: 'Video Calls', icon: Video },
    { to: '/account', label: 'Account', icon: Shield },
  ],
  doctor: [
    { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { to: '/care-desk', label: 'Care Desk', icon: BriefcaseMedical },
    { to: '/upload', label: 'Upload Study', icon: Upload },
    { to: '/studies', label: 'Studies', icon: FolderOpen },
    { to: '/streams', label: 'Streams', icon: Library },
    { to: '/messages', label: 'Messages', icon: MessageCircle },
    { to: '/video', label: 'Video Calls', icon: Video },
    { to: '/account', label: 'Account', icon: Shield },
  ],
  clinic: [
    { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { to: '/upload', label: 'Upload Study', icon: Upload },
    { to: '/studies', label: 'Studies', icon: FolderOpen },
    { to: '/streams', label: 'Streams', icon: Library },
    { to: '/messages', label: 'Messages', icon: MessageCircle },
    { to: '/video', label: 'Video Calls', icon: Video },
    { to: '/account', label: 'Account', icon: Shield },
  ],
  patient: [
    { to: '/cases', label: 'My Cases', icon: Inbox },
    { to: '/messages', label: 'Messages', icon: MessageCircle },
    { to: '/video', label: 'Video Calls', icon: Video },
    { to: '/account', label: 'Account', icon: Shield },
  ],
};

export default function AppSidebar() {
  const { pathname } = useLocation();
  const { user } = useAuth();
  const [hasActiveLive, setHasActiveLive] = useState(false);

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

  const navItems = NAV_BY_ROLE[user.role] ?? [];

  return (
    <aside className="fixed inset-y-0 left-0 z-30 flex w-64 flex-col bg-sidebar text-sidebar-foreground">
      <div className="flex h-16 items-center gap-3 border-b border-sidebar-border px-6">
        <Activity className="h-6 w-6 text-sidebar-primary" />
        <span className="text-lg font-semibold tracking-tight">OCTELERAD PACS</span>
      </div>

      <nav className="flex-1 space-y-1 px-3 py-4">
        {hasActiveLive && (
          <Link
            to="/upload?resumeLive=1"
            className="mb-2 flex items-center gap-3 rounded-md border border-red-400/50 bg-red-500/10 px-3 py-2.5 text-sm font-medium text-red-300 hover:bg-red-500/20"
          >
            <span className="inline-block h-2.5 w-2.5 rounded-full bg-red-400 animate-pulse" />
            Resume Live
          </Link>
        )}
        {navItems.map((item) => {
          const active = pathname.startsWith(item.to);
          return (
            <Link
              key={item.to}
              to={item.to}
              className={cn(
                'flex items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium transition-colors',
                active
                  ? 'bg-sidebar-accent text-sidebar-primary'
                  : 'text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground'
              )}
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </Link>
          );
        })}
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
