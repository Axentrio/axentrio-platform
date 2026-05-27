/**
 * Shared date formatting utilities.
 *
 * All timestamps from the API are UTC ISO 8601 strings.
 * These functions convert to the user's local timezone at display time
 * using the browser's Intl API — no library needed.
 */

/** Ensure a timestamp string is parseable as UTC */
function toUTC(dateStr: string | Date): Date {
  if (dateStr instanceof Date) return dateStr;
  // If the string has no timezone indicator, treat as UTC
  const normalized = dateStr.endsWith('Z') || dateStr.includes('+') ? dateStr : dateStr + 'Z';
  return new Date(normalized);
}

/** Relative time: "just now", "5m ago", "2h ago", "3d ago" */
export function timeAgo(dateStr: string | Date): string {
  const diff = Date.now() - toUTC(dateStr).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

/** Time only: "14:30" or "2:30 PM" depending on locale */
export function formatTime(dateStr: string | Date): string {
  return toUTC(dateStr).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Date only: "Mar 30, 2026" */
export function formatDate(dateStr: string | Date): string {
  return toUTC(dateStr).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Date + time: "Mar 30, 2026, 14:30" */
export function formatDateTime(dateStr: string | Date): string {
  return toUTC(dateStr).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Smart format: time if today, "Yesterday" if yesterday, date otherwise */
export function formatSmart(dateStr: string | Date): string {
  const date = toUTC(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffDays === 0 && date.toDateString() === now.toDateString()) {
    return formatTime(date);
  }

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) {
    return `Yesterday, ${formatTime(date)}`;
  }

  if (diffDays < 7) {
    return `${date.toLocaleDateString([], { weekday: 'short' })}, ${formatTime(date)}`;
  }

  return formatDate(date);
}
