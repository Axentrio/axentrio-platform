/**
 * FilePreview Component
 * Inline file preview without download
 */

import React from 'react';
import { FileText, Image, Video, Music, File } from 'lucide-react';
import { fileService } from '@services/fileService';
import { cn } from '@/lib/utils';

// Inline file attachment for chat messages
interface FileAttachmentProps {
  fileName: string;
  fileType: string;
  fileSize?: number;
  onClick?: () => void;
  className?: string;
}

export const FileAttachment: React.FC<FileAttachmentProps> = ({
  fileName,
  fileType,
  fileSize,
  onClick,
  className = '',
}) => {
  const getIcon = () => {
    if (fileType.startsWith('image/')) return <Image className="w-5 h-5" />;
    if (fileType.startsWith('video/')) return <Video className="w-5 h-5" />;
    if (fileType.startsWith('audio/')) return <Music className="w-5 h-5" />;
    if (fileType === 'application/pdf') return <FileText className="w-5 h-5" />;
    return <File className="w-5 h-5" />;
  };

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-3 px-3 py-2 bg-surface-3 hover:bg-surface-4 rounded-xl transition-colors text-left",
        className
      )}
    >
      <div className="flex-shrink-0 text-text-secondary">
        {getIcon()}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-text-secondary truncate">{fileName}</p>
        {!!fileSize && (
          <p className="text-xs text-text-muted">
            {fileService.formatFileSize(fileSize)}
          </p>
        )}
      </div>
    </button>
  );
};
