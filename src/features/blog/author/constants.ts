import { SANITY_AUTHOR_PATH_PREFIX, SANITY_PERSON_DOCUMENT_TYPE } from "~/sanity/constants";
import { DEFAULT_LOCALE, splitLocalePrefix } from "~/sanity/i18n";
import { localizeDocumentPath, resolveSectionRequest } from "~/sanity/sections";

/** The crop every portrait is served at, so the panel and the author's own page frame the same headshot the same way. */
export const PORTRAIT_ASPECT_RATIO = 7 / 8;

/** Names the panel off the profile's own heading, which is the only title it has. */
export const AUTHOR_DIALOG_TITLE_ID = "author-dialog-title";

/** Marks the links the panel answers. Every one is still a real href to the page it is a view of. */
export const AUTHOR_LINK_ATTR = "data-author-link";

/** Where one locale's author URLs live (`/blog/authors`, prefixed and in the section's own word elsewhere). */
export function authorPathPrefix(locale: string): string {
  return localizeDocumentPath(SANITY_PERSON_DOCUMENT_TYPE, locale, SANITY_AUTHOR_PATH_PREFIX);
}

/** True for one author's own URL in any locale, false for the prefix it lives under and for the partial below it. */
export function isAuthorPath(pathname: string): boolean {
  const { locale, localeInPath, pathname: unprefixed } = splitLocalePrefix(pathname);
  const section = resolveSectionRequest(locale, unprefixed);

  // Spellings the middleware only redirects (`/en/...`, the default section word under a prefix) are nobody's URL.
  if (localeInPath === DEFAULT_LOCALE || (section && "redirect" in section)) {
    return false;
  }

  const routed = section?.rewrite ?? unprefixed;
  const rest = routed.startsWith(`${SANITY_AUTHOR_PATH_PREFIX}/`) ? routed.slice(SANITY_AUTHOR_PATH_PREFIX.length + 1) : "";

  return rest.length > 0 && !rest.includes("/");
}

/** The panel fetches this rather than the full page, so opening one costs kilobytes instead of a document. */
export function authorPartialPath(pathname: string): string {
  return `${pathname}/modal`;
}
