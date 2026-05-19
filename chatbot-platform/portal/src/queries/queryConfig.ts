import { QueryClient, QueryCache, MutationCache } from '@tanstack/react-query';
import { AxiosError } from 'axios';
import { toast } from 'sonner';

function extractErrorMessage(error: unknown): string {
  if (error instanceof AxiosError) {
    const data = error.response?.data;
    if (data?.error?.message) return data.error.message;
    if (typeof data?.error === 'string') return data.error;
    return error.message;
  }
  return error instanceof Error ? error.message : 'An unexpected error occurred';
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    mutationCache: new MutationCache({
      onError: (error, _variables, _context, mutation) => {
        // 402 plan-limit responses are surfaced by the apiClient axios
        // interceptor as a friendly toast with an "Upgrade" deep-link.
        // Don't double-toast the raw `plan_limit_*` code from the
        // mutation's reject path.
        if (error instanceof AxiosError && error.response?.status === 402) {
          return;
        }
        // Only toast if the mutation didn't define its own onError
        if (!mutation.options.onError) {
          toast.error(extractErrorMessage(error));
        }
      },
    }),
    queryCache: new QueryCache({
      onError: (error, query) => {
        // Same dedupe for query-side 402s (entitlement-gated GETs).
        if (error instanceof AxiosError && error.response?.status === 402) {
          return;
        }
        if (query.state.data !== undefined) {
          toast.error(`Update failed: ${extractErrorMessage(error)}`);
        }
      },
    }),
    defaultOptions: {
      queries: {
        staleTime: 30 * 1000,
        gcTime: 5 * 60 * 1000,
        retry: 2,
      },
    },
  });
}
