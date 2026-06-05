/**
 * App Component
 * Main application with Clerk auth and routing
 */

import React from 'react';
import { BrowserRouter, Routes, Route, Navigate, useParams } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from './queries/queryConfig';
import { Toaster } from '@/components/ui/sonner';
import { ClerkProvider, SignedIn, SignedOut, SignIn } from '@clerk/clerk-react';

// Context Providers
import { ThemeProvider, useTheme } from '@/contexts/ThemeContext';
import { SocketProvider, useSocket } from '@websocket/SocketContext';

// Auth
import { OrganizationRequired } from '@auth/OrganizationRequired';
import { AppAuthProvider } from '@auth/AppAuthProvider';
import { ProtectedRoute, SupervisorRoute, SuperAdminRoute } from '@auth/ProtectedRoute';

// Layout
import { ErrorBoundary } from '@components/ui/error-boundary';
import { Sidebar } from '@components/Sidebar';
import { TenantCommandPalette } from '@components/admin/TenantCommandPalette';
import { TenantImpersonationBanner } from '@components/admin/TenantImpersonationBanner';
import { useTenantTheme } from '@/hooks/useTenantTheme';
import { useOrganization } from '@clerk/clerk-react';
import { useUiStore } from './stores/uiStore';
import { useAppAuth } from '@auth/useAppAuth';

// Pages
import Inbox from '@pages/Inbox';
import AiContent from '@pages/AiContent';
import BotEditor from '@pages/bots/BotEditor';
import Analytics from '@pages/Analytics';
import Team from '@pages/Team';
import Bookings from '@pages/Bookings';
import Leads from '@pages/Leads';
import SocialMedia from '@pages/SocialMedia';
import SuccessMeter from '@pages/SuccessMeter';
import SettingsLayout from '@pages/settings/SettingsLayout';
import ProfileSettings from '@pages/settings/ProfileSettings';
import NotificationSettings from '@pages/settings/NotificationSettings';
import AppearanceSettings from '@pages/settings/AppearanceSettings';
import IntegrationSettings from '@pages/settings/IntegrationSettings';
import WidgetBrandSettings from '@pages/settings/WidgetBrandSettings';
import ChannelsSettings from '@pages/settings/ChannelsSettings';
import CapabilitiesSettings from '@pages/settings/CapabilitiesSettings';
import BillingSettings from '@pages/settings/BillingSettings';
import WidgetTest from '@pages/WidgetTest';
import AdminTenants from '@pages/admin/AdminTenants';
import AdminUsers from '@pages/admin/AdminUsers';
import AdminAnalytics from '@pages/admin/AdminAnalytics';
import AdminFaqEditor from '@pages/admin/AdminFaqEditor';
import AdminTenantDetail from '@pages/admin/AdminTenantDetail';
import Help from '@pages/help/Help';

// Copilot (AI Platform Assistant) — Pro+ feature, locked-but-visible
import { CopilotDrawerProvider } from '@components/copilot/CopilotDrawerProvider';
import { CopilotLauncher } from '@components/copilot/CopilotLauncher';
import { CopilotDrawer } from '@components/copilot/CopilotDrawer';

const CLERK_PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

// Create Query Client
const queryClient = createQueryClient();

// Connection status banner — shown when socket is disconnected
const ConnectionBanner: React.FC = () => {
  const { isConnected, isConnecting } = useSocket();
  const [show, setShow] = React.useState(false);

  // Only show after a brief delay to avoid flashing on page load
  React.useEffect(() => {
    if (isConnected) {
      setShow(false);
      return;
    }
    const timer = setTimeout(() => setShow(true), 2000);
    return () => clearTimeout(timer);
  }, [isConnected]);

  if (!show) return null;

  return (
    <div className="flex items-center justify-center gap-2 px-4 py-1.5 text-xs font-medium bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300 border-b border-amber-200 dark:border-amber-800">
      <span className="relative flex h-2 w-2">
        {isConnecting && <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />}
        <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500" />
      </span>
      {isConnecting ? 'Reconnecting to live updates…' : 'Live updates disconnected'}
    </div>
  );
};

