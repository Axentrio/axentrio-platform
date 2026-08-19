/**
 * The gate that makes setup mandatory.
 *
 * Sits above the route table, so an unfinished workspace shows the wizard whatever URL
 * it is pointed at — a guard that only covers the routes someone remembered to list is
 * not a guard.
 *
 * THREE THINGS IT DELIBERATELY DOES NOT BLOCK:
 *
 *   A failed status call. If the endpoint errors the gate opens, because a customer
 *   locked out of the product they pay for is a far worse failure than one who skipped
 *   a wizard. Only a definite "not finished" closes it.
 *
 *   Super admins, except when impersonating. Sitting in their own session they skip
 *   the wizard. Impersonating an unfinished workspace shows it — otherwise there is
 *   no way to review first-run setup without a second account.
 *
 *   Non-admins. Only admins can write setup, so a member of a half-set-up workspace is
 *   told who has to finish it rather than being handed a wizard that will refuse them.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { useAppAuth } from '@auth/useAppAuth';
import { useTenantContextStore } from '@/stores/tenantContextStore';
import { useSetupStatus } from '@/queries/useOnboardingQueries';
import SetupWizard from './SetupWizard';

export const SetupGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { t } = useTranslation();
  const { user } = useAppAuth();
  const activeTenant = useTenantContextStore((s) => s.activeTenant);
  const { data: status, isLoading, isError } = useSetupStatus();
  const impersonating = user?.role === 'super_admin' && !!activeTenant;

  // Own session: skip. Impersonating an unfinished tenant: fall through and show setup.
  if (user?.role === 'super_admin' && !impersonating) return <>{children}</>;

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-text-muted" />
      </div>
    );
  }

  // Fail open — see the note above.
  if (isError || !status || status.complete) return <>{children}</>;

  if (user?.role !== 'admin' && user?.role !== 'super_admin') {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <div className="max-w-md space-y-2 text-center">
          <h1 className="text-lg font-semibold text-text-primary">{t('setup.blocked.title')}</h1>
          <p className="text-sm text-text-secondary">{t('setup.blocked.body')}</p>
        </div>
      </div>
    );
  }

  return <SetupWizard />;
};
