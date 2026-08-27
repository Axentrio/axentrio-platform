/**
 * App Component
 * Main application with Clerk auth and routing
 */

import React from 'react';
import { BrowserRouter, Routes, Route, Navigate, useParams } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from './queries/queryConfig';
import { Toaster } from '@/components/ui/sonner';
import { toast } from 'sonner';
import { ClerkProvider, SignedIn, SignedOut, SignIn } from '@clerk/clerk-react';
import { Menu } from 'lucide-react';

// Context Providers
import { ThemeProvider, useTheme } from '@/contexts/ThemeContext';
import { SocketProvider, useSocket } from '@websocket/SocketContext';
import { useNotificationSound } from '@websocket/notificationSound';

// Auth
import { OrganizationRequired } from '@auth/OrganizationRequired';
import { AppAuthProvider } from '@auth/AppAuthProvider';
import { ProtectedRoute, SupervisorRoute, SuperAdminRoute } from '@auth/ProtectedRoute';
import { afterAuthRedirectPath } from '@auth/afterAuthRedirect';

// Layout
import { ErrorBoundary } from '@components/ui/error-boundary';
import { Sidebar } from '@components/Sidebar';
import { MobileNavDrawer } from '@components/MobileNavDrawer';
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
import { SetupGate } from '@pages/setup/SetupGate';
import { useSetupStatus } from '@/queries/useOnboardingQueries';
import ProfileSettings from '@pages/settings/ProfileSettings';
import AccountInformationSettings from '@pages/settings/AccountInformationSettings';
import NotificationSettings from '@pages/settings/NotificationSettings';
import AppearanceSettings from '@pages/settings/AppearanceSettings';
import { IntegrationTab } from '@components/settings/IntegrationTab';
import WidgetBrandSettings from '@pages/settings/WidgetBrandSettings';
import { SocialChannelsContent } from '@components/channels/SocialChannelsContent';
import CapabilitiesSettings from '@pages/settings/CapabilitiesSettings';
import FeaturesSettings from '@pages/settings/FeaturesSettings';
import BillingSettings from '@pages/settings/BillingSettings';
import WidgetTest from '@pages/WidgetTest';
import AdminTenants from '@pages/admin/AdminTenants';
import AdminUsers from '@pages/admin/AdminUsers';
import AdminAnalytics from '@pages/admin/AdminAnalytics';
import AdminGuardrails from '@pages/admin/AdminGuardrails';
import AdminGuardrailConversation from '@pages/admin/AdminGuardrailConversation';
import AdminFaqEditor from '@pages/admin/AdminFaqEditor';
import AdminStudio from '@pages/admin/AdminStudio';
import AdminBotTemplateDetail from '@pages/admin/AdminBotTemplateDetail';
import AdminTenantDetail from '@pages/admin/AdminTenantDetail';
import AdminLegalInvoices from '@pages/admin/AdminLegalInvoices';
import Help from '@pages/help/Help';

// Public legal pages — rendered outside the Clerk auth gate (see early return in App)
import PrivacyPolicy from '@pages/legal/PrivacyPolicy';
import Terms from '@pages/legal/Terms';
import DataDeletion from '@pages/legal/DataDeletion';

// Copilot (AI Platform Assistant) — Pro+ feature, locked-but-visible
import { CopilotDrawerProvider } from '@components/copilot/CopilotDrawerProvider';
import { CopilotLauncher } from '@components/copilot/CopilotLauncher';
import { CopilotDrawer } from '@components/copilot/CopilotDrawer';

const CLERK_PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

// Create Query Client
const queryClient = createQueryClient();

