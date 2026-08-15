import type { User } from '../database/entities/User';
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
} from '../contracts/notification-preferences';

export interface EffectiveNotificationPrefs {
  handoffPlatform: boolean;
  handoffEmail: boolean;
  newMessagePlatform: boolean;
}

export function resolveNotificationPrefs(
  user: Pick<User, 'notificationPreferences'>,
): EffectiveNotificationPrefs {
  const p = {
    ...DEFAULT_NOTIFICATION_PREFERENCES,
    ...(user.notificationPreferences ?? {}),
  };

  return {
    handoffPlatform: p.handoffRequest && p.push,
    handoffEmail: p.handoffRequest && p.email,
    newMessagePlatform: p.newMessage && p.push,
  };
}
