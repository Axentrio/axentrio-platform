import { api, extractApiErrorMessage } from '../services/apiClient';

export const CHAT_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

export const CHAT_ATTACHMENT_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'video/mp4',
  'video/quicktime',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
];

export interface ChatAttachmentDraft {
  uploadSessionId: string;
  fileName: string;
  fileSize: number;
  fileType: string;
}

export type ChatAttachmentError = 'too_large' | 'unsupported_type' | 'rejected' | 'failed';

export class ChatAttachmentUploadError extends Error {
  code: ChatAttachmentError;
  detail?: string;

  constructor(code: ChatAttachmentError, detail?: string) {
    super(code);
    this.code = code;
    this.detail = detail;
  }
}

export async function uploadChatAttachment(chatId: string, file: File): Promise<ChatAttachmentDraft> {
  if (file.size > CHAT_ATTACHMENT_MAX_BYTES) {
    throw new ChatAttachmentUploadError('too_large');
  }
  if (!CHAT_ATTACHMENT_MIME_TYPES.includes(file.type)) {
    throw new ChatAttachmentUploadError('unsupported_type');
  }

  try {
    const { upload } = await api.post<{ upload: { sessionId: string } }>('/files/upload', {
      fileName: file.name,
      fileSize: file.size,
      mimeType: file.type,
      sessionId: chatId,
    });

    await api.post(`/files/${upload.sessionId}/content`, file, {
      headers: { 'Content-Type': file.type },
      timeout: 120_000,
    });

    const complete = await api.post<{ status: string }>(`/files/${upload.sessionId}/upload-complete`);
    if (complete.status !== 'ready') {
      throw new ChatAttachmentUploadError('rejected');
    }

    return {
      uploadSessionId: upload.sessionId,
      fileName: file.name,
      fileSize: file.size,
      fileType: file.type,
    };
  } catch (err) {
    if (err instanceof ChatAttachmentUploadError) throw err;
    throw new ChatAttachmentUploadError('failed', extractApiErrorMessage(err));
  }
}
