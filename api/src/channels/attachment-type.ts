import type { ChannelCapabilities } from './types';

export type OutboundAttachmentType = 'image' | 'video' | 'audio' | 'file';

export function outboundAttachmentType(mimeType: string): OutboundAttachmentType {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  return 'file';
}

export function channelSupportsAttachment(
  caps: ChannelCapabilities,
  type: OutboundAttachmentType,
): boolean {
  switch (type) {
    case 'image':
      return caps.supportsImages;
    case 'video':
      return caps.supportsVideo;
    case 'audio':
      return caps.supportsAudio;
    case 'file':
      return caps.supportsFiles;
  }
}
