/**
 * Parse a stored timestamp. `posted_at` is ISO-8601; `created_at` is Postgres
 * `now()` text such as "2026-10-07 08:50:09.46-08", which JavaScript can't parse
 * as written. Returns null when the value isn't a date at all.
 */
export function parseTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const iso = value.includes("T") ? value : value.replace(" ", "T");
  const padded = iso.replace(/([+-]\d{2})$/, "$1:00");
  const ms = new Date(padded).getTime();
  return Number.isNaN(ms) ? null : ms;
}
