/**
 * Durable handle this conversation belongs to.
 *
 * Channel subjects reuse the lead `dedupe_key` shape (`<channel>:<visitorId>`)
 * because inbound pipeline stamps `ChatSession.visitorId = externalUserId`.
 * Widget subjects are bot-scoped: the browser key is already per embed.
 */
import { createHash } from 'crypto';
import { isErasedDedupeKey } from '../leads/lead-tombstone';

/** The durable handle this conversation belongs to, or null when there is none. */
export function computeSubjectKey(session: {
  channel?: string | null;
  botId?: string | null;
  visitorId?: string | null;
}): string | null {
  if (isErasedDedupeKey(session.visitorId)) return null;
  if (!session.visitorId) return null;
  if (session.channel && session.channel !== 'widget') {
    return `${session.channel}:${session.visitorId}`;
  }
  if (session.channel === 'widget') {
    return `widget:${session.botId}:${session.visitorId}`;
  }
  return null;
}

/** Inverse of `computeSubjectKey`. Null when the key is malformed. */
export function parseSubjectKey(subjectKey: string): {
  channel: string;
  botId?: string;
  visitorId: string;
} | null {
  if (subjectKey.startsWith('widget:')) {
    const rest = subjectKey.slice('widget:'.length);
    const split = rest.indexOf(':');
    if (split <= 0 || split === rest.length - 1) return null;
    return {
      channel: 'widget',
      botId: rest.slice(0, split),
      visitorId: rest.slice(split + 1),
    };
  }
  const split = subjectKey.indexOf(':');
  if (split <= 0 || split === subjectKey.length - 1) return null;
  return {
    channel: subjectKey.slice(0, split),
    visitorId: subjectKey.slice(split + 1),
  };
}

/** Short hash for logs. Never log the raw handle — it can hold a phone or PSID. */
export function hashSubjectKey(subjectKey: string): string {
  return createHash('sha256').update(subjectKey).digest('hex').slice(0, 12);
}
