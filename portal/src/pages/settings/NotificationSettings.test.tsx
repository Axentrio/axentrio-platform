import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import NotificationSettings from './NotificationSettings';
import { DEFAULT_NOTIFICATION_PREFERENCES, type NotificationPreferences } from '@contracts/notification-preferences';
import { ENDPOINTS } from '@config/api.config';

type ResolvedNotificationPreferences = Required<NotificationPreferences>;

interface AuthMock {
  notificationPreferences: ResolvedNotificationPreferences;
  setNotificationPreferences: ReturnType<typeof vi.fn>;
}

const { authRef, patch, toastSuccess, toastError, soundRef } = vi.hoisted(() => ({
  authRef: { current: undefined as AuthMock | undefined },
  patch: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  soundRef: {
    current: {
      isMuted: false,
      volume: 0.5,
      setMuted: vi.fn(),
      setVolume: vi.fn(),
    },
  },
}));

vi.mock('@auth/useAppAuth', () => ({
  useAppAuth: () => authRef.current,
}));

vi.mock('@services/apiClient', () => ({
  api: { patch },
}));

vi.mock('sonner', () => ({
  toast: {
    success: toastSuccess,
    error: toastError,
  },
}));

vi.mock('@websocket/notificationSound', () => ({
  useNotificationSound: () => soundRef.current,
  setSoundMuted: vi.fn(),
}));

vi.mock('@utils/desktopNotificationPref', () => ({
  isDesktopNotificationsEnabled: () => false,
  setDesktopNotificationsEnabled: vi.fn(),
}));

beforeEach(() => {
  authRef.current = {
    notificationPreferences: DEFAULT_NOTIFICATION_PREFERENCES,
    setNotificationPreferences: vi.fn(),
  };
  patch.mockReset();
  patch.mockResolvedValue({ preferences: DEFAULT_NOTIFICATION_PREFERENCES });
  toastSuccess.mockReset();
  toastError.mockReset();
  soundRef.current.isMuted = false;
  soundRef.current.volume = 0.5;
  soundRef.current.setMuted.mockReset();
  soundRef.current.setVolume.mockReset();
});

function renderUI() {
  return render(<NotificationSettings />);
}

describe('NotificationSettings', () => {
  it('renders the server defaults in each preference switch', () => {
    renderUI();

    expect(screen.getByRole('switch', { name: 'Handoff requests' })).toBeChecked();
    expect(screen.getByRole('switch', { name: 'New messages' })).not.toBeChecked();
    expect(screen.getByRole('switch', { name: 'Platform notifications' })).toBeChecked();
    expect(screen.getByRole('switch', { name: 'Email notifications' })).toBeChecked();
    expect(screen.getByRole('switch', { name: 'Sound Notifications' })).toBeChecked();
  });

  it('saves all five fields through the preferences endpoint', async () => {
    const user = userEvent.setup();
    renderUI();

    await user.click(screen.getByRole('switch', { name: 'New messages' }));
    await user.click(screen.getByRole('button', { name: 'Save Changes' }));

    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(patch).toHaveBeenCalledWith(ENDPOINTS.users.preferences, {
      notificationPreferences: {
        ...DEFAULT_NOTIFICATION_PREFERENCES,
        newMessage: true,
      },
    });
    expect(toastSuccess).toHaveBeenCalledWith('Settings saved successfully!');
  });

  it('propagates the folded response and clears dirty state after saving', async () => {
    const user = userEvent.setup();
    const savedPreferences = { ...DEFAULT_NOTIFICATION_PREFERENCES, newMessage: true };
    patch.mockResolvedValue({ preferences: savedPreferences });
    renderUI();

    await user.click(screen.getByRole('switch', { name: 'New messages' }));
    const saveButton = screen.getByRole('button', { name: 'Save Changes' });
    await user.click(saveButton);

    await waitFor(() => {
      expect(authRef.current?.setNotificationPreferences).toHaveBeenCalledWith(savedPreferences);
    });
    expect(saveButton).toBeDisabled();
  });
});
