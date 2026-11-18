import { stegaClean } from "@sanity/client/stega";
import { joinSiteUrl } from "~/lib/site-url";
import { DEFAULT_LOCALE, IS_I18N_ENABLED, isLocale } from "~/sanity/i18n";
import type { AlternateResult } from "./fragment";
import { sharedLocalePaths } from "./shared-documents";

export type AlternateLink = {
  hreflang: string;
  /** Absolute URL. */
  href: string;
  /** The path as stored; the switcher builds its own links (`buildLanguageLinks`), noindex translations included. */
  path: string;
};

type BuildArgs = {
  siteUrl: string;
  locale: string;
  uri: string;
  noIndex?: boolean | null;
  alternates?: (AlternateResult | null | undefined)[] | null;
};

/** Every indexable variant plus a self-reference, and `x-default` on the default locale. Nothing for a noindex page. */
export function buildAlternateLinks({ siteUrl, locale, uri, noIndex, alternates }: BuildArgs): AlternateLink[] {
  if (!IS_I18N_ENABLED || noIndex === true) {
    return [];
  }

  const byLocale = new Map<string, string>();

  // Seed with the page itself: the metadata document is absent until a first translation exists.
  byLocale.set(locale, uri);

  for (const alternate of alternates ?? []) {
    const language = stegaClean(alternate?.language ?? "");
    const alternateUri = stegaClean(alternate?.uri ?? "");

    if (!isLocale(language) || !alternateUri || alternate?.noIndex === true) {
      continue;
    }

    byLocale.set(language, alternateUri);
  }

  if (byLocale.size < 2) {
    return [];
  }

  const links = [...byLocale].map(([language, path]) => ({
    hreflang: language,
    href: joinSiteUrl(siteUrl, path),
    path,
  }));

  const fallback = byLocale.get(DEFAULT_LOCALE);

  if (fallback) {
    links.push({ hreflang: "x-default", href: joinSiteUrl(siteUrl, fallback), path: fallback });
  }

  return links;
}

/** A shared routed document's translations: itself at every configured language's URL, from its one stored `uri`. */
export function sharedAlternates(type: string, storedUri: string, noIndex?: boolean | null): AlternateResult[] {
  return sharedLocalePaths(type, storedUri).map((path) => ({ ...path, noIndex }));
}
