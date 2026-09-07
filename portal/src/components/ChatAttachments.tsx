import type React from 'react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Paperclip } from 'lucide-react';
import type { Message } from '@app-types/index';
import { api } from '../services/apiClient';
import { queryKeys } from '../queries/queryKeys';
import { useHasFeature } from '../queries/useEntitlementsQueries';
import { FileAttachment } from './FilePreview';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { openFileDownload } from '../services/fileService';
import { CHAT_ATTACHMENT_MIME_TYPES } from '../queries/useChatAttachment';

export const MessageAttachment: React.FC<{ message: Message }> = ({ message }) => {
  const { t } = useTranslation();
  const uploadSessionId = message.uploadSessionId;
  const isImage = message.type === 'image';

  const preview = useQuery({
    queryKey: queryKeys.files.preview(uploadSessionId ?? ''),
    queryFn: () => api.get<{ previewUrl: string }>(`/files/${uploadSessionId}/preview`),
    enabled: isImage && !!uploadSessionId,
    staleTime: 50 * 60_000,
  });

  if (isImage && uploadSessionId && preview.data?.previewUrl) {
    return (
      <ImageAttachmentPreview
        previewUrl={preview.data.previewUrl}
        fileName={message.fileName}
      />
    );
  }

  if (isImage && uploadSessionId && (preview.isLoading || preview.isError)) {
    return (
      <FileAttachment
        fileName={message.fileName || t('inbox.window.message.file')}
        fileType={message.fileType || 'application/octet-stream'}
        fileSize={message.fileSize}
        onClick={() => openFileDownload(uploadSessionId)}
      />
    );
  }

  if (isImage && message.fileUrl) {
    return (
      <img
        src={message.fileUrl}
        alt={message.fileName || t('inbox.window.message.image')}
        className="max-w-48 max-h-48 rounded-lg object-cover"
      />
    );
  }

  return (
    <FileAttachment
      fileName={message.fileName || t('inbox.window.message.file')}
      fileType={message.fileType || 'application/octet-stream'}
      fileSize={message.fileSize}
      onClick={uploadSessionId ? () => openFileDownload(uploadSessionId) : undefined}
    />
  );
};

function ImageAttachmentPreview({
  previewUrl,
  fileName,
}: {
  previewUrl: string;
  fileName?: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="block overflow-hidden rounded-lg border border-edge hover:border-primary-500"
        aria-label={t('inbox.window.message.openImage')}
      >
        <img
          src={previewUrl}
          alt={fileName || t('inbox.window.message.image')}
          className="max-w-48 max-h-48 object-cover"
        />
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-3xl p-2">
          <DialogTitle className="sr-only">{fileName || t('inbox.window.message.image')}</DialogTitle>
          <img
            src={previewUrl}
            alt={fileName || t('inbox.window.message.image')}
            className="max-h-[80vh] w-full object-contain"
          />
        </DialogContent>
      </Dialog>
    </>
  );
}

export const AttachButton: React.FC<{
  chatId: string;
  disabled: boolean;
  onPicked: (file: File) => void;
}> = ({ chatId, disabled, onPicked }) => {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const allowed = useHasFeature('fileUpload');

  if (!allowed) return null;

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        disabled={disabled}
        className="text-text-secondary hover:text-text-primary hover:bg-surface-3 rounded-xl flex-shrink-0"
        title={t('inbox.window.composer.attach')}
        aria-label={t('inbox.window.composer.attach')}
        onClick={() => inputRef.current?.click()}
      >
        <Paperclip className="w-5 h-5" />
      </Button>
      <input
        ref={inputRef}
        type="file"
        accept={CHAT_ATTACHMENT_MIME_TYPES.join(',')}
        data-testid="chat-attach-input"
        data-chat-id={chatId}
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onPicked(file);
          e.target.value = '';
        }}
      />
    </>
  );
};
