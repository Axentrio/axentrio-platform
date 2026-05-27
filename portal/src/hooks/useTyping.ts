/**
 * useTyping Hook
 * Manages typing indicator with debounce
 */

import { useState, useCallback, useRef, useEffect } from 'react';

interface UseTypingOptions {
  onTypingStart?: () => void;
  onTypingStop?: () => void;
  debounceMs?: number;
  timeoutMs?: number;
}

interface UseTypingReturn {
  isTyping: boolean;
  handleInputChange: (value: string) => void;
  stopTyping: () => void;
}

export const useTyping = (options: UseTypingOptions = {}): UseTypingReturn => {
  const { 
    onTypingStart, 
    onTypingStop, 
    debounceMs = 500, 
    timeoutMs = 3000 
  } = options;
  
  const [isTyping, setIsTyping] = useState(false);
  const debounceRef = useRef<NodeJS.Timeout | null>(null);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastValueRef = useRef('');

  // Clear all timers
  const clearTimers = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  // Stop typing
  const stopTyping = useCallback(() => {
    clearTimers();
    if (isTyping) {
      setIsTyping(false);
      onTypingStop?.();
    }
  }, [isTyping, onTypingStop, clearTimers]);

  // Handle input change
  const handleInputChange = useCallback((value: string) => {
    const wasTyping = isTyping;
    const isEmpty = !value || value.trim().length === 0;
    lastValueRef.current = value;

    // Clear existing timers
    clearTimers();

    if (isEmpty) {
      // Stop typing if input is empty
      if (wasTyping) {
        setIsTyping(false);
        onTypingStop?.();
      }
      return;
    }

    // Start typing if not already typing
    if (!wasTyping) {
      // Debounce the typing start
      debounceRef.current = setTimeout(() => {
        setIsTyping(true);
        onTypingStart?.();
      }, debounceMs);
    } else {
      // Already typing, just set the timeout
      setIsTyping(true);
    }

    // Set timeout to stop typing
    timeoutRef.current = setTimeout(() => {
      setIsTyping(false);
      onTypingStop?.();
    }, timeoutMs);
  }, [isTyping, onTypingStart, onTypingStop, debounceMs, timeoutMs, clearTimers]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      clearTimers();
    };
  }, [clearTimers]);

  return {
    isTyping,
    handleInputChange,
    stopTyping,
  };
};

export default useTyping;
