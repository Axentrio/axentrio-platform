import type { AxiosInstance } from 'axios';
import type {
  ApiSuccess,
  AuthMe,
  Booking,
  BookingStatus,
  Conversation,
  Lead,
  LeadsPage,
  AppNotification,
  Pagination,
  SessionStatus,
  SessionSummary,
} from '@axentrio/contracts';

export interface ListSessionsParams {
  status?: SessionStatus;
  page?: number;
  limit?: number;
  sortBy?: string;
}

export interface ListBookingsParams {
  status?: BookingStatus;
  page?: number;
  limit?: number;
}

export interface ListNotificationsParams {
  unread?: boolean;
  page?: number;
  limit?: number;
}

export interface ListLeadsParams {
  cursor?: string;
  limit?: number;
}

export interface Paged<T> {
  items: T[];
  pagination?: Pagination;
}

/**
 * Typed endpoint functions over a configured axios instance. Each reads the
 * `{ data, meta }` envelope; errors are already normalized to ApiError by the
 * client's response interceptor.
 */
export function createEndpoints(client: AxiosInstance) {
  const data = <T>(p: Promise<{ data: ApiSuccess<T> }>) => p.then((r) => r.data.data);

  return {
    // --- auth / identity ---
    authMe: () => data(client.get<ApiSuccess<AuthMe>>('/auth/me')),
    // --- chats / inbox ---
    listSessions: async (params?: ListSessionsParams): Promise<Paged<SessionSummary>> => {
      const res = await client.get<ApiSuccess<SessionSummary[]>>('/chats/sessions', { params });
      return { items: res.data.data, pagination: res.data.meta?.pagination };
    },
    getConversation: (id: string) =>
      data(client.get<ApiSuccess<Conversation>>(`/chats/${id}`)),
    closeConversation: (id: string) =>
      data(client.post<ApiSuccess<unknown>>(`/chats/${id}/close`, {})),

    // --- handoffs ---
    acceptHandoff: (sessionId: string) =>
      data(client.post<ApiSuccess<unknown>>('/handoffs/accept', { sessionId })),
    returnHandoff: (sessionId: string, reason?: string) =>
      data(client.post<ApiSuccess<unknown>>('/handoffs/return', { sessionId, reason })),

    // --- scheduler / bookings ---
    listBookings: async (params?: ListBookingsParams): Promise<Paged<Booking>> => {
      const res = await client.get<ApiSuccess<Booking[]>>('/scheduler/bookings', { params });
      return { items: res.data.data, pagination: res.data.meta?.pagination };
    },
    acceptBooking: (id: string) =>
      data(client.post<ApiSuccess<unknown>>(`/scheduler/bookings/${id}/accept`, {})),
    declineBooking: (id: string, reason?: string) =>
      data(client.post<ApiSuccess<unknown>>(`/scheduler/bookings/${id}/decline`, { reason })),

    // --- leads ---
    listLeads: (params?: ListLeadsParams) =>
      data(client.get<ApiSuccess<LeadsPage>>('/leads', { params })),

    // --- notifications ---
    listNotifications: async (
      params?: ListNotificationsParams,
    ): Promise<{ items: AppNotification[]; unreadCount?: number }> => {
      const res = await client.get<ApiSuccess<AppNotification[]>>('/notifications', {
        params: params ? { ...params, unread: params.unread ? 'true' : undefined } : undefined,
      });
      return { items: res.data.data, unreadCount: res.data.meta?.unreadCount };
    },
    markNotificationRead: (id: string) =>
      data(client.patch<ApiSuccess<unknown>>(`/notifications/${id}/read`, {})),
    markAllNotificationsRead: () =>
      data(client.patch<ApiSuccess<unknown>>('/notifications/read-all', {})),
  };
}

export type Endpoints = ReturnType<typeof createEndpoints>;
