/**
 * File Service
 * API methods for file operations
 */

import { api } from './apiClient';
import { ENDPOINTS } from '@config/api.config';
import type { ApiResponse } from '@app-types/index';

interface UploadResponse {
  fileId: string;
  url: string;
  name: string;
  type: string;
  size: number;
}

interface PreviewResponse {
  url: string;
  name: string;
  type: string;
  size: number;
}

export const fileService = {
  // Upload file
  uploadFile: async (file: File, onProgress?: (progress: number) => void): Promise<ApiResponse<UploadResponse>> => {
    const formData = new FormData();
    formData.append('file', file);

    return api.post(ENDPOINTS.files.upload, formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
      onUploadProgress: (progressEvent) => {
        if (onProgress && progressEvent.total) {
          const progress = Math.round((progressEvent.loaded * 100) / progressEvent.total);
          onProgress(progress);
        }
      },
    });
  },

  // Get file preview URL
  getPreview: async (fileId: string): Promise<ApiResponse<PreviewResponse>> => {
    return api.get(ENDPOINTS.files.preview(fileId));
  },

  // Download file
  downloadFile: async (fileId: string, fileName?: string): Promise<void> => {
    const response = await fetch(`${ENDPOINTS.files.download(fileId)}`, {
      headers: {
        Authorization: `Bearer ${localStorage.getItem('handsoff_access_token')}`,
      },
    });

    if (!response.ok) {
      throw new Error('Failed to download file');
    }

    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName || 'download';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.URL.revokeObjectURL(url);
  },

  // Validate file
  validateFile: (file: File, allowedTypes?: string[], maxSize?: number): { valid: boolean; error?: string } => {
    // Check file size (default 10MB)
    const maxFileSize = maxSize || 10 * 1024 * 1024;
    if (file.size > maxFileSize) {
      return { valid: false, error: `File size exceeds ${maxFileSize / 1024 / 1024}MB limit` };
    }

    // Check file type if specified
    if (allowedTypes && allowedTypes.length > 0) {
      const isAllowed = allowedTypes.some((type) => {
        if (type.endsWith('/*')) {
          return file.type.startsWith(type.replace('/*', ''));
        }
        return file.type === type;
      });

      if (!isAllowed) {
        return { valid: false, error: 'File type not allowed' };
      }
    }

    return { valid: true };
  },

  // Get file icon based on type
  getFileIcon: (fileType: string): string => {
    if (fileType.startsWith('image/')) return 'image';
    if (fileType.startsWith('video/')) return 'video';
    if (fileType.startsWith('audio/')) return 'audio';
    if (fileType === 'application/pdf') return 'pdf';
    if (fileType.includes('word')) return 'word';
    if (fileType.includes('excel') || fileType.includes('spreadsheet')) return 'excel';
    if (fileType.includes('powerpoint') || fileType.includes('presentation')) return 'powerpoint';
    return 'file';
  },

  // Format file size
  formatFileSize: (bytes: number): string => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  },
};

export default fileService;
