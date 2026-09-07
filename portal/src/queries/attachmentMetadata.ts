import type { Message } from '@app-types/index';

/** Inbox list preview: prefer text, fall back to attachment file name. */
export function messagePreviewText(
  message: Pick<Message, 'content' | 'fileName'>,
  maxLen = 80,
): string {
  const text = message.content?.trim() ?? '';
  if (text) return text.substring(0, maxLen);
  if (message.fileName) return message.fileName.substring(0, maxLen);
  return '';
}

/** True when the bubble should render as an attachment, not plain text. */
export function messageHasAttachment(message: Pick<Message, 'type' | 'uploadSessionId' | 'fileUrl'>): boolean {
  return (
    !!message.uploadSessionId ||
    !!message.fileUrl ||
    message.type === 'image' ||
    message.type === 'file' ||
    message.type === 'audio' ||
    message.type === 'video'
  );
}

/** Attachment facts live in message.metadata on every wire shape (REST detail, thread, socket). */
export function attachmentFieldsFromMetadata(
  metadata: Record<string, unknown> | undefined | null,
): Pick<Message, 'fileName' | 'fileSize' | 'fileType' | 'uploadSessionId'> {
  if (!metadata) return {};
  const out: Pick<Message, 'fileName' | 'fileSize' | 'fileType' | 'uploadSessionId'> = {};
  if (typeof metadata.fileName === 'string') out.fileName = metadata.fileName;
  if (typeof metadata.fileSize === 'number') out.fileSize = metadata.fileSize;
  if (typeof metadata.fileType === 'string') out.fileType = metadata.fileType;
  if (typeof metadata.uploadSessionId === 'string') out.uploadSessionId = metadata.uploadSessionId;
  return out;
}
