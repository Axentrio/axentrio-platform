/**
 * File Service
 *
 * Display-side file utilities for chat attachments and file metadata.
 */

import { api, extractApiErrorMessage } from './apiClient';
import { toast } from 'sonner';

/** Fetch a fresh signed URL for an attached file and open it (404 if removed). */
export async function openFileDownload(fileSessionId: string): Promise<void> {
  try {
    const { downloadUrl } = await api.get<{ downloadUrl: string }>(`/files/${fileSessionId}/download`);
    window.open(downloadUrl, '_blank', 'noopener');
  } catch (err) {
    toast.error(extractApiErrorMessage(err) ?? 'File is no longer available');
  }
}

export const fileService = {
  // Format file size for display.
  formatFileSize: (bytes: number): string => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  },
};

