import { createHash } from "node:crypto";
import { fail } from "@agent-native/core/action";
import { Readability } from "@mozilla/readability";
import { and, desc, eq, inArray } from "drizzle-orm";
import { parseHTML } from "linkedom";
import { getDb, schema } from "../db/index.js";
import { FetchError, safeFetchText, type DomainPolicy, type FetchText } from "./safe-fetch.js";

const { items, sourceSettings } = schema;

/** Longest article text we store. Longer pages are truncated, not rejected. */
export const MAX_ARTICLE_CHARS = 50_000;
/** Readable text shorter than this is treated as "no article found". */
export const MIN_ARTICLE_CHARS = 300;
/** Failed and paywalled items are not retried automatically inside this window. */
const RETRY_AFTER_MS = 6 * 60 * 60 * 1000;
const BATCH_CONCURRENCY = 3;

export type ArticleStatus = "ok" | "paywalled" | "failed";

export interface ExtractedArticle {
  status: ArticleStatus;
  text?: string;
  title?: string;
  error?: string;
}

/** Normalize extracted text: strip control characters, collapse whitespace, cap length. */
export function cleanText(raw: string): string {
  const text = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t ]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.length > MAX_ARTICLE_CHARS ? `${text.slice(0, MAX_ARTICLE_CHARS)}…` : text;
}

const BLOCK_SELECTOR = "p,div,section,article,header,footer,aside,main,li,ul,ol,dl,dt,dd,h1,h2,h3,h4,h5,h6,blockquote,pre,table,tr,figure,figcaption,hr";

/**
 * Convert Readability's cleaned article HTML to plain text, keeping a line break
 * at every block boundary. `textContent` alone glues adjacent blocks together
 * ("...screenMake a sign"), which garbles summaries and breaks verbatim citations.
 */
