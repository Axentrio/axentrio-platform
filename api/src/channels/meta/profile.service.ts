import axios from 'axios';
import { logger } from '../../utils/logger';
import { sanitizeGraphError } from '../../utils/axios-error';
import { FB_GRAPH_API as GRAPH_API } from './graph-api';

// Simple in-memory cache with TTL
const profileCache = new Map<string, { displayName: string; avatarUrl?: string; expiresAt: number }>();
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours
const MAX_CACHE_ENTRIES = 50_000;

// The key is a Meta PSID/IGSID, so without a sweep the map grows by one entry
// per distinct contact that ever messages the bot and never shrinks — the TTL
// alone only ever evicts a key that is looked up again after it expired.
function sweepProfileCache(): void {
  const now = Date.now();
  for (const [key, entry] of profileCache) {
    if (entry.expiresAt <= now) profileCache.delete(key);
  }
  // Hard cap for the pathological case (>50k contacts inside one TTL window):
  // drop the entries closest to expiry first.
  const excess = profileCache.size - MAX_CACHE_ENTRIES;
  if (excess > 0) {
    const byExpiry = [...profileCache.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt);
    for (const [key] of byExpiry.slice(0, excess)) profileCache.delete(key);
  }
}

// Sweep expired entries every 60 seconds to prevent memory leak
setInterval(sweepProfileCache, 60_000).unref(); // .unref() so it doesn't keep the process alive

/** Test seam — observe cache growth. */
export function __profileCacheSize(): number {
  return profileCache.size;
}

/** Test seam — clear the in-memory cache between cases. */
export function __resetProfileCache(): void {
  profileCache.clear();
}

/**
 * Fetch profile info for a Meta user (Messenger PSID or Instagram IGSID).
 */
export async function fetchMetaProfile(
  userId: string,
  accessToken: string,
  channel: 'messenger' | 'instagram',
): Promise<{ displayName: string; avatarUrl?: string }> {
  // Check cache
  const cacheKey = `${channel}:${userId}`;
  const cached = profileCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { displayName: cached.displayName, avatarUrl: cached.avatarUrl };
  }

  try {
    const fields = channel === 'messenger'
      ? 'first_name,last_name,profile_pic'
      : 'name,profile_pic';

    const response = await axios.get(`${GRAPH_API}/${userId}`, {
      params: { fields, access_token: accessToken },
      timeout: 5000,
    });

    const data = response.data;
    const displayName = channel === 'messenger'
      ? [data.first_name, data.last_name].filter(Boolean).join(' ')
      : data.name || 'Instagram User';
    const avatarUrl = data.profile_pic;

    // Cache result
    profileCache.set(cacheKey, {
      displayName,
      avatarUrl,
      expiresAt: Date.now() + CACHE_TTL,
    });

    return { displayName, avatarUrl };
  } catch (error) {
    logger.debug('[meta-profile] Failed to fetch profile', {
      userId,
      channel,
      ...sanitizeGraphError(error),
    });
    const fallback = channel === 'messenger' ? 'Facebook User' : 'Instagram User';
    return { displayName: fallback };
  }
}
