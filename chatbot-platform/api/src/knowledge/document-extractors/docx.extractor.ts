import mammoth from 'mammoth';
import TurndownService from 'turndown';
// @ts-ignore — turndown-plugin-gfm has no types
import { gfm } from 'turndown-plugin-gfm';

const turndown = new TurndownService({
  headingStyle: 'atx',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
});
turndown.use(gfm); // adds table support

export async function extractDocx(buffer: Buffer): Promise<string> {
  // Convert to HTML first to preserve tables, headings, and lists
  const result = await mammoth.convertToHtml({ buffer });
  // Convert HTML to markdown for clean, structured text
  const markdown = turndown.turndown(result.value);
  return markdown;
}
