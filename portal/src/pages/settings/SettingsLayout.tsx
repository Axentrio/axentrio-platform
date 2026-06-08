/**
 * Settings Layout
 * Vertical sidebar navigation for settings pages
 */

import React, { useMemo } from 'react';
import { NavLink, Outlet, Navigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { User, Bell, Paintbrush, Palette, Plug, MessageSquare, Zap, CreditCard } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAppAuth } from '@auth/useAppAuth';

interface SettingsNavItem {
  path: string;
  /** Translation key under `settings.tabs.*` */
  labelKey: string;
  icon: React.ElementType;
  /** Group identifier — also used as the translation key suffix under `settings.groups.*`. */
  group: 'Account' | 'Bot' | 'Connections' | 'Billing';
}

const settingsNav: SettingsNavItem[] = [
  // Account
  { path: '/settings/profile', labelKey: 'profile', icon: User, group: 'Account' },
  { path: '/settings/notifications', labelKey: 'notifications', icon: Bell, group: 'Account' },
  { path: '/settings/appearance', labelKey: 'appearance', icon: Paintbrush, group: 'Account' },
  // Bot Configuration
  { path: '/settings/widget', labelKey: 'widget', icon: Palette, group: 'Bot' },
  { path: '/settings/capabilities', labelKey: 'capabilities', icon: Zap, group: 'Bot' },
  // Connections
  { path: '/settings/integrations', labelKey: 'integrations', icon: Plug, group: 'Connections' },
  { path: '/settings/channels', labelKey: 'channels', icon: MessageSquare, group: 'Connections' },
  // Billing
  { path: '/settings/billing', labelKey: 'billing', icon: CreditCard, group: 'Billing' },
];

const SettingsLayout: React.FC = () => {
  const location = useLocation();
  const { isRole } = useAppAuth();
  const { t } = useTranslation();

  const visibleNav = useMemo(() => {
    if (isRole(['admin', 'super_admin'])) return settingsNav;
    return settingsNav.filter((item) => item.group === 'Account');
  }, [isRole]);

  if (location.pathname === '/settings') {
    return <Navigate to="/settings/profile" replace />;
  }

  const groups = [...new Set(visibleNav.map((item) => item.group))];

  return (
    <div className="h-full overflow-auto">
      <div className="max-w-6xl mx-auto p-6">
        {/* Header */}
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-text-primary">{t('settings.header.title')}</h1>
          <p className="text-text-secondary">{t('settings.header.subtitle')}</p>
        </div>

        {/* Mobile horizontal tabs */}
        <nav className="md:hidden w-full mb-4 overflow-x-auto">
          <div className="flex gap-1 border-b border-edge pb-2">
            {visibleNav.map((item) => (
              <NavLink
                key={item.path}
                to={item.path}
                className={({ isActive }) =>
                  cn(
                    'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium whitespace-nowrap transition-colors',
                    isActive
                      ? 'bg-primary-600/10 text-primary-400'
                      : 'text-text-secondary hover:text-text-primary'
                  )
                }
              >
                <item.icon className="w-3.5 h-3.5" />
                {t(`settings.tabs.${item.labelKey}`)}
              </NavLink>
            ))}
          </div>
        </nav>

        <div className="flex gap-6">
          {/* Desktop vertical sidebar */}
          <nav className="hidden md:block w-52 flex-shrink-0">
            {groups.map((group) => (
              <div key={group} className="mb-4">
                <span className="block px-3 mb-1 text-xs font-semibold text-text-muted uppercase tracking-wider">
                  {t(`settings.groups.${group}`)}
                </span>
                <ul className="space-y-0.5">
                  {visibleNav
                    .flatMap((item) =>
                      item.group !== group
                        ? []
                        : [
                      <li key={item.path}>
                        <NavLink
                          to={item.path}
                          className={({ isActive }) =>
                            cn(
                              'flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors',
                              isActive
                                ? 'bg-primary-600/10 text-primary-400'
                                : 'text-text-secondary hover:bg-surface-3 hover:text-text-primary'
                            )
                          }
                        >
                          <item.icon className="w-4 h-4" />
                          {t(`settings.tabs.${item.labelKey}`)}
                        </NavLink>
                      </li>,
                    ])}
                </ul>
              </div>
            ))}
          </nav>

          {/* Content */}
          <div className="flex-1 min-w-0">
            <Outlet />
          </div>
        </div>
      </div>
    </div>
  );
};

export default SettingsLayout;
