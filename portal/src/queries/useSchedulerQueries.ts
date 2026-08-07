import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, extractApiErrorMessage } from '../services/apiClient';
import { toast } from 'sonner';
import type { ServiceAreaEntry } from '@contracts/service-area';

export type { ServiceAreaEntry };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

export interface TimeWindow {
  start: string;
  end: string;
}

/**
 * The API's weekday keys, exactly. This was `Record<string, TimeWindow[]>`, which is why
 * the compiler happily let the setup wizard send `monday` while the settings page sent
 * `mon` — the API enum only accepts the short form, so the wizard's save 422'd every time
 * and the step could never be completed. Keep this narrow.
 */
export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
export type WeeklyHours = Partial<Record<Weekday, TimeWindow[]>>;

export interface SchedulerEventType {
  id?: string;
  name: string;
  durationMin: number;
  bufferBeforeMin: number | null;
  bufferAfterMin: number | null;
  minNoticeMin: number | null;
  maxHorizonDays: number | null;
  locationType: string;
}

export type AvailabilityMode = 'always_open' | 'business_hours';

export interface SchedulerAvailability {
  id?: string;
  timezone: string;
  availabilityMode?: AvailabilityMode;
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
  /** Owner's steer on HOW or WHEN to ask. Rides into the prompt on this question's line. */
  aiInstruction?: string;
  /** A sample answer, so the model recognises a good one. */
  exampleAnswer?: string;
  /** Absent = true. A paused question keeps its id, so answers already collected still
   *  render under their label instead of orphaning to a uuid. */
  active?: boolean;
  /** Absent = true. Off for answers that are useful to the bot but noise on a calendar. */
  includeInCalendar?: boolean;
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
  /** null = inherit from the business defaults (then the platform fallback). */
  bufferBeforeMin: number | null;
  bufferAfterMin: number | null;
  minNoticeMin: number | null;
  maxHorizonDays: number | null;
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

/**
 * Business-level ceilings. `null` means unlimited on every field — and on the write path
 * `null` CLEARS a rule while omitting the key leaves it untouched, so always send the whole
 * object from an editor that shows all three.
 */
export interface BookingRules {
  maxBookingsPerDay: number | null;
  maxBookedMinutesPerDay: number | null;
  minGapMin: number | null;
  /** DEFAULTS, not ceilings — used only where a service leaves the field null. */
  defaultBufferBeforeMin: number | null;
  defaultBufferAfterMin: number | null;
  defaultMinNoticeMin: number | null;
  defaultMaxHorizonDays: number | null;
}

/**
 * Where customers come TO. Deliberately NOT the VAT/legal address captured at onboarding —
 * that one is often the owner's home, and putting it on invites by default is precisely
 * what GDPR Art. 25(2) prohibits. Empty until the owner types one in.
 */
export interface VenueAddress {
  street: string | null;
  postalCode: string | null;
  city: string | null;
  /** ISO 3166-1 alpha-2. */
  country: string | null;
}

export interface SchedulerConfig {
  provider: 'calcom' | 'internal';
  eventType: SchedulerEventType | null;
  services?: Service[];
  availability: SchedulerAvailability | null;
  /** Places the business travels to. Always an array — [] means none configured. */
  serviceArea?: ServiceAreaEntry[];
  bookingRules?: BookingRules;
  venueAddress?: VenueAddress;
  /**
   * Which Agent these settings belong to.
   *
   * Always the tenant's DEFAULT Agent today, because that is the only one the settings
   * endpoint can write (#86). Named rather than assumed, so an owner with several Agents can
   * see which one they are editing — and so #86 extends this shape instead of replacing it.
   */
  agent?: { id: string; name: string };
  travel?: {
    enabled: boolean;
    slackMin: number | null;
    startFromBase: boolean;
    /**
     * Why the switch cannot be turned on, or null when it can. The API refuses each of these
     * on write too; this is what lets the screen say so BEFORE the owner tries.
     */
    blockedReason: 'no_maps_key' | 'not_entitled' | 'shared_itinerary' | null;
  };
  /** Owner has switched new online bookings off. Captures requests rather than refusing. */
  bookingsPaused?: boolean;
}

export interface UpdateSchedulerPayload {
  provider?: 'calcom' | 'internal';
  eventType?: Omit<SchedulerEventType, 'id'>;
  availability?: Omit<SchedulerAvailability, 'id'>;
  /** [] is a real value here — it clears the area — so never drop an empty array. */
  serviceArea?: ServiceAreaEntry[];
  bookingRules?: Partial<BookingRules>;
  /** `null` clears the whole venue; omitting the key leaves it untouched. */
  venueAddress?: Partial<VenueAddress> | null;
  travel?: { enabled?: boolean; slackMin?: number | null; startFromBase?: boolean };
  bookingsPaused?: boolean;
}

const schedulerKey = ['scheduler', 'config', 'default-agent'] as const;

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

/**
 * Reorder the whole catalog in one call.
 *
 * The full ordered id list, not a move-this-one instruction: reordering renumbers several
 * rows, and N separate PUTs can half-apply and leave the catalog in an order nobody chose.
 */
export function useReorderServices() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (serviceIds: string[]) => api.put<SchedulerConfig>('/scheduler/services/reorder', { serviceIds }),
    onSuccess: () => invalidateServices(queryClient),
    onError: (err: Any) => toast.error(extractApiErrorMessage(err) ?? 'Failed to reorder services'),
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
  /** What the service-area gate saw. Null = it did not apply to this booking. */
  serviceAreaMatch?: 'inside' | 'outside' | 'unknown' | null;
  /**
   * What the travel gate DID. Null = it did not apply, which is every booking today.
   *
   * `ok` and `degraded` are both successful checks and are deliberately NOT rendered: the
   * first is unremarkable, and the second is provenance rather than a fault — it is the
   * ordinary state of a business whose jobs sit close together, so labelling it would
   * flag most of a good day. Only `captured` and `overridden` reach the owner.
   */
  travelCheck?: 'ok' | 'degraded' | 'captured' | 'overridden' | null;
  /**
   * Requests only: how far this sits from the jobs either side, from DISTANCE alone.
   *
   * Rides down with the list rather than being fetched per row. Null whenever there is nothing
   * honest to say — travel off, no usable position, neither neighbour placed — and "not known"
   * is what the owner should read then, never a fabricated number.
   */
  travelEstimate?: {
    before: { km: number; fastestMin: number; slowestMin: number } | null;
    after: { km: number; fastestMin: number; slowestMin: number } | null;
    basis: 'distance';
  } | null;
  customerPhone?: string | null;
  uploadedFiles?: Array<{ fileSessionId: string; fileName: string }> | null;
  /** Whether the booking actually reached the owner's connected calendar. */
  calendarSync?: 'synced' | 'pending' | 'failed' | 'none';
  sourceChannel?: string | null;
  aiSummary?: string | null;
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
  /** Reschedule picker: the booking being moved, so it isn't counted against itself. */
  excludeBookingId?: string | null,
) {
  return useQuery({
    queryKey: ['scheduler', 'availability', startDate, endDate, serviceId, durationMin, excludeBookingId],
    enabled,
    queryFn: async () => {
      const params = new URLSearchParams({ startDate, endDate });
      if (serviceId) params.set('serviceId', serviceId);
      if (durationMin) params.set('durationMin', String(durationMin));
      if (excludeBookingId) params.set('excludeBookingId', excludeBookingId);
      return (await api.get<Any>(`/scheduler/availability?${params.toString()}`)) as {
        slots: AvailabilitySlot[];
        timezone: string;
        /**
         * What travel time made of these slots — present only for a business using it.
         *
         * THE OWNER'S PICKER IS NEVER FILTERED. Feasibility is a hard constraint against the
         * bot and never against the person who owns the diary, so `slots` here holds the whole
         * day and this says which of those the owner should think twice about. Dropping it at
         * this cast is how the picker came to show an unreachable time as an ordinary one.
         */
        travel?: {
          /** Reachable only if the drive is short enough, and nothing has measured it. */
          requestableSlots: AvailabilitySlot[];
          /** Proven impossible from the jobs either side. */
          unreachableSlots: AvailabilitySlot[];
          /** The address placed only to a town centre, so nothing here could be cleared. */
          addressTooVague?: true;
          /** The check could not run at all — so NONE of these times were assessed. */
          unavailableReason?: 'no_address' | 'not_placeable' | 'lookup_unavailable';
        };
      };
    },
  });
}

