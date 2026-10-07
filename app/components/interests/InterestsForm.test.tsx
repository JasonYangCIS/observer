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

const { InterestsForm } = await import("./InterestsForm");

const base = {
  value: "I follow edge rendering and WebAssembly, and less crypto and politics.",
  onChange: () => {},
  onSave: () => {},
  onReset: () => {},
  onAskAgent: () => {},
  saving: false,
  dirty: false,
  isDefault: false,
  lastChanged: "2 hours ago",
  staleScores: 0,
};
const html = (over: Partial<typeof base> = {}) => renderToStaticMarkup(<InterestsForm {...base} {...over} />);

describe("InterestsForm", () => {
  it("shows the saved text with its length and when it last changed, and disables Save until edited", () => {
    const out = html();
    expect(out).toContain("I follow edge rendering and WebAssembly");
    expect(out).toContain("70 of 2000 characters");
    expect(out).toContain("Last changed 2 hours ago");
    expect(out).toMatch(/<button type="submit" disabled=""[^>]*>Save<\/button>/);
    expect(out).not.toContain("Unsaved changes");
    expect(out).toContain("Ask the agent to change it");
    expect(out).toContain("more edge rendering, less crypto");
  });

  it("marks unsaved edits and enables Save when the text is valid", () => {
    const out = html({ dirty: true });
    expect(out).toContain("Unsaved changes");
    expect(out).not.toContain("Last changed");
    expect(out).toMatch(/<button type="submit"[^>]*>Save<\/button>/);
    expect(out).not.toMatch(/<button type="submit"[^>]*disabled=""/);
  });

  it("keeps Save disabled and flags the count when the text is too short or too long", () => {
    const short = html({ dirty: true, value: "Too short" });
    expect(short).toMatch(/<button type="submit" disabled=""/);
    expect(short).toContain("text-destructive");
    expect(html({ dirty: true, value: "x".repeat(2001) })).toMatch(/<button type="submit" disabled=""/);
  });

  it("shows a saving state, and the re-score note only when nothing is unsaved", () => {
    expect(html({ dirty: true, saving: true })).toContain("Saving...");
    expect(html({ staleScores: 4 })).toContain("4 recent items will be re-scored on the next update.");
    expect(html({ staleScores: 4, dirty: true })).not.toContain("re-scored");
  });

  it("offers the starting text only when the profile isn't already the default", () => {
    expect(html()).toContain("Use the starting text");
    const def = html({ isDefault: true });
    expect(def).not.toContain("Use the starting text");
    expect(def).toContain("This is the starting text.");
    expect(html({ isDefault: true, dirty: true })).toContain("Use the starting text");
  });
});