// Layout wrapper for authenticated pages
const AuthenticatedLayout: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  useTenantTheme();
  const { organization } = useOrganization();
  const { openTenantPalette } = useUiStore();
  const { user } = useAppAuth();
  const isSuperAdmin = user?.role === 'super_admin';

  // Global keyboard shortcut: Cmd+K / Ctrl+K
  React.useEffect(() => {
    if (!isSuperAdmin) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        // Don't trigger inside inputs/textareas/contenteditable
        const target = e.target as HTMLElement;
        if (
          target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable
        ) {
          return;
        }
        e.preventDefault();
        openTenantPalette();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isSuperAdmin, openTenantPalette]);

  return (
    <div className="h-screen flex overflow-hidden bg-surface-1">
      <div className="hidden md:flex w-64 flex-shrink-0">
        <Sidebar />
      </div>
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="bg-surface-0 border-b border-edge px-4 py-2 flex items-center justify-between md:hidden">
          <div className="flex items-center gap-2">
            {organization?.hasImage ? (
              <img
                src={organization.imageUrl}
                alt={organization.name ?? ''}
                className="w-7 h-7 rounded-lg object-cover"
              />
            ) : (
              <div className="w-7 h-7 bg-primary-600 rounded-lg flex items-center justify-center">
                <span className="text-xs font-bold text-white">
                  {organization?.name?.charAt(0)?.toUpperCase() ?? 'H'}
                </span>
              </div>
            )}
            <span className="font-semibold text-text-primary truncate max-w-[150px]">
              {organization?.name ?? 'Axentrio'}
            </span>
          </div>
        </div>
        <TenantImpersonationBanner />
        <ConnectionBanner />
        <main className="flex-1 overflow-hidden">
          {children}
        </main>
      </div>
      {isSuperAdmin && <TenantCommandPalette />}
      {/* Copilot — single render site so the drawer persists across route navigation. */}
      <CopilotLauncher />
      <CopilotDrawer />
    </div>
  );
};

// Widget test page — renders outside Clerk auth entirely
const WidgetTestRouter: React.FC = () => {
  if (window.location.pathname !== '/widget-test') return null;
  return <WidgetTest />;
};

// Clerk provider with theme-aware appearance
const ThemedClerkProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';

  return (
    <ClerkProvider
      publishableKey={CLERK_PUBLISHABLE_KEY}
      appearance={{
        variables: {
          colorBackground: isDark ? '#161821' : '#ffffff',
          colorInputBackground: isDark ? '#1e2030' : '#f9fafb',
          colorText: isDark ? '#f1f3f9' : '#111827',
          colorTextSecondary: isDark ? '#9ca3bf' : '#6b7280',
          colorPrimary: '#6366f1',
          colorInputText: isDark ? '#f1f3f9' : '#111827',
          colorDanger: '#f87171',
          colorSuccess: '#34d399',
          colorNeutral: isDark ? '#9ca3bf' : '#6b7280',
          borderRadius: '0.75rem',
          fontFamily: "'Plus Jakarta Sans', sans-serif",
        },
        elements: {
          card: {
            backgroundColor: isDark ? '#161821' : '#ffffff',
            border: isDark ? '1px solid #2a2d3e' : '1px solid #e5e7eb',
            boxShadow: isDark
              ? '0 25px 50px -12px rgba(0,0,0,0.5)'
              : '0 25px 50px -12px rgba(0,0,0,0.1)',
          },
          headerTitle: { color: isDark ? '#f1f3f9' : '#111827' },
          headerSubtitle: { color: isDark ? '#9ca3bf' : '#6b7280' },
          socialButtonsBlockButton: {
            backgroundColor: isDark ? '#1e2030' : '#f9fafb',
            border: isDark ? '1px solid #2a2d3e' : '1px solid #e5e7eb',
            color: isDark ? '#f1f3f9' : '#111827',
            '&:hover': { backgroundColor: isDark ? '#262940' : '#f3f4f6' },
          },
          dividerLine: { backgroundColor: isDark ? '#2a2d3e' : '#e5e7eb' },
          dividerText: { color: isDark ? '#9ca3bf' : '#6b7280' },
          formFieldLabel: { color: isDark ? '#9ca3bf' : '#6b7280' },
          formFieldInput: {
            backgroundColor: isDark ? '#1e2030' : '#ffffff',
            border: isDark ? '1px solid #2a2d3e' : '1px solid #e5e7eb',
            color: isDark ? '#f1f3f9' : '#111827',
            '&:focus': {
              borderColor: '#6366f1',
              boxShadow: '0 0 0 3px rgba(99,102,241,0.15)',
            },
          },
          formButtonPrimary: {
            backgroundColor: '#6366f1',
            '&:hover': { backgroundColor: '#818cf8' },
          },
          footerActionLink: { color: '#818cf8' },
          footerActionText: { color: isDark ? '#9ca3bf' : '#6b7280' },
          identityPreviewEditButton: { color: '#818cf8' },
          formFieldAction: { color: '#818cf8' },
          otpCodeFieldInput: {
            backgroundColor: isDark ? '#1e2030' : '#ffffff',
            border: isDark ? '1px solid #2a2d3e' : '1px solid #e5e7eb',
            color: isDark ? '#f1f3f9' : '#111827',
          },
          footer: {
            '& + div': { color: isDark ? '#9ca3bf' : '#6b7280' },
          },
        },
      }}
    >
      {children}
    </ClerkProvider>
  );
};

