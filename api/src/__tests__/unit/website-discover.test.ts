import { describe, it, expect } from "vitest";
import {
  apexHost,
  isSubdomainOfApex,
  sameSiteHosts,
  parseCrtNameValues,
  discoverExtraHosts,
  DISCOVERY_PREFIXES,
} from "../../knowledge/website-discover";

describe("DISCOVERY_PREFIXES", () => {
  it("includes chat and ops", () => {
    expect(DISCOVERY_PREFIXES).toContain("chat");
    expect(DISCOVERY_PREFIXES).toContain("ops");
  });
});

describe("apexHost", () => {
  it("strips www", () => {
    expect(apexHost("www.valyro.be")).toBe("valyro.be");
    expect(apexHost("valyro.be")).toBe("valyro.be");
  });
});

describe("isSubdomainOfApex", () => {
  it("accepts the apex and its subdomains", () => {
    expect(isSubdomainOfApex("app.valyro.be", "valyro.be")).toBe(true);
    expect(isSubdomainOfApex("valyro.be", "valyro.be")).toBe(true);
  });
  it("rejects a different registrable host", () => {
    expect(isSubdomainOfApex("evil.com", "valyro.be")).toBe(false);
    expect(isSubdomainOfApex("valyro.be.evil.com", "valyro.be")).toBe(false);
  });
});

describe("sameSiteHosts", () => {
  it("treats www and apex as the same site", () => {
    const skip = sameSiteHosts("www.valyro.be");
    expect(skip.has("www.valyro.be")).toBe(true);
    expect(skip.has("valyro.be")).toBe(true);
    expect(skip.has("app.valyro.be")).toBe(false);
  });
});

describe("parseCrtNameValues", () => {
  it("splits newline SAN lists and drops the wildcard star", () => {
    const names = parseCrtNameValues([
      { name_value: "valyro.be\napp.valyro.be" },
      { name_value: "*.valyro.be" },
    ]);
    expect(names).toContain("valyro.be");
    expect(names).toContain("app.valyro.be");
  });
});

describe("discoverExtraHosts", () => {
  it("returns live related hosts and ignores foreign CT names", async () => {
    const result = await discoverExtraHosts("https://Valyro.be/", {
      lookup: async (host) => {
        if (host === "app.valyro.be") return ["104.18.37.19"];
        throw new Error("nxdomain");
      },
      fetchCt: async () => [
        { name_value: "app.valyro.be\nevil.com" },
        { name_value: "www.valyro.be" },
      ],
    });
    expect(result.apex).toBe("valyro.be");
    expect(result.hosts.map((h) => h.host)).toEqual(["app.valyro.be"]);
    expect(result.hosts[0].sources).toEqual(
      expect.arrayContaining(["dns", "ct"]),
    );
  });

  it("skips a host whose DNS answers include a private IP", async () => {
    const result = await discoverExtraHosts("https://valyro.be/", {
      lookup: async (host) => {
        if (host === "app.valyro.be") return ["10.0.0.4"];
        throw new Error("nxdomain");
      },
      fetchCt: async () => [],
    });
    expect(result.hosts).toEqual([]);
  });
});
