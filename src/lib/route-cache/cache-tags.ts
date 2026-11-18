// Our tags as the Workers Cache accepts them: printable ASCII with no space or comma, at most 1,024 characters,
// compared case-insensitively. A URI tag carries any other character percent-encoded.

/** Cloudflare drops an invalid tag silently, so one past this is left out rather than sent. */
const MAX_TAG_LENGTH = 1024;

/** The `Cache-Tag` header may not exceed 16 KB in all. */
const MAX_HEADER_LENGTH = 16 * 1024;

export function encodeCacheTag(tag: string): string | null {
  const encoded = tag.replace(/[^\x21-\x7e]|[,%]/gu, (char) => encodeURIComponent(char));

  return encoded.length > 0 && encoded.length <= MAX_TAG_LENGTH ? encoded : null;
}

export function encodeCacheTags(tags: readonly string[]): string[] {
  return [...new Set(tags.flatMap((tag) => encodeCacheTag(tag) ?? []))];
}

/** Null when the tags would not fit one header: storing such a response would leave it unpurgeable by some of them. */
export function cacheTagHeader(tags: readonly string[]): string | null {
  const header = encodeCacheTags(tags).join(",");

  return header.length <= MAX_HEADER_LENGTH ? header : null;
}
