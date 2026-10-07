import { beforeEach, describe, expect, it, vi } from "vitest";

const ssrfSafeFetch = vi.fn();
vi.mock("@agent-native/core/extensions/url-safety", () => ({ ssrfSafeFetch }));

const { decodeBody, safeFetchText } = await import("../safe-fetch.js");

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const s of chunks) c.enqueue(enc.encode(s));
      c.close();
    },
  });
}

beforeEach(() => {
  ssrfSafeFetch.mockReset();
});

describe("response limits", () => {
  it("returns text for a small response", async () => {
    ssrfSafeFetch.mockResolvedValue(new Response(streamOf("hel", "lo"), { status: 200 }));
    const res = await safeFetchText("https://example.com/", { minIntervalMs: 0 });
    expect(res.text).toBe("hello");
  });

  it("rejects when the streamed body exceeds maxBytes", async () => {
    ssrfSafeFetch.mockResolvedValue(new Response(streamOf("aaaa", "bbbb", "cccc"), { status: 200 }));
    await expect(safeFetchText("https://example.com/", { maxBytes: 6, minIntervalMs: 0 })).rejects.toMatchObject({
      code: "too_large",
    });
  });

  it("rejects early when content-length exceeds maxBytes", async () => {
    ssrfSafeFetch.mockResolvedValue(
      new Response(streamOf("x"), { status: 200, headers: { "content-length": "999999" } }),
    );
    await expect(safeFetchText("https://example.com/", { maxBytes: 100, minIntervalMs: 0 })).rejects.toMatchObject({
      code: "too_large",
    });
  });

  const run = () => safeFetchText("https://example.com/", { minIntervalMs: 0 }).catch((e) => e);

  it("maps HTTP errors to a typed code", async () => {
    ssrfSafeFetch.mockResolvedValue(new Response("nope", { status: 503 }));
    expect(await run()).toMatchObject({ name: "FetchError", code: "http_error", status: 503 });
  });

  it("maps SSRF guard errors to a typed code", async () => {
    ssrfSafeFetch.mockImplementation(() => Promise.reject(new Error("SSRF blocked: private address")));
    expect(await run()).toMatchObject({ name: "FetchError", code: "blocked" });
  });

  it("maps timeouts to a typed code", async () => {
    ssrfSafeFetch.mockImplementation(() =>
      Promise.reject(Object.assign(new Error("t"), { name: "TimeoutError" })),
    );
    expect(await run()).toMatchObject({ name: "FetchError", code: "timeout" });
  });

  it("passes the domain policy to every redirect hop", async () => {
    ssrfSafeFetch.mockResolvedValue(new Response("ok", { status: 200 }));
    await safeFetchText("https://example.com/", {
      minIntervalMs: 0,
      policy: { allowlist: [], denylist: ["evil.test"] },
    });
    const opts = ssrfSafeFetch.mock.calls[0][2];
    expect(() => opts.assertUrlAllowed("https://evil.test/redirected")).toThrow(/denylist/);
    expect(() => opts.assertUrlAllowed("https://fine.test/")).not.toThrow();
  });
});

describe("decodeBody", () => {
  it("honors a declared charset and falls back to UTF-8", () => {
    const latin1 = Uint8Array.from([0x63, 0x61, 0x66, 0xe9]); // "café" in ISO-8859-1
    expect(decodeBody(latin1, "text/html; charset=ISO-8859-1")).toBe("café");
    expect(decodeBody(latin1, 'text/html; charset="iso-8859-1"')).toBe("café");
    expect(decodeBody(new TextEncoder().encode("café"), "text/html")).toBe("café");
    expect(decodeBody(new TextEncoder().encode("café"), "text/html; charset=bogus-9000")).toBe("café");
  });
});
