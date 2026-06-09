import axios, { AxiosError, type AxiosInstance } from 'axios';
import type { ApiResponse } from '@axentrio/contracts';

/** Supplies a fresh Clerk session JWT for the Authorization header. */
export type TokenProvider = () => Promise<string | null>;

/** Normalized API error thrown by the client (success:false or transport). */
export class ApiError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly details?: unknown;

  constructor(code: string, message: string, status?: number, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export interface CreateApiClientOptions {
  /** Full base URL including the version prefix, e.g. https://api.example.com/api/v1 */
  baseURL: string;
  getToken: TokenProvider;
}

/**
 * Axios instance that injects the Clerk Bearer token and normalizes the
 * standard `{ success, data, meta }` envelope: on `success:false` (or a
 * transport error) it throws an {@link ApiError}; on success the full envelope
 * is left on `response.data` for endpoint helpers to read `.data` / `.meta`.
 */
export function createApiClient({ baseURL, getToken }: CreateApiClientOptions): AxiosInstance {
  const instance = axios.create({ baseURL, timeout: 20_000 });

  instance.interceptors.request.use(async (config) => {
    const token = await getToken();
    if (token) {
      config.headers.set('Authorization', `Bearer ${token}`);
    }
    return config;
  });

  instance.interceptors.response.use(
    (response) => {
      const body = response.data as ApiResponse<unknown> | undefined;
      if (body && typeof body === 'object' && 'success' in body && body.success === false) {
        throw new ApiError(body.error.code, body.error.message, response.status, body.error.details);
      }
      return response;
    },
    (error: AxiosError<ApiResponse<unknown>>) => {
      const body = error.response?.data;
      if (body && typeof body === 'object' && 'success' in body && body.success === false) {
        throw new ApiError(body.error.code, body.error.message, error.response?.status, body.error.details);
      }
      throw new ApiError('NETWORK_ERROR', error.message || 'Network error', error.response?.status);
    },
  );

  return instance;
}
