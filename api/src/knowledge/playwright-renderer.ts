import { extractHtml } from "./document-extractors/html.extractor";
import { KNOWLEDGE_BOT_UA } from "./website-robots";
import {
  assertPublicHostname,
  assertSafeOutboundUrl,
} from "../security/ssrf-guard";
import type { RenderedPage } from "./website-crawl";

/**
 * Render a page with Chromium. Imported only from the crawl worker, never from
 * an HTTP handler.
 */
export async function renderWithPlaywright(url: string): Promise<RenderedPage> {
  const parsed = assertSafeOutboundUrl(url);
  await assertPublicHostname(parsed.hostname);

  let chromium: {
    launch: (opts: { headless: boolean }) => Promise<BrowserLike>;
  };
  try {
    // Loaded at job time only. The HTTP process never imports this file.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    ({ chromium } = require("playwright") as {
      chromium: {
        launch: (opts: { headless: boolean }) => Promise<BrowserLike>;
      };
    });
  } catch {
    throw new Error(
      "Playwright is not installed. Add it to the crawl worker image.",
    );
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ userAgent: KNOWLEDGE_BOT_UA });
    await page.route("**/*", async (route) => {
      try {
        const requestUrl = route.request().url();
        assertSafeOutboundUrl(requestUrl);
        // DNS-level check per request: a hostname that re-resolves to a
        // private/metadata address mid-crawl must not be fetched.
        await assertPublicHostname(new URL(requestUrl).hostname);
        await route.continue();
      } catch {
        await route.abort();
      }
    });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.waitForTimeout(2000);
    await page.evaluate(async () => {
      const sleep = (ms: number) =>
        new Promise((resolve) => setTimeout(resolve, ms));
      let last = 0;
      for (let i = 0; i < 12; i += 1) {
        const height = document.body.scrollHeight;
        window.scrollTo(0, height);
        await sleep(250);
        if (height === last) break;
        last = height;
      }
    });
    const html = await page.content();
    const extracted = extractHtml(html, url);
    return {
      url,
      html,
      title: extracted.title,
      links: extracted.links,
      text: extracted.text,
    };
  } finally {
    await browser.close();
  }
}

interface BrowserLike {
  newPage: (opts: { userAgent: string }) => Promise<{
    route: (
      pattern: string,
      handler: (route: {
        request: () => { url: () => string };
        continue: () => Promise<void>;
        abort: () => Promise<void>;
      }) => Promise<void>,
    ) => Promise<void>;
    goto: (
      url: string,
      opts: { waitUntil: string; timeout: number },
    ) => Promise<unknown>;
    waitForTimeout: (ms: number) => Promise<void>;
    evaluate: (fn: () => Promise<void>) => Promise<void>;
    content: () => Promise<string>;
  }>;
  close: () => Promise<void>;
}
