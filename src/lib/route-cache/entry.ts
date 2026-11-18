// What keys a cached response: the router's path plus the normalized query, and which responses may be
// stored at all. See docs/sanity/revalidation-and-caching.md

import type { CacheOptions } from "astro";
import { decodeRequestPath } from "~/features/auth/canonical-path";
import { splitLocalePrefix } from "~/sanity/i18n";
import { resolveSectionRequest } from "~/sanity/sections";

/** Past this a body still renders, it is just not stored. */
export const ENTRY_MAX_BYTES = 1_000_000;

export type EntryTarget = {
  /** Decoded the way the router decodes it, doubled slashes collapsed and the trailing slash dropped. */
  path: string;
  /** The route's own params, deduped and sorted; empty for none. */
  query: string;
};

// Campaign and referral parameters never change content; without this every ?utm_source is its own entry.
const TRACKING_PARAMS = new Set([
  "fbclid",
  "gclid",
  "gbraid",
  "wbraid",
  "dclid",
  "msclkid",
  "twclid",
  "li_fat_id",
  "mc_cid",
  "mc_eid",
  "_ga",
  "_gl",
  "_hsenc",
  "_hsmi",
  "_ke",
  "oly_anon_id",
  "oly_enc_id",
  "rb_clickid",
  "s_cid",
  "vero_id",
  "wickedid",
  "yclid",
  "__s",
  "ref",
]);

function isTrackingParam(key: string): boolean {
  const lower = key.toLowerCase();

  return lower.startsWith("utm_") || TRACKING_PARAMS.has(lower);
}

/** Query params each route reads, keyed by its unprefixed path; a new one goes here, or its requests are never stored. */
export const ROUTE_QUERY_PARAMS: Readonly<Record<string, readonly string[]>> = {
  "/blog": ["category"],
};

/** The route a public path renders: its locale prefix stripped and a language's own section word mapped back. */
function routePath(path: string): string {
  const { locale, pathname } = splitLocalePrefix(path);
  const section = resolveSectionRequest(locale, pathname);

  return section && "rewrite" in section ? section.rewrite : pathname;
}

/** Past these a request still renders, it is just not stored, so no query can mint an oversized key. */
const MAX_QUERY_PAIRS = 16;
const MAX_QUERY_VALUE_LENGTH = 100;

/** The route's own params, deduped and sorted, minus tracking ones; null (not stored) for any other. */
export function entryQuery(path: string, params: URLSearchParams): string | null {
  const allowed = ROUTE_QUERY_PARAMS[routePath(path)] ?? [];
  const pairs: [string, string][] = [];

  for (const name of [...new Set(params.keys())].sort()) {
    if (isTrackingParam(name)) {
      continue;
    }

    // Refused, not dropped: a route that starts reading it must never get an entry keyed without it.
    if (!allowed.includes(name)) {
      return null;
    }

    for (const value of [...new Set(params.getAll(name))].sort()) {
      if (value.length > MAX_QUERY_VALUE_LENGTH) {
        return null;
      }

      pairs.push([name, value]);
    }
  }

  return pairs.length > MAX_QUERY_PAIRS ? null : new URLSearchParams(pairs).toString();
}

/** The path the router renders plus the normalized query; null for a request that must not be cached at all. */
export function entryTarget(url: URL): EntryTarget | null {
  const path = decodeRequestPath(url.pathname);

  if (path === null) {
    return null;
  }

  const query = entryQuery(path, url.searchParams);

  return query === null ? null : { path, query };
}

// Astro turns `Astro.cookies` writes into Set-Cookie only after this provider returns, so read them off the response.
const ASTRO_COOKIES = Symbol.for("astro.cookies");

function setsCookies(response: Response): boolean {
  if (response.headers.has("set-cookie")) {
    return true;
  }

  const cookies: unknown = Reflect.get(response, ASTRO_COOKIES);

  if (typeof cookies !== "object" || cookies === null || !("headers" in cookies) || typeof cookies.headers !== "function") {
    return false;
  }

  return !(cookies.headers() as Iterator<string>).next().done;
}

/** Null when it must not be stored: only a plain 200 that sets no cookie, with a lifetime the route asked for, is an entry. */
export function entryTtl(response: Response, options: CacheOptions | undefined): number | null {
  if (response.status !== 200 || setsCookies(response)) {
    return null;
  }

  const maxAge = options?.maxAge ?? 0;

  return maxAge > 0 ? maxAge : null;
}
