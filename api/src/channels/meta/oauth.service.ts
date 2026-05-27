import axios from 'axios';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { config } from '../../config/environment';
import { FB_GRAPH_API as GRAPH_API, FB_OAUTH_DIALOG } from './graph-api';
import { logger } from '../../utils/logger';
import { getRedisClient } from '../../config/redis';

// Scopes must be added to the app in Meta Developer Console before requesting.
// Core messaging scopes plus Instagram DM scopes (instagram_basic +
// instagram_manage_messages). These require the Instagram product enabled on
// the app and, for production, App Review approval.
const OAUTH_SCOPES = [
  'pages_messaging',
  'pages_manage_metadata',
  'pages_show_list',
  'business_management',
  'instagram_basic',
  'instagram_manage_messages',
].join(',');

interface MetaPage {
  id: string;
  name: string;
  accessToken: string;
  picture?: string;
  tasks: string[];
  instagramAccount?: {
    id: string;
    username?: string;
    profilePicUrl?: string;
  };
}

/**
 * Build the Facebook Login OAuth URL for a tenant.
 */
export function buildOAuthUrl(tenantId: string): string {
  const state = jwt.sign(
    { tenantId, nonce: crypto.randomBytes(16).toString('hex') },
    config.meta.oauthJwtSecret,
    { expiresIn: '5m' },
  );

  const params = new URLSearchParams({
    client_id: config.meta.appId,
    redirect_uri: config.meta.oauthRedirectUri,
    scope: OAUTH_SCOPES,
    state,
    response_type: 'code',
    auth_type: 'rerequest', // Force re-show permission dialog
  });

  return `${FB_OAUTH_DIALOG}?${params.toString()}`;
}

/**
 * Validate the OAuth state JWT and extract tenantId.
 */
export function validateOAuthState(state: string): { tenantId: string } {
  const decoded = jwt.verify(state, config.meta.oauthJwtSecret) as { tenantId: string };
  return { tenantId: decoded.tenantId };
}

/**
 * Exchange authorization code for access tokens, then list available Pages.
 */
