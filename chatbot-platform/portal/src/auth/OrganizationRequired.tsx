import React from 'react';
import { useOrganization, OrganizationList } from '@clerk/clerk-react';

export const OrganizationRequired: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { organization, isLoaded } = useOrganization();

  if (!isLoaded) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-text-secondary">Loading...</div>
      </div>
    );
  }

  if (isLoaded && (organization?.publicMetadata as Record<string, unknown>)?.suspended) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center max-w-md p-8">
          <h1 className="text-2xl font-bold text-text-primary mb-4">Organization Suspended</h1>
          <p className="text-text-secondary">
            Your organization has been suspended. Please contact support for assistance.
          </p>
        </div>
      </div>
    );
  }

  if (!organization) {
    return (
      <div className="h-full flex flex-col items-center justify-center">
        <h2 className="text-xl font-semibold text-text-primary mb-6">Select an Organization</h2>
        <OrganizationList
          appearance={{
            elements: {
              rootBox: 'mx-auto',
              card: 'bg-surface-2 border border-edge shadow-card',
              headerTitle: 'text-text-primary',
            },
          }}
        />
      </div>
    );
  }

  return <>{children}</>;
};
