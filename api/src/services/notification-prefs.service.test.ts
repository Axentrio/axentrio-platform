import { describe, expect, it } from 'vitest';
import { resolveNotificationPrefs } from './notification-prefs.service';

describe('resolveNotificationPrefs', () => {
  it('folds null preferences over the full defaults', () => {
    expect(resolveNotificationPrefs({ notificationPreferences: null })).toEqual({
      handoffPlatform: true,
      handoffEmail: true,
      newMessagePlatform: false,
    });
  });

  it('gates handoff platform notifications on the push channel', () => {
    expect(
      resolveNotificationPrefs({
        notificationPreferences: { handoffRequest: true, push: false },
      }).handoffPlatform,
    ).toBe(false);
  });

  it('keeps handoff platform notifications off when the event is disabled', () => {
    expect(
      resolveNotificationPrefs({
        notificationPreferences: { handoffRequest: false, push: true },
      }).handoffPlatform,
    ).toBe(false);
  });

  it('gates handoff email independently from platform notifications', () => {
    expect(
      resolveNotificationPrefs({
        notificationPreferences: { handoffRequest: true, email: false },
      }),
    ).toEqual({
      handoffPlatform: true,
      handoffEmail: false,
      newMessagePlatform: false,
    });
  });
});
