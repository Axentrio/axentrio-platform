/**
 * Sidebar Component
 * Navigation sidebar with menu items.
 *
 * M2 (subscription/feature-access epic) — locked-but-visible nav:
 *   - 8 epic-mandated items: Inbox, AI Bot & Content, Social Media, Lead
 *     Capture, Bookings, Success Meter, General Settings, Help & FAQ.
 *   - Items carrying `requiredFeature` are gated via `useHasFeature()`. When
 *     the calling tenant lacks the entitlement, the entry stays visible and
 *     clickable; it renders a compact PlanBadge + Lock icon + tooltip. The
 *     click routes through to the module path where the locked-preview hero
 *     takes over (Deviation 11).
 *   - Existing admin sub-menu (super_admin only) is retained.
 */

import React from 'react';
import { NavLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  MessageSquare,
  Bot,
  Share2,
  UserPlus,
  Calendar,
  Gauge,
  Settings,
  LogOut,
  Shield,
  UserCog,
  TrendingUp,
  HelpCircle,
  ChevronDown,
  Lock,
} from 'lucide-react';
import { useClerk, useOrganization } from '@clerk/clerk-react';
import { useAppAuth } from '@auth/useAppAuth';
import { useTenantContextStore } from '../stores/tenantContextStore';
import { useUiStore } from '../stores/uiStore';
import { useTenantSwitch } from '../hooks/useTenantSwitch';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useHandoffsQuery } from '../queries/useHandoffQueries';
import {
  useHasFeature,
  type PlanFeatures,
} from '../queries/useEntitlementsQueries';
import { PlanBadge } from '@/components/billing/PlanBadge';
import type { UserRole } from '@app-types/index';

type RequiredTier = 'pro' | 'enterprise';

interface MenuItem {
  path: string;
  /** Translation key under `nav.*` */
  labelKey: string;
  icon: React.ElementType;
  /**
   * Feature flag that gates this item. When omitted, the item is visible to
   * everyone (any paid tier — the `free` cancellation sink is handled
   * upstream by route guards).
   */
  requiredFeature?: keyof PlanFeatures;
  /** Tier that unlocks `requiredFeature`. Drives the badge + tooltip copy. */
  requiredTier?: RequiredTier;
}

interface AdminMenuItem {
  path: string;
  labelKey: string;
  icon: React.ElementType;
  roles: UserRole[];
}

const menuItems: MenuItem[] = [
  // 1. Inbox — all paid tiers
  { path: '/inbox', labelKey: 'nav.inbox', icon: MessageSquare },
  // 2. AI Bot & Content — all paid tiers
  { path: '/ai', labelKey: 'nav.aiContent', icon: Bot },
  // 3. Social Media — all paid tiers
  { path: '/channels', labelKey: 'nav.socialMedia', icon: Share2 },
  // 4. Lead Capture — all paid tiers (surface arrives in M6)
  { path: '/leads', labelKey: 'nav.leadCapture', icon: UserPlus },
  // 5. Bookings — Pro+ only (surface arrives in M5)
  {
    path: '/bookings',
    labelKey: 'nav.bookings',
    icon: Calendar,
    requiredFeature: 'bookings',
    requiredTier: 'pro',
  },
  // 6. Success Meter — sidebar alias for Insights/Analytics (Deviation 5)
  { path: '/success-meter', labelKey: 'nav.successMeter', icon: Gauge },
  // 7. General Settings — all roles
  { path: '/settings', labelKey: 'nav.settings', icon: Settings },
  // 8. Help & FAQ — all roles
  { path: '/help', labelKey: 'nav.helpFaq', icon: HelpCircle },
];

const adminMenuItems: AdminMenuItem[] = [
  { path: '/admin/tenants', labelKey: 'nav.allTenants', icon: Shield, roles: ['super_admin'] },
  { path: '/admin/users', labelKey: 'nav.allUsers', icon: UserCog, roles: ['super_admin'] },
  { path: '/admin/analytics', labelKey: 'nav.platformAnalytics', icon: TrendingUp, roles: ['super_admin'] },
  { path: '/admin/faq', labelKey: 'nav.faqEditor', icon: HelpCircle, roles: ['super_admin'] },
];

interface SidebarProps {
  className?: string;
}

interface SidebarMenuEntryProps {
  item: MenuItem;
  badgeCount?: number;
}