// Global desktop delivery for backend notifications (handoff, guardrail pause,
// channel-down, SLA, leads, booking). The push worker only covers mobile; this
// is the desktop path. Mounted once inside the socket provider so every tenant
// agent gets a toast + sound when a notification fires.
const NotificationListener: React.FC = () => {
  const { registerHandlers, unregisterHandlers } = useSocket();
  const { playNotification } = useNotificationSound();
  React.useEffect(() => {
    const id = registerHandlers({
      onNotification: (n) => {
        toast(n.title || 'Notification', { description: n.message });
        playNotification();
      },
    });
    return () => unregisterHandlers(id);
  }, [registerHandlers, unregisterHandlers, playNotification]);
  return null;
};

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
    <div className="flex flex-wrap items-center justify-center gap-2 px-4 py-1.5 text-xs font-medium bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300 border-b border-amber-200 dark:border-amber-800">
      <span className="relative flex h-2 w-2">
        {isConnecting && <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />}
        <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500" />
      </span>
      <span className="min-w-0">{isConnecting ? 'Reconnecting to live updates…' : 'Live updates disconnected'}</span>
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
  const { data: setupStatus } = useSetupStatus();
  const inSetup = !isSuperAdmin && setupStatus != null && !setupStatus.complete;
  const [navOpen, setNavOpen] = React.useState(false);

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
      {/* During first-run setup the nav is hidden: every destination in it bounces
          back to the wizard, and offering doors that do not open is worse than
          offering none. Same cached query the gate reads, so no extra request. */}
      {!inSetup && (
        <div className="hidden md:flex w-64 flex-shrink-0">
          <Sidebar />
        </div>
      )}
      {!inSetup && (
        <MobileNavDrawer open={navOpen} onClose={() => setNavOpen(false)} />
      )}
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
          {!inSetup && (
            <button
              type="button"
              onClick={() => setNavOpen(true)}
              aria-label="Open menu"
              className="p-2.5 -mr-1 text-text-primary md:hidden"
            >
              <Menu className="h-5 w-5" />
            </button>
          )}
        </div>
        <TenantImpersonationBanner />
        <ConnectionBanner />
        <NotificationListener />
        <main className="flex-1 overflow-hidden">
          {children}
        </main>
      </div>
      {isSuperAdmin && <TenantCommandPalette />}
      {/* Copilot — single render site so the drawer persists across route navigation.
          Withheld during setup: it advises on a workspace that does not exist yet. */}
      {!inSetup && (
        <>
          <CopilotLauncher />
          <CopilotDrawer />
        </>
      )}
    </div>
  );
};

// Widget test page — renders outside Clerk auth entirely
const WidgetTestRouter: React.FC = () => {
  if (window.location.pathname !== '/widget-test') return null;
  return <WidgetTest />;
};

// Clerk provider with theme-aware appearance

/** The nine colours the Clerk appearance map needs, resolved once per theme. */
interface ClerkPalette {
  background: string;
  inputBackground: string;
  formInputBackground: string;
  text: string;
  textSecondary: string;
  border: string;
  cardShadow: string;
  socialHover: string;
  divider: string;
}

function clerkPalette(isDark: boolean): ClerkPalette {
  return isDark
    ? {
        background: '#161821',
        inputBackground: '#1e2030',
        formInputBackground: '#1e2030',
        text: '#f1f3f9',
        textSecondary: '#9ca3bf',
        border: '1px solid #2a2d3e',
        cardShadow: '0 25px 50px -12px rgba(0,0,0,0.5)',
        socialHover: '#262940',
        divider: '#2a2d3e',
      }
    : {
        background: '#ffffff',
        inputBackground: '#f9fafb',
        formInputBackground: '#ffffff',
        text: '#111827',
        textSecondary: '#6b7280',
        border: '1px solid #e5e7eb',
        cardShadow: '0 25px 50px -12px rgba(0,0,0,0.1)',
        socialHover: '#f3f4f6',
        divider: '#e5e7eb',
      };
}

const ThemedClerkProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { resolvedTheme } = useTheme();
  const palette = clerkPalette(resolvedTheme === 'dark');

  return (
    <ClerkProvider
      publishableKey={CLERK_PUBLISHABLE_KEY}
      appearance={{
        variables: {
          colorBackground: palette.background,
          colorInputBackground: palette.inputBackground,
          colorText: palette.text,
          colorTextSecondary: palette.textSecondary,
          colorPrimary: '#6366f1',
          colorInputText: palette.text,
          colorDanger: '#f87171',
          colorSuccess: '#34d399',
          colorNeutral: palette.textSecondary,
          borderRadius: '0.75rem',
          fontFamily: "'Plus Jakarta Sans', sans-serif",
        },
        elements: {
          card: {
            backgroundColor: palette.background,
            border: palette.border,
            boxShadow: palette.cardShadow,
          },
          headerTitle: { color: palette.text },
          headerSubtitle: { color: palette.textSecondary },
          socialButtonsBlockButton: {
            backgroundColor: palette.inputBackground,
            border: palette.border,
            color: palette.text,
            '&:hover': { backgroundColor: palette.socialHover },
          },
          dividerLine: { backgroundColor: palette.divider },
          dividerText: { color: palette.textSecondary },
          formFieldLabel: { color: palette.textSecondary },
          formFieldInput: {
            backgroundColor: palette.formInputBackground,
            border: palette.border,
            color: palette.text,
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
          footerActionText: { color: palette.textSecondary },
          identityPreviewEditButton: { color: '#818cf8' },
          formFieldAction: { color: '#818cf8' },
          otpCodeFieldInput: {
            backgroundColor: palette.formInputBackground,
            border: palette.border,
            color: palette.text,
          },
          footer: {
            '& + div': { color: palette.textSecondary },
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

const LEGAL_PATHS = ['/privacy', '/terms', '/data-deletion'];

/** Lifted out of App so the provider/layout JSX stays under the depth limit.
 *  Identical routes — pure extraction, no behavior change. */
function AppRoutes() {
  return (
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
                        <Route path="account" element={<AccountInformationSettings />} />
                        <Route path="notifications" element={<NotificationSettings />} />
                        <Route path="appearance" element={<AppearanceSettings />} />
                        <Route path="widget" element={<WidgetBrandSettings />} />
                        <Route path="integrations" element={<IntegrationTab />} />
                        <Route path="channels" element={<SocialChannelsContent />} />
                        <Route path="capabilities" element={<CapabilitiesSettings />} />
                        <Route path="features" element={<FeaturesSettings />} />
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
                      <Route path="/admin/legal-invoices" element={<AdminLegalInvoices />} />
                      <Route path="/admin/users" element={<AdminUsers />} />
                      <Route path="/admin/analytics" element={<AdminAnalytics />} />
                      <Route path="/admin/guardrails" element={<AdminGuardrails />} />
                      <Route path="/admin/guardrails/:conversationId" element={<AdminGuardrailConversation />} />
                      <Route path="/admin/faq" element={<AdminFaqEditor />} />
                      <Route path="/admin/studio" element={<AdminStudio />} />
                      <Route path="/admin/bot-templates" element={<Navigate to="/admin/studio?tab=templates" replace />} />
                      <Route path="/admin/bot-templates/:id" element={<AdminBotTemplateDetail />} />
                      <Route path="/admin/modules" element={<Navigate to="/admin/studio?tab=skills" replace />} />
                      <Route path="/admin/modules/:id" element={<Navigate to="/admin/studio?tab=skills" replace />} />
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
  );
}

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

  // Public legal pages — must be reachable logged-out (Meta's crawler reads them)
  if (LEGAL_PATHS.includes(window.location.pathname)) {
    return (
      <ThemeProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/privacy" element={<PrivacyPolicy />} />
            <Route path="/terms" element={<Terms />} />
            <Route path="/data-deletion" element={<DataDeletion />} />
          </Routes>
        </BrowserRouter>
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
              forceRedirectUrl={afterAuthRedirectPath(window.location)}
              signUpForceRedirectUrl={afterAuthRedirectPath(window.location)}
              fallbackRedirectUrl="/"
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
                  <SetupGate>
                    <AppRoutes />
                  </SetupGate>
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
