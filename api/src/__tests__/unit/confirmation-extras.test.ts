import { describe, it, expect, vi, beforeEach } from 'vitest';

const bsFindOne = vi.fn();

vi.mock('../../database/data-source', () => ({
  AppDataSource: {
    getRepository: () => ({ findOne: bsFindOne }),
  },
}));

vi.mock('../../utils/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../config/environment', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config/environment')>();
  return {
    ...actual,
    config: {
      ...actual.config,
      booking: { ...actual.config.booking, confirmationAttachmentMaxMb: 10 },
    },
  };
});

import {
  confirmationAttachmentMaxBytes,
  loadConfirmationExtras,
} from '../../booking/booking-providers/confirmation-extras';
import { TOTAL_MAX_BYTES } from '../../booking/booking-providers/booking-attachments';

describe('loadConfirmationExtras', () => {
  beforeEach(() => {
    bsFindOne.mockReset();
  });

  it('returns null when the Agent has no settings row', async () => {
    bsFindOne.mockResolvedValue(null);
    expect(await loadConfirmationExtras('bot-1')).toBeNull();
  });

  it('returns text-only with no attachments when only extra info is set', async () => {
    bsFindOne.mockResolvedValue({
      confirmationExtraInfo: '  Arrive 10 minutes early.  ',
      confirmationAttachments: [],
    });
    expect(await loadConfirmationExtras('bot-1')).toEqual({
      text: 'Arrive 10 minutes early.',
      attachments: [],
    });
  });

  it('skips a file over the per-file cap using the stored size', async () => {
    const perFile = confirmationAttachmentMaxBytes();
    bsFindOne.mockResolvedValue({
      confirmationExtraInfo: null,
      confirmationAttachments: [
        {
          id: '1',
          fileName: 'huge.pdf',
          mimeType: 'application/pdf',
          fileSize: perFile + 1,
          fileKey: 'k1',
          uploadedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
    const store = { getObjectBytes: vi.fn() };
    expect(await loadConfirmationExtras('bot-1', store)).toBeNull();
    expect(store.getObjectBytes).not.toHaveBeenCalled();
  });

  it('stops at the total budget when a second large file would exceed it', async () => {
    const chunk = Math.floor(TOTAL_MAX_BYTES / 2) + 1;
    bsFindOne.mockResolvedValue({
      confirmationExtraInfo: null,
      confirmationAttachments: [
        {
          id: '1',
          fileName: 'a.pdf',
          mimeType: 'application/pdf',
          fileSize: chunk,
          fileKey: 'k1',
          uploadedAt: '2026-01-01T00:00:00.000Z',
        },
        {
          id: '2',
          fileName: 'b.pdf',
          mimeType: 'application/pdf',
          fileSize: chunk,
          fileKey: 'k2',
          uploadedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
    const store = {
      getObjectBytes: vi
        .fn()
        .mockResolvedValueOnce(Buffer.alloc(chunk))
        .mockResolvedValueOnce(Buffer.alloc(chunk)),
    };
    const out = await loadConfirmationExtras('bot-1', store);
    expect(out?.attachments).toHaveLength(1);
    expect(out?.attachments[0].filename).toBe('a.pdf');
  });

  it('skips an unreadable file and keeps the rest', async () => {
    bsFindOne.mockResolvedValue({
      confirmationExtraInfo: 'Parking is behind the building.',
      confirmationAttachments: [
        {
          id: '1',
          fileName: 'bad.pdf',
          mimeType: 'application/pdf',
          fileSize: 100,
          fileKey: 'k1',
          uploadedAt: '2026-01-01T00:00:00.000Z',
        },
        {
          id: '2',
          fileName: 'good.pdf',
          mimeType: 'application/pdf',
          fileSize: 100,
          fileKey: 'k2',
          uploadedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
    const store = {
      getObjectBytes: vi
        .fn()
        .mockRejectedValueOnce(new Error('s3 down'))
        .mockResolvedValueOnce(Buffer.from('%PDF')),
    };
    const out = await loadConfirmationExtras('bot-1', store);
    expect(out?.text).toBe('Parking is behind the building.');
    expect(out?.attachments).toHaveLength(1);
    expect(out?.attachments[0].filename).toBe('good.pdf');
  });
});