/**
 * Renders one navigation entry. When the item carries a `requiredFeature`
 * and the tenant lacks it, the entry shows a lock icon + plan badge + tooltip
 * but stays clickable so the destination route can render its preview hero.
 *
 * The Tooltip wraps only the icon (matches the pre-M2 pattern). Wrapping the
 * whole NavLink via `TooltipTrigger asChild` is structurally fine in Radix
 * but the data-state attributes Radix injects into NavLink interact poorly
 * with NavLink's own active-state styling on some browser/CSS combinations.
 * Icon-only tooltip is the safe pattern that worked pre-M2.
 */
const SidebarMenuEntry: React.FC<SidebarMenuEntryProps> = ({ item, badgeCount }) => {
  const { t } = useTranslation();
  // Hook order must not depend on whether the item is gated, so always call
  // with a stable key. `unifiedInbox` is a safe no-op (true on every paid
  // tier) when `requiredFeature` is undefined.
  const featureKey = item.requiredFeature ?? 'unifiedInbox';
  const hasFeature = useHasFeature(featureKey);
  const isLocked = !!item.requiredFeature && !hasFeature;
  const requiredTier = item.requiredTier ?? 'pro';

  const label = t(item.labelKey);
  const tooltipLabel = isLocked
    ? t(`sidebar.unlockWith.${requiredTier}`)
    : label;

  return (
    <NavLink
      to={item.path}
      className={({ isActive }) =>
        cn(
          'flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-colors',
          isActive
            ? 'bg-primary-600/10 text-primary-400 border-l-2 border-primary-500'
            : isLocked
              ? 'text-text-muted hover:bg-surface-3 hover:text-text-secondary'
              : 'text-text-secondary hover:bg-surface-3 hover:text-text-primary',
        )
      }
      aria-label={
        isLocked ? `${label} — ${t('sidebar.lockTooltip')}` : undefined
      }
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="flex-shrink-0 inline-flex items-center justify-center">
            <item.icon className="w-5 h-5" />
          </span>
        </TooltipTrigger>
        <TooltipContent side="right">{tooltipLabel}</TooltipContent>
      </Tooltip>
      <span className="flex-1 min-w-0 truncate">{label}</span>
      {isLocked && (
        <span className="flex items-center gap-1 flex-shrink-0">
          <Lock className="w-3 h-3" aria-hidden="true" />
          <PlanBadge tier={requiredTier} size="sm" />
        </span>
      )}
      {!isLocked && badgeCount != null && badgeCount > 0 && (
        <span className="flex items-center justify-center min-w-5 h-5 px-1.5 text-xs font-medium text-white bg-red-500 rounded-full flex-shrink-0">
          {badgeCount > 99 ? '99+' : badgeCount}
        </span>
      )}
    </NavLink>
  );
};

