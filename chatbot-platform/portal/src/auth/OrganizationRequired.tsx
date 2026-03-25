import React from 'react';
import { useOrganization, OrganizationList } from '@clerk/clerk-react';

export const OrganizationRequired: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { organization, isLoaded } = useOrganization();

  if (!isLoaded) {
    return (
      <div className="flex items-center justify-center h-screen bg-surface-1">
        <div className="text-text-secondary">Loading...</div>
      </div>
    );
  }

  if (!organization) {
    return (
      <div className="flex flex-col items-center justify-center h-screen bg-surface-1">
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
