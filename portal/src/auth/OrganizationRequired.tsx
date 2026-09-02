import React from 'react';
import { useOrganization } from '@clerk/clerk-react';
import SetupWizard from '@/pages/setup/SetupWizard';

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
    return <SetupWizard />;
  }

  return <>{children}</>;
};
