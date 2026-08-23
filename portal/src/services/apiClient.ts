/**
 * API Client
 * Centralized HTTP client with Clerk token authentication
 */

import axios, { AxiosInstance, AxiosRequestConfig, AxiosError } from 'axios';
import { API_CONFIG } from '@config/api.config';
import { useTenantContextStore } from '../stores/tenantContextStore';

// Token provider — set from React context via setTokenProvider()
let tokenProvider: (() => Promise<string | null>) | null = null;

export function setTokenProvider(provider: () => Promise<string | null>) {
  tokenProvider = provider;
}

// Create axios instance
const apiClient: AxiosInstance = axios.create({
  baseURL: API_CONFIG.baseURL,
  timeout: API_CONFIG.timeout,
  headers: API_CONFIG.headers,
});

// Request interceptor - add Clerk token
apiClient.interceptors.request.use(
  async (config) => {
    if (tokenProvider) {
      try {
        const token = await tokenProvider();
        if (token) {
          config.headers.Authorization = `Bearer ${token}`;
        }
      } catch {
        // Token fetch failed — request will proceed without auth
      }
    }

    // Inject tenant context header for super admin context switching
    const { activeTenant } = useTenantContextStore.getState();
    if (activeTenant) {
      config.headers['X-Tenant-Context'] = activeTenant.tenantId;
    }

    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// Plan-limit (HTTP 402) → toast. Human-readable copy keyed off the lowercase
// service error code (matches src/routes/billing.routes.ts and
// src/billing/enforce.ts). Falls back to the server's message field when an
// unknown code arrives.
//
// Imported lazily inside the interceptor so apiClient can be initialized
// before sonner mounts (Toaster lives in App.tsx).
const PLAN_LIMIT_COPY: Record<string, string> = {
  plan_limit_agents: 'You\'ve reached your plan\'s agent limit. Upgrade to add more.',
  plan_limit_sessions: 'You\'ve reached your plan\'s concurrent-session limit. Upgrade to handle more chats at once.',
  plan_limit_channels: 'You\'ve reached your plan\'s channel limit. Upgrade to connect more channels.',
  plan_limit_file_upload: 'File uploads aren\'t available on your current plan. Upgrade to enable them.',
  plan_limit_handoff: 'Human handoff isn\'t available on your current plan. Upgrade to enable it.',
  plan_limit_custom_branding: 'Custom branding isn\'t available on your current plan. Upgrade to enable it.',
  plan_feature_cloud_import: 'Cloud import isn\'t available on your current plan. Upgrade to enable it.',
};

// Plan-gate codes whose 402 response should NOT fire a global toast.
// These features render their own locked-preview surface that handles
// the upgrade UX inline (M9a Copilot, future locked-preview-only
// features). The toast would be noise on top of an already-locked UI.
const PLAN_LIMIT_NO_TOAST: ReadonlySet<string> = new Set([
  'plan_limit_platform_assistant',
  // Leads page renders a LockedPreview but still fires GET /leads on mount
  // (hooks run before the locked-check), so its 402 would double-notify on
  // top of the already-locked UI.
  'plan_limit_lead_capture',
]);

type PlanLimitBody =
  | { error?: { code?: string; message?: string; details?: { limit?: number; reason?: string } } }
  | undefined;

/**
 * On a `responseType: 'blob'` request (the CSV/XLS exports) axios hands the ERROR
 * body back as a Blob too, so reading `data.error.code` yields undefined and the
 * suppression list below silently misses — the user got a generic "plan limit"
 * toast instead of the right copy, or none at all. Decode the blob before parsing.
 */
async function readErrorBody(error: AxiosError): Promise<PlanLimitBody> {
  const raw = error.response?.data;
  if (raw instanceof Blob) {
    try {
      return JSON.parse(await raw.text()) as PlanLimitBody;
    } catch {
      return undefined; // a genuinely non-JSON error body
    }
  }
  return raw as PlanLimitBody;
}

async function handlePlanLimit(error: AxiosError): Promise<void> {
  if (error.response?.status !== 402) return;
  const body = await readErrorBody(error);
  const code = body?.error?.code ?? '';
  if (PLAN_LIMIT_NO_TOAST.has(code)) return;

  // `disabled_by_tenant` means the tenant switched this feature OFF themselves
  // (it IS in their plan) — point them to Settings → Features, NOT an upgrade.
  if (body?.error?.details?.reason === 'disabled_by_tenant') {
    import('sonner').then(({ toast }) => {
      toast.warning('This feature is switched off for your workspace.', {
        action: {
          label: 'Manage features',
          onClick: () => {
            window.location.href = '/settings/features';
          },
        },
      });
    });
    return;
  }

  const message =
    PLAN_LIMIT_COPY[code] ??
    body?.error?.message ??
    'You\'ve reached a plan limit. Upgrade to continue.';
  // Lazy import so this module stays decoupled from sonner's bundle init.
  import('sonner').then(({ toast }) => {
    toast.warning(message, {
      action: {
        label: 'View plans',
        onClick: () => {
          window.location.href = '/settings/billing';
        },
      },
    });
  });
}

// Response interceptor - unwrap { success, data } envelope + handle errors
apiClient.interceptors.response.use(
  (response) => {
    // If the response has our standard envelope, unwrap it
    if (response.data && typeof response.data === 'object' && 'success' in response.data && 'data' in response.data) {
      if ('meta' in response.data && response.data.meta) {
        // Preserve pagination metadata alongside data
        response.data = { data: response.data.data, meta: response.data.meta };
      } else {
        response.data = response.data.data;
      }
    }
    return response;
  },
  async (error: AxiosError) => {
    await handlePlanLimit(error);
    return Promise.reject(error);
  }
);

// Generic request methods
export const api = {
  get: <T>(url: string, config?: AxiosRequestConfig) =>
    apiClient.get<T>(url, config).then((res) => res.data),

  post: <T>(url: string, data?: unknown, config?: AxiosRequestConfig) =>
    apiClient.post<T>(url, data, config).then((res) => res.data),

  put: <T>(url: string, data?: unknown, config?: AxiosRequestConfig) =>
    apiClient.put<T>(url, data, config).then((res) => res.data),

  patch: <T>(url: string, data?: unknown, config?: AxiosRequestConfig) =>
    apiClient.patch<T>(url, data, config).then((res) => res.data),

  delete: <T>(url: string, config?: AxiosRequestConfig) =>
    apiClient.delete<T>(url, config).then((res) => res.data),

  /**
   * Fetch a file export and trigger the browser download, using the server's
   * `Content-Disposition` filename. Callers used to hardcode the name, which
   * threw away the date range the server had already encoded into it (and would
   * have mislabelled a `.xlsx` as `.csv` the moment a second format shipped).
   * `fallbackFilename` covers a proxy that strips the header.
   */
  download: async (
    url: string,
    fallbackFilename: string,
    config?: AxiosRequestConfig,
  ): Promise<{ truncated: boolean; rowLimit: number | null }> => {
    const res = await apiClient.get<Blob>(url, { ...config, responseType: 'blob' });
    const objectUrl = URL.createObjectURL(res.data);
    try {
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = filenameFromDisposition(res.headers['content-disposition']) ?? fallbackFilename;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
    // Returned, not swallowed: a row-capped export is incomplete data and the
    // caller has to be able to tell the user that.
    const limit = Number(res.headers['x-export-row-limit']);
    return {
      truncated: res.headers['x-export-truncated'] === 'true',
      rowLimit: Number.isFinite(limit) && limit > 0 ? limit : null,
    };
  },
};

/**
 * Pull the filename out of a Content-Disposition header. Prefers RFC 5987
 * `filename*=UTF-8''…` (percent-encoded, what a non-ASCII name needs) over the
 * plain `filename="…"`. Any path separator is stripped so a hostile header can
 * never steer the download outside the browser's download directory.
 */
function filenameFromDisposition(header: unknown): string | null {
  if (typeof header !== 'string') return null;
  const extended = /filename\*=UTF-8''([^;]+)/i.exec(header);
  const plain = /filename="?([^";]+)"?/i.exec(header);
  const raw = extended ? safeDecode(extended[1]) : plain?.[1];
  if (!raw) return null;
  const base = raw.trim().replace(/^.*[\\/]/, '');
  return base && base !== '.' && base !== '..' ? base : null;
}

function safeDecode(v: string): string | undefined {
  try {
    return decodeURIComponent(v);
  } catch {
    return undefined;
  }
}

// Strictly extracts the server-side error string from an Axios response body. Returns
// undefined for:
//   - non-Axios errors (callers chain their own `err.message` / hardcoded fallback)
//   - Axios errors without `response` (network/timeout — caller falls back to err.message,
//     which axios sets to "Network Error" / "timeout of Xms exceeded")
//   - Axios responses with no extractable string in the body (caller falls back)
// Precedence inside the response body:
//   1. data.error.message (new envelope) — most specific server message.
//   2. data.message (legacy bodies that emit both `error: 'short'` and `message: 'detail'`,
//      e.g. today's rate-limit body. Picking message before string-error gives the more
//      useful copy "Rate limit exceeded. Please try again later." instead of "Too Many Requests".)
//   3. data.error as string (legacy string-only error bodies).
/**
 * Name the offending fields from a `ZodError.flatten()` payload.
 *
 * The API parses a whole payload before any write, so one bad character rejects the entire
 * save — and the envelope's message for that is always the bare string "Validation failed".
 * The settings editors PUT ~20 controls at once, so without the field names the owner is told
 * only that something, somewhere, is wrong.
 */
function describeFieldErrors(details: unknown): string | undefined {
  if (!details || typeof details !== 'object') return undefined;
  const { formErrors, fieldErrors } = details as {
    formErrors?: unknown;
    fieldErrors?: Record<string, unknown>;
  };
  const parts: string[] = [];
  if (Array.isArray(formErrors)) {
    for (const m of formErrors) if (typeof m === 'string' && m) parts.push(m);
  }
  for (const [field, msgs] of Object.entries(fieldErrors ?? {})) {
    const first = Array.isArray(msgs) ? msgs.find((m) => typeof m === 'string' && m) : undefined;
    if (first) parts.push(`${field}: ${first}`);
  }
  if (!parts.length) return undefined;
  // Cap it: a toast that lists twelve fields is as unreadable as one that lists none.
  return parts.length > 3 ? `${parts.slice(0, 3).join('; ')}; +${parts.length - 3} more` : parts.join('; ');
}

export function extractApiErrorMessage(error: unknown): string | undefined {
  if (!axios.isAxiosError(error)) return undefined;
  if (!error.response) return undefined; // network/timeout — caller falls back to err.message
  const data = error.response.data as
    | { error?: string | { message?: string; code?: string; details?: unknown }; message?: string }
    | undefined;
  if (data?.error && typeof data.error === 'object' && typeof data.error.message === 'string') {
    const fields = describeFieldErrors(data.error.details);
    return fields ? `${data.error.message}: ${fields}` : data.error.message;
  }
  if (typeof data?.message === 'string') return data.message;
  if (typeof data?.error === 'string') return data.error;
  return undefined;
}

// Error handler
export const handleApiError = (error: unknown): string => {
  const serverMessage = extractApiErrorMessage(error);
  if (serverMessage) return serverMessage;
  if (axios.isAxiosError(error)) {
    if (error.response) {
      return `Error ${error.response.status}: ${error.response.statusText}`;
    }
    if (error.request) {
      return 'Network error. Please check your connection.';
    }
  }
  return 'An unexpected error occurred.';
};

export default apiClient;
