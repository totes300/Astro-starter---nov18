// The one client read seam: `loadQuery` and every API route read through it, so every query binds the locale params.
// `fetch.test.ts` fails on a Sanity read anywhere else, outside the proxy-state HTTP fetch.

import type { FilteredResponseQueryOptions, QueryParams, SanityClient } from "@sanity/client";
import { localeParams } from "~/features/i18n/fragment";

const WORD = /[\w$]/;
const DIGIT = /\d/;
/** GROQ's own whitespace, narrower than `\s`: any other character outside a string is kept, never dropped. */
const WHITESPACE = /[\t\n\v\f\r \u0085 ]/;

/** Neighbours a dropped space would fuse into one token: an operator, a comment, or a number. */
const FUSING_PAIRS = new Set(["**", "->", "=>", "==", "!=", "<=", ">=", "..", "||", "&&", "::", "//", "--", "++"]);

function keepsSpace(before: string, after: string): boolean {
  return (
    (WORD.test(before) && WORD.test(after)) ||
    FUSING_PAIRS.has(before + after) ||
    (DIGIT.test(before) && after === ".") ||
    (before === "." && DIGIT.test(after))
  );
}

/** Just past the string literal opening at `start`, escapes included; the end of the text when it never closes. */
function stringEnd(query: string, start: number): number {
  const quote = query.charAt(start);
  let index = start + 1;

  while (index < query.length) {
    const char = query.charAt(index);

    if (char === "\\") {
      index += 2;
      continue;
    }

    if (char === quote) {
      return index + 1;
    }

    index++;
  }

  return query.length;
}

/** The text sent: `//` comments and whitespace dropped outside string literals, a space kept only where tokens would fuse. */
export function minifyGroq(query: string): string {
  let minified = "";
  let spaced = false;
  let index = 0;

  while (index < query.length) {
    const char = query.charAt(index);

    if (char === "/" && query.charAt(index + 1) === "/") {
      const lineEnd = query.indexOf("\n", index);

      index = lineEnd === -1 ? query.length : lineEnd;
      spaced = true;
      continue;
    }

    if (WHITESPACE.test(char)) {
      index++;
      spaced = true;
      continue;
    }

    if (spaced && keepsSpace(minified.slice(-1), char)) {
      minified += " ";
    }

    const end = char === '"' || char === "'" ? stringEnd(query, index) : index + 1;

    minified += query.slice(index, end);
    index = end;
    spaced = false;
  }

  return minified;
}

// Minified so the long page queries stay under the client's GET limit, which the API CDN's edge caches (query-budget.test.ts).
export function fetchSanity<R>(
  client: SanityClient,
  query: string,
  params?: QueryParams,
  options: FilteredResponseQueryOptions = {}
): Promise<R> {
  return client.fetch<R>(minifyGroq(query), localeParams(params), options);
}