// Redirect helpers for old routes
const TakeoverRedirect: React.FC = () => {
  const { chatId } = useParams<{ chatId: string }>();
  return <Navigate to={`/inbox?chat=${chatId}`} replace />;
};

const DefaultRedirect: React.FC = () => {
  const { user } = useAppAuth();
  if (user?.role === 'agent') {
    return <Navigate to="/inbox" replace />;
  }
  return <Navigate to="/analytics" replace />;
};

const App: React.FC = () => {
  // If on widget-test path, render only the widget test page (no Clerk)
  if (window.location.pathname === '/widget-test') {
    return (
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <WidgetTestRouter />
          <Toaster />
        </QueryClientProvider>
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider>
      <ThemedClerkProvider>
      <QueryClientProvider client={queryClient}>
        <SignedOut>
          <div className="flex items-center justify-center h-screen bg-surface-1">
            <SignIn
              forceRedirectUrl="/"
              signUpForceRedirectUrl="/"
            />
          </div>
        </SignedOut>

        <SignedIn>
          <AppAuthProvider>
            <BrowserRouter>
              <SocketProvider>
              <ErrorBoundary>
              <CopilotDrawerProvider>
              <AuthenticatedLayout>
                <OrganizationRequired>
                  <Routes>
                    {/* New navigation structure */}
                    <Route element={<ProtectedRoute />}>
                      <Route path="/inbox" element={<Inbox />} />
                      <Route path="/ai" element={<AiContent />} />
                      <Route path="/ai/bots/:id" element={<BotEditor />} />
                      <Route path="/analytics" element={<Analytics />} />
                      {/* M2 epic nav: locked-but-visible module routes */}
                      <Route path="/channels" element={<SocialMedia />} />
                      <Route path="/leads" element={<Leads />} />
                      <Route path="/bookings" element={<Bookings />} />
                      <Route path="/success-meter" element={<SuccessMeter />} />
                      <Route path="/help" element={<Help />} />
                      <Route path="/settings" element={<SettingsLayout />}>
                        <Route index element={<Navigate to="/settings/profile" replace />} />
                        <Route path="skills" element={<Navigate to="/settings/capabilities" replace />} />
                        <Route path="profile" element={<ProfileSettings />} />
                        <Route path="notifications" element={<NotificationSettings />} />
                        <Route path="appearance" element={<AppearanceSettings />} />
                        <Route path="widget" element={<WidgetBrandSettings />} />
                        <Route path="integrations" element={<IntegrationSettings />} />
                        <Route path="channels" element={<ChannelsSettings />} />
                        <Route path="capabilities" element={<CapabilitiesSettings />} />
                        <Route path="billing" element={<BillingSettings />} />
                        <Route path="automations" element={<Navigate to="/settings/capabilities" replace />} />
                      </Route>
                    </Route>

                    {/* Supervisor/Admin routes */}
                    <Route element={<SupervisorRoute />}>
                      <Route path="/team" element={<Team />} />
                    </Route>

                    {/* Super Admin routes */}
                    <Route element={<SuperAdminRoute />}>
                      <Route path="/admin/tenants" element={<AdminTenants />} />
                      <Route path="/admin/tenants/:id" element={<AdminTenantDetail />} />
                      <Route path="/admin/users" element={<AdminUsers />} />
                      <Route path="/admin/analytics" element={<AdminAnalytics />} />
                      <Route path="/admin/faq" element={<AdminFaqEditor />} />
                    </Route>

                    {/* Redirects for old routes */}
                    <Route path="/" element={<DefaultRedirect />} />
                    <Route path="/monitor" element={<Navigate to="/inbox" replace />} />
                    <Route path="/queue" element={<Navigate to="/inbox?filter=handoff" replace />} />
                    <Route path="/takeover/:chatId" element={<TakeoverRedirect />} />
                    <Route path="/knowledge" element={<Navigate to="/ai?tab=knowledge" replace />} />
                    <Route path="/canned-responses" element={<Navigate to="/ai?tab=canned" replace />} />
                    <Route path="/tenants" element={<Navigate to="/settings/widget" replace />} />

                    {/* Catch all */}
                    <Route path="*" element={<Navigate to="/inbox" replace />} />
                  </Routes>
                </OrganizationRequired>
              </AuthenticatedLayout>
              </CopilotDrawerProvider>
              </ErrorBoundary>
              </SocketProvider>
            </BrowserRouter>
          </AppAuthProvider>
        </SignedIn>

        <Toaster />
      </QueryClientProvider>
      </ThemedClerkProvider>
    </ThemeProvider>
  );
};

export default App;
