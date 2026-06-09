import { useQuery } from '@tanstack/react-query';
import { queryKeys, type ListBookingsParams } from '@axentrio/api-client';

import { useApi } from '@/providers/api-provider';

export function useBookings(params?: ListBookingsParams) {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.bookings(params),
    queryFn: () => api.listBookings(params),
  });
}
