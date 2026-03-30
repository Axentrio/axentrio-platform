import axios from 'axios';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { config } from '../../config/environment';

const GRAPH_API = 'https://graph.facebook.com/v21.0';

// Scopes must be added to the app in Meta Developer Console before requesting.
// Start with core messaging scopes; add instagram scopes after enabling in console.
const OAUTH_SCOPES = [
  'pages_messaging',
  'pages_manage_metadata',
  'pages_show_list',
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
  });

  return `https://www.facebook.com/v21.0/dialog/oauth?${params.toString()}`;
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

  // 3. Get pages the user manages
  const pagesResponse = await axios.get(`${GRAPH_API}/me/accounts`, {
    params: {
      access_token: longLivedUserToken,
      fields: 'id,name,access_token,picture,tasks,instagram_business_account{id,username,profile_picture_url}',
      limit: 100,
    },
    timeout: 10000,
  });

  const pages: MetaPage[] = [];

  for (const page of pagesResponse.data.data || []) {
    // Filter pages that have MESSAGING task
    if (!page.tasks?.includes('MESSAGING')) continue;

    const metaPage: MetaPage = {
      id: page.id,
      name: page.name,
      accessToken: page.access_token, // Long-lived page token (does not expire)
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

  // Store page tokens temporarily in memory (keyed by page ID)
  // In production, use Redis. For now, module-level Map with TTL.
  for (const page of pages) {
    pageTokenCache.set(page.id, {
      accessToken: page.accessToken,
      expiresAt: Date.now() + 15 * 60 * 1000,
    });
  }

  return { pages, sessionToken };
}

// TODO: Replace with Redis for multi-instance deployments.
// Currently, OAuth callback and /connect may hit different instances,
// causing "No valid pages found" errors with multiple replicas.
const pageTokenCache = new Map<string, { accessToken: string; expiresAt: number }>();

export function getCachedPageToken(pageId: string): string | null {
  const cached = pageTokenCache.get(pageId);
  if (!cached || cached.expiresAt < Date.now()) {
    pageTokenCache.delete(pageId);
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
