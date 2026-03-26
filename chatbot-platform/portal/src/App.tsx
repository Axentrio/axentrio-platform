/**
 * App Component
 * Main application with Clerk auth and routing
 */

import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from './queries/queryConfig';
import { Toaster } from '@/components/ui/sonner';
import { ClerkProvider, SignedIn, SignedOut, SignIn } from '@clerk/clerk-react';

// Context Providers
import { SocketProvider } from '@websocket/SocketContext';

// Auth
import { OrganizationRequired } from '@auth/OrganizationRequired';
import { AppAuthProvider } from '@auth/AppAuthProvider';
import { ProtectedRoute, AdminRoute, SupervisorRoute, SuperAdminRoute } from '@auth/ProtectedRoute';

// Layout
import { Sidebar } from '@components/Sidebar';
import { TenantContextSwitcher } from '@components/admin/TenantContextSwitcher';
import { useTenantTheme } from '@/hooks/useTenantTheme';
import { useOrganization } from '@clerk/clerk-react';

// Pages
import Dashboard from '@pages/Dashboard';
import LiveMonitor from '@pages/LiveMonitor';
import ChatTakeover from '@pages/ChatTakeover';
import Queue from '@pages/Queue';
import Analytics from '@pages/Analytics';
import Tenants from '@pages/Tenants';
import Team from '@pages/Team';
import Settings from '@pages/Settings';
import WidgetTest from '@pages/WidgetTest';
import AdminTenants from '@pages/admin/AdminTenants';
import AdminUsers from '@pages/admin/AdminUsers';
import AdminAnalytics from '@pages/admin/AdminAnalytics';
import AdminTenantDetail from '@pages/admin/AdminTenantDetail';

const CLERK_PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

// Create Query Client
const queryClient = createQueryClient();

// Layout wrapper for authenticated pages
const AuthenticatedLayout: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  useTenantTheme();
  const { organization } = useOrganization();

  return (
    <div className="h-screen flex overflow-hidden bg-surface-1">
      <div className="hidden md:flex w-64 flex-shrink-0">
        <Sidebar />
      </div>
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="bg-surface-0 border-b border-edge px-4 py-2 flex items-center justify-between">
          <div className="flex items-center gap-2 md:hidden">
            {organization?.imageUrl ? (
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
              {organization?.name ?? 'HandsOff'}
            </span>
          </div>
          <div className="hidden md:block" />
          <TenantContextSwitcher />
        </div>
        <main className="flex-1 overflow-hidden">
          {children}
        </main>
      </div>
    </div>
  );
};

// Widget test page — renders outside Clerk auth entirely
const WidgetTestRouter: React.FC = () => {
  if (window.location.pathname !== '/widget-test') return null;
  return <WidgetTest />;
};

const App: React.FC = () => {
  // If on widget-test path, render only the widget test page (no Clerk)
  if (window.location.pathname === '/widget-test') {
    return (
      <QueryClientProvider client={queryClient}>
        <WidgetTestRouter />
        <Toaster />
      </QueryClientProvider>
    );
  }

  return (
    <ClerkProvider
      publishableKey={CLERK_PUBLISHABLE_KEY}
      appearance={{
        variables: {
          colorBackground: '#161821',
          colorInputBackground: '#1e2030',
          colorText: '#f1f3f9',
          colorTextSecondary: '#9ca3bf',
          colorPrimary: '#6366f1',
          colorInputText: '#f1f3f9',
          colorDanger: '#f87171',
          colorSuccess: '#34d399',
          colorNeutral: '#9ca3bf',
          borderRadius: '0.75rem',
          fontFamily: "'Plus Jakarta Sans', sans-serif",
        },
        elements: {
          card: {
            backgroundColor: '#161821',
            border: '1px solid #2a2d3e',
            boxShadow: '0 25px 50px -12px rgba(0,0,0,0.5)',
          },
          headerTitle: { color: '#f1f3f9' },
          headerSubtitle: { color: '#9ca3bf' },
          socialButtonsBlockButton: {
            backgroundColor: '#1e2030',
            border: '1px solid #2a2d3e',
            color: '#f1f3f9',
            '&:hover': { backgroundColor: '#262940' },
          },
          dividerLine: { backgroundColor: '#2a2d3e' },
          dividerText: { color: '#9ca3bf' },
          formFieldLabel: { color: '#9ca3bf' },
          formFieldInput: {
            backgroundColor: '#1e2030',
            border: '1px solid #2a2d3e',
            color: '#f1f3f9',
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
          footerActionText: { color: '#9ca3bf' },
          identityPreviewEditButton: { color: '#818cf8' },
          formFieldAction: { color: '#818cf8' },
          otpCodeFieldInput: {
            backgroundColor: '#1e2030',
            border: '1px solid #2a2d3e',
            color: '#f1f3f9',
          },
          footer: {
            '& + div': { color: '#9ca3bf' },
          },
        },
      }}
    >
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
              <AuthenticatedLayout>
                <OrganizationRequired>
                  <Routes>
                    {/* Protected routes */}
                    <Route element={<ProtectedRoute />}>
                      <Route
                        path="/"
                        element={
                          <SocketProvider>
                            <Dashboard />
                          </SocketProvider>
                        }
                      />
                      <Route
                        path="/monitor"
                        element={
                          <SocketProvider>
                            <LiveMonitor />
                          </SocketProvider>
                        }
                      />
                      <Route
                        path="/takeover/:chatId"
                        element={
                          <SocketProvider>
                            <ChatTakeover />
                          </SocketProvider>
                        }
                      />
                      <Route
                        path="/queue"
                        element={
                          <SocketProvider>
                            <Queue />
                          </SocketProvider>
                        }
                      />
                      <Route path="/settings" element={<Settings />} />
                    </Route>

                    {/* Supervisor/Admin routes */}
                    <Route element={<SupervisorRoute />}>
                      <Route path="/analytics" element={<Analytics />} />
                      <Route path="/team" element={<Team />} />
                    </Route>

                    {/* Admin only routes */}
                    <Route element={<AdminRoute />}>
                      <Route path="/tenants" element={<Tenants />} />
                    </Route>

                    {/* Super Admin routes */}
                    <Route element={<SuperAdminRoute />}>
                      <Route path="/admin/tenants" element={<AdminTenants />} />
                      <Route path="/admin/tenants/:id" element={<AdminTenantDetail />} />
                      <Route path="/admin/users" element={<AdminUsers />} />
                      <Route path="/admin/analytics" element={<AdminAnalytics />} />
                    </Route>

                    {/* Catch all */}
                    <Route path="*" element={<Navigate to="/" replace />} />
                  </Routes>
                </OrganizationRequired>
              </AuthenticatedLayout>
            </BrowserRouter>
          </AppAuthProvider>
        </SignedIn>

        <Toaster />
      </QueryClientProvider>
    </ClerkProvider>
  );
};

export default App;
