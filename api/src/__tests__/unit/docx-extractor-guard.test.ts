import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockLoad = vi.fn();
vi.mock('jszip', () => ({ default: { loadAsync: (...a: unknown[]) => mockLoad(...a) } }));

import {
  assertArchiveWithinLimits,
  MAX_ARCHIVE_ENTRIES,
  MAX_DECOMPRESSED_BYTES,
} from '../../knowledge/document-extractors/docx.extractor';

/** Build a JSZip-shaped `files` map with the given declared uncompressed sizes. */
function filesWith(sizes: number[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  sizes.forEach((s, i) => {
    out[`entry-${i}`] = { _data: { uncompressedSize: s } };
  });
  return out;
}

beforeEach(() => {
  mockLoad.mockReset();
});

describe('assertArchiveWithinLimits (#20 zip-bomb guard)', () => {
  it('passes a well-behaved archive', async () => {
    mockLoad.mockResolvedValue({ files: filesWith([1024, 2048, 4096]) });
    await expect(assertArchiveWithinLimits(Buffer.from('x'))).resolves.toBeUndefined();
  });

  it('rejects an archive with too many entries', async () => {
    mockLoad.mockResolvedValue({ files: filesWith(new Array(MAX_ARCHIVE_ENTRIES + 1).fill(1)) });
    await expect(assertArchiveWithinLimits(Buffer.from('x'))).rejects.toThrow(/archive entries exceeds/);
  });

  it('rejects an archive that declares an inflated decompressed size', async () => {
    // One entry claiming to expand past the cap — the classic deflate bomb.
    mockLoad.mockResolvedValue({ files: filesWith([MAX_DECOMPRESSED_BYTES + 1]) });
    await expect(assertArchiveWithinLimits(Buffer.from('x'))).rejects.toThrow(/decompressed size exceeds/);
  });

  it('sums entries and rejects once their total crosses the cap', async () => {
    const half = Math.ceil(MAX_DECOMPRESSED_BYTES / 2);
    mockLoad.mockResolvedValue({ files: filesWith([half, half, half]) });
    await expect(assertArchiveWithinLimits(Buffer.from('x'))).rejects.toThrow(/decompressed size exceeds/);
  });

  it('defers to mammoth when the buffer is not a readable zip', async () => {
    mockLoad.mockRejectedValue(new Error('End of data reached'));
    await expect(assertArchiveWithinLimits(Buffer.from('not a zip'))).resolves.toBeUndefined();
  });
});
