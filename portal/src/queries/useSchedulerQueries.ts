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

export type BookingMode = 'auto' | 'request';
export type DurationMode = 'fixed' | 'range' | 'ai';
export type PriceDisplayType = 'none' | 'fixed' | 'from' | 'range' | 'on_request';

export type IntakeQuestionType = 'text' | 'choice';
export interface IntakeQuestion {
  /** Server-minted; echo it back on save so historical answer labels stay stable. */
  id?: string;
  label: string;
  type: IntakeQuestionType;
  required: boolean;
  options?: string[];
}

export interface Service {
  id: string;
  name: string;
  category?: string | null;
  description?: string | null;
  bookingMode: BookingMode;
  onlineBookable: boolean;
  durationMode: DurationMode;
  durationMin: number;
  minDurationMin?: number | null;
  maxDurationMin?: number | null;
  bufferBeforeMin: number;
  bufferAfterMin: number;
  minNoticeMin: number;
  maxHorizonDays: number;
  maxBookingsPerDay?: number | null;
  priceDisplayType: PriceDisplayType;
  fixedPrice?: number | null;
  minPrice?: number | null;
  maxPrice?: number | null;
  priceNote?: string | null;
  locationType: string;
  preparationInstructions?: string | null;
  customerAddressRequired?: boolean;
  customerLocationRequired?: boolean;
  fileUploadAllowed?: boolean;
  intakeQuestions?: IntakeQuestion[] | null;
  sortOrder: number;
  isActive: boolean;
}

/** Create/update payload — required name+duration, everything else optional (server defaults). */
export type ServiceInput = Partial<Omit<Service, 'id' | 'sortOrder'>> & { name: string; durationMin: number };

export interface SchedulerConfig {
  provider: 'calcom' | 'internal';
  eventType: SchedulerEventType | null;
  services?: Service[];
  availability: SchedulerAvailability | null;
}

export interface UpdateSchedulerPayload {
  provider?: 'calcom' | 'internal';
  eventType?: Omit<SchedulerEventType, 'id'>;
  availability?: Omit<SchedulerAvailability, 'id'>;
}

const schedulerKey = ['scheduler', 'config'] as const;

export function useSchedulerConfig(enabled = true) {
  return useQuery({
    queryKey: schedulerKey,
    queryFn: async () => (await api.get<Any>('/scheduler/config')) as SchedulerConfig,
    // Locked tenants render a preview without firing the (now feature-gated)
    // endpoint — otherwise the mount fires a guaranteed 402 before the
    // LockedPreview early-return.
    enabled,
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

// --- Services catalog (multi-service) ---

const servicesKey = ['scheduler', 'services'] as const;

export function useServices(enabled = true) {
  return useQuery({
    queryKey: servicesKey,
    queryFn: async () => (await api.get<Any>('/scheduler/services')) as { services: Service[] },
    enabled,
  });
}

function invalidateServices(queryClient: ReturnType<typeof useQueryClient>) {
  queryClient.invalidateQueries({ queryKey: servicesKey });
  queryClient.invalidateQueries({ queryKey: schedulerKey });
}

export function useCreateService() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ServiceInput) => api.post<Service>('/scheduler/services', input),
    onSuccess: () => {
      invalidateServices(queryClient);
      toast.success('Service added');
    },
    onError: (err: Any) => toast.error(extractApiErrorMessage(err) ?? 'Failed to add service'),
  });
}

export function useUpdateService() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: Partial<ServiceInput> }) =>
      api.put<Service>(`/scheduler/services/${id}`, input),
    onSuccess: () => {
      invalidateServices(queryClient);
      toast.success('Service saved');
    },
    onError: (err: Any) => toast.error(extractApiErrorMessage(err) ?? 'Failed to save service'),
  });
}

export function useDeleteService() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/scheduler/services/${id}`),
    onSuccess: () => {
      invalidateServices(queryClient);
      toast.success('Service deleted');
    },
    onError: (err: Any) => toast.error(extractApiErrorMessage(err) ?? 'Failed to delete service'),
  });
}

// --- Business-type presets (P4) ---

export interface Preset {
  key: string;
  label: string;
  description: string;
  serviceCount: number;
}

export function usePresets(enabled: boolean) {
  return useQuery({
    queryKey: ['scheduler', 'presets'] as const,
    enabled,
    queryFn: async () => (await api.get<Any>('/scheduler/presets')) as { presets: Preset[] },
  });
}

export function useApplyPreset() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (key: string) => api.post<{ services: Service[] }>(`/scheduler/presets/${key}/apply`, {}),
    onSuccess: () => {
      invalidateServices(queryClient);
      toast.success('Services added from preset');
    },
    onError: (err: Any) => toast.error(extractApiErrorMessage(err) ?? 'Failed to apply preset'),
  });
}

// --- Admin bookings management ---

export type BookingScope = 'upcoming' | 'past' | 'requests';

export interface AdminBooking {
  id: string;
  startTime: string;
  endTime: string;
  status: string;
  attendeeName: string | null;
  attendeeEmail: string | null;
  notes: string | null;
  meetingUrl: string | null;
  serviceName?: string | null;
  serviceId?: string | null;
  durationMin?: number | null;
  bookingMode?: string | null;
  intakeAnswers?: Array<{ label: string; answer: string }> | null;
  customerAddress?: string | null;
  customerPhone?: string | null;
  uploadedFiles?: Array<{ fileSessionId: string; fileName: string }> | null;
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
export function useBookingAvailability(
  startDate: string,
  endDate: string,
  enabled: boolean,
  serviceId?: string | null,
  durationMin?: number | null,
) {
  return useQuery({
    queryKey: ['scheduler', 'availability', startDate, endDate, serviceId, durationMin],
    enabled,
    queryFn: async () => {
      const params = new URLSearchParams({ startDate, endDate });
      if (serviceId) params.set('serviceId', serviceId);
      if (durationMin) params.set('durationMin', String(durationMin));
      return (await api.get<Any>(`/scheduler/availability?${params.toString()}`)) as {
        slots: AvailabilitySlot[];
        timezone: string;
      };
    },
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

/** Accept a request_created lead → confirm it (creates the calendar event + email). */
export function useAcceptRequest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post(`/scheduler/bookings/${id}/accept`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: bookingsKey });
      toast.success('Request accepted — appointment confirmed');
    },
    onError: (err: Any) => {
      toast.error(extractApiErrorMessage(err) ?? 'Failed to accept request');
    },
  });
}

/** Decline a request_created lead → close it. */
export function useDeclineRequest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) =>
      api.post(`/scheduler/bookings/${id}/decline`, { reason }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: bookingsKey });
      toast.success('Request declined');
    },
    onError: (err: Any) => {
      toast.error(extractApiErrorMessage(err) ?? 'Failed to decline request');
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
