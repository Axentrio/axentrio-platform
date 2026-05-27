import axios from 'axios';

export interface ParsedAxiosError {
  message: string;
  /** True for transient failures worth retrying (5xx, 429, network errors). */
  retryable: boolean;
}

/**
 * Normalize an unknown error from an axios call into a human-readable message
 * and a retryable flag. Centralizes the error-shape handling that was
 * previously duplicated across every channel transport.
 */
export function parseAxiosError(error: unknown): ParsedAxiosError {
  if (axios.isAxiosError(error)) {
    const message = error.response?.data?.error?.message || error.message || 'Unknown error';
    const status = error.response?.status || 0;
    return { message, retryable: status >= 500 || status === 429 };
  }
  return {
    message: error instanceof Error ? error.message : 'Unknown error',
    // Non-HTTP errors (e.g. network/timeout) are treated as transient.
    retryable: true,
  };
}
