// Each language's published homepage, shaped for locale routing and the switcher; env-free so it runs under `node --test`.

import { SANITY_PAGE_DOCUMENT_TYPE } from "~/sanity/constants";
import { DEFAULT_LOCALE, homeUris } from "~/sanity/i18n";
import { ConfiguredLocaleFilter } from "./fragment";

export type HomepageLocalesPayload = { uri?: string | null; language?: string | null }[] | null;

export type HomepageLocalesState = {
  homeUriByLocale: ReadonlyMap<string, string>;
};

export function toHomepageLocalesState(payload: HomepageLocalesPayload): HomepageLocalesState {
  const entries = (payload ?? [])
    .filter(
      (page): page is { uri: string; language: string } => typeof page?.uri === "string" && typeof page?.language === "string"
    )
    .map(({ language, uri }): [string, string] => [language, uri]);

  return { homeUriByLocale: new Map(entries) };
}

// Matched against every locale's home path, so the query stays a constant string and still asks for few documents.
const HOME_URI_LIST = homeUris()
  .map((uri) => `"${uri}"`)
  .join(", ");

// A protected homepage is left out like an unpublished one: the switcher and the landing redirect must not name it.
export const HOMEPAGE_LOCALES_QUERY = `*[
  _type == "${SANITY_PAGE_DOCUMENT_TYPE}" && uri.current in [${HOME_URI_LIST}]
  && passwordProtected != true && ${ConfiguredLocaleFilter}
]{
  "uri": uri.current,
  "language": coalesce(language, "${DEFAULT_LOCALE}")
}`;