export function useCancelBooking() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) =>
      api.post<{ travelWarning?: string }>(`/scheduler/bookings/${id}/cancel`, { reason }),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: bookingsKey });
      toast.success('Booking cancelled');
      // WHAT THE CANCELLATION LEFT BEHIND. The next appointment that day now starts from the
      // business address, and its journey does not clear. A separate, longer-lived toast
      // rather than a line inside the success one: it is a different fact about a different
      // booking, and it asks the owner to go and look at something.
      // ATTRIBUTED IN THE TOAST ITSELF. The warning is a verdict derived from coordinates
      // Google placed, and a toast is its own visual container — an attribution rendered on the
      // page behind it does not cover content floating above it. As a description rather than
      // appended to the sentence, so the warning still reads as one instruction.
      if (result?.travelWarning) {
        toast.warning(result.travelWarning, { description: 'Powered by Google', duration: 10000 });
      }
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
      api.post<{ travelWarning?: string }>(`/scheduler/bookings/${id}/reschedule`, { newStartTime }),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: bookingsKey });
      toast.success('Booking rescheduled');
      // The owner was ALLOWED to make this move — feasibility is never enforced against the
      // person who owns the diary — so this is the other half of that permission. Allowing
      // silently would be the same defect as annotating a slot list without marking it.
      // ATTRIBUTED IN THE TOAST ITSELF. The warning is a verdict derived from coordinates
      // Google placed, and a toast is its own visual container — an attribution rendered on the
      // page behind it does not cover content floating above it. As a description rather than
      // appended to the sentence, so the warning still reads as one instruction.
      if (result?.travelWarning) {
        toast.warning(result.travelWarning, { description: 'Powered by Google', duration: 10000 });
      }
    },
    onError: (err: Any) => {
      toast.error(extractApiErrorMessage(err) ?? 'Failed to reschedule booking');
    },
  });
}
