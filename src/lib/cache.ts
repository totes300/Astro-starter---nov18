// Cache tag model, shared by the pages that set tags and the webhook that invalidates them.
// Every page also carries the site-wide tags, since what they name renders in every head and footer.

import type { CacheOptions } from "astro";
import { SANITY_SINGLETON_SITE_ID, SANITY_SINGLETON_SITE_SETTINGS_ID } from "~/sanity/constants";
import { homeUris } from "~/sanity/i18n";

export { capRouteCacheTtl } from "~/lib/route-cache/render-scope";

/** Publish-driven only; the year-long maxAge exists because the cache API requires one. */
export const CACHE_TTL = {
  maxAge: 31536000,
} as const;

/** Seconds a render that fell back after a passing upstream failure is kept, so the fallback is gone soon after the outage. */
export const FALLBACK_RENDER_TTL = 60;

type CacheTarget = {
  cache: { set(input: CacheOptions | false): void };
  locals: Pick<App.Locals, "draftSession">;
};

/** How every route caches its response, or declines to with `false`: never under a draft session, whatever it asks. */
export function cacheResponse({ cache, locals }: CacheTarget, options: CacheOptions | false): void {
  cache.set(locals.draftSession ? false : options);
}

// The switcher falls back to these homepages on any page, so publishing or unpublishing one refreshes them all.
const LANGUAGE_HOME_TAGS = homeUris().filter((uri) => uri !== "/");

/** Every response they can change carries these: `site` owns the header, footer and SEO defaults, `siteSettings` the favicon. */
export const SITE_WIDE_CACHE_TAGS = [SANITY_SINGLETON_SITE_ID, SANITY_SINGLETON_SITE_SETTINGS_ID, ...LANGUAGE_HOME_TAGS];

/** Stable per-document tag; draft ids collapse onto their published id. */
export function docTag(id: string): string {
  return `doc:${id.replace(/^drafts\./, "")}`;
}

/** The tags a routed document's response carries, and the ones a publish invalidates. */
export function docCacheTags({ _id, _type, uri }: { _id: string; _type: string; uri?: string | null }): string[] {
  const tags = [_type, docTag(_id)];

  if (uri) {
    tags.push(uri);
  }

  return tags;
}
