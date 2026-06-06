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

// --- Admin bookings management ---

export type BookingScope = 'upcoming' | 'past';

export interface AdminBooking {
  id: string;
  startTime: string;
  endTime: string;
  status: string;
  attendeeName: string | null;
  attendeeEmail: string | null;
  notes: string | null;
  meetingUrl: string | null;
}

export interface AvailabilitySlot {
  start: string;
  end: string;
}

const bookingsKey = ['scheduler', 'bookings'] as const;

export function useAdminBookings(scope: BookingScope) {
  return useQuery({
    queryKey: [...bookingsKey, scope],
    queryFn: async () =>
      (await api.get<Any>(`/scheduler/bookings?scope=${scope}`)) as { bookings: AdminBooking[]; total: number },
  });
}

/** Available slots between two ISO datetimes — drives the reschedule picker. */
export function useBookingAvailability(startDate: string, endDate: string, enabled: boolean) {
  return useQuery({
    queryKey: ['scheduler', 'availability', startDate, endDate],
    enabled,
    queryFn: async () =>
      (await api.get<Any>(
        `/scheduler/availability?startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}`
      )) as { slots: AvailabilitySlot[]; timezone: string },
  });
}

export function useCancelBooking() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) =>
      api.post(`/scheduler/bookings/${id}/cancel`, { reason }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: bookingsKey });
      toast.success('Booking cancelled');
    },
    onError: (err: Any) => {
      toast.error(extractApiErrorMessage(err) ?? 'Failed to cancel booking');
    },
  });
}

export function useRescheduleBooking() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, newStartTime }: { id: string; newStartTime: string }) =>
      api.post(`/scheduler/bookings/${id}/reschedule`, { newStartTime }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: bookingsKey });
      toast.success('Booking rescheduled');
    },
    onError: (err: Any) => {
      toast.error(extractApiErrorMessage(err) ?? 'Failed to reschedule booking');
    },
  });
}
