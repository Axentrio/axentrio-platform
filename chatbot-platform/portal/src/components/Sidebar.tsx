/**
 * Sidebar Component
 * Navigation sidebar with menu items
 */

import React from 'react';
import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard,
  MessageSquare,
  Users,
  BarChart3,
  Building2,
  Settings,
  LogOut,
  Headphones,
  Shield,
  UserCog,
  TrendingUp,
} from 'lucide-react';
import { useClerk, useOrganization } from '@clerk/clerk-react';
import { useAppAuth } from '@auth/useAppAuth';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { UserRole } from '@app-types/index';

interface MenuItem {
  path: string;
  label: string;
  icon: React.ElementType;
  roles: UserRole[];
  badge?: number;
}

const menuItems: MenuItem[] = [
  { path: '/', label: 'Dashboard', icon: LayoutDashboard, roles: ['super_admin', 'admin', 'supervisor', 'agent'] },
  { path: '/monitor', label: 'Live Monitor', icon: MessageSquare, roles: ['super_admin', 'admin', 'supervisor', 'agent'] },
  { path: '/queue', label: 'Queue', icon: Headphones, roles: ['super_admin', 'admin', 'supervisor', 'agent'], badge: 0 },
  { path: '/analytics', label: 'Analytics', icon: BarChart3, roles: ['super_admin', 'admin', 'supervisor'] },
  { path: '/tenants', label: 'Tenants', icon: Building2, roles: ['super_admin', 'admin'] },
  { path: '/team', label: 'Team', icon: Users, roles: ['super_admin', 'admin', 'supervisor'] },
  { path: '/settings', label: 'Settings', icon: Settings, roles: ['super_admin', 'admin', 'supervisor', 'agent'] },
];

const adminMenuItems: MenuItem[] = [
  { path: '/admin/tenants', label: 'All Tenants', icon: Shield, roles: ['super_admin'] },
  { path: '/admin/users', label: 'All Users', icon: UserCog, roles: ['super_admin'] },
  { path: '/admin/analytics', label: 'Platform Analytics', icon: TrendingUp, roles: ['super_admin'] },
];

interface SidebarProps {
  pendingHandoffs?: number;
  className?: string;
}

export const Sidebar: React.FC<SidebarProps> = ({
  pendingHandoffs = 0,
  className = ''
}) => {
  const { user } = useAppAuth();
  const { signOut } = useClerk();
  const { organization } = useOrganization();
  const hasAccess = (roles: UserRole[]) => {
    // While user is loading, show all items — route guards handle actual access
    if (!user) return true;
    return roles.includes(user.role);
  };

  const filteredMenuItems = menuItems.filter((item) => hasAccess(item.roles));
  const filteredAdminItems = adminMenuItems.filter((item) => hasAccess(item.roles));

  return (
    <aside className={cn('flex flex-col w-full h-full bg-surface-0 border-r border-edge', className)}>
      {/* Gradient overlay at top */}
      <div className="absolute top-0 left-0 right-0 h-32 bg-gradient-to-b from-primary-600/5 to-transparent pointer-events-none" />

      {/* Org branding */}
      <div className="flex items-center gap-3 px-4 py-4 border-b border-edge relative">
        <div className="relative">
          <div className="absolute inset-0 bg-primary-500/20 rounded-xl blur-md" />
          {organization?.hasImage ? (
            <img
              src={organization.imageUrl}
              alt={organization.name ?? ''}
              className="relative w-8 h-8 rounded-xl object-cover"
            />
          ) : (
            <div className="relative w-8 h-8 bg-primary-600 rounded-xl flex items-center justify-center">
              <span className="text-sm font-bold text-white">
                {organization?.name?.charAt(0)?.toUpperCase() ?? 'H'}
              </span>
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="font-bold text-text-primary truncate">
            {organization?.name ?? 'HandsOff'}
          </h1>
          <p className="text-xs text-text-muted">HandsOff</p>
        </div>
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
                      {item.label}
                    </TooltipContent>
                  </Tooltip>
                  <span className="flex-1">{item.label}</span>
                  {item.path === '/queue' && pendingHandoffs > 0 && (
                    <span className="flex items-center justify-center min-w-5 h-5 px-1.5 text-xs font-medium text-white bg-red-500 rounded-full">
                      {pendingHandoffs > 99 ? '99+' : pendingHandoffs}
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
                  Super Admin
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
                          {item.label}
                        </TooltipContent>
                      </Tooltip>
                      <span className="flex-1">{item.label}</span>
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
              <p className="text-xs text-text-muted capitalize">{user?.role?.replace('_', ' ')}</p>
            </div>
          </div>
        </div>

        <Button
          variant="ghost"
          onClick={() => signOut()}
          className="flex items-center gap-3 w-full px-3 py-2 text-sm font-medium text-text-secondary hover:bg-surface-3 hover:text-text-primary rounded-xl transition-colors justify-start"
        >
          <LogOut className="w-5 h-5" />
          Sign Out
        </Button>
      </div>
    </aside>
  );
};

export default Sidebar;
