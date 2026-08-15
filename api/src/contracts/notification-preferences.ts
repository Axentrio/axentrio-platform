export interface NotificationPreferences {
  email?: boolean;
  push?: boolean;
  sound?: boolean;
  newMessage?: boolean;
  handoffRequest?: boolean;
}

export const DEFAULT_NOTIFICATION_PREFERENCES: Required<NotificationPreferences> = {
  email: true,
  push: true,
  sound: true,
  newMessage: false,
  handoffRequest: true,
};
