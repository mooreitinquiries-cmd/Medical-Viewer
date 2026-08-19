import { toast } from 'sonner';
import { getVisibleErrorMessage } from '@/lib/sessionApi';

export function showErrorToast(error: unknown, fallback: string): boolean {
  const message = getVisibleErrorMessage(error, fallback);
  if (!message) return false;
  toast.error(message);
  return true;
}
