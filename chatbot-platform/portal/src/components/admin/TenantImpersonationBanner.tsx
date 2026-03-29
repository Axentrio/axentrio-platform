import { useTenantContextStore } from '../../stores/tenantContextStore';
import { useTenantSwitch } from '../../hooks/useTenantSwitch';
import { Button } from '@/components/ui/button';

export function TenantImpersonationBanner() {
  const { activeTenant } = useTenantContextStore();
  const { exitTenant } = useTenantSwitch();

  if (!activeTenant) return null;

  return (
    <div className="w-full bg-orange-500/10 border-l-4 border-orange-500 px-4 py-1.5 flex items-center justify-between">
      <div className="flex items-center gap-2 text-sm text-orange-400">
        <span className="w-2 h-2 rounded-full bg-orange-400 animate-pulse" />
        <span>
          You are viewing <strong>{activeTenant.tenantName}</strong>
        </span>
      </div>
      <Button
        variant="ghost"
        size="sm"
        onClick={exitTenant}
        className="text-orange-400 hover:text-orange-300 hover:bg-orange-500/10 h-7 text-xs"
      >
        Exit
      </Button>
    </div>
  );
}
