// Each routed section's URL segment per language, and the one rule that moves a path between languages.
// Full reference: docs/features/internationalization.md ("Section segments").

import { SANITY_ARTICLE_DOCUMENT_TYPE, SANITY_PERSON_DOCUMENT_TYPE, SANITY_SINGLETON_BLOG_ID } from "./constants";
import { DEFAULT_LOCALE, isLocale, splitLocalePrefix, withLocalePrefix } from "./i18n";

/** The key names the section's route folder and is its default-locale word; other languages name their own. */
export const SECTION_SEGMENTS = {
  blog: { it: "blog" },
  // PLOP: Add Section Segment
} as const satisfies Record<string, Record<string, string>>;

export type Section = keyof typeof SECTION_SEGMENTS;

export type SectionTypes = {
  /** The singleton the section opens on; a generated prefix route has none. */
  index?: string;
  item: string;
  /** Other types routed under the section word (people at `/blog/authors/<slug>`), validated and moved like an item. */
  nested?: readonly string[];
};

export const SECTION_TYPES: Record<Section, SectionTypes> = {
  blog: { index: SANITY_SINGLETON_BLOG_ID, item: SANITY_ARTICLE_DOCUMENT_TYPE, nested: [SANITY_PERSON_DOCUMENT_TYPE] },
  // PLOP: Add Section Types
};

export const SECTIONS = Object.keys(SECTION_SEGMENTS) as Section[];

/** Read through `SectionTypes`, so this still typechecks once a trim leaves no section and `Section` is `never`. */
function typesOf(section: Section): SectionTypes {
  return SECTION_TYPES[section];
}

/** The types served under a section's word, the index excluded. */
function routedTypes(section: Section): readonly string[] {
  const { item, nested = [] } = typesOf(section);

  return [item, ...nested];
}

/** Every document type that lives under a section: index, items and nested types alike. */
export const SECTION_DOCUMENT_TYPES: string[] = SECTIONS.flatMap((section) => {
  const { index } = typesOf(section);

  return index ? [index, ...routedTypes(section)] : routedTypes(section);
});

export function sectionOfType(type: string | null | undefined): Section | undefined {
  if (!type) {
    return undefined;
  }

  return SECTIONS.find((section) => typesOf(section).index === type || routedTypes(section).includes(type));
}

/** The section's URL word in `locale`; the key for the default locale, a language that is switched off, or an unnamed one. */
export function sectionSegment(locale: string, section: Section): string {
  if (locale === DEFAULT_LOCALE || !isLocale(locale)) {
    return section;
  }

  return (SECTION_SEGMENTS[section] as Record<string, string>)[locale] ?? section;
}

/** The section's public path in `locale`, with `rest` (`/<slug>`) appended. */
export function sectionPath(locale: string, section: Section, rest = ""): string {
  return withLocalePrefix(locale, `/${sectionSegment(locale, section)}${rest}`);
}

/** A document's path moved into `locale`: the prefix, and for a section's documents the word in their first segment. */
export function localizeDocumentPath(type: string | null | undefined, locale: string, path: string): string {
  const { pathname } = splitLocalePrefix(path);
  const section = sectionOfType(type);

  if (!section) {
    return withLocalePrefix(locale, pathname);
  }

  if (typesOf(section).index === type) {
    return sectionPath(locale, section);
  }

  const segments = pathname.split("/").filter(Boolean);
  const slug = segments.length > 1 ? segments.slice(1) : segments;

  return sectionPath(locale, section, slug.length ? `/${slug.join("/")}` : "");
}

/** A shared routed document's one stored URI from any language's URL of it: the prefix and the section word undone. */
export function sharedDocumentPath(path: string): string {
  const { locale, pathname } = splitLocalePrefix(path);
  const section = resolveSectionRequest(locale, pathname);

  return section && "rewrite" in section ? section.rewrite : pathname;
}

export type SectionRequest = { rewrite: string } | { redirect: string } | null;

/** After the prefix is stripped: the route folder a language's own section word maps to, or a redirect off the default word. */
export function resolveSectionRequest(locale: string, pathname: string): SectionRequest {
  const [first, ...rest] = pathname.split("/").filter(Boolean);

  if (!first || locale === DEFAULT_LOCALE) {
    return null;
  }

  const tail = rest.length ? `/${rest.join("/")}` : "";
  const localized = SECTIONS.find((section) => sectionSegment(locale, section) === first);

  if (localized && localized !== first) {
    return { rewrite: `/${localized}${tail}` };
  }

  if (!localized && SECTIONS.includes(first as Section)) {
    return { redirect: sectionPath(locale, first as Section, tail) };
  }

  return null;
}

/** Where a document must sit: an index at its section's path, routed types under its word, anything else outside every word. */
export function sectionPathIssue(type: string | null | undefined, locale: string, uri: string): string | undefined {
  const { pathname } = splitLocalePrefix(uri);
  const section = sectionOfType(type);

  if (section) {
    const expected = localizeDocumentPath(type, locale, uri);

    if (typesOf(section).index === type) {
      return uri === expected ? undefined : `This URI is fixed at "${expected}".`;
    }

    const base = sectionPath(locale, section);

    if (uri.startsWith(`${base}/`) && uri.length > base.length + 1) {
      return undefined;
    }

    const issue = `Must sit under "${base}/".`;

    // A nested type's own sub-path (`/authors/`) is its route's rule, so only an item's corrected path is known here.
    return typesOf(section).item === type ? `${issue} Use "${expected}".` : issue;
  }

  const first = pathname.split("/").filter(Boolean)[0];
  // The default word too: `resolveSectionRequest` redirects it to the language's own, so nothing could be served there.
  const claimed = SECTIONS.find((candidate) => sectionSegment(locale, candidate) === first || candidate === first);

  return claimed ? `"${sectionPath(locale, claimed)}" belongs to the ${claimed} section. Choose a different path.` : undefined;
}
