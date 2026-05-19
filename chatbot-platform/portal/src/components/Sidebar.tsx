/**
 * Sidebar Component
 * Navigation sidebar with menu items
 */

import React from 'react';
import { NavLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  MessageSquare,
  Users,
  BarChart3,
  Settings,
  LogOut,
  Shield,
  UserCog,
  TrendingUp,
  BookOpen,
  HelpCircle,
  ChevronDown,
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
import type { UserRole } from '@app-types/index';

interface MenuItem {
  path: string;
  /** Translation key under `nav.*` */
  labelKey: string;
  icon: React.ElementType;
  roles: UserRole[];
  badge?: number;
}

const menuItems: MenuItem[] = [
  { path: '/inbox', labelKey: 'nav.inbox', icon: MessageSquare, roles: ['super_admin', 'admin', 'supervisor', 'agent'] },
  { path: '/ai', labelKey: 'nav.aiContent', icon: BookOpen, roles: ['super_admin', 'admin', 'supervisor', 'agent'] },
  { path: '/analytics', labelKey: 'nav.analytics', icon: BarChart3, roles: ['super_admin', 'admin', 'supervisor', 'agent'] },
  { path: '/team', labelKey: 'nav.team', icon: Users, roles: ['super_admin', 'admin', 'supervisor'] },
  { path: '/settings', labelKey: 'nav.settings', icon: Settings, roles: ['super_admin', 'admin', 'supervisor', 'agent'] },
  { path: '/help', labelKey: 'nav.helpFaq', icon: HelpCircle, roles: ['super_admin', 'admin', 'supervisor', 'agent'] },
];

const adminMenuItems: MenuItem[] = [
  { path: '/admin/tenants', labelKey: 'nav.allTenants', icon: Shield, roles: ['super_admin'] },
  { path: '/admin/users', labelKey: 'nav.allUsers', icon: UserCog, roles: ['super_admin'] },
  { path: '/admin/analytics', labelKey: 'nav.platformAnalytics', icon: TrendingUp, roles: ['super_admin'] },
];

interface SidebarProps {
  className?: string;
}

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

  const hasAccess = (roles: UserRole[]) => {
    // While user is loading, show all items — route guards handle actual access
    if (!user) return true;
    return roles.includes(user.role);
  };

  const filteredMenuItems = menuItems.filter((item) => hasAccess(item.roles));
  const filteredAdminItems = adminMenuItems.filter((item) => hasAccess(item.roles));

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
            {isImpersonating ? activeTenant.tenantName : organization?.name ?? 'HandsOff'}
          </h1>
          <p className={cn(
            'text-xs',
            isImpersonating ? 'text-orange-400 font-medium' : 'text-text-muted'
          )}>
            {isImpersonating ? t('sidebar.impersonating') : 'HandsOff'}
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
            {filteredMenuItems.map((item) => (
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
                  {item.path === '/inbox' && pendingCount > 0 && (
                    <span className="flex items-center justify-center min-w-5 h-5 px-1.5 text-xs font-medium text-white bg-red-500 rounded-full">
                      {pendingCount > 99 ? '99+' : pendingCount}
                    </span>
                  )}
                </NavLink>
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
