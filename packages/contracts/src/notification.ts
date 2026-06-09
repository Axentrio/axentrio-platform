// Current (in-memory) notification shape. The DB-backed version (#24) keeps
// this client-facing shape stable so the app does not change when the backend
// is replaced.
export interface AppNotification {
  id: string;
  userId: string;
  type: string;
  title: string;
  message: string;
  read: boolean;
  createdAt: string;
  metadata?: Record<string, unknown>;
}
