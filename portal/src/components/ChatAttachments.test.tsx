import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Message } from '@app-types/index';
import { MessageAttachment } from './ChatAttachments';

vi.mock('../services/fileService', () => ({
  openFileDownload: vi.fn(),
  fileService: {
    formatFileSize: (bytes: number) => `${bytes} B`,
  },
}));

vi.mock('../services/apiClient', () => ({
  api: { get: vi.fn() },
}));

vi.mock('../queries/useEntitlementsQueries', () => ({
  useHasFeature: () => true,
}));

function wrap(ui: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe('MessageAttachment', () => {
  it('renders file name for file attachments', () => {
    const message: Message = {
      id: 'm1',
      chatId: 'c1',
      type: 'file',
      content: '',
      sender: 'agent',
      isRead: true,
      createdAt: new Date().toISOString(),
      fileName: 'report.pdf',
      fileType: 'application/pdf',
      fileSize: 1024,
      uploadSessionId: '00000000-0000-4000-8000-000000000001',
    };
    wrap(<MessageAttachment message={message} />);
    expect(screen.getByText('report.pdf')).toBeInTheDocument();
  });
});
