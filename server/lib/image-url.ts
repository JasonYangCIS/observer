/** Longest thumbnail URL we will store. */
const MAX_IMAGE_URL_CHARS = 2048;

/**
 * Validate a thumbnail URL taken from untrusted feed or page metadata.
 *
 * Only absolute https URLs without embedded credentials are accepted; `data:`,
 * `http:`, `javascript:` and everything else is dropped. Relative URLs are
 * resolved against `base` (the page they were found on). Returns the normalized
 * URL, or undefined when it isn't usable. The image itself is never fetched or
 * stored by the server; only this URL is kept, and the browser loads it.
 */
export function safeImageUrl(raw: string | null | undefined, base?: string): string | undefined {
  const value = raw?.trim();
  if (!value || value.length > MAX_IMAGE_URL_CHARS) return undefined;
  try {
    const url = new URL(value, base);
    if (url.protocol !== "https:" || url.username || url.password) return undefined;
    const href = url.toString();
    return href.length <= MAX_IMAGE_URL_CHARS ? href : undefined;
  } catch {
    return undefined;
  }
}
