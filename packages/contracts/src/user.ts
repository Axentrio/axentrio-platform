import type { OperatorRole } from './common';

export interface NotificationPreferences {
  email?: boolean;
  push?: boolean;
  sound?: boolean;
  newMessage?: boolean;
  handoffRequest?: boolean;
}

/** GET /api/v1/users/profile -> { profile } */
export interface UserProfile {
  id: string;
  name: string;
  email: string;
  role: OperatorRole;
  avatarUrl?: string;
  timezone?: string;
  locale?: string;
  isActive: boolean;
  emailVerified: boolean;
  notificationPreferences?: NotificationPreferences;
  lastLoginAt?: string;
  createdAt: string;
}
