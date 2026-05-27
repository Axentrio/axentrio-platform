export function timeAgo(dateStr: string): string {
  // DB stores timestamps without timezone — treat as UTC
  const normalized = dateStr.endsWith('Z') || dateStr.includes('+') ? dateStr : dateStr + 'Z';
  const diff = Date.now() - new Date(normalized).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
