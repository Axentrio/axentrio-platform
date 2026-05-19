import { useTranslation, Trans } from 'react-i18next';
import { useTenantContextStore } from '../../stores/tenantContextStore';
import { useTenantSwitch } from '../../hooks/useTenantSwitch';
import { Button } from '@/components/ui/button';

export function TenantImpersonationBanner() {
  const { t } = useTranslation();
  const { activeTenant } = useTenantContextStore();
  const { exitTenant } = useTenantSwitch();

  if (!activeTenant) return null;

  return (
    <div className="w-full bg-orange-500/10 border-l-4 border-orange-500 px-4 py-1.5 flex items-center justify-between">
      <div className="flex items-center gap-2 text-sm text-orange-400">
        <span className="w-2 h-2 rounded-full bg-orange-400 animate-pulse" />
        <span>
          <Trans
            i18nKey="admin.impersonationBanner.message"
            values={{ tenant: activeTenant.tenantName }}
            components={{ strong: <strong /> }}
          />
        </span>
      </div>
      <Button
        variant="ghost"
        size="sm"
        onClick={exitTenant}
        className="text-orange-400 hover:text-orange-300 hover:bg-orange-500/10 h-7 text-xs"
      >
        {t('admin.impersonationBanner.exitButton')}
      </Button>
    </div>
  );
}
