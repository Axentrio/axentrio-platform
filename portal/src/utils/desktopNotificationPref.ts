import { STORAGE_KEYS } from '@config/constants';

export function isDesktopNotificationsEnabled(): boolean {
  return localStorage.getItem(STORAGE_KEYS.DESKTOP_NOTIFICATIONS) === 'true';
}

export function setDesktopNotificationsEnabled(enabled: boolean): void {
  localStorage.setItem(STORAGE_KEYS.DESKTOP_NOTIFICATIONS, String(enabled));
}
