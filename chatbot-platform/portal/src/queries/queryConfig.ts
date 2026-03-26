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
    queryCache: new QueryCache({
      onError: (error, query) => {
        // Only toast on background refetch failures (not first loads)
        if (query.state.data !== undefined) {
          toast.error(`Update failed: ${extractErrorMessage(error)}`);
        }
      },
    }),
    mutationCache: new MutationCache({
      onError: (error, _variables, _context, mutation) => {
        // Only toast if the mutation didn't define its own onError
        if (!mutation.options.onError) {
          toast.error(extractErrorMessage(error));
        }
      },
    }),
    defaultOptions: {
      queries: {
        staleTime: 5 * 60 * 1000,
        gcTime: 10 * 60 * 1000,
        retry: 2,
      },
    },
  });
}
