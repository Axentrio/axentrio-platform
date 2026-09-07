import type { Message } from '@app-types/index';

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
