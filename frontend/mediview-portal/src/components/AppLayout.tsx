import { Outlet } from 'react-router-dom';
import AppSidebar from './AppSidebar';
import { useAuth } from '@/context/AuthContext';

export default function AppLayout() {
  const { user } = useAuth();

  return (
    <div className="flex min-h-screen">
      <AppSidebar />
      <main className={`flex-1 ${user ? 'pl-64' : ''}`}>
        <div className="mx-auto max-w-6xl px-8 py-8">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
