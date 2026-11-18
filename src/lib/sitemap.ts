import { SHARED_ROUTED_DOCUMENT_TYPES } from "~/sanity/constants";
import { DEFAULT_LOCALE, IS_I18N_ENABLED, isLocale, LOCALE_IDS } from "~/sanity/i18n";
import { localizeDocumentPath } from "~/sanity/sections";
import { escapeXml } from "./xml";

/** A translation of the entry's page; `href` is absolute, already built with `absoluteUrl()`. */
export type SitemapAlternate = { hreflang: string; href: string };

/** `loc` is absolute, already built with `absoluteUrl()`. */
export type SitemapEntry = { loc: string; lastmod: string; alternates?: SitemapAlternate[] };

/** One `SitemapQ` row: a listable document, its language and the `translation.metadata` it belongs to. */
export type SitemapDocument = {
  uri: string;
  language?: string | null;
  translationGroup?: string | null;
  updatedAt: string;
};

/** A shared routed document is one row per configured language, clustered on its own id. */
export function withSharedRows<T extends SitemapDocument & { _id?: string; _type?: string }>(rows: T[]): SitemapDocument[] {
  return rows.flatMap(({ _id, _type, ...row }) =>
    _type && _id && SHARED_ROUTED_DOCUMENT_TYPES.includes(_type)
      ? LOCALE_IDS.map((language) => ({
          ...row,
          uri: localizeDocumentPath(_type, language, row.uri),
          language,
          translationGroup: _id,
        }))
      : [row]
  );
}

const URLSET_OPEN = '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">';

/** Clusters rows by `translation.metadata`, from the filtered rows, so no annotation names a URL the sitemap leaves out. */
export function sitemapEntries(documents: SitemapDocument[], toUrl: (path: string) => string): SitemapEntry[] {
  const groups = new Map<string, SitemapAlternate[]>();

  for (const { uri, language, translationGroup } of documents) {
    if (IS_I18N_ENABLED && translationGroup && isLocale(language)) {
      groups.set(translationGroup, [...(groups.get(translationGroup) ?? []), { hreflang: language, href: toUrl(uri) }]);
    }
  }

  return documents.map(({ uri, language, translationGroup, updatedAt }) => {
    const entry = { loc: toUrl(uri), lastmod: updatedAt };
    const group = translationGroup ? (groups.get(translationGroup) ?? []) : [];

    // A cluster of one is noise, and a row in a language the site does not serve is annotated with nothing.
    if (group.length < 2 || !isLocale(language)) {
      return entry;
    }

    const fallback = group.find(({ hreflang }) => hreflang === DEFAULT_LOCALE);

    return { ...entry, alternates: fallback ? [...group, { hreflang: "x-default", href: fallback.href }] : group };
  });
}

// The protocol wants URLs percent-encoded (`/it/caffè` is `/it/caff%C3%A8`); one that cannot be encoded is left out.
function sitemapUrl(url: string): string | null {
  try {
    return escapeXml(encodeURI(url));
  } catch {
    return null;
  }
}

function renderAlternate({ hreflang, href }: SitemapAlternate): string[] {
  const url = sitemapUrl(href);

  return url ? [`    <xhtml:link rel="alternate" hreflang="${escapeXml(hreflang)}" href="${url}" />`] : [];
}

// Google ignores <changefreq> and <priority>, so entries carry only the URL, its language annotations and lastmod.
function renderEntry({ loc, lastmod, alternates = [] }: SitemapEntry): string[] {
  const url = sitemapUrl(loc);

  if (!url) {
    return [];
  }

  return [
    "  <url>",
    `    <loc>${url}</loc>`,
    ...alternates.flatMap(renderAlternate),
    `    <lastmod>${escapeXml(lastmod)}</lastmod>`,
    "  </url>",
  ];
}

export function renderSitemap(entries: SitemapEntry[]): string {
  const urls = entries.flatMap(renderEntry).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>\n${URLSET_OPEN}\n${urls}\n</urlset>\n`;
}
