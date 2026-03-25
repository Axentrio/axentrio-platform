/**
 * App Component
 * Main application with Clerk auth and routing
 */

import React, { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'react-hot-toast';
import { ClerkProvider, SignedIn, SignedOut, SignIn, useAuth } from '@clerk/clerk-react';

// Context Providers
import { SocketProvider } from '@websocket/SocketContext';

// Auth
import { OrganizationRequired } from '@auth/OrganizationRequired';
import { ProtectedRoute, AdminRoute, SupervisorRoute } from '@auth/ProtectedRoute';
import { setTokenProvider } from '@services/apiClient';

// Layout
import { Sidebar } from '@components/Sidebar';

// Pages
import Dashboard from '@pages/Dashboard';
import LiveMonitor from '@pages/LiveMonitor';
import ChatTakeover from '@pages/ChatTakeover';
import Queue from '@pages/Queue';
import Analytics from '@pages/Analytics';
import Tenants from '@pages/Tenants';
import Team from '@pages/Team';
import Settings from '@pages/Settings';

const CLERK_PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

// Create Query Client
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000,
      retry: 2,
    },
  },
});

// Wire Clerk token to API client
const TokenProviderSetup: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { getToken } = useAuth();
  useEffect(() => { setTokenProvider(getToken); }, [getToken]);
  return <>{children}</>;
};

// Layout wrapper for authenticated pages
const AuthenticatedLayout: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  return (
    <div className="h-screen flex overflow-hidden bg-surface-1">
      <div className="hidden md:flex w-64 flex-shrink-0">
        <Sidebar />
      </div>
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="md:hidden bg-surface-0 border-b border-edge px-4 py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 bg-primary-600 rounded-xl flex items-center justify-center">
                <span className="text-white font-bold">H</span>
              </div>
              <span className="font-bold text-text-primary">HandsOff</span>
            </div>
          </div>
        </div>
        <main className="flex-1 overflow-hidden">
          {children}
        </main>
      </div>
    </div>
  );
};

const App: React.FC = () => {
  return (
    <ClerkProvider publishableKey={CLERK_PUBLISHABLE_KEY}>
      <QueryClientProvider client={queryClient}>
        <SignedOut>
          <div className="flex items-center justify-center h-screen bg-surface-1">
            <SignIn
              appearance={{
                elements: {
                  rootBox: 'mx-auto',
                  card: 'bg-surface-2 border border-edge shadow-card',
                  headerTitle: 'text-text-primary',
                  headerSubtitle: 'text-text-secondary',
                  formButtonPrimary: 'bg-primary-600 hover:bg-primary-700',
                  footerActionLink: 'text-primary-400 hover:text-primary-300',
                },
              }}
            />
          </div>
        </SignedOut>

        <SignedIn>
          <TokenProviderSetup>
            <OrganizationRequired>
              <BrowserRouter>
                <Routes>
                  {/* Protected routes */}
                  <Route element={<ProtectedRoute />}>
                    <Route
                      path="/"
                      element={
                        <SocketProvider>
                          <AuthenticatedLayout>
                            <Dashboard />
                          </AuthenticatedLayout>
                        </SocketProvider>
                      }
                    />
                    <Route
                      path="/monitor"
                      element={
                        <SocketProvider>
                          <AuthenticatedLayout>
                            <LiveMonitor />
                          </AuthenticatedLayout>
                        </SocketProvider>
                      }
                    />
                    <Route
                      path="/takeover/:chatId"
                      element={
                        <SocketProvider>
                          <AuthenticatedLayout>
                            <ChatTakeover />
                          </AuthenticatedLayout>
                        </SocketProvider>
                      }
                    />
                    <Route
                      path="/queue"
                      element={
                        <SocketProvider>
                          <AuthenticatedLayout>
                            <Queue />
                          </AuthenticatedLayout>
                        </SocketProvider>
                      }
                    />
                    <Route
                      path="/settings"
                      element={
                        <AuthenticatedLayout>
                          <Settings />
                        </AuthenticatedLayout>
                      }
                    />
                  </Route>

                  {/* Supervisor/Admin routes */}
                  <Route element={<SupervisorRoute />}>
                    <Route
                      path="/analytics"
                      element={
                        <AuthenticatedLayout>
                          <Analytics />
                        </AuthenticatedLayout>
                      }
                    />
                    <Route
                      path="/team"
                      element={
                        <AuthenticatedLayout>
                          <Team />
                        </AuthenticatedLayout>
                      }
                    />
                  </Route>

                  {/* Admin only routes */}
                  <Route element={<AdminRoute />}>
                    <Route
                      path="/tenants"
                      element={
                        <AuthenticatedLayout>
                          <Tenants />
                        </AuthenticatedLayout>
                      }
                    />
                  </Route>

                  {/* Catch all */}
                  <Route path="*" element={<Navigate to="/" replace />} />
                </Routes>
              </BrowserRouter>
            </OrganizationRequired>
          </TokenProviderSetup>
        </SignedIn>

        <Toaster
          position="top-right"
          toastOptions={{
            duration: 5000,
            style: {
              background: '#1e2030',
              color: '#f1f3f9',
              border: '1px solid #2a2d3e',
            },
            success: {
              duration: 3000,
              iconTheme: {
                primary: '#34d399',
                secondary: '#f1f3f9',
              },
            },
            error: {
              duration: 5000,
              iconTheme: {
                primary: '#f87171',
                secondary: '#f1f3f9',
              },
            },
          }}
        />
      </QueryClientProvider>
    </ClerkProvider>
  );
};

export default App;
