import { stegaClean } from "@sanity/client/stega";
import { getLocaleTitle, IS_I18N_ENABLED, isLocale, LOCALE_IDS } from "~/sanity/i18n";
import type { AlternateResult } from "./fragment";

export type LanguageLink = {
  locale: string;
  title: string;
  href: string;
  isCurrent: boolean;
};

type BuildArgs = {
  locale: string;
  uri: string;
  alternates?: (AlternateResult | null | undefined)[] | null;
  homeUriByLocale: ReadonlyMap<string, string>;
};

/**
 * The switcher's options, in `LOCALES` order: the page's own translation, else that language's published homepage.
 * Unlike hreflang, a noindex translation is still a place a reader can go.
 */
export function buildLanguageLinks({ locale, uri, alternates, homeUriByLocale }: BuildArgs): LanguageLink[] {
  if (!IS_I18N_ENABLED) {
    return [];
  }

  const byLocale = new Map<string, string>([[locale, uri]]);

  for (const alternate of alternates ?? []) {
    const language = stegaClean(alternate?.language ?? "");
    const alternateUri = stegaClean(alternate?.uri ?? "");

    if (isLocale(language) && alternateUri && language !== locale) {
      byLocale.set(language, alternateUri);
    }
  }

  const links = LOCALE_IDS.flatMap((id) => {
    const href = byLocale.get(id) ?? homeUriByLocale.get(id);

    return href ? [{ locale: id, title: getLocaleTitle(id), href, isCurrent: id === locale }] : [];
  });

  return links.length > 1 ? links : [];
}
