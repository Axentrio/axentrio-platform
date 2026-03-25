/**
 * Protected Route Component
 * Guards routes based on authentication and role requirements
 */

import React from 'react';
import { Navigate, Outlet } from 'react-router-dom';
import { useAppAuth } from './useAppAuth';
import type { UserRole } from '@app-types/index';

interface ProtectedRouteProps {
  children?: React.ReactNode;
  requiredRoles?: UserRole[];
  requiredPermission?: string;
  fallback?: React.ReactNode;
}

export const ProtectedRoute: React.FC<ProtectedRouteProps> = ({
  children,
  requiredRoles,
  requiredPermission,
  fallback,
}) => {
  const { isAuthenticated, user, hasPermission, isLoading } = useAppAuth();

  // Show loading state
  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="flex flex-col items-center space-y-4">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600"></div>
          <p className="text-gray-600">Loading...</p>
        </div>
      </div>
    );
  }

  // Not authenticated — Clerk handles this at the App level, but just in case
  if (!isAuthenticated) {
    return <Navigate to="/" replace />;
  }

  // Check role requirements
  if (requiredRoles && requiredRoles.length > 0) {
    const hasRequiredRole = requiredRoles.some((role) => user?.role === role);
    if (!hasRequiredRole) {
      return fallback ? (
        <>{fallback}</>
      ) : (
        <div className="min-h-screen flex items-center justify-center bg-gray-50">
          <div className="text-center">
            <h1 className="text-2xl font-bold text-gray-900 mb-2">Access Denied</h1>
            <p className="text-gray-600 mb-4">
              You don't have permission to access this page.
            </p>
            <button
              onClick={() => window.history.back()}
              className="text-primary-600 hover:text-primary-700 font-medium"
            >
              Go Back
            </button>
          </div>
        </div>
      );
    }
  }

  // Check permission requirements
  if (requiredPermission && !hasPermission(requiredPermission)) {
    return fallback ? (
      <>{fallback}</>
    ) : (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-gray-900 mb-2">Access Denied</h1>
          <p className="text-gray-600 mb-4">
            You don't have the required permission to access this page.
          </p>
          <button
            onClick={() => window.history.back()}
            className="text-primary-600 hover:text-primary-700 font-medium"
          >
            Go Back
          </button>
        </div>
      </div>
    );
  }

  // Render children or outlet
  return children ? <>{children}</> : <Outlet />;
};

// Role-specific route wrappers
export const AdminRoute: React.FC<{ children?: React.ReactNode }> = ({ children }) => (
  <ProtectedRoute requiredRoles={['admin']}>{children}</ProtectedRoute>
);

export const SupervisorRoute: React.FC<{ children?: React.ReactNode }> = ({ children }) => (
  <ProtectedRoute requiredRoles={['admin', 'supervisor']}>{children}</ProtectedRoute>
);

export const AgentRoute: React.FC<{ children?: React.ReactNode }> = ({ children }) => (
  <ProtectedRoute requiredRoles={['admin', 'supervisor', 'agent']}>{children}</ProtectedRoute>
);

export default ProtectedRoute;
