import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useAuth } from '@clerk/expo';
import { createApiClient, createEndpoints, type Endpoints } from '@axentrio/api-client';

import { env } from '@/lib/env';

const ApiContext = createContext<Endpoints | null>(null);

/** Builds the typed API client bound to the current Clerk session token. */
export function ApiProvider({ children }: { children: ReactNode }) {
  const { getToken } = useAuth();

  const endpoints = useMemo(() => {
    const client = createApiClient({
      baseURL: env.apiUrl,
      getToken: () => getToken(),
    });
    return createEndpoints(client);
  }, [getToken]);

  return <ApiContext.Provider value={endpoints}>{children}</ApiContext.Provider>;
}

export function useApi(): Endpoints {
  const ctx = useContext(ApiContext);
  if (!ctx) {
    throw new Error('useApi must be used within <ApiProvider>');
  }
  return ctx;
}
