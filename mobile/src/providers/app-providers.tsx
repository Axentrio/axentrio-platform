import { ClerkProvider } from '@clerk/expo';
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { env } from '@/lib/env';
import { queryClient } from '@/lib/query-client';
import { tokenCache } from '@/lib/token-cache';
import { ApiProvider } from '@/providers/api-provider';

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <ClerkProvider publishableKey={env.clerkPublishableKey} tokenCache={tokenCache}>
      <QueryClientProvider client={queryClient}>
        <ApiProvider>{children}</ApiProvider>
      </QueryClientProvider>
    </ClerkProvider>
  );
}