export async function handleOAuthCallback(code: string): Promise<{
  pages: MetaPage[];
  sessionToken: string;
}> {
  // 1. Exchange code for short-lived user token
  const tokenResponse = await axios.get(`${GRAPH_API}/oauth/access_token`, {
    params: {
      client_id: config.meta.appId,
      client_secret: config.meta.appSecret,
      redirect_uri: config.meta.oauthRedirectUri,
      code,
    },
    timeout: 10000,
  });
  const shortLivedToken = tokenResponse.data.access_token;

  // 2. Exchange for long-lived user token
  const longLivedResponse = await axios.get(`${GRAPH_API}/oauth/access_token`, {
    params: {
      grant_type: 'fb_exchange_token',
      client_id: config.meta.appId,
      client_secret: config.meta.appSecret,
      fb_exchange_token: shortLivedToken,
    },
    timeout: 10000,
  });
  const longLivedUserToken = longLivedResponse.data.access_token;

  // Debug: check what permissions the token has
  try {
    const debugResponse = await axios.get(`${GRAPH_API}/me/permissions`, {
      params: { access_token: longLivedUserToken },
      timeout: 10000,
    });
    logger.debug('[meta-oauth] Token permissions', { permissions: debugResponse.data.data });
  } catch (e: any) {
    logger.debug('[meta-oauth] Permission check failed', { error: e.response?.data || e.message });
  }

  // 3. Get pages the user manages (personal pages)
  const pageFields = 'id,name,access_token,picture,tasks,instagram_business_account{id,username,profile_picture_url}';
  const pagesResponse = await axios.get(`${GRAPH_API}/me/accounts`, {
    params: {
      access_token: longLivedUserToken,
      fields: pageFields,
      limit: 100,
    },
    timeout: 10000,
  });

  const allPageData: any[] = [...(pagesResponse.data.data || [])];

  // 4. Also get pages from Business Portfolios (Business Manager-managed pages)
  try {
    const businessesResponse = await axios.get(`${GRAPH_API}/me/businesses`, {
      params: { access_token: longLivedUserToken, fields: 'id,name', limit: 100 },
      timeout: 10000,
    });

    for (const biz of businessesResponse.data.data || []) {
      try {
        const bizPagesResponse = await axios.get(`${GRAPH_API}/${biz.id}/owned_pages`, {
          params: {
            access_token: longLivedUserToken,
            fields: pageFields,
            limit: 100,
          },
          timeout: 10000,
        });
        // Add business pages that aren't already in the list
        for (const bizPage of bizPagesResponse.data.data || []) {
          if (!allPageData.find((p: any) => p.id === bizPage.id)) {
            allPageData.push(bizPage);
          }
        }
      } catch (e: any) {
        logger.warn(`[meta-oauth] Failed to get pages for business ${biz.id}`, { error: e.response?.data?.error?.message || e.message });
      }
    }
  } catch (e: any) {
    logger.warn('[meta-oauth] Failed to get businesses', { error: e.response?.data?.error?.message || e.message });
  }

  logger.debug('[meta-oauth] Total pages found', { pages: allPageData.map((p: any) => ({ id: p.id, name: p.name, tasks: p.tasks })) });

  const pages: MetaPage[] = [];

  for (const page of allPageData) {
    // Filter pages that have MESSAGING task
    if (!page.tasks?.includes('MESSAGING')) continue;

    const metaPage: MetaPage = {
      id: page.id,
      name: page.name,
      accessToken: page.access_token,
      picture: page.picture?.data?.url,
      tasks: page.tasks,
    };

    // Check for linked Instagram Business account
    if (page.instagram_business_account) {
      metaPage.instagramAccount = {
        id: page.instagram_business_account.id,
        username: page.instagram_business_account.username,
        profilePicUrl: page.instagram_business_account.profile_picture_url,
      };
    }

    pages.push(metaPage);
  }

  // 4. Create a signed session token containing page data (15-min expiry)
  const sessionToken = jwt.sign(
    { pages: pages.map((p) => ({ ...p, accessToken: undefined })) }, // Don't put tokens in session JWT
    config.meta.oauthJwtSecret,
    { expiresIn: '15m' },
  );

  // Stash page tokens for the short window between this callback and /connect.
  await Promise.all(pages.map((page) => cachePageToken(page.id, page.accessToken)));

  return { pages, sessionToken };
}

// Page tokens are cached in Redis so the OAuth callback and the subsequent
// /connect request resolve the same token even when they land on different
// instances. A module-level Map is kept only as a single-instance fallback when
// Redis is unavailable (graceful degradation, matching the rest of the app).
const PAGE_TOKEN_TTL_MS = 15 * 60 * 1000;
const pageTokenKey = (pageId: string) => `meta:page_token:${pageId}`;
const fallbackTokenCache = new Map<string, { accessToken: string; expiresAt: number }>();

async function cachePageToken(pageId: string, accessToken: string): Promise<void> {
  const redis = getRedisClient();
  if (redis) {
    try {
      await redis.set(pageTokenKey(pageId), accessToken, 'PX', PAGE_TOKEN_TTL_MS);
      return;
    } catch (err) {
      logger.warn('[meta-oauth] Redis set failed, using in-memory fallback', { error: err });
    }
  }
  fallbackTokenCache.set(pageId, { accessToken, expiresAt: Date.now() + PAGE_TOKEN_TTL_MS });
}

export async function getCachedPageToken(pageId: string): Promise<string | null> {
  const redis = getRedisClient();
  if (redis) {
    try {
      const token = await redis.get(pageTokenKey(pageId));
      if (token) return token;
    } catch (err) {
      logger.warn('[meta-oauth] Redis get failed, using in-memory fallback', { error: err });
    }
  }
  const cached = fallbackTokenCache.get(pageId);
  if (!cached || cached.expiresAt < Date.now()) {
    fallbackTokenCache.delete(pageId);
    return null;
  }
  return cached.accessToken;
}

/**
 * Get the pages available from a session token.
 */
export function getSessionPages(sessionToken: string): MetaPage[] {
  const decoded = jwt.verify(sessionToken, config.meta.oauthJwtSecret) as { pages: MetaPage[] };
  return decoded.pages;
}
