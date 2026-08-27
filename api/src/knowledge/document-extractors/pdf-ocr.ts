import type { Canvas, SKRSContext2D } from '@napi-rs/canvas';
import { logger } from '../../utils/logger';
import { getProvider } from '../../llm/provider-factory';
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from '../../llm/defaults';
import type { ChatMessage } from '../../llm/llm.types';

const OCR_SYS =
  'Transcribe all text in this page image faithfully as markdown. Preserve tables. Output only the transcription.';

const OCR_OPTIONS = {
  model: DEFAULT_MODEL,
  maxTokens: 3500,
  temperature: 0,
  jsonMode: false,
};

interface CanvasLib {
  createCanvas(width: number, height: number): Canvas;
  Path2D: unknown;
  DOMMatrix: unknown;
  ImageData: unknown;
}

interface CanvasPair {
  canvas: Canvas | null;
  context: SKRSContext2D | null;
}

interface PdfjsDocument {
  numPages: number;
  getPage: (n: number) => Promise<{
    getViewport: (opts: { scale: number }) => { width: number; height: number };
    render: (opts: { canvasContext: never; viewport: { width: number; height: number } }) => { promise: Promise<void> };
  }>;
  destroy: () => Promise<void>;
}

interface PdfjsModule {
  getDocument: (src: object) => { promise: Promise<PdfjsDocument> };
}

let canvasMod: CanvasLib | null | undefined;

function loadCanvas(): CanvasLib | null {
  if (canvasMod !== undefined) return canvasMod;
  try {
    // Native binary is optional in some images; a static import would crash boot.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    canvasMod = require('@napi-rs/canvas') as CanvasLib;
    const g = globalThis as unknown as Record<string, unknown>;
    if (g.Path2D == null) g.Path2D = canvasMod.Path2D;
    if (g.DOMMatrix == null) g.DOMMatrix = canvasMod.DOMMatrix;
    if (g.ImageData == null) g.ImageData = canvasMod.ImageData;
    return canvasMod;
  } catch (err) {
    canvasMod = null;
    logger.error('[pdf-ocr] @napi-rs/canvas failed to load — scanned PDFs will be marked failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export function isPdfOcrAvailable(): boolean {
  return loadCanvas() !== null;
}

async function transcribeJpeg(base64: string, mimeType: string): Promise<string> {
  const messages: ChatMessage[] = [
    { role: 'system', content: OCR_SYS },
    { role: 'user', content: [{ type: 'image', mimeType, data: base64 }] },
  ];
  const provider = getProvider(DEFAULT_PROVIDER);
  try {
    const first = await provider.chat(messages, OCR_OPTIONS);
    return (first.content || '').trim();
  } catch {
    const retry = await provider.chat(messages, OCR_OPTIONS);
    return (retry.content || '').trim();
  }
}

export async function ocrImageWithVision(buffer: Buffer, mimeType: string): Promise<string> {
  const text = await transcribeJpeg(buffer.toString('base64'), mimeType);
  if (!text) throw new Error('image OCR returned empty text');
  return text;
}

function napiCanvasFactoryClass(canvasLib: CanvasLib) {
  return class NapiCanvasFactory {
    constructor(_opts?: { ownerDocument?: unknown; enableHWA?: boolean }) {}
    create(width: number, height: number): CanvasPair {
      const canvas = canvasLib.createCanvas(Math.ceil(width), Math.ceil(height));
      return { canvas, context: canvas.getContext('2d') };
    }
    reset(pair: CanvasPair, width: number, height: number) {
      if (!pair.canvas) return;
      pair.canvas.width = Math.ceil(width);
      pair.canvas.height = Math.ceil(height);
    }
    destroy(pair: CanvasPair) {
      if (pair.canvas) {
        pair.canvas.width = 0;
        pair.canvas.height = 0;
      }
      pair.canvas = null;
      pair.context = null;
    }
  };
}

export async function rasterizePdfPages(
  buffer: Buffer,
  opts?: { maxPages?: number },
): Promise<{ page: number; jpeg: Buffer | null }[]> {
  const canvasLib = loadCanvas();
  if (!canvasLib) {
    throw new Error('PDF OCR unavailable: @napi-rs/canvas failed to load');
  }
  // tsc commonjs rewrites `await import()` to require(), which throws ERR_REQUIRE_ESM for pdfjs-dist.
  const dynamicImport = new Function('specifier', 'return import(specifier)') as (s: string) => Promise<PdfjsModule>;
  const pdfjs = await dynamicImport('pdfjs-dist/legacy/build/pdf.mjs');
  const CanvasFactory = napiCanvasFactoryClass(canvasLib);
  const factory = new CanvasFactory();
  const data = Uint8Array.from(buffer);
  const doc = await pdfjs.getDocument({
    data,
    isEvalSupported: false,
    disableFontFace: false,
    useSystemFonts: true,
    CanvasFactory,
  }).promise;
  const pageCount = Math.min(doc.numPages, opts?.maxPages ?? 15);
  const pages: { page: number; jpeg: Buffer | null }[] = [];
  try {
    for (let n = 1; n <= pageCount; n++) {
      let pair: CanvasPair | undefined;
      try {
        const page = await doc.getPage(n);
        const viewport = page.getViewport({ scale: 1.5 });
        pair = factory.create(viewport.width, viewport.height);
        if (!pair.context || !pair.canvas) throw new Error('canvas context missing');
        // pdfjs types a browser CanvasRenderingContext2D; napi-rs is the Node stand-in.
        const canvasContext = pair.context as never;
        await page.render({
          canvasContext,
          viewport,
        }).promise;
        pages.push({ page: n, jpeg: pair.canvas.toBuffer('image/jpeg', 80) });
      } catch {
        pages.push({ page: n, jpeg: null });
      } finally {
        if (pair) factory.destroy(pair);
      }
    }
  } finally {
    await doc.destroy();
  }
  return pages;
}

export async function ocrPdfWithVision(
  buffer: Buffer,
  opts?: { maxPages?: number },
): Promise<{ text: string; pages: number }> {
  const rasters = await rasterizePdfPages(buffer, opts);
  const parts: string[] = [];
  let ok = 0;
  for (const { page: n, jpeg } of rasters) {
    if (!jpeg) {
      parts.push(`\n\n<!-- Page ${n} -->\n\n[Page ${n} could not be read]`);
      continue;
    }
    try {
      const text = await transcribeJpeg(jpeg.toString('base64'), 'image/jpeg');
      parts.push(`\n\n<!-- Page ${n} -->\n\n${text || `[Page ${n} could not be read]`}`);
      if (text) ok += 1;
    } catch {
      parts.push(`\n\n<!-- Page ${n} -->\n\n[Page ${n} could not be read]`);
    }
  }
  if (ok === 0) throw new Error('every PDF page failed OCR');
  return { text: parts.join('').trim(), pages: rasters.length };
}
