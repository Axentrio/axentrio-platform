import type {
  ListSessionsParams,
  ListBookingsParams,
  ListNotificationsParams,
} from './endpoints';

/** Stable react-query cache keys, shared so screens never hand-roll keys. */
export const queryKeys = {
  authMe: ['auth', 'me'] as const,
  profile: ['users', 'profile'] as const,
  sessions: (params?: ListSessionsParams) => ['chats', 'sessions', params ?? {}] as const,
  conversation: (id: string) => ['chats', id] as const,
  history: (id: string) => ['chats', id, 'history'] as const,
  bookings: (params?: ListBookingsParams) => ['scheduler', 'bookings', params ?? {}] as const,
  leads: ['leads'] as const,
  notifications: (params?: ListNotificationsParams) => ['notifications', params ?? {}] as const,
  handoffQueue: ['handoffs', 'queue'] as const,
};
