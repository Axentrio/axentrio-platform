import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/services/apiClient';
import { queryKeys } from '@/queries/queryKeys';

export type WidgetAppearance = {
  primaryColor: string | null;
  avatarUrl: string | null;
  launcherPosition: 'bottom-right' | 'bottom-left';
  launcherLabel: string | null;
};

export type UpdateWidgetAppearancePayload = Partial<WidgetAppearance>;

const widgetAppearanceKey = [...queryKeys.tenants.me(), 'widget-appearance'] as const;

export function useGetWidgetAppearance(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: widgetAppearanceKey,
    queryFn: () => api.get<WidgetAppearance>('/tenants/me/widget-appearance'),
    enabled: options?.enabled ?? true,
  });
}

export function useUpdateWidgetAppearance() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: UpdateWidgetAppearancePayload) =>
      api.patch<WidgetAppearance>('/tenants/me/widget-appearance', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tenants.me() });
      queryClient.invalidateQueries({ queryKey: widgetAppearanceKey });
      toast.success('Appearance saved');
    },
    onError: () => toast.error('Failed to save appearance'),
  });
}
