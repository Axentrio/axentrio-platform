/**
 * NotifyMeButton
 * Captures demand for a "coming soon" feature. On click, POSTs a demand
 * signal to the backend and remembers the request in localStorage so a
 * refresh keeps the "Notified" state.
 *
 * - 429 from the backend (already requested / rate-limited) flips the UI to
 *   the notified state with a friendly toast instead of erroring.
 * - Network/5xx surfaces a generic error toast.
 */

import * as React from 'react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import axios, { AxiosError } from 'axios';
import { Bell, Check } from 'lucide-react';
import { api } from '../../services/apiClient';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface NotifyMeButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> {
  feature: string;
  context?: Record<string, unknown>;
}

function storageKey(feature: string) {
  return `notifyMe:${feature}`;
}

function readNotified(feature: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(storageKey(feature)) === '1';
  } catch {
    return false;
  }
}

function persistNotified(feature: string) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(storageKey(feature), '1');
  } catch {
    // localStorage may be disabled (private browsing, quota) — degrade silently.
  }
}

export function NotifyMeButton({
  feature,
  context,
  className,
  disabled,
  ...rest
}: NotifyMeButtonProps) {
  const { t } = useTranslation();
  const [notified, setNotified] = React.useState(() => readNotified(feature));

  const mutation = useMutation({
    mutationFn: () =>
      api.post('/demand-signals/notify-me', { feature, context }),
    onSuccess: () => {
      persistNotified(feature);
      setNotified(true);
      toast.success(t('notifyMe.notified'));
    },
    onError: (err: unknown) => {
      // Already-requested / rate-limited: treat as a soft success so the user
      // sees the same "we've got you" state without a scary error.
      if (axios.isAxiosError(err) && (err as AxiosError).response?.status === 429) {
        persistNotified(feature);
        setNotified(true);
        toast.info(t('notifyMe.notified'));
        return;
      }
      toast.error(t('notifyMe.error'));
    },
  });

  const isNotified = notified;

  return (
    <Button
      type="button"
      variant="outline"
      className={cn(className)}
      disabled={disabled || isNotified || mutation.isPending}
      onClick={() => mutation.mutate()}
      aria-pressed={isNotified}
      {...rest}
    >
      {isNotified ? (
        <Check className="h-4 w-4" aria-hidden="true" />
      ) : (
        <Bell className="h-4 w-4" aria-hidden="true" />
      )}
      <span>{isNotified ? t('notifyMe.notified') : t('notifyMe.cta')}</span>
    </Button>
  );
}

export default NotifyMeButton;
