// eslint-disable-next-line @typescript-eslint/no-var-requires
const pdfParse = require('pdf-parse');

/**
 * Page-count guard (#20). `pdf-parse` otherwise walks every page of an
 * attacker-supplied PDF; a document packed with pages can pin the ingestion
 * worker's CPU/memory even under the 25MB upload cap. `max` bounds the pages
 * parsed — far above any real knowledge-base document.
 */
const MAX_PDF_PAGES = 1000;

export async function extractPdf(buffer: Buffer): Promise<string> {
  const result = await pdfParse(buffer, { max: MAX_PDF_PAGES });
  return result.text;
}
