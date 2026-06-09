import AsyncStorage from '@react-native-async-storage/async-storage';
import { ClerkProvider } from '@clerk/expo';
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import type { ReactNode } from 'react';

import '@/lib/online'; // wires NetInfo -> onlineManager (side effect)
import { env } from '@/lib/env';
import { queryClient } from '@/lib/query-client';
import { tokenCache } from '@/lib/token-cache';
import { ApiProvider } from '@/providers/api-provider';

const persister = createAsyncStoragePersister({ storage: AsyncStorage });

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <ClerkProvider publishableKey={env.clerkPublishableKey} tokenCache={tokenCache}>
      <PersistQueryClientProvider client={queryClient} persistOptions={{ persister }}>
        <ApiProvider>{children}</ApiProvider>
      </PersistQueryClientProvider>
    </ClerkProvider>
  );
}
