/**
 * Single source of truth for the Meta Graph API version used across all
 * Meta-family channels (Messenger, Instagram, WhatsApp).
 *
 * Bump this one constant to migrate every channel at once. Current stable is
 * v25.0 (released 2026-02-18); Meta deprecates a version ~2 years after the
 * next one ships, so re-check https://developers.facebook.com/docs/graph-api/changelog
 * before a major bump.
 */
export const META_GRAPH_VERSION = 'v25.0';

/** Graph API host for Facebook/Messenger and WhatsApp Cloud API calls. */
export const FB_GRAPH_API = `https://graph.facebook.com/${META_GRAPH_VERSION}`;

/** Graph API host for the Instagram-Login messaging path. */
export const IG_GRAPH_API = `https://graph.instagram.com/${META_GRAPH_VERSION}`;

/** Facebook Login OAuth dialog endpoint. */
export const FB_OAUTH_DIALOG = `https://www.facebook.com/${META_GRAPH_VERSION}/dialog/oauth`;
