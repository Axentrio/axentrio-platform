/**
 * useDebounce Hook
 * Debounces a value or function
 */

import { useState, useEffect, useRef, useCallback } from 'react';

// Debounce a value
export function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedValue(value);
    }, delay);

    return () => {
      clearTimeout(timer);
    };
  }, [value, delay]);

  return debouncedValue;
}

// Debounce a callback function
export function useDebouncedCallback<T extends (...args: any[]) => any>(
  callback: T,
  delay: number
): (...args: Parameters<T>) => void {
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  return useCallback(
    (...args: Parameters<T>) => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }

      timeoutRef.current = setTimeout(() => {
        callback(...args);
      }, delay);
    },
    [callback, delay]
  );
}

// Debounce with leading/trailing options
interface DebounceOptions {
  leading?: boolean;
  trailing?: boolean;
}

export function useDebounceWithOptions<T extends (...args: any[]) => any>(
  callback: T,
  delay: number,
  options: DebounceOptions = {}
): (...args: Parameters<T>) => void {
  const { leading = false, trailing = true } = options;
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastCallTimeRef = useRef<number>(0);

  return useCallback(
    (...args: Parameters<T>) => {
      const now = Date.now();
      const isLeading = leading && now - lastCallTimeRef.current > delay;

      if (isLeading) {
        callback(...args);
        lastCallTimeRef.current = now;
      }

      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }

      if (trailing) {
        timeoutRef.current = setTimeout(() => {
          if (!isLeading) {
            callback(...args);
          }
          timeoutRef.current = null;
        }, delay);
      }
    },
    [callback, delay, leading, trailing]
  );
}

export default useDebounce;
