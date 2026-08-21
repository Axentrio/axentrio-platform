import { describe, it, expect } from "vitest";
import { extractHtml } from "../../knowledge/document-extractors/html.extractor";

const PAGE = "https://plumber.example/services";

describe("extractHtml", () => {
  it("takes the title, readable body, image alt, and figcaption", () => {
    const html = `<!doctype html>
      <html>
        <head><title>Boiler repair</title></head>
        <body>
          <nav>Home About</nav>
          <article>
            <h1>Boiler repair in Ghent</h1>
            <p>We fix boilers the same day.</p>
            <figure>
              <img src="/van.jpg" alt="White van with ladder" />
              <figcaption>Our service van</figcaption>
            </figure>
          </article>
          <script>window.TRACK = true</script>
        </body>
      </html>`;

    const out = extractHtml(html, PAGE);
    expect(out.title).toBe("Boiler repair");
    expect(out.text).toContain("Boiler repair in Ghent");
    expect(out.text).toContain("We fix boilers the same day.");
    expect(out.text).toContain("White van with ladder");
    expect(out.text).toContain("Our service van");
    expect(out.text).not.toContain("window.TRACK");
  });

  it("collects absolute same-document links and drops hashes", () => {
    const html = `<!doctype html>
      <html><body>
        <a href="/pricing">Pricing</a>
        <a href="https://plumber.example/emergency#top">Emergency</a>
        <a href="https://other.example/nope">Other</a>
      </body></html>`;

    const out = extractHtml(html, PAGE);
    expect(out.links).toContain("https://plumber.example/pricing");
    expect(out.links).toContain("https://plumber.example/emergency");
    expect(out.links.some((href: string) => href.includes("#"))).toBe(false);
  });

  it("returns empty text when the page has no readable content", () => {
    const out = extractHtml(
      "<html><body><script>x</script></body></html>",
      PAGE,
    );
    expect(out.text.trim()).toBe("");
  });
});
