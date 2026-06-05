import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, extractApiErrorMessage } from '../services/apiClient';
import { toast } from 'sonner';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

export interface TimeWindow {
  start: string;
  end: string;
}

export type WeeklyHours = Record<string, TimeWindow[]>;

export interface SchedulerEventType {
  id?: string;
  name: string;
  durationMin: number;
  bufferBeforeMin: number;
  bufferAfterMin: number;
  minNoticeMin: number;
  maxHorizonDays: number;
  locationType: string;
}

export interface SchedulerAvailability {
  id?: string;
  timezone: string;
  weeklyHours: WeeklyHours;
  dateOverrides: unknown[];
  slotGranularityMin: number;
}

export interface SchedulerConfig {
  provider: 'calcom' | 'internal';
  eventType: SchedulerEventType | null;
  availability: SchedulerAvailability | null;
}

export interface UpdateSchedulerPayload {
  provider?: 'calcom' | 'internal';
  eventType?: Omit<SchedulerEventType, 'id'>;
  availability?: Omit<SchedulerAvailability, 'id'>;
}

const schedulerKey = ['scheduler', 'config'] as const;

export function useSchedulerConfig() {
  return useQuery({
    queryKey: schedulerKey,
    queryFn: async () => (await api.get<Any>('/scheduler/config')) as SchedulerConfig,
  });
}

export function useUpdateSchedulerConfig() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: UpdateSchedulerPayload) => api.put<SchedulerConfig>('/scheduler/config', payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: schedulerKey });
      toast.success('Booking settings saved');
    },
    onError: (err: Any) => {
      toast.error(
        extractApiErrorMessage(err) ?? (err instanceof Error ? err.message : undefined) ?? 'Failed to save'
      );
    },
  });
}
