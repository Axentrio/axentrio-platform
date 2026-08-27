import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { extractPptx } from '../../knowledge/document-extractors/pptx.extractor';

async function pptxBuffer(slides: Record<string, string>): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types></Types>');
  for (const [name, xml] of Object.entries(slides)) {
    zip.file(name, xml);
  }
  return Buffer.from(await zip.generateAsync({ type: 'uint8array' }));
}

describe('extractPptx', () => {
  it('emits slides in numeric order and decodes text runs', async () => {
    const buf = await pptxBuffer({
      'ppt/slides/slide2.xml': '<p><a:t>Second &amp; last</a:t></p>',
      'ppt/slides/slide1.xml': '<p><a:t>Hello</a:t><a:t> world</a:t></p>',
      'ppt/notesSlides/notesSlide1.xml': '<p><a:t>Notes should be skipped</a:t></p>',
    });
    const text = await extractPptx(buf);
    expect(text).toBe('## Slide 1\nHello  world\n## Slide 2\nSecond & last');
  });

  it('returns empty string when the slides dir is missing', async () => {
    const buf = await pptxBuffer({
      'ppt/presentation.xml': '<p></p>',
    });
    expect(await extractPptx(buf)).toBe('');
  });
});
