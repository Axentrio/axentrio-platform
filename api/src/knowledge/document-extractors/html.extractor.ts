import { JSDOM } from "jsdom";

/**
 * Turn a rendered HTML page into KnowledgeDocument text.
 *
 * Image alt and figcaptions are kept as text. Script and style are dropped.
 * Links are returned as absolute URLs with the hash stripped.
 */
export function extractHtml(
  html: string,
  pageUrl: string,
): { title: string; text: string; links: string[] } {
  const dom = new JSDOM(html, { url: pageUrl });
  const doc = dom.window.document;

  const title = (doc.querySelector("title")?.textContent || "").trim();

  const imageBits: string[] = [];
  doc.querySelectorAll("img").forEach((img) => {
    const alt = (img.getAttribute("alt") || "").trim();
    if (alt) imageBits.push(alt);
    const imgTitle = (img.getAttribute("title") || "").trim();
    if (imgTitle && imgTitle !== alt) imageBits.push(imgTitle);
  });
  doc.querySelectorAll("figcaption").forEach((el) => {
    const caption = (el.textContent || "").trim();
    if (caption) imageBits.push(caption);
  });

  const links: string[] = [];
  const seen = new Set<string>();
  doc.querySelectorAll("a[href]").forEach((anchor) => {
    const href = anchor.getAttribute("href");
    if (!href) return;
    try {
      const abs = new URL(href, pageUrl);
      abs.hash = "";
      const key = abs.toString();
      if (!seen.has(key)) {
        seen.add(key);
        links.push(key);
      }
    } catch {
      // skip unparseable href
    }
  });

  for (const el of Array.from(
    doc.querySelectorAll("script, style, noscript, iframe"),
  )) {
    el.remove();
  }

  const main =
    doc.querySelector("article") || doc.querySelector("main") || doc.body;
  const bodyText = (main?.textContent || "").replace(/\s+/g, " ").trim();

  const text = [bodyText, ...imageBits]
    .filter((part) => part.length > 0)
    .join("\n");

  let fallbackTitle = title;
  if (!fallbackTitle) {
    try {
      fallbackTitle = new URL(pageUrl).hostname;
    } catch {
      fallbackTitle = pageUrl;
    }
  }

  return { title: fallbackTitle, text, links };
}
