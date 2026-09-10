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
  it("honours Disallow for * when no group names our bot", () => {
    const robots = parseRobotsTxt("User-agent: *\nDisallow: /private\n");
    expect(robots.allows("/services")).toBe(true);
    expect(robots.allows("/private/x")).toBe(false);
  });

  it("lets a group naming our bot override the * group instead of stacking", () => {
    const robots = parseRobotsTxt(
      "User-agent: *\nDisallow: /private\n\nUser-agent: Axentrio-KnowledgeBot\nDisallow: /drafts\n",
    );
    expect(robots.allows("/services")).toBe(true);
    expect(robots.allows("/drafts/a")).toBe(false);
    expect(robots.allows("/private/x")).toBe(true);
  });

  it("matches * as any sequence of characters", () => {
    const robots = parseRobotsTxt(
      "User-agent: *\nDisallow: /private*\nDisallow: /*/secret\nDisallow: /*?session=\n",
    );
    expect(robots.allows("/private/team")).toBe(false);
    expect(robots.allows("/en/secret/team")).toBe(false);
    expect(robots.allows("/cart?session=1")).toBe(false);
    expect(robots.allows("/en/public")).toBe(true);
    expect(robots.allows("/cart")).toBe(true);
  });

  it("matches many wildcards against a long path without backtracking", () => {
    const robots = parseRobotsTxt(
      `User-agent: *\nDisallow: /${"*a".repeat(20)}*b\nDisallow: /x${"*a".repeat(20)}$\n`,
    );
    const path = `/${"a".repeat(200)}`;
    const started = performance.now();
    expect(robots.allows(path)).toBe(true);
    expect(robots.allows(`${path}b`)).toBe(false);
    expect(robots.allows(`/x${"a".repeat(200)}`)).toBe(false);
    expect(robots.allows(`/x${"a".repeat(200)}c`)).toBe(true);
    expect(performance.now() - started).toBeLessThan(250);
  });

  it("anchors a trailing $ at the end of the path", () => {
    const robots = parseRobotsTxt("User-agent: *\nDisallow: /p$\n");
    expect(robots.allows("/p")).toBe(false);
    expect(robots.allows("/page")).toBe(true);
  });

  it("applies a group with several User-agent lines to each agent", () => {
    const withStar = parseRobotsTxt(
      "User-agent: *\nUser-agent: GPTBot\nDisallow: /private\n",
    );
    expect(withStar.allows("/private")).toBe(false);
    const withOwn = parseRobotsTxt(
      "User-agent: GPTBot\nUser-agent: Axentrio-KnowledgeBot\nDisallow: /drafts\n",
    );
    expect(withOwn.allows("/drafts/a")).toBe(false);
  });

  it("starts a new group at a User-agent line after a rule line", () => {
    const robots = parseRobotsTxt(
      "User-agent: *\nDisallow: /a\nUser-agent: GPTBot\nDisallow: /b\n",
    );
    expect(robots.allows("/a")).toBe(false);
    expect(robots.allows("/b")).toBe(true);
  });

  it("lets the longest match win, and Allow win a tie", () => {
    const robots = parseRobotsTxt(
      "User-agent: *\nDisallow: /\nAllow: /public\nDisallow: /folder\nAllow: /folder\n",
    );
    expect(robots.allows("/public/page")).toBe(true);
    expect(robots.allows("/private/page")).toBe(false);
    expect(robots.allows("/folder/x")).toBe(true);
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

  it("refuses the canonical directory URL when Disallow ends in a slash", async () => {
    const allows = await fetchRobotsAllows(
      "https://example.com",
      async () => ({
        status: 200,
        body: "User-agent: *\nDisallow: /private/\n",
      }),
    );
    expect(await allows("https://example.com/private")).toBe(false);
    expect(await allows("https://example.com/private?page=2")).toBe(false);
    expect(await allows("https://example.com/private/team")).toBe(false);
    expect(await allows("https://example.com/privateer")).toBe(true);
    expect(await allows("https://example.com/private.html")).toBe(true);
  });

  describe("percent-encoding", () => {
    const allowsFor = (rules: string) =>
      fetchRobotsAllows("https://example.com", async () => ({
        status: 200,
        body: `User-agent: *\n${rules}\n`,
      }));

    it("encodes a non-ASCII rule to match the encoded pathname", async () => {
      const allows = await allowsFor("Disallow: /über-uns/intern");
      expect(new URL("https://example.com/über-uns/intern").pathname).toBe(
        "/%C3%BCber-uns/intern",
      );
      expect(await allows("https://example.com/über-uns/intern")).toBe(false);
      expect(await allows("https://example.com/%c3%bcber-uns/intern")).toBe(
        false,
      );
      expect(await allows("https://example.com/über-uns/public")).toBe(true);
    });

    it("does not double-encode a rule that is already percent-encoded", async () => {
      const allows = await allowsFor("Disallow: /%C3%BCber-uns/intern");
      expect(await allows("https://example.com/über-uns/intern")).toBe(false);
    });

    it("matches lowercase hex in a rule against the uppercase pathname", async () => {
      const allows = await allowsFor("Disallow: /%c3%bcber-uns/intern");
      expect(await allows("https://example.com/über-uns/intern")).toBe(false);
    });

    it("leaves ASCII k and s unencoded so rule lengths stay correct", async () => {
      const allows = await allowsFor("Allow: /services/\nDisallow: /*/internal");
      expect(await allows("https://example.com/services/internal")).toBe(false);
      expect(await allows("https://example.com/services/boilers")).toBe(true);
    });

    it("keeps * and $ working in a rule with non-ASCII text", async () => {
      const allows = await allowsFor("Disallow: /über-uns/*\nDisallow: /straße$");
      expect(await allows("https://example.com/über-uns/team/anna")).toBe(
        false,
      );
      expect(await allows("https://example.com/straße")).toBe(false);
      expect(await allows("https://example.com/straße/karte")).toBe(true);
    });
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

  it("refuses every path when robots.txt is a redirect that was not followed", async () => {
    const allows = await fetchRobotsAllows(
      "https://example.com",
      async () => ({ status: 301, body: "" }),
    );
    expect(await allows("https://example.com/")).toBe(false);
    expect(await allows("https://example.com/private/x")).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), {
      origin: "https://example.com",
      cause: "robots.txt returned status 301",
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

  describe("when a page redirects", () => {
    const home = "https://plumber.example/";
    const crawlWithRedirect = async (from: string, to: string) => {
      const robotsAllows = await fetchRobotsAllows(home, async () => ({
        status: 200,
        body: "User-agent: *\nDisallow: /members/\n",
      }));
      const rendered: string[] = [];
      const stored: Array<{ sourceUrl: string; text: string }> = [];
      const result = await crawlWebsite({
        originUrl: home,
        followLinks: true,
        maxPages: 10,
        remainingSlots: 10,
        renderer: {
          render: async (url: string) => {
            rendered.push(url);
            const finalUrl = url === from ? to : url;
            return {
              url: finalUrl,
              html: "",
              title: finalUrl,
              links:
                url === home ? [from] : ["https://plumber.example/discovered"],
              text: `Text of ${finalUrl}`,
            };
          },
        },
        robotsAllows,
        assertSafe: () => undefined,
        upsertPage: async (page) => {
          stored.push({ sourceUrl: page.sourceUrl, text: page.text });
          return { id: page.sourceUrl, processingVersion: 1, created: true };
        },
        enqueueIngest: async () => undefined,
      });
      return { rendered, stored, result };
    };

    it("stores nothing when an allowed url redirects to a disallowed one", async () => {
      const { rendered, stored, result } = await crawlWithRedirect(
        "https://plumber.example/account",
        "https://plumber.example/members/login",
      );
      expect(stored).toEqual([{ sourceUrl: home, text: `Text of ${home}` }]);
      expect(rendered).not.toContain("https://plumber.example/discovered");
      expect(result).toMatchObject({ indexed: 1, failed: 0 });
    });

    it("stores normally when an allowed url redirects to another allowed one", async () => {
      const { rendered, stored } = await crawlWithRedirect(
        "https://plumber.example/old",
        "https://plumber.example/new",
      );
      expect(stored).toContainEqual({
        sourceUrl: "https://plumber.example/old",
        text: "Text of https://plumber.example/new",
      });
      expect(rendered).toContain("https://plumber.example/discovered");
    });

    it("leaves a page without a redirect unaffected", async () => {
      const { stored } = await crawlWithRedirect(
        "https://plumber.example/account",
        "https://plumber.example/members/login",
      );
      expect(stored[0]).toEqual({ sourceUrl: home, text: `Text of ${home}` });
    });
  });

  it("counts a disallowed page once when a redirect and a link both lead to it", async () => {
    const home = "https://plumber.example/";
    const robotsAllows = await fetchRobotsAllows(home, async () => ({
      status: 200,
      body: "User-agent: *\nDisallow: /members/\n",
    }));
    const result = await crawlWebsite({
      originUrl: home,
      followLinks: true,
      maxPages: 10,
      remainingSlots: 10,
      renderer: {
        render: async (url: string) => ({
          url:
            url === "https://plumber.example/account"
              ? "https://plumber.example/members/"
              : url,
          html: "",
          title: url,
          links:
            url === home
              ? [
                  "https://plumber.example/account",
                  "https://plumber.example/members/",
                ]
              : [],
          text: `Text of ${url}`,
        }),
      },
      robotsAllows,
      assertSafe: () => undefined,
      upsertPage: async (page) => ({
        id: page.sourceUrl,
        processingVersion: 1,
        created: true,
      }),
      enqueueIngest: async () => undefined,
    });
    expect(result.skippedByRules).toBe(1);
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
