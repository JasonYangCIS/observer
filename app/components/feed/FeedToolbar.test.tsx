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

const { FeedToolbar } = await import("./FeedToolbar");
import type { FeedToolbarProps } from "./FeedToolbar";

const base: FeedToolbarProps = { view: "feed", onViewChange: () => {}, sort: "ranked", onSortChange: () => {}, hideRead: false, onHideReadChange: () => {}, readCount: 0 };
const html = (over: Partial<FeedToolbarProps> = {}) => renderToStaticMarkup(<FeedToolbar {...base} {...over} />);

/** The aria-pressed value of the button with this label. */
const pressed = (out: string, label: string) => new RegExp(`aria-pressed="(true|false)"[^>]*>${label}</button>`).exec(out)?.[1];

describe("FeedToolbar", () => {
  it("shows the Feed and Saved tabs with the current view pressed", () => {
    expect(pressed(html(), "Feed")).toBe("true");
    expect(pressed(html(), "Saved")).toBe("false");
    expect(pressed(html({ view: "saved" }), "Saved")).toBe("true");
  });

  it("shows the sort toggle with the current order pressed", () => {
    expect(pressed(html(), "Ranked")).toBe("true");
    expect(pressed(html(), "Newest")).toBe("false");
    const newest = html({ sort: "newest" });
    expect(pressed(newest, "Newest")).toBe("true");
    expect(pressed(newest, "Ranked")).toBe("false");
  });

  it("shows the hide-read checkbox with the count of read items, and its checked state", () => {
    expect(html()).toContain(">Hide read</span>");
    expect(html({ readCount: 12 })).toContain(">Hide read (12)</span>");
    expect(html()).not.toMatch(/<input[^>]*checked=""/);
    expect(html({ hideRead: true })).toMatch(/<input[^>]*checked=""/);
    expect(html({ hideRead: true })).toContain("font-medium text-foreground");
  });

  it("labels each group for assistive technology", () => {
    const out = html();
    expect(out).toContain('aria-label="View"');
    expect(out).toContain('aria-label="Sort"');
    expect(out).toContain('type="checkbox"');
  });
});
