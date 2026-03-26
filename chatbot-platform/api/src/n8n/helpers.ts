/**
 * Shared helpers for n8n module
 */

const MAX_BODY_SIZE = 2048;

/**
 * Truncate a request body to a safe size for storage in delivery logs
 */
export function truncateRequestBody(
  body: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!body) return undefined;

  const bodyStr = JSON.stringify(body);
  if (bodyStr.length <= MAX_BODY_SIZE) return body;

  return { _truncated: true, preview: bodyStr.slice(0, MAX_BODY_SIZE) };
}

/**
 * Generate a unique request ID for tracing
 */
export function generateRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}
