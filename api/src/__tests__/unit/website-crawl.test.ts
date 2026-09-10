import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { logger } from "../../utils/logger";
import {
  canonicalSourceUrl,
  normalizeWebsiteUrl,
  isSameHost,
  isMediaUrl,
  originFromSourceUrl,
} from "../../knowledge/website-url";
import {
  parseRobotsTxt,
  fetchRobotsAllows,
} from "../../knowledge/website-robots";
import {
  crawlWebsite,
  DEFAULT_MAX_PAGES,
  HARD_MAX_PAGES,
} from "../../knowledge/website-crawl";
import type { PageRenderer } from "../../knowledge/website-crawl";

describe("canonicalSourceUrl", () => {
  it("strips the hash, lowercases the host, and drops a trailing slash on paths", () => {
    expect(canonicalSourceUrl("https://Plumber.Example/services/#top")).toBe(
      "https://plumber.example/services",
    );
  });
});

describe("normalizeWebsiteUrl", () => {
  it("accepts a bare domain and a www host without a scheme", () => {
    expect(normalizeWebsiteUrl("valyro.be")).toBe("https://valyro.be/");
    expect(normalizeWebsiteUrl("www.valyro.be")).toBe(
      "https://www.valyro.be/",
    );
  });

  it("adds https to a bare host with a port", () => {
    expect(normalizeWebsiteUrl("valyro.be:8080")).toBe(
      "https://valyro.be:8080/",
    );
  });

  it("keeps a full https URL", () => {
    expect(normalizeWebsiteUrl("https://www.valyro.be")).toBe(
      "https://www.valyro.be/",
    );
  });

  it("upgrades http to https", () => {
    expect(normalizeWebsiteUrl("http://valyro.be")).toBe("https://valyro.be/");
  });

  it("rejects a non-http scheme", () => {
    expect(() => normalizeWebsiteUrl("javascript:alert(1)")).toThrow(
      "Invalid website URL",
    );
  });
});

describe("isSameHost", () => {
  it("treats www and apex as the same host", () => {
    expect(
      isSameHost(
        "https://www.plumber.example/",
        "https://plumber.example/pricing",
      ),
    ).toBe(true);
  });
  it("rejects a different host", () => {
    expect(
      isSameHost("https://plumber.example/", "https://evil.example/x"),
    ).toBe(false);
  });
});

describe("isMediaUrl", () => {
  it("flags gallery images and documents", () => {
    expect(isMediaUrl("https://x.example/wp-content/uploads/a.jpeg")).toBe(
      true,
    );
    expect(isMediaUrl("https://x.example/about")).toBe(false);
  });
});

describe("originFromSourceUrl", () => {
  it("returns scheme and host", () => {
    expect(originFromSourceUrl("https://valyro.be/diensten")).toBe(
      "https://valyro.be",
    );
  });
});

describe("parseRobotsTxt", () => {
  it("honours Disallow for our bot and for *", () => {
    const robots = parseRobotsTxt(
      "User-agent: *\nDisallow: /private\n\nUser-agent: Axentrio-KnowledgeBot\nDisallow: /drafts\n",
    );
    expect(robots.allows("/services")).toBe(true);
    expect(robots.allows("/private/x")).toBe(false);
    expect(robots.allows("/drafts/a")).toBe(false);
  });
});

describe("fetchRobotsAllows", () => {
  beforeEach(() => {
    vi.mocked(logger.warn).mockClear();
  });

  it("refuses Disallow paths on 200 and allows the rest", async () => {
    const allows = await fetchRobotsAllows(
      "https://example.com",
      async () => ({
        status: 200,
        body: "User-agent: *\nDisallow: /private\n",
      }),
    );
    expect(await allows("https://example.com/private/x")).toBe(false);
    expect(await allows("https://example.com/services")).toBe(true);
  });

  it("allows every path when robots.txt is 404", async () => {
    const allows = await fetchRobotsAllows(
      "https://example.com",
      async () => ({ status: 404, body: "" }),
    );
    expect(await allows("https://example.com/private/x")).toBe(true);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("refuses every path when get throws", async () => {
    const allows = await fetchRobotsAllows("https://example.com", async () => {
      throw new Error("timeout of 5000ms exceeded");
    });
    expect(await allows("https://example.com/")).toBe(false);
    expect(await allows("https://example.com/private/x")).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), {
      origin: "https://example.com",
      cause: "timeout of 5000ms exceeded",
    });
  });

  it("refuses every path when robots.txt is 5xx", async () => {
    const allows = await fetchRobotsAllows(
      "https://example.com",
      async () => ({ status: 503, body: "" }),
    );
    expect(await allows("https://example.com/")).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), {
      origin: "https://example.com",
      cause: "robots.txt returned status 503",
    });
  });

  it("requests robots.txt at the origin root", async () => {
    const requested: string[] = [];
    await fetchRobotsAllows("https://example.com/blog/post", async (url) => {
      requested.push(url);
      return { status: 404, body: "" };
    });
    expect(requested).toEqual(["https://example.com/robots.txt"]);
  });

  it("fetches robots.txt once per origin", async () => {
    let calls = 0;
    const allows = await fetchRobotsAllows(
      "https://example.com",
      async () => {
        calls += 1;
        return {
          status: 200,
          body: "User-agent: *\nDisallow: /private\n",
        };
      },
    );
    await allows("https://example.com/a");
    await allows("https://example.com/b");
    await allows("https://example.com/private/x");
    expect(calls).toBe(1);
  });
});

