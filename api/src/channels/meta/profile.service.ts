import axios from 'axios';
import { logger } from '../../utils/logger';
import { FB_GRAPH_API as GRAPH_API } from './graph-api';

// Simple in-memory cache with TTL
const profileCache = new Map<string, { displayName: string; avatarUrl?: string; expiresAt: number }>();
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

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
    logger.debug(`[meta-profile] Failed to fetch profile for ${userId}:`, error);
    const fallback = channel === 'messenger' ? 'Facebook User' : 'Instagram User';
    return { displayName: fallback };
  }
}
