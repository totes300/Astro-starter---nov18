import type { APIRoute } from "astro";
import { isSectionPreviewRequestPath } from "~/features/page-builder/section-preview-path";
import { CACHE_TTL, cacheResponse, SITE_WIDE_CACHE_TAGS } from "~/lib/cache";
import { absoluteUrl } from "~/lib/env";
import { renderSitemap, type SitemapDocument, sitemapEntries, withSharedRows } from "~/lib/sitemap";
import type { SitemapQResult } from "~/sanity/types";
import { loadQuery } from "../sanity/lib/load-query";
import { SitemapQ } from "../sanity/queries";

const XML_HEADERS = { "content-type": "application/xml; charset=utf-8" };

// CMS-driven sitemap: every routed document that is not noindex or password protected, in every language, with its alternates.
// While the site is locked the middleware gates this route like a page, and the route cache never stores it.
export const GET: APIRoute = async (context) => {
  // Any routed document's publish changes the sitemap, so it carries every routed _type.
  cacheResponse(context, { ...CACHE_TTL, tags: ["page", "legalPage", "article", "person", "blog", ...SITE_WIDE_CACHE_TAGS] });

  const { data } = await loadQuery<SitemapQResult>({ query: SitemapQ });

  // The specimen's path is reserved and gated in every language, so a CMS page under it is never public.
  const documents: SitemapDocument[] = withSharedRows(
    (data ?? []).flatMap(({ uri, ...row }) => (uri && !isSectionPreviewRequestPath(uri) ? [{ ...row, uri }] : []))
  );

  return new Response(renderSitemap(sitemapEntries(documents, absoluteUrl)), { headers: XML_HEADERS });
};
