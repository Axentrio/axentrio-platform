/**
 * useFilePreview Hook
 * Manages file preview functionality
 */

import { useState, useCallback } from 'react';
import { api } from '@services/apiClient';
import type { FilePreview } from '@app-types/index';

interface UseFilePreviewReturn {
  previewFile: FilePreview | null;
  isOpen: boolean;
  isLoading: boolean;
  error: string | null;
  openPreview: (fileId: string, fileName: string, fileType: string) => Promise<void>;
  closePreview: () => void;
}

export const useFilePreview = (): UseFilePreviewReturn => {
  const [previewFile, setPreviewFile] = useState<FilePreview | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const openPreview = useCallback(async (fileId: string, fileName: string, fileType: string) => {
    setIsLoading(true);
    setError(null);
    
    try {
      // Fetch file metadata and preview URL
      const data = await api.get<{ url: string; size?: number }>(`/files/${fileId}/preview`);
      
      setPreviewFile({
        url: data.url,
        name: fileName,
        type: fileType,
        size: data.size || 0,
      });
      setIsOpen(true);
    } catch (err: any) {
      setError(err.message || 'Failed to load file preview');
    } finally {
      setIsLoading(false);
    }
  }, []);

  const closePreview = useCallback(() => {
    setIsOpen(false);
    // Delay clearing the preview to allow for exit animation
    setTimeout(() => {
      setPreviewFile(null);
      setError(null);
    }, 300);
  }, []);

  return {
    previewFile,
    isOpen,
    isLoading,
    error,
    openPreview,
    closePreview,
  };
};

export default useFilePreview;
