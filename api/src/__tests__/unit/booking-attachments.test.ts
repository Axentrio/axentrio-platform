/**
 * `buildOwnerFileAttachments` — the customer's uploaded files as owner-email
 * attachments. Pins the policy: clean-only (`status === 'ready'`), per-file and
 * total size caps, order preserved, and best-effort (one unreadable file never
 * stops the rest).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  buildOwnerFileAttachments,
  type UploadedFileStore,
} from '../../booking/booking-providers/booking-attachments';

type Session = NonNullable<Awaited<ReturnType<UploadedFileStore['getSession']>>>;

function ready(overrides: Partial<Session> = {}): Session {
  return {
    status: 'ready',
    fileKey: 'uploads/t/f.png',
    originalName: 'f.png',
    mimeType: 'image/png',
    fileSize: 10,
    scanResult: { clean: true },
    ...overrides,
  };
}

/** A store backed by a map of id -> session, with byte content derived from the key. */
function storeOf(
  sessions: Record<string, Session | undefined>,
  bytesByKey: Record<string, Buffer> = {},
): UploadedFileStore {
  return {
    getSession: vi.fn(async (id: string) => sessions[id]),
    getObjectBytes: vi.fn(async (key: string) => bytesByKey[key] ?? Buffer.from('x')),
  };
}

describe('buildOwnerFileAttachments', () => {
  it('returns [] for no ids', async () => {
    expect(await buildOwnerFileAttachments([], storeOf({}))).toEqual([]);
  });

  it('attaches a ready+clean file as base64 with its content type, order preserved', async () => {
    const store = storeOf(
      {
        a: ready({ fileKey: 'k/a', originalName: 'a.pdf', mimeType: 'application/pdf' }),
        b: ready({ fileKey: 'k/b', originalName: 'b.png', mimeType: 'image/png' }),
      },
      { 'k/a': Buffer.from('AAA'), 'k/b': Buffer.from('BB') },
    );
    const out = await buildOwnerFileAttachments(['a', 'b'], store);
    expect(out).toEqual([
      { filename: 'a.pdf', content: Buffer.from('AAA').toString('base64'), contentType: 'application/pdf' },
      { filename: 'b.png', content: Buffer.from('BB').toString('base64'), contentType: 'image/png' },
    ]);
  });

  it('skips files that are not ready or not clean', async () => {
    const store = storeOf({
      scanning: ready({ status: 'scanning' }),
      quarantined: ready({ status: 'quarantined' }),
      unclean: ready({ scanResult: { clean: false } }),
      good: ready({ fileKey: 'k/g', originalName: 'g.png' }),
      missing: undefined,
    });
    const out = await buildOwnerFileAttachments(['scanning', 'quarantined', 'unclean', 'missing', 'good'], store);
    expect(out.map((a) => a.filename)).toEqual(['g.png']);
  });

  it('skips a file over the per-file cap (10MB)', async () => {
    const store = storeOf({
      big: ready({ fileSize: 11 * 1024 * 1024 }),
      ok: ready({ fileKey: 'k/ok', originalName: 'ok.png', fileSize: 100 }),
    });
    const out = await buildOwnerFileAttachments(['big', 'ok'], store);
    expect(out.map((a) => a.filename)).toEqual(['ok.png']);
  });

  it('does not download a file over the declared per-file cap', async () => {
    const store = storeOf({
      big: ready({ fileKey: 'k/big', fileSize: 11 * 1024 * 1024 }),
    });
    await buildOwnerFileAttachments(['big'], store);
    expect(store.getObjectBytes).not.toHaveBeenCalled();
  });

  it('skips a file whose downloaded bytes exceed the per-file cap', async () => {
    const store = storeOf(
      { lie: ready({ fileKey: 'k/lie', originalName: 'lie.bin', fileSize: 100 }) },
      { 'k/lie': Buffer.alloc(11 * 1024 * 1024) },
    );
    const out = await buildOwnerFileAttachments(['lie'], store);
    expect(out).toEqual([]);
  });

  it('stops attaching once the total budget (15MB) is reached but keeps earlier files', async () => {
    const store = storeOf({
      first: ready({ fileKey: 'k/1', originalName: '1.bin', fileSize: 9 * 1024 * 1024 }),
      second: ready({ fileKey: 'k/2', originalName: '2.bin', fileSize: 9 * 1024 * 1024 }),
    });
    const out = await buildOwnerFileAttachments(['first', 'second'], store);
    expect(out.map((a) => a.filename)).toEqual(['1.bin']);
  });

  it('is non-fatal: an unreadable file is skipped, the rest still attach', async () => {
    const store = storeOf({
      bad: ready({ fileKey: 'k/bad', originalName: 'bad.png' }),
      good: ready({ fileKey: 'k/good', originalName: 'good.png' }),
    });
    (store.getObjectBytes as ReturnType<typeof vi.fn>).mockImplementation(async (key: string) => {
      if (key === 'k/bad') throw new Error('S3 down');
      return Buffer.from('ok');
    });
    const out = await buildOwnerFileAttachments(['bad', 'good'], store);
    expect(out.map((a) => a.filename)).toEqual(['good.png']);
  });
});
