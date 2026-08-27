import JSZip from 'jszip';
import { assertArchiveWithinLimits } from './docx.extractor';

const SLIDE_PATH = /^ppt\/slides\/slide(\d+)\.xml$/;

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/**
 * Extract slide text from a PPTX buffer. Skips notes. Missing slides dir
 * returns an empty string.
 */
export async function extractPptx(buffer: Buffer): Promise<string> {
  await assertArchiveWithinLimits(buffer);
  const zip = await JSZip.loadAsync(buffer);
  const slideFiles = Object.keys(zip.files)
    .filter((name) => SLIDE_PATH.test(name))
    .sort((a, b) => Number(a.match(SLIDE_PATH)?.[1] ?? 0) - Number(b.match(SLIDE_PATH)?.[1] ?? 0));
  if (slideFiles.length === 0) return '';

  const parts: string[] = [];
  for (const name of slideFiles) {
    const n = Number(name.match(SLIDE_PATH)?.[1] ?? 0);
    const xml = await zip.files[name].async('string');
    const texts: string[] = [];
    const re = /<a:t[^>]*>([^<]*)<\/a:t>/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(xml)) !== null) {
      texts.push(decodeXmlEntities(match[1]));
    }
    parts.push(`## Slide ${n}`);
    if (texts.length > 0) parts.push(texts.join(' '));
  }
  return parts.join('\n');
}
