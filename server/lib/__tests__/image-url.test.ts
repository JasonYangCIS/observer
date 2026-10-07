import { describe, expect, it } from "vitest";
import { safeImageUrl } from "../image-url.js";

describe("safeImageUrl", () => {
  it("accepts absolute https URLs and resolves relative ones against the page", () => {
    expect(safeImageUrl("https://cdn.example.com/a.jpg")).toBe("https://cdn.example.com/a.jpg");
    expect(safeImageUrl("/img/og.png", "https://blog.example.com/post/1")).toBe("https://blog.example.com/img/og.png");
    expect(safeImageUrl("//cdn.example.com/a.jpg", "https://blog.example.com/")).toBe("https://cdn.example.com/a.jpg");
    expect(safeImageUrl("  https://cdn.example.com/a.jpg  ")).toBe("https://cdn.example.com/a.jpg");
  });

  it("rejects everything that isn't a plain https image URL", () => {
    for (const bad of [
      "http://cdn.example.com/a.jpg", // mixed content on an https site
      "data:image/png;base64,AAAA",
      "javascript:alert(1)",
      "file:///etc/passwd",
      "https://user:pw@cdn.example.com/a.jpg",
      "relative/without/base.png",
      "",
      "   ",
      null,
      undefined,
      `https://cdn.example.com/${"a".repeat(2100)}.jpg`,
    ]) {
      expect(safeImageUrl(bad as string | null | undefined)).toBeUndefined();
    }
    // A relative URL resolved against an http page is still http, so it is dropped.
    expect(safeImageUrl("/a.png", "http://insecure.example.com/")).toBeUndefined();
  });
});
