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
  Headphones
} from 'lucide-react';
import { useClerk } from '@clerk/clerk-react';
import { useAppAuth } from '@auth/useAppAuth';
import type { UserRole } from '@app-types/index';

interface MenuItem {
  path: string;
  label: string;
  icon: React.ElementType;
  roles: UserRole[];
  badge?: number;
}

const menuItems: MenuItem[] = [
  { path: '/', label: 'Dashboard', icon: LayoutDashboard, roles: ['admin', 'supervisor', 'agent'] },
  { path: '/monitor', label: 'Live Monitor', icon: MessageSquare, roles: ['admin', 'supervisor', 'agent'] },
  { path: '/queue', label: 'Queue', icon: Headphones, roles: ['admin', 'supervisor', 'agent'], badge: 0 },
  { path: '/analytics', label: 'Analytics', icon: BarChart3, roles: ['admin', 'supervisor'] },
  { path: '/tenants', label: 'Tenants', icon: Building2, roles: ['admin'] },
  { path: '/team', label: 'Team', icon: Users, roles: ['admin', 'supervisor'] },
  { path: '/settings', label: 'Settings', icon: Settings, roles: ['admin', 'supervisor', 'agent'] },
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
  const hasAccess = (roles: UserRole[]) => {
    if (!user) return false;
    return roles.includes(user.role);
  };

  const filteredMenuItems = menuItems.filter((item) => hasAccess(item.roles));

  return (
    <aside className={`flex flex-col h-full bg-surface-0 border-r border-edge ${className}`}>
      {/* Gradient overlay at top */}
      <div className="absolute top-0 left-0 right-0 h-32 bg-gradient-to-b from-primary-600/5 to-transparent pointer-events-none" />

      {/* Logo */}
      <div className="flex items-center gap-3 px-4 py-4 border-b border-edge relative">
        <div className="relative">
          <div className="absolute inset-0 bg-primary-500/20 rounded-xl blur-md" />
          <div className="relative w-8 h-8 bg-primary-600 rounded-xl flex items-center justify-center">
            <Headphones className="w-5 h-5 text-white" />
          </div>
        </div>
        <div>
          <h1 className="font-bold text-text-primary">HandsOff</h1>
          <p className="text-xs text-text-muted">Agent Portal</p>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-2 py-4 overflow-y-auto">
        <ul className="space-y-1">
          {filteredMenuItems.map((item) => (
            <li key={item.path}>
              <NavLink
                to={item.path}
                className={({ isActive }) => `
                  flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-colors
                  ${isActive
                    ? 'bg-primary-600/10 text-primary-400 border-l-2 border-primary-500'
                    : 'text-text-secondary hover:bg-surface-3 hover:text-text-primary'
                  }
                `}
              >
                <item.icon className="w-5 h-5 flex-shrink-0" />
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
              <p className="text-xs text-text-muted capitalize">{user?.role}</p>
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={() => signOut()}
          className="flex items-center gap-3 w-full px-3 py-2 text-sm font-medium text-text-secondary hover:bg-surface-3 hover:text-text-primary rounded-xl transition-colors"
        >
          <LogOut className="w-5 h-5" />
          Sign Out
        </button>
      </div>
    </aside>
  );
};

export default Sidebar;
