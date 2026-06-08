/**
 * Notification Sound System
 * Handles audio notifications for handoff requests and messages
 */

import { useCallback, useRef, useEffect, useState } from 'react';

// Sound file URLs - these should be placed in the public folder
const SOUND_URLS = {
  handoff: '/sounds/handoff.mp3',
  message: '/sounds/message.mp3',
  notification: '/sounds/notification.mp3',
  error: '/sounds/error.mp3',
} as const;

type SoundType = keyof typeof SOUND_URLS;

interface SoundOptions {
  volume?: number;
  loop?: boolean;
}

class NotificationSound {
  // Reserved for future Web Audio API usage
  public audioContext: AudioContext | null = null;
  private sounds: Map<SoundType, HTMLAudioElement> = new Map();
  private isInitialized = false;
  private isMuted = false;
  private volume = 0.5;

  constructor() {
    // Check for user preference
    const storedMute = localStorage.getItem('handsoff_sound_muted');
    this.isMuted = storedMute === 'true';
    
    const storedVolume = localStorage.getItem('handsoff_sound_volume');
    if (storedVolume) {
      this.volume = parseFloat(storedVolume);
    }
  }

  // Initialize sounds (must be called after user interaction)
  initialize(): void {
    if (this.isInitialized) return;

    // Create audio elements for each sound
    Object.entries(SOUND_URLS).forEach(([type, url]) => {
      const audio = new Audio(url);
      audio.preload = 'auto';
      audio.volume = this.volume;
      this.sounds.set(type as SoundType, audio);
    });

    this.isInitialized = true;
  }

  // Play a sound
  play(type: SoundType, options: SoundOptions = {}): void {
    if (this.isMuted) return;
    if (!this.isInitialized) this.initialize();

    const audio = this.sounds.get(type);
    if (!audio) return;

    // Reset and configure
    audio.currentTime = 0;
    audio.volume = options.volume ?? this.volume;
    audio.loop = options.loop ?? false;

    // Play with error handling
    audio.play().catch((error) => {
      console.warn(`Failed to play sound ${type}:`, error);
    });
  }

  // Stop a sound
  stop(type: SoundType): void {
    const audio = this.sounds.get(type);
    if (audio) {
      audio.pause();
      audio.currentTime = 0;
    }
  }

  // Stop all sounds
  stopAll(): void {
    this.sounds.forEach((audio) => {
      audio.pause();
      audio.currentTime = 0;
    });
  }

  // Set muted state
  setMuted(muted: boolean): void {
    this.isMuted = muted;
    localStorage.setItem('handsoff_sound_muted', String(muted));
    
    if (muted) {
      this.stopAll();
    }
  }

  // Get muted state
  getMuted(): boolean {
    return this.isMuted;
  }

  // Toggle muted state
  toggleMute(): boolean {
    this.setMuted(!this.isMuted);
    return this.isMuted;
  }

  // Set volume (0-1)
  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
    localStorage.setItem('handsoff_sound_volume', String(this.volume));
    
    this.sounds.forEach((audio) => {
      audio.volume = this.volume;
    });
  }

  // Get volume
  getVolume(): number {
    return this.volume;
  }
}

// Singleton instance
const notificationSound = new NotificationSound();

// React hook for notification sounds
export const useNotificationSound = () => {
  const soundRef = useRef(notificationSound);
  const [isMuted, setIsMutedState] = useState(() => soundRef.current.getMuted());
  const [volume, setVolumeState] = useState(() => soundRef.current.getVolume());

  // Initialize on first user interaction
  useEffect(() => {
    const handleInteraction = () => {
      soundRef.current.initialize();
    };

    document.addEventListener('click', handleInteraction, { once: true });
    document.addEventListener('keydown', handleInteraction, { once: true });

    return () => {
      document.removeEventListener('click', handleInteraction);
      document.removeEventListener('keydown', handleInteraction);
    };
  }, []);

  const playHandoff = useCallback(() => {
    soundRef.current.play('handoff');
  }, []);

  const playMessage = useCallback(() => {
    soundRef.current.play('message');
  }, []);

  const playNotification = useCallback(() => {
    soundRef.current.play('notification');
  }, []);

  const playError = useCallback(() => {
    soundRef.current.play('error');
  }, []);

  const stopAll = useCallback(() => {
    soundRef.current.stopAll();
  }, []);

  const setMuted = useCallback((muted: boolean) => {
    soundRef.current.setMuted(muted);
    setIsMutedState(muted);
  }, []);

  const toggleMute = useCallback(() => {
    const newMuted = soundRef.current.toggleMute();
    setIsMutedState(newMuted);
    return newMuted;
  }, []);

  const setVolume = useCallback((vol: number) => {
    soundRef.current.setVolume(vol);
    setVolumeState(soundRef.current.getVolume());
  }, []);

  return {
    playHandoff,
    playMessage,
    playNotification,
    playError,
    stopAll,
    setMuted,
    toggleMute,
    setVolume,
    isMuted,
    volume,
    initialize: () => soundRef.current.initialize(),
  };
};
