/**
 * Inbound image → vision content-part resolution, per channel.
 *
 * Messenger/Instagram expose a directly-fetchable CDN fileUrl; WhatsApp
 * exposes a token-gated media id that must be resolved through the Graph API.
 * All paths are best-effort: any failure returns null so the turn degrades to
 * text-only rather than erroring the whole reply.
 */
import { safeOutboundRequest } from '../security/ssrf-guard';
import { logger } from '../utils/logger';
import { AppDataSource } from '../database/data-source';
import { ConversationBinding } from '../database/entities/ConversationBinding';
import { ChannelConnection } from '../database/entities/ChannelConnection';
import type { Message } from '../database/entities/Message';
import type { ChatSession } from '../database/entities/ChatSession';
import type { AgentImageInput } from '../agent/agent.service';
import { getWhatsAppAccessToken } from '../channels/credential-utils';
import { FB_GRAPH_API } from '../channels/meta/graph-api';

// Anthropic caps a single base64 image near 5 MB; stay under that.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
// sharp's detected format → the MIME both LLM providers (Anthropic + OpenAI) accept.
const IMAGE_FORMAT_TO_MIME: Record<string, string> = {
  jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
};

// Download an image URL → base64 content part for the vision model.
//
// Uses the SAME mechanism as inbound-media ingestion
// (`UploadService.ingestRemoteFile`): the SSRF-guarded axios path with MANUAL
// redirect following. A bare `fetch()` does NOT reliably retrieve Meta CDN URLs
// from the prod datacenter — they 302-redirect (lookaside → scontent) and the
// CDN rejects the default client. Following redirects manually also lets us
// re-apply `authHeader` on every hop (axios drops Authorization across hosts) —
// required for WhatsApp media, whose download URLs are token-gated. Format is
// sniffed with sharp (authoritative), not the content-type header.
//
// Best-effort: returns null on any failure so the turn degrades to text-only
// rather than erroring the whole reply. The sharp import stays lazy so the
// native dep never lands on this hot module's load path.
export async function downloadInboundMediaBytes(
  url: string,
  authHeader?: Record<string, string>,
  maxBytes = MAX_IMAGE_BYTES,
): Promise<Buffer | null> {
  try {
    let current = url;
    let response: Awaited<ReturnType<typeof safeOutboundRequest>> | undefined;
    for (let hop = 0; hop < 4; hop++) {
      response = await safeOutboundRequest({
        url: current,
        method: 'GET',
        responseType: 'arraybuffer',
        headers: authHeader,
        timeout: 15_000,
        maxContentLength: maxBytes,
        maxBodyLength: maxBytes,
      });
      if (response.status >= 300 && response.status < 400) {
        const location = (response.headers as Record<string, string> | undefined)?.location;
        if (!location) break;
        current = new URL(location, current).toString();
        response = undefined;
        continue;
      }
      break;
    }
    if (!response || response.status < 200 || response.status >= 300) {
      logger.warn(`Inbound media fetch failed (status ${response?.status ?? 'redirect-no-location'})`);
      return null;
    }
    const buf = Buffer.from(response.data as ArrayBuffer);
    if (buf.byteLength === 0 || buf.byteLength > maxBytes) {
      logger.warn(`Inbound media rejected (size ${buf.byteLength}B)`);
      return null;
    }
    return buf;
  } catch (error) {
    logger.warn('Inbound media fetch threw', { error });
    return null;
  }
}

async function downloadImageAsContentPart(
  url: string,
  label: string,
  authHeader?: Record<string, string>,
): Promise<AgentImageInput | null> {
  try {
    const buf = await downloadInboundMediaBytes(url, authHeader, MAX_IMAGE_BYTES);
    if (!buf) return null;
    // Authoritative format sniff via sharp.
    const sharp = (await import('sharp')).default;
    let format: string | undefined;
    try {
      format = (await sharp(buf).metadata()).format;
    } catch {
      format = undefined;
    }
    const mimeType = format ? IMAGE_FORMAT_TO_MIME[format] : undefined;
    if (!mimeType) {
      logger.warn(`${label} image format '${format ?? 'unknown'}' unsupported — answering without vision`);
      return null;
    }
    return { mimeType, data: buf.toString('base64') };
  } catch (error) {
    logger.warn(`${label} image fetch threw — answering without vision`, { error });
    return null;
  }
}

// Messenger/Instagram: the stored fileUrl is a directly-fetchable CDN URL.
function fetchInboundImageForAgent(url: string): Promise<AgentImageInput | null> {
  return downloadImageAsContentPart(url, 'Inbound');
}

export async function resolveWhatsAppMediaUrl(
  sessionId: string,
  mediaId: string,
): Promise<{ url: string; authHeader: Record<string, string> } | null> {
  try {
    const binding = await AppDataSource.getRepository(ConversationBinding).findOne({
      where: { sessionId },
      select: { channelConnectionId: true },
    });
    if (!binding) {
      logger.warn('WhatsApp media: no conversation binding for session');
      return null;
    }
    const connection = await AppDataSource.getRepository(ChannelConnection).findOne({
      where: { id: binding.channelConnectionId },
    });
    const accessToken = connection ? getWhatsAppAccessToken(connection.credentials) : null;
    if (!accessToken) {
      logger.warn('WhatsApp media: no access token on connection');
      return null;
    }
    const authHeader = { Authorization: `Bearer ${accessToken}` };
    let mediaUrl: string | undefined;
    try {
      const meta = await safeOutboundRequest({
        url: `${FB_GRAPH_API}/${encodeURIComponent(mediaId)}`,
        method: 'GET',
        headers: authHeader,
        timeout: 15_000,
      });
      mediaUrl = (meta.data as { url?: string } | undefined)?.url;
    } catch (error) {
      logger.warn('WhatsApp media: media-id resolve failed', { error });
      return null;
    }
    if (!mediaUrl) {
      logger.warn('WhatsApp media: media-id resolve returned no url');
      return null;
    }
    return { url: mediaUrl, authHeader };
  } catch (error) {
    logger.warn('WhatsApp media resolve threw', { error });
    return null;
  }
}

async function fetchWhatsAppImageForAgent(sessionId: string, mediaId: string): Promise<AgentImageInput | null> {
  const resolved = await resolveWhatsAppMediaUrl(sessionId, mediaId);
  if (!resolved) return null;
  return downloadImageAsContentPart(resolved.url, 'WhatsApp', resolved.authHeader);
}

// Resolve an inbound image message into a vision content part, picking the right
// download path per channel: Messenger/IG expose a fetchable fileUrl; WhatsApp
// exposes a token-gated media id in customData. Returns null for non-images and
// on any failure (caller falls back to a text placeholder).
export async function resolveInboundImage(pending: Message, session: ChatSession): Promise<AgentImageInput | null> {
  if (pending.type !== 'image') return null;
  if (pending.metadata?.fileUrl) {
    return fetchInboundImageForAgent(pending.metadata.fileUrl);
  }
  if (session.channel === 'whatsapp') {
    const mediaId = (pending.metadata?.customData as Record<string, unknown> | undefined)?.mediaId;
    if (typeof mediaId === 'string' && mediaId) {
      return fetchWhatsAppImageForAgent(session.id, mediaId);
    }
  }
  return null;
}
