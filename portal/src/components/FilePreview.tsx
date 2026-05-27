/**
 * FilePreview Component
 * Inline file preview without download
 */

import React, { useState } from 'react';
import { X, FileText, Image, Video, Music, File } from 'lucide-react';
import { fileService } from '@services/fileService';
import { Card, CardHeader, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface FilePreviewProps {
  fileUrl: string;
  fileName: string;
  fileType: string;
  fileSize?: number;
  onClose?: () => void;
  className?: string;
}

export const FilePreview: React.FC<FilePreviewProps> = ({
  fileUrl,
  fileName,
  fileType,
  fileSize,
  onClose,
  className = '',
}) => {
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const isImage = fileType.startsWith('image/');
  const isVideo = fileType.startsWith('video/');
  const isAudio = fileType.startsWith('audio/');
  const isPDF = fileType === 'application/pdf';

  const getFileIcon = () => {
    const iconClass = "w-16 h-16 text-text-muted";
    if (isImage) return <Image className={iconClass} />;
    if (isVideo) return <Video className={iconClass} />;
    if (isAudio) return <Music className={iconClass} />;
    if (isPDF) return <FileText className={iconClass} />;
    return <File className={iconClass} />;
  };

  const renderPreview = () => {
    if (isImage) {
      return (
        <div className="relative">
          {isLoading && (
            <div className="flex items-center justify-center h-64 bg-surface-3 rounded-xl">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600" />
            </div>
          )}
          <img
            src={fileUrl}
            alt={fileName}
            className={`max-w-full max-h-96 object-contain rounded-xl ${isLoading ? 'hidden' : ''}`}
            onLoad={() => setIsLoading(false)}
            onError={() => {
              setIsLoading(false);
              setError('Failed to load image');
            }}
          />
        </div>
      );
    }

    if (isVideo) {
      return (
        <video
          src={fileUrl}
          controls
          className="max-w-full max-h-96 rounded-xl"
          onLoadedData={() => setIsLoading(false)}
          onError={() => {
            setIsLoading(false);
            setError('Failed to load video');
          }}
        >
          Your browser does not support the video tag.
        </video>
      );
    }

    if (isAudio) {
      return (
        <div className="flex flex-col items-center p-8 bg-surface-1 rounded-xl">
          <Music className="w-16 h-16 text-text-muted mb-4" />
          <audio
            src={fileUrl}
            controls
            className="w-full max-w-md"
            onLoadedData={() => setIsLoading(false)}
            onError={() => {
              setIsLoading(false);
              setError('Failed to load audio');
            }}
          >
            Your browser does not support the audio tag.
          </audio>
        </div>
      );
    }

    if (isPDF) {
      return (
        <div className="relative bg-surface-1 rounded-xl overflow-hidden">
          {isLoading && (
            <div className="flex items-center justify-center h-96">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600" />
            </div>
          )}
          <iframe
            src={`${fileUrl}#toolbar=0&navpanes=0`}
            title={fileName}
            className={`w-full h-96 border-0 ${isLoading ? 'hidden' : ''}`}
            onLoad={() => setIsLoading(false)}
            onError={() => {
              setIsLoading(false);
              setError('Failed to load PDF');
            }}
          />
        </div>
      );
    }

    // Generic file preview
    return (
      <div className="flex flex-col items-center justify-center p-12 bg-surface-1 rounded-xl">
        {getFileIcon()}
        <p className="mt-4 text-text-secondary text-center">
          Preview not available for this file type
        </p>
      </div>
    );
  };

  return (
    <Card variant="glass" className={cn("overflow-hidden", className)}>
      <CardHeader className="flex-row items-center justify-between gap-3 px-4 py-3 space-y-0 border-b border-edge">
        <div className="flex items-center gap-3 min-w-0">
          {getFileIcon()}
          <div className="min-w-0">
            <p className="font-medium text-text-primary truncate">{fileName}</p>
            {fileSize && (
              <p className="text-sm text-text-secondary">
                {fileService.formatFileSize(fileSize)}
              </p>
            )}
          </div>
        </div>
        {onClose && (
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            className="text-text-muted hover:text-text-secondary"
          >
            <X className="w-5 h-5" />
          </Button>
        )}
      </CardHeader>

      <CardContent className="p-4">
        {error ? (
          <div className="flex flex-col items-center justify-center p-8 text-text-secondary">
            <File className="w-16 h-16 text-text-muted mb-4" />
            <p>{error}</p>
          </div>
        ) : (
          renderPreview()
        )}
      </CardContent>
    </Card>
  );
};

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
        {fileSize && (
          <p className="text-xs text-text-muted">
            {fileService.formatFileSize(fileSize)}
          </p>
        )}
      </div>
    </button>
  );
};

export default FilePreview;