export function htmlToText(html: string): string {
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`) as unknown as { document: Document };
  for (const br of Array.from(document.querySelectorAll("br"))) br.replaceWith(document.createTextNode("\n"));
  for (const el of Array.from(document.querySelectorAll(BLOCK_SELECTOR))) {
    el.appendChild(document.createTextNode("\n"));
  }
  return document.body.textContent ?? "";
}

function declaresPaywall(document: Document): boolean {
  for (const node of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
    try {
      const walk = (value: unknown): boolean => {
        if (Array.isArray(value)) return value.some(walk);
        if (value && typeof value === "object") {
          const free = (value as Record<string, unknown>).isAccessibleForFree;
          if (free === false || (typeof free === "string" && free.toLowerCase() === "false")) return true;
          return Object.values(value).some(walk);
        }
        return false;
      };
      if (walk(JSON.parse(node.textContent ?? ""))) return true;
    } catch {
      // Malformed JSON-LD is common; ignore it.
    }
  }
  return false;
}

/**
 * Extract readable article text from an HTML page. Pure: no network or database.
 *
 * The HTML is untrusted. It is parsed in a detached DOM and only plain text is
 * returned, never markup. A page is reported as `paywalled` only when it says so
 * itself (schema.org `isAccessibleForFree: false`) and yielded too little text;
 * otherwise too little text is a plain `failed`, so we never guess.
 */
export function extractArticle(html: string): ExtractedArticle {
  let document: Document;
  try {
    ({ document } = parseHTML(html) as unknown as { document: Document });
  } catch {
    return { status: "failed", error: "The page could not be parsed as HTML." };
  }

  const paywall = declaresPaywall(document);
  let parsed: { title?: string | null; content?: string | null; textContent?: string | null } | null = null;
  try {
    parsed = new Readability(document.cloneNode(true) as Document).parse();
  } catch {
    parsed = null;
  }

  const text = cleanText(parsed?.content ? htmlToText(parsed.content) : (parsed?.textContent ?? ""));
  const title = parsed?.title?.trim() || undefined;

  if (text.length >= MIN_ARTICLE_CHARS) return { status: "ok", text, title };
  if (paywall) {
    return {
      status: "paywalled",
      title,
      error: "The page says its content is behind a paywall, so only a preview was available.",
    };
  }
  return {
    status: "failed",
    title,
    error: "Couldn't find readable article text on this page (it may need JavaScript, a login, or isn't an article).",
  };
}

interface FetchArticleArgs {
  ownerEmail: string;
  itemId: string;
  /** Re-fetch even if text is stored or a recent attempt failed. */
  force?: boolean;
  fetchText?: FetchText;
}

export interface ArticleResult {
  itemId: string;
  status: ArticleStatus;
  /** True when stored text was reused without a network request. */
  cached: boolean;
  /** Length of the stored text, in characters. */
  chars: number;
  error?: string;
}

function errorFor(err: unknown): string {
  if (err instanceof FetchError) {
    if (err.code === "blocked") {
      return "Blocked by the network safety check (the address resolves to a private or reserved range).";
    }
    if (err.code === "http_error" && err.status && [401, 402, 403].includes(err.status)) {
      return `The site refused access (HTTP ${err.status}); it may be a paywall, a login wall, or bot protection.`;
    }
    return `${err.code}: ${err.message}`;
  }
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}

async function loadPolicy(ownerEmail: string): Promise<DomainPolicy> {
  const [settings] = await getDb().select().from(sourceSettings).where(eq(sourceSettings.ownerEmail, ownerEmail)).limit(1);
  const list = (json: string | undefined) => {
    try {
      const v = JSON.parse(json ?? "[]");
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    } catch {
      return [];
    }
  };
  return { allowlist: list(settings?.allowlistDomains), denylist: list(settings?.denylistDomains) };
}

/**
 * Fetch and store the readable text of one item's article.
 *
 * A failed or paywalled page is an expected outcome, not an action failure: it
 * is recorded on the item (`fetch_status`, `fetch_error`) and returned, so
 * summarization can say the article couldn't be read instead of guessing. Stored
 * text is reused unless `force` is set, and failed attempts are not retried for
 * six hours unless forced.
 *
 * @throws not_found when the item doesn't exist for this owner.
 */
export async function fetchArticleText(args: FetchArticleArgs): Promise<ArticleResult> {
  const { ownerEmail, itemId, force = false, fetchText = safeFetchText } = args;
  const db = getDb();
  const [item] = await db
    .select()
    .from(items)
    .where(and(eq(items.id, itemId), eq(items.ownerEmail, ownerEmail)))
    .limit(1);
  if (!item) fail("Item not found", { errorCode: "not_found", statusCode: 404 });

  const length = item.fetchedText?.length ?? 0;
  if (!force) {
    if (item.fetchStatus === "ok" && length > 0) {
      return { itemId, status: "ok", cached: true, chars: length };
    }
    const recentFailure =
      (item.fetchStatus === "failed" || item.fetchStatus === "paywalled") &&
      item.fetchedAt &&
      Date.now() - new Date(item.fetchedAt).getTime() < RETRY_AFTER_MS;
    if (recentFailure) {
      return { itemId, status: item.fetchStatus as ArticleStatus, cached: true, chars: 0, error: item.fetchError ?? undefined };
    }
  }

  const record = async (status: ArticleStatus, text: string | null, error: string | null): Promise<ArticleResult> => {
    await db
      .update(items)
      .set({
        fetchStatus: status,
        fetchError: error,
        fetchedText: text,
        fetchedTextHash: text ? createHash("sha256").update(text).digest("hex") : null,
        fetchedAt: new Date().toISOString(),
      })
      .where(and(eq(items.id, itemId), eq(items.ownerEmail, ownerEmail)));
    return { itemId, status, cached: false, chars: text?.length ?? 0, ...(error ? { error } : {}) };
  };

  if (item.discussionUrl && item.url === item.discussionUrl) {
    return record("failed", null, "This is a discussion-only post with no external article to read.");
  }

  let page;
  try {
    page = await fetchText(item.url, {
      accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
      policy: await loadPolicy(ownerEmail),
    });
  } catch (err) {
    return record(err instanceof FetchError && err.status === 402 ? "paywalled" : "failed", null, errorFor(err));
  }

  if (!/html|xml/i.test(page.contentType) && page.contentType !== "") {
    return record("failed", null, `Not a web page (${page.contentType.split(";")[0]}), so there's no article text to read.`);
  }

  const extracted = extractArticle(page.text);
  if (extracted.status === "ok") return record("ok", extracted.text!, null);
  return record(extracted.status, null, extracted.error ?? "No readable text.");
}

/**
 * Fetch article text for up to `limit` items that haven't been tried yet,
 * newest first, a few at a time. Returns one result per item; failures are
 * reported per item and never abort the batch.
 */
export async function fetchPendingArticles(args: {
  ownerEmail: string;
  limit: number;
  fetchText?: FetchText;
}): Promise<ArticleResult[]> {
  const { ownerEmail, limit, fetchText } = args;
  const rows = await getDb()
    .select({ id: items.id })
    .from(items)
    .where(and(eq(items.ownerEmail, ownerEmail), inArray(items.fetchStatus, ["pending"])))
    .orderBy(desc(items.postedAt), desc(items.createdAt))
    .limit(limit);

  const results: ArticleResult[] = [];
  for (let i = 0; i < rows.length; i += BATCH_CONCURRENCY) {
    const batch = rows.slice(i, i + BATCH_CONCURRENCY);
    const settled = await Promise.allSettled(
      batch.map((r) => fetchArticleText({ ownerEmail, itemId: r.id, fetchText })),
    );
    settled.forEach((s, idx) => {
      results.push(
        s.status === "fulfilled"
          ? s.value
          : { itemId: batch[idx].id, status: "failed", cached: false, chars: 0, error: errorFor(s.reason) },
      );
    });
  }
  return results;
}