export const Sidebar: React.FC<SidebarProps> = ({
  className = ''
}) => {
  const { t } = useTranslation();
  const { pendingCount } = useHandoffsQuery('pending');
  const { user } = useAppAuth();
  const { signOut } = useClerk();
  const { organization } = useOrganization();
  const { activeTenant } = useTenantContextStore();
  const { openTenantPalette } = useUiStore();
  const { exitTenant } = useTenantSwitch();
  const isSuperAdmin = user?.role === 'super_admin';
  const isImpersonating = isSuperAdmin && !!activeTenant;

  const hasAdminAccess = (roles: UserRole[]) => {
    // While user is loading, show all items — route guards handle actual access
    if (!user) return true;
    return roles.includes(user.role);
  };

  const filteredAdminItems = adminMenuItems.filter((item) => hasAdminAccess(item.roles));

  return (
    <aside className={cn(
      'flex flex-col w-full h-full bg-surface-0 border-r border-edge',
      isImpersonating && 'border-l-[3px] border-l-orange-500',
      className
    )}>
      {/* Gradient overlay at top */}
      <div className="absolute top-0 left-0 right-0 h-32 bg-gradient-to-b from-primary-600/5 to-transparent pointer-events-none" />

      {/* Org branding / Tenant switcher trigger */}
      <div
        className={cn(
          'flex items-center gap-3 px-4 py-4 border-b border-edge relative',
          isImpersonating && 'bg-orange-500/10'
        )}
      >
        <div className="relative">
          <div className={cn(
            'absolute inset-0 rounded-xl blur-md',
            isImpersonating ? 'bg-orange-500/20' : 'bg-primary-500/20'
          )} />
          {!isImpersonating && organization?.hasImage ? (
            <img
              src={organization.imageUrl}
              alt={organization.name ?? ''}
              className="relative w-8 h-8 rounded-xl object-cover"
            />
          ) : (
            <div className={cn(
              'relative w-8 h-8 rounded-xl flex items-center justify-center',
              isImpersonating ? 'bg-orange-500' : 'bg-primary-600'
            )}>
              <span className="text-sm font-bold text-white">
                {isImpersonating
                  ? activeTenant.tenantName.charAt(0).toUpperCase()
                  : organization?.name?.charAt(0)?.toUpperCase() ?? 'H'}
              </span>
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="font-bold text-text-primary truncate">
            {isImpersonating ? activeTenant.tenantName : organization?.name ?? 'Axentrio'}
          </h1>
          <p className={cn(
            'text-xs',
            isImpersonating ? 'text-orange-400 font-medium' : 'text-text-muted'
          )}>
            {isImpersonating ? t('sidebar.impersonating') : 'Axentrio'}
          </p>
        </div>
        {isSuperAdmin && !isImpersonating && (
          <button
            onClick={openTenantPalette}
            className="p-1 rounded-md hover:bg-surface-2 text-text-muted hover:text-text-primary transition-colors"
            title={t('sidebar.switchTenant')}
          >
            <ChevronDown className="w-4 h-4" />
          </button>
        )}
        {isImpersonating && (
          <button
            onClick={exitTenant}
            className="px-2 py-1 rounded-md text-xs font-medium text-orange-400 hover:bg-orange-500/10 transition-colors"
          >
            {t('sidebar.exitImpersonation')}
          </button>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-2 py-4 overflow-y-auto">
        <TooltipProvider>
          <ul className="space-y-1">
            {menuItems.map((item) => (
              <li key={item.path}>
                <SidebarMenuEntry
                  item={item}
                  badgeCount={item.path === '/inbox' ? pendingCount : undefined}
                />
              </li>
            ))}
          </ul>

          {filteredAdminItems.length > 0 && (
            <>
              <div className="my-3 mx-2 border-t border-edge" />
              <div className="px-3 mb-1">
                <span className="text-xs font-semibold text-text-muted uppercase tracking-wider">
                  {t('nav.superAdmin')}
                </span>
              </div>
              <ul className="space-y-1">
                {filteredAdminItems.map((item) => (
                  <li key={item.path}>
                    <NavLink
                      to={item.path}
                      className={({ isActive }) =>
                        cn(
                          'flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-colors',
                          isActive
                            ? 'bg-primary-600/10 text-primary-400 border-l-2 border-primary-500'
                            : 'text-text-secondary hover:bg-surface-3 hover:text-text-primary'
                        )
                      }
                    >
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <item.icon className="w-5 h-5 flex-shrink-0" />
                        </TooltipTrigger>
                        <TooltipContent side="right">
                          {t(item.labelKey)}
                        </TooltipContent>
                      </Tooltip>
                      <span className="flex-1">{t(item.labelKey)}</span>
                    </NavLink>
                  </li>
                ))}
              </ul>
            </>
          )}
        </TooltipProvider>
      </nav>

      {/* User section */}
      <div className="px-4 py-4 border-t border-edge">
        <div className="flex items-center gap-3 mb-4 p-2 rounded-xl glass">
          <div className="w-10 h-10 rounded-full bg-primary-600/20 flex items-center justify-center">
            <span className="text-sm font-medium text-primary-400">
              {user?.firstName?.charAt(0)}{user?.lastName?.charAt(0)}
            </span>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-text-primary truncate">
              {user?.firstName} {user?.lastName}
            </p>
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-status-online shadow-[0_0_6px_rgba(52,211,153,0.5)]" />
              <p className="text-xs text-text-muted">{user?.role ? t(`roles.${user.role}`) : ''}</p>
            </div>
          </div>
        </div>

        <Button
          variant="ghost"
          onClick={() => signOut()}
          className="flex items-center gap-3 w-full px-3 py-2 text-sm font-medium text-text-secondary hover:bg-surface-3 hover:text-text-primary rounded-xl transition-colors justify-start"
        >
          <LogOut className="w-5 h-5" />
          {t('sidebar.signOut')}
        </Button>
      </div>
    </aside>
  );
};

export default Sidebar;
