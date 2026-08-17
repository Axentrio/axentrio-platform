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

export interface SafeGraphError {
  message: string;
  retryable: boolean;
  status?: number;
  code?: number;
  subcode?: number;
  fbtraceId?: string;
}

/**
 * Compact Graph/Axios failure for logs. Never includes URL, query string,
 * request config, headers, or tokens — those live on the raw AxiosError and
 * must not be splat into Winston (format.errors + splat dumps the whole
 * object, including `access_token` query params).
 */
export function sanitizeGraphError(error: unknown): SafeGraphError {
  const parsed = parseAxiosError(error);
  if (!axios.isAxiosError(error)) {
    return { message: parsed.message, retryable: parsed.retryable };
  }
  const graph = error.response?.data?.error;
  const safe: SafeGraphError = {
    message: parsed.message,
    retryable: parsed.retryable,
  };
  if (error.response?.status) safe.status = error.response.status;
  if (typeof graph?.code === 'number') safe.code = graph.code;
  if (typeof graph?.error_subcode === 'number') safe.subcode = graph.error_subcode;
  if (typeof graph?.fbtrace_id === 'string') safe.fbtraceId = graph.fbtrace_id;
  return safe;
}
