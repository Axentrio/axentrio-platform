import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import WebsiteCrawlNotices from "./WebsiteCrawlNotices";

describe("WebsiteCrawlNotices", () => {
  it("says nothing was imported only for a site that has no pages", () => {
    render(
      <WebsiteCrawlNotices
        notices={[
          {
            origin: "https://new.example/",
            skippedByRules: 0,
            rulesUnreachable: true,
            hasPages: false,
          },
          {
            origin: "https://kept.example/",
            skippedByRules: 0,
            rulesUnreachable: true,
            hasPages: true,
          },
        ]}
      />,
    );

    expect(
      screen.getByText(
        "The site's own rules for new.example were not available, so nothing was imported.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "The latest check could not read the site's own rules for kept.example, so no new pages were added.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/kept\.example.*nothing was imported/),
    ).not.toBeInTheDocument();
  });

  it("says the requested address was disallowed, with no count or whole-site claim, only when its rules left no pages", () => {
    render(
      <WebsiteCrawlNotices
        notices={[
          {
            origin: "https://members.example/",
            skippedByRules: 1,
            rulesUnreachable: false,
            hasPages: false,
          },
          {
            origin: "https://shop.example/",
            skippedByRules: 1,
            rulesUnreachable: false,
            hasPages: true,
          },
        ]}
      />,
    );

    expect(
      screen.getByText(
        "Nothing was imported from members.example because the site's own rules disallow the address that was requested.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/page.*members\.example/),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/whole site/i)).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "1 page on shop.example was skipped because the site's own rules disallow it.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Nothing was imported from shop\.example/),
    ).not.toBeInTheDocument();
  });
});
