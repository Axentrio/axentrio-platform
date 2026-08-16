import mammoth from 'mammoth';
import JSZip from 'jszip';
import TurndownService from 'turndown';
// @ts-ignore — turndown-plugin-gfm has no types
import { gfm } from 'turndown-plugin-gfm';

const turndown = new TurndownService({
  headingStyle: 'atx',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
});
turndown.use(gfm); // adds table support

/**
 * Zip-bomb guard (#20). A DOCX is a zip, and `mammoth.convertToHtml` fully
 * inflates it into worker memory. The 25MB multipart cap bounds the COMPRESSED
 * input; this bounds the DECOMPRESSED output. We read each entry's declared
 * uncompressed size from the zip's central directory (JSZip populates it on
 * `loadAsync` WITHOUT expanding a single byte) and refuse a document that inflates
 * past a sane bound or packs an absurd number of entries — before extraction runs.
 * A well-behaved DOCX has a few dozen small entries; these caps are far above that.
 */
export const MAX_DECOMPRESSED_BYTES = 100 * 1024 * 1024; // 100 MB
export const MAX_ARCHIVE_ENTRIES = 2048;

export async function assertArchiveWithinLimits(buffer: Buffer): Promise<void> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    // Not a readable zip — leave it to mammoth to surface the real parse error.
    return;
  }
  const entries = Object.values(zip.files);
  if (entries.length > MAX_ARCHIVE_ENTRIES) {
    throw new Error(
      `DOCX rejected: ${entries.length} archive entries exceeds the limit of ${MAX_ARCHIVE_ENTRIES}`,
    );
  }
  let declared = 0;
  for (const entry of entries) {
    // The central-directory uncompressed size, read without inflating the entry.
    const size =
      (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;
    declared += size;
    if (declared > MAX_DECOMPRESSED_BYTES) {
      throw new Error(
        `DOCX rejected: declared decompressed size exceeds the limit of ${MAX_DECOMPRESSED_BYTES} bytes`,
      );
    }
  }
}

export async function extractDocx(buffer: Buffer): Promise<string> {
  await assertArchiveWithinLimits(buffer);
  // Convert to HTML first to preserve tables, headings, and lists
  const result = await mammoth.convertToHtml({ buffer });
  // Convert HTML to markdown for clean, structured text
  const markdown = turndown.turndown(result.value);
  return markdown;
}
