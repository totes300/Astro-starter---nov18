// Where each locale's homepage lives, so the middleware never redirects a visitor to an unpublished or gated page.
// The published URI is returned rather than constructed, like every other link on the site.

import { createProxySanityState } from "~/features/sanity/proxy-state";
import { capRouteCacheTtl, FALLBACK_RENDER_TTL } from "~/lib/cache";
import { contentVersion } from "~/lib/content-version";
import { PUBLIC_SANITY_API_VERSION, PUBLIC_SANITY_DATASET, PUBLIC_SANITY_PROJECT_ID, SANITY_API_VIEW_TOKEN } from "~/lib/env";
import { IS_I18N_ENABLED, type Locale } from "~/sanity/i18n";
import { HOMEPAGE_LOCALES_QUERY, toHomepageLocalesState } from "./homepage-locales-state";

// Refetched on publish, so a page rendered after one never carries the homepage list from before it.
export const getHomepageLocalesState = createProxySanityState(
  HOMEPAGE_LOCALES_QUERY,
  toHomepageLocalesState,
  {
    projectId: PUBLIC_SANITY_PROJECT_ID,
    dataset: PUBLIC_SANITY_DATASET,
    apiVersion: PUBLIC_SANITY_API_VERSION,
    token: SANITY_API_VIEW_TOKEN,
  },
  { version: () => contentVersion.read() }
);

/** Where a first visit preferring `locale` lands, `undefined` while that homepage is unpublished. */
export async function landingHomeUri(locale: Locale): Promise<string | undefined> {
  return (await getHomepageLocalesState()).homeUriByLocale.get(locale);
}

// For the site chrome: an unreachable list only costs the fallback links, never the page, and only until it is re-rendered.
export async function readHomeUriByLocale(): Promise<ReadonlyMap<string, string>> {
  if (!IS_I18N_ENABLED) {
    return new Map();
  }

  try {
    return (await getHomepageLocalesState()).homeUriByLocale;
  } catch {
    capRouteCacheTtl(FALLBACK_RENDER_TTL);

    return new Map();
  }
}
