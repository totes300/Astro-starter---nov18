// GROQ building blocks for locale-aware queries; `coalesce` everywhere, so pre-language documents still resolve.
// Every read binds `$language` and `$locales` through `localeParams` (the ghost guard): docs/features/internationalization.md

import type { QueryParams } from "@sanity/client";
import { stegaClean } from "@sanity/client/stega";
import { DEFAULT_LOCALE, isLocale, LOCALE_IDS, type Locale } from "~/sanity/i18n";

/** Matches the requested locale. Pair with a `$language` param. */
export const LocaleFilter = `coalesce(language, "${DEFAULT_LOCALE}") == $language`;

/** Pins a read to the default locale's document. */
export const DefaultLocaleFilter = `coalesce(language, "${DEFAULT_LOCALE}") == "${DEFAULT_LOCALE}"`;

/** With `LocaleFirstOrder`: a per-locale singleton in the requested locale, else the default's, so no page renders bare. */
export const LocaleOrDefaultFilter = `(${LocaleFilter} || ${DefaultLocaleFilter})`;

export const LocaleFirstOrder = `order((coalesce(language, "${DEFAULT_LOCALE}") == $language) desc)`;

/** Inside a sub-query: keeps the join in the enclosing document's language. */
export const ParentLocaleFilter = `coalesce(language, "${DEFAULT_LOCALE}") == coalesce(^.language, "${DEFAULT_LOCALE}")`;

/** Hides a document whose language `LOCALES` no longer lists, so removing a locale is safe before its content is purged. */
export const ConfiguredLocaleFilter = `coalesce(language, "${DEFAULT_LOCALE}") in $locales`;

/** The same test on a referenced document, inside `select(...)`; pass a string literal or typegen drops the query. */
export const configuredReference = (path: string) => `coalesce(${path}->language, "${DEFAULT_LOCALE}") in $locales`;

/** A field translated in place, else its default, else a pre-translation string; `string()` stops typegen reading a filter. */
export const localized = (path: string) => `coalesce(string(${path}[$language]), ${path}.${DEFAULT_LOCALE}, string(${path}))`;

/** Projects the document's locale, defaulting documents written before the field existed. */
export const LocaleField = `"language": coalesce(language, "${DEFAULT_LOCALE}")`;

/** Projected onto the fetched document via `translation.metadata`; a protected, unrouted or unconfigured one is never named. */
export const AlternatesFragment = `
  "alternates": (*[_type == "translation.metadata" && references(^._id)].translations[].value->)[
    defined(uri.current) && passwordProtected != true && ${ConfiguredLocaleFilter}
  ]{
    "language": coalesce(language, "${DEFAULT_LOCALE}"),
    "uri": uri.current,
    "noIndex": seoMetadata.noIndex == true
  }
`;

export type AlternateResult = {
  language?: string | null;
  uri?: string | null;
  noIndex?: boolean | null;
};

export type LocaleParams = { language: Locale; locales: readonly Locale[] };

/** Every read's params: `$language` cleaned and checked, and `$locales` spread last, so no caller can widen the guard. */
export function localeParams<P extends QueryParams>(params?: P): P & LocaleParams {
  const language = stegaClean(params?.language ?? DEFAULT_LOCALE);

  if (!isLocale(language)) {
    throw new Error(`[i18n] localeParams: $language must be a configured locale, got "${String(language)}".`);
  }

  return { ...params, language, locales: LOCALE_IDS } as P & LocaleParams;
}
