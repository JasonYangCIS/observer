import { describe, expect, it } from "vitest";
import { FetchError, assertDomainAllowed, hostMatches, safeFetchText } from "../safe-fetch.js";

describe("SSRF blocking (real guard, no network)", () => {
  const blocked = [
    "http://127.0.0.1/",
    "http://localhost/admin",
    "http://169.254.169.254/latest/meta-data/",
    "http://10.0.0.5/",
    "http://192.168.1.1/",
    "http://[::1]/",
  ];
  for (const url of blocked) {
    it(`blocks ${url}`, async () => {
      await expect(safeFetchText(url, { minIntervalMs: 0 })).rejects.toMatchObject({
        name: "FetchError",
        code: "blocked",
      });
    });
  }

  it("rejects non-http schemes", async () => {
    await expect(safeFetchText("file:///etc/passwd", { minIntervalMs: 0 })).rejects.toMatchObject({
      code: "blocked",
    });
    await expect(safeFetchText("not a url", { minIntervalMs: 0 })).rejects.toBeInstanceOf(FetchError);
  });
});

describe("domain policy", () => {
  it("matches exact hosts and subdomains only", () => {
    expect(hostMatches("example.com", "example.com")).toBe(true);
    expect(hostMatches("blog.example.com", "example.com")).toBe(true);
    expect(hostMatches("blog.example.com", "*.example.com")).toBe(true);
    expect(hostMatches("badexample.com", "example.com")).toBe(false);
  });

  it("denylist always wins, even over the allowlist and skipAllowlist", () => {
    const policy = { allowlist: ["example.com"], denylist: ["example.com"] };
    expect(() => assertDomainAllowed("https://example.com/x", policy)).toThrow(/denylist/);
    expect(() => assertDomainAllowed("https://example.com/x", policy, true)).toThrow(/denylist/);
  });

  it("enforces a non-empty allowlist unless skipped", () => {
    const policy = { allowlist: ["example.com"], denylist: [] };
    expect(() => assertDomainAllowed("https://other.org/x", policy)).toThrow(/allowlist/);
    expect(() => assertDomainAllowed("https://other.org/x", policy, true)).not.toThrow();
    expect(() => assertDomainAllowed("https://blog.example.com/x", policy)).not.toThrow();
  });

  it("allows anything when the lists are empty", () => {
    expect(() => assertDomainAllowed("https://anything.test/", { allowlist: [], denylist: [] })).not.toThrow();
  });
});
