import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import messages from "@/i18n/en-US";

function translate(key: string, options?: Record<string, unknown>): string {
  const value = key.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], messages);
  if (typeof value !== "string") throw new Error(`Missing translation: ${key}`);
  return value.replace(/\{\{(\w+)\}\}/g, (_, name) => {
    if (!options || !(name in options)) throw new Error(`Missing value "${name}" for ${key}`);
    return String(options[name]);
  });
}

vi.mock("@agent-native/core/client/i18n", () => ({ useT: () => translate }));

const { AddSourceForm, SOURCE_TYPES, buildAddPayload } = await import("./AddSourceForm");

const base = { existingTypes: [] as string[], pending: false, onAdd: () => {}, onImportOpml: () => {}, importing: false };
const html = (over: Partial<typeof base> = {}) => renderToStaticMarkup(<AddSourceForm {...base} {...over} />);

describe("buildAddPayload", () => {
  it("builds the manage-sources arguments, trimming and omitting blank optional fields", () => {
    expect(buildAddPayload("rss", " https://a.example.com/feed ")).toEqual({ operation: "add", type: "rss", url: "https://a.example.com/feed" });
    expect(buildAddPayload("reddit", "programming")).toEqual({ operation: "add", type: "reddit", subreddit: "programming" });
    expect(buildAddPayload("devto", "webdev")).toEqual({ operation: "add", type: "devto", tag: "webdev" });
    expect(buildAddPayload("devto", "  ")).toEqual({ operation: "add", type: "devto" });
    expect(buildAddPayload("github", "TypeScript")).toEqual({ operation: "add", type: "github", language: "TypeScript" });
    expect(buildAddPayload("github", "")).toEqual({ operation: "add", type: "github" });
    for (const type of ["hn", "lobsters", "producthunt"] as const) expect(buildAddPayload(type, "ignored")).toEqual({ operation: "add", type });
  });

  it("returns null when a required field is empty", () => {
    expect(buildAddPayload("rss", "")).toBeNull();
    expect(buildAddPayload("reddit", "   ")).toBeNull();
  });
});

describe("AddSourceForm", () => {
  it("offers every source type, and every label and placeholder it needs exists", () => {
    const out = html();
    for (const label of ["RSS / Atom feed", "Subreddit", "Hacker News (top stories)", "Lobsters (hottest)", "dev.to (top of the week)", "GitHub (popular new repos)", "Product Hunt"]) {
      expect(out).toContain(`>${label}</option>`);
    }
    expect(out.match(/<option /g)).toHaveLength(SOURCE_TYPES.length);
    expect(out).toContain("Feed URL");
    expect(out).toContain('placeholder="https://example.com/feed.xml"');
    expect(out).toContain("Import OPML");
    // Every per-type field key resolves (translate throws on a missing one).
    for (const name of ["url", "subreddit", "tag", "language"]) {
      expect(() => translate(`sources.${name}Label`)).not.toThrow();
      expect(() => translate(`sources.${name}Placeholder`)).not.toThrow();
    }
  });

  it("disables single-instance types that were already added, and only those", () => {
    const out = html({ existingTypes: ["hn", "lobsters", "rss", "devto"] });
    expect(out).toMatch(/<option value="hn" disabled="">/);
    expect(out).toMatch(/<option value="lobsters" disabled="">/);
    expect(out).not.toMatch(/<option value="producthunt" disabled="">/);
    expect(out).not.toMatch(/<option value="rss" disabled="">/); // you can add many feeds
    expect(out).not.toMatch(/<option value="devto" disabled="">/); // and several dev.to tags
  });

  it("shows a pending state and the import state", () => {
    expect(html({ pending: true })).toContain("Adding...");
    expect(html({ importing: true })).toContain("Importing...");
  });
});
