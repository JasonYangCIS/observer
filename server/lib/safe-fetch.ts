import { ssrfSafeFetch } from "@agent-native/core/extensions/url-safety";

// Every server-side fetch of an external URL goes through here. Fetched content
// is untrusted data: this layer only moves bytes (SSRF guard, timeout, size
// cap, per-domain rate limit, domain policy) and never interprets them.

export type FetchErrorCode =
  | "blocked"
  | "denied"
  | "timeout"
  | "too_large"
  | "http_error"
  | "network";

export class FetchError extends Error {
  constructor(
    public code: FetchErrorCode,
    message: string,
    public status?: number,
  ) {
    super(message);
    this.name = "FetchError";
  }
}

export interface DomainPolicy {
  allowlist: string[];
  denylist: string[];
}

export interface SafeFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  accept?: string;
  policy?: DomainPolicy;
  /** Skip the allowlist (not the denylist) for fixed official API hosts. */
  skipAllowlist?: boolean;
  /** Minimum gap between requests to the same host. */
  minIntervalMs?: number;
}

export interface SafeFetchResult {
  text: string;
  status: number;
  contentType: string;
  finalUrl: string;
}

export type FetchText = (
  url: string,
  options?: SafeFetchOptions,
) => Promise<SafeFetchResult>;

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 2_000_000;
const DEFAULT_MIN_INTERVAL_MS = 250;
const USER_AGENT = "ObserverBot/0.1 (+https://github.com/JasonYangCIS/observer)";

const nextSlot = new Map<string, number>();

function normalizeDomain(d: string): string {
  return d.trim().toLowerCase().replace(/^\*?\./, "");
}

export function hostMatches(host: string, domain: string): boolean {
  const h = host.toLowerCase();
  const d = normalizeDomain(domain);
  return h === d || h.endsWith(`.${d}`);
}

export function assertDomainAllowed(
  url: string,
  policy: DomainPolicy | undefined,
  skipAllowlist = false,
): void {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new FetchError("blocked", `Unsupported URL scheme: ${parsed.protocol}`);
  }
  if (!policy) return;
  const host = parsed.hostname;
  if (policy.denylist.some((d) => d && hostMatches(host, d))) {
    throw new FetchError("denied", `Domain is on the denylist: ${host}`);
  }
  if (
    !skipAllowlist &&
    policy.allowlist.length > 0 &&
    !policy.allowlist.some((d) => d && hostMatches(host, d))
  ) {
    throw new FetchError("denied", `Domain is not on the allowlist: ${host}`);
  }
}

async function waitForHost(host: string, minIntervalMs: number): Promise<void> {
  const now = Date.now();
  const slot = Math.max(now, nextSlot.get(host) ?? 0);
  nextSlot.set(host, slot + minIntervalMs);
  if (slot > now) await new Promise((r) => setTimeout(r, slot - now));
}

/**
 * Decode bytes using the charset declared in a Content-Type header, falling
 * back to UTF-8 for a missing or unsupported label.
 */
export function decodeBody(bytes: Uint8Array, contentType: string): string {
  const label = /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType)?.[1];
  if (label) {
    try {
      return new TextDecoder(label).decode(bytes);
    } catch {
      // Unknown charset label: fall through to UTF-8.
    }
  }
  return new TextDecoder("utf-8").decode(bytes);
}

/** Read a response body as text, aborting once it exceeds `maxBytes`. */
async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new FetchError("too_large", `Response exceeds ${maxBytes} bytes`);
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new FetchError("too_large", `Response exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    buf.set(c, offset);
    offset += c.byteLength;
  }
  return decodeBody(buf, res.headers.get("content-type") ?? "");
}

export const safeFetchText: FetchText = async (url, options = {}) => {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBytes = DEFAULT_MAX_BYTES,
    maxRedirects = 3,
    accept = "*/*",
    policy,
    skipAllowlist = false,
    minIntervalMs = DEFAULT_MIN_INTERVAL_MS,
  } = options;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new FetchError("blocked", "Invalid URL");
  }
  const check = (u: string) => assertDomainAllowed(u, policy, skipAllowlist);
  check(url);
  await waitForHost(parsed.hostname, minIntervalMs);

  let res: Response;
  try {
    res = await ssrfSafeFetch(
      url,
      {
        headers: { "user-agent": USER_AGENT, accept },
        signal: AbortSignal.timeout(timeoutMs),
      },
      { maxRedirects, assertUrlAllowed: check },
    );
  } catch (err) {
    if (err instanceof FetchError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith("SSRF blocked")) throw new FetchError("blocked", message);
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      throw new FetchError("timeout", `Timed out after ${timeoutMs}ms`);
    }
    throw new FetchError("network", message);
  }

  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new FetchError("http_error", `HTTP ${res.status}`, res.status);
  }
  let text: string;
  try {
    text = await readCapped(res, maxBytes);
  } catch (err) {
    if (err instanceof FetchError) throw err;
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      throw new FetchError("timeout", `Timed out after ${timeoutMs}ms`);
    }
    throw new FetchError("network", err instanceof Error ? err.message : String(err));
  }
  return {
    text,
    status: res.status,
    contentType: res.headers.get("content-type") ?? "",
    finalUrl: res.url || url,
  };
};
