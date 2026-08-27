import { describe, expect, it } from "vitest";
import {
  discoverWebsiteSchema,
  importWebsiteSchema,
} from "../../schemas/knowledge.schema";

describe("importWebsiteSchema", () => {
  it("accepts a bare domain and a www host without a scheme", () => {
    expect(importWebsiteSchema.parse({ url: "valyro.be" }).url).toBe(
      "https://valyro.be/",
    );
    expect(importWebsiteSchema.parse({ url: "www.valyro.be" }).url).toBe(
      "https://www.valyro.be/",
    );
  });

  it("keeps a full https URL", () => {
    expect(
      importWebsiteSchema.parse({ url: "https://www.valyro.be" }).url,
    ).toBe("https://www.valyro.be/");
  });

  it("rejects a non-http scheme", () => {
    expect(importWebsiteSchema.safeParse({ url: "javascript:alert(1)" }).success).toBe(
      false,
    );
  });
});

describe("discoverWebsiteSchema", () => {
  it("accepts a bare domain", () => {
    expect(discoverWebsiteSchema.parse({ url: "valyro.be" }).url).toBe(
      "https://valyro.be/",
    );
  });
});