describe("crawlWebsite", () => {
  it("follows same-host links up to the cap and upserts by sourceUrl", async () => {
    const pages: Record<string, string> = {
      "https://plumber.example/": `<html><head><title>Home</title></head><body>
        <a href="/services">Services</a><a href="/services">Services again</a>
        <a href="https://other.example/x">Nope</a>
        <p>Welcome</p></body></html>`,
      "https://plumber.example/services": `<html><head><title>Services</title></head><body>
        <p>Boiler repair</p><img alt="White van" /></body></html>`,
    };
    const renderer: PageRenderer = {
      render: async (url: string) => {
        const html = pages[url];
        if (!html) throw new Error(`unexpected render ${url}`);
        const { extractHtml } = await import(
          "../../knowledge/document-extractors/html.extractor"
        );
        const extracted = extractHtml(html, url);
        return {
          url,
          html,
          title: extracted.title,
          links: extracted.links,
          text: extracted.text,
        };
      },
    };
    const upserted: string[] = [];
    const ingested: string[] = [];
    const result = await crawlWebsite({
      originUrl: "https://plumber.example/",
      followLinks: true,
      maxPages: 25,
      remainingSlots: 10,
      renderer,
      robotsAllows: async () => true,
      assertSafe: () => undefined,
      upsertPage: async (page: { sourceUrl: string }) => {
        upserted.push(page.sourceUrl);
        return { id: page.sourceUrl, processingVersion: 1, created: true };
      },
      enqueueIngest: async (doc: { id: string }) => {
        ingested.push(doc.id);
      },
    });
    expect(result.indexed).toBe(2);
    expect(upserted).toEqual([
      "https://plumber.example/",
      "https://plumber.example/services",
    ]);
    expect(ingested).toEqual(upserted);
  });

  it("skips a path robots.txt disallows", async () => {
    const renderer: PageRenderer = {
      render: async (url: string) => ({
        url,
        html: `<html><head><title>X</title></head><body><a href="/secret">s</a><p>Hi</p></body></html>`,
        title: "X",
        links: ["https://plumber.example/secret"],
        text: "Hi",
      }),
    };
    const visited: string[] = [];
    await crawlWebsite({
      originUrl: "https://plumber.example/",
      followLinks: true,
      maxPages: 10,
      remainingSlots: 10,
      renderer,
      robotsAllows: async (url: string) => !url.includes("/secret"),
      assertSafe: () => undefined,
      upsertPage: async (page: { sourceUrl: string }) => {
        visited.push(page.sourceUrl);
        return { id: page.sourceUrl, processingVersion: 1, created: true };
      },
      enqueueIngest: async () => undefined,
    });
    expect(visited).toEqual(["https://plumber.example/"]);
  });

  it("stops at remaining document quota", async () => {
    const renderer: PageRenderer = {
      render: async (url: string) => ({
        url,
        html: '<html><body><a href="/two">two</a><p>one</p></body></html>',
        title: "one",
        links: ["https://plumber.example/two"],
        text: "one",
      }),
    };
    const visited: string[] = [];
    const result = await crawlWebsite({
      originUrl: "https://plumber.example/",
      followLinks: true,
      maxPages: 25,
      remainingSlots: 1,
      renderer,
      robotsAllows: async () => true,
      assertSafe: () => undefined,
      upsertPage: async (page: { sourceUrl: string }) => {
        visited.push(page.sourceUrl);
        return { id: page.sourceUrl, processingVersion: 1, created: true };
      },
      enqueueIngest: async () => undefined,
    });
    expect(visited).toEqual(["https://plumber.example/"]);
    expect(result.indexed).toBe(1);
  });

  it("keeps DEFAULT_MAX_PAGES under HARD_MAX_PAGES", () => {
    expect(DEFAULT_MAX_PAGES).toBe(25);
    expect(HARD_MAX_PAGES).toBe(50);
    expect(DEFAULT_MAX_PAGES).toBeLessThan(HARD_MAX_PAGES);
  });

  it("skips a page when assertSafe throws", async () => {
    const renderer: PageRenderer = {
      render: async (url: string) => ({
        url,
        html: "<html><body><p>x</p></body></html>",
        title: "x",
        links: [],
        text: "x",
      }),
    };
    const visited: string[] = [];
    await crawlWebsite({
      originUrl: "https://plumber.example/",
      followLinks: false,
      maxPages: 5,
      remainingSlots: 5,
      renderer,
      robotsAllows: async () => true,
      assertSafe: () => {
        throw new Error("blocked");
      },
      upsertPage: async (page: { sourceUrl: string }) => {
        visited.push(page.sourceUrl);
        return { id: page.sourceUrl, processingVersion: 1, created: true };
      },
      enqueueIngest: async () => undefined,
    });
    expect(visited).toEqual([]);
  });

  it("skips JPEG gallery links so they do not fill the page cap", async () => {
    const renderer: PageRenderer = {
      render: async (url: string) => ({
        url,
        html: '<html><body><a href="/photo.jpg">pic</a><a href="/about">about</a><p>home</p></body></html>',
        title: "home",
        links: [
          "https://plumber.example/photo.jpg",
          "https://plumber.example/about",
        ],
        text: "home",
      }),
    };
    const visited: string[] = [];
    await crawlWebsite({
      originUrl: "https://plumber.example/",
      followLinks: true,
      maxPages: 25,
      remainingSlots: 10,
      renderer,
      robotsAllows: async () => true,
      assertSafe: () => undefined,
      upsertPage: async (page: { sourceUrl: string }) => {
        visited.push(page.sourceUrl);
        return { id: page.sourceUrl, processingVersion: 1, created: true };
      },
      enqueueIngest: async () => undefined,
    });
    expect(visited).toEqual([
      "https://plumber.example/",
      "https://plumber.example/about",
    ]);
  });
});
