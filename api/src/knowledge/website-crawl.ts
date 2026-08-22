import { extractHtml } from "./document-extractors/html.extractor";
import { canonicalSourceUrl, isSameHost, isMediaUrl } from "./website-url";

export const DEFAULT_MAX_PAGES = 25;
export const HARD_MAX_PAGES = 50;

export interface RenderedPage {
  url: string;
  html: string;
  title: string;
  links: string[];
  text: string;
}

export interface PageRenderer {
  render: (url: string) => Promise<RenderedPage>;
}

export interface UpsertedUrlDocument {
  id: string;
  processingVersion: number;
  created: boolean;
}

export interface UrlPageRecord {
  sourceUrl: string;
  title: string;
  text: string;
}

export function clampMaxPages(
  requested: number | undefined,
  remainingSlots: number,
): number {
  const wanted = requested ?? DEFAULT_MAX_PAGES;
  const capped = Math.min(Math.max(1, wanted), HARD_MAX_PAGES);
  if (remainingSlots === Infinity) return capped;
  return Math.min(capped, Math.max(0, remainingSlots));
}

export async function crawlWebsite(input: {
  originUrl: string;
  followLinks: boolean;
  maxPages: number;
  remainingSlots: number;
  renderer: PageRenderer;
  robotsAllows: (url: string) => Promise<boolean>;
  assertSafe: (url: string) => void;
  upsertPage: (page: UrlPageRecord) => Promise<UpsertedUrlDocument>;
  enqueueIngest: (doc: {
    id: string;
    processingVersion: number;
  }) => Promise<void>;
}): Promise<{ visited: number; indexed: number; failed: number }> {
  const budget = clampMaxPages(input.maxPages, input.remainingSlots);
  const origin = canonicalSourceUrl(input.originUrl);
  const queue: string[] = [origin];
  const seen = new Set<string>();
  let indexed = 0;
  let failed = 0;
  let visited = 0;

  while (queue.length > 0 && visited < budget) {
    const raw = queue.shift();
    if (!raw) break;
    let pageUrl: string;
    try {
      pageUrl = canonicalSourceUrl(raw);
      input.assertSafe(pageUrl);
    } catch {
      failed += 1;
      continue;
    }
    if (seen.has(pageUrl)) continue;
    if (!isSameHost(origin, pageUrl)) continue;
    if (isMediaUrl(pageUrl)) continue;
    if (!(await input.robotsAllows(pageUrl))) continue;
    seen.add(pageUrl);
    visited += 1;

    try {
      const rendered = await input.renderer.render(pageUrl);
      const extracted = rendered.text
        ? { title: rendered.title, text: rendered.text, links: rendered.links }
        : extractHtml(rendered.html, pageUrl);
      if (!extracted.text.trim()) {
        failed += 1;
        continue;
      }
      const saved = await input.upsertPage({
        sourceUrl: pageUrl,
        title: extracted.title || rendered.title,
        text: extracted.text,
      });
      await input.enqueueIngest({
        id: saved.id,
        processingVersion: saved.processingVersion,
      });
      indexed += 1;

      if (input.followLinks) {
        for (const href of extracted.links) {
          if (!isSameHost(origin, href)) continue;
          const next = canonicalSourceUrl(href);
          if (isMediaUrl(next)) continue;
          if (!seen.has(next)) queue.push(next);
        }
      }
    } catch {
      failed += 1;
    }
  }

  return { visited, indexed, failed };
}
