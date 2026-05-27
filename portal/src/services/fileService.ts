/**
 * File Service
 *
 * Display-side file utilities. The upload/download/preview methods that
 * used to live here have been deleted because no portal code consumed
 * them — the actual file-upload flow the portal supports goes through
 * `useKnowledgeQueries.useUploadFile()` → `/knowledge/documents/upload`,
 * not `/files/*`. The widget has its own (currently broken) upload path
 * — see `chatbot-platform/docs/widget-file-upload-status.md` for the
 * follow-up plan.
 *
 * Only `formatFileSize` remains because `FilePreview.tsx` uses it to
 * render attachment metadata in the chat UI.
 */

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

export default fileService;
