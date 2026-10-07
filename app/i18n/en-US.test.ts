import { describe, expect, it } from "vitest";
import messages from "./en-US.js";

/** Every message string, with the dotted key it lives at. */
function flatten(value: unknown, prefix = ""): [string, string][] {
  if (typeof value === "string") return [[prefix, value]];
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => flatten(v, prefix ? `${prefix}.${k}` : k));
  }
  return [];
}

describe("en-US messages", () => {
  it("use i18next's {{name}} placeholders, never single-brace {name}", () => {
    // i18next only fills {{name}}; a single-brace placeholder is printed literally in the UI.
    const offenders = flatten(messages)
      .filter(([, text]) => /(?<!\{)\{\w+\}(?!\})/.test(text))
      .map(([key]) => key);
    expect(offenders).toEqual([]);
  });

  it("every placeholder is a plain word, so callers can pass it by name", () => {
    for (const [key, text] of flatten(messages)) {
      for (const match of text.matchAll(/\{\{([^}]*)\}\}/g)) {
        expect(match[1], key).toMatch(/^\w+$/);
      }
    }
  });
});
