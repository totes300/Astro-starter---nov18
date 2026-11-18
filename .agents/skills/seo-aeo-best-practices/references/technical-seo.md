# Technical SEO Checklist

Essential technical SEO elements for modern web applications.

## Table of Contents

- Metadata
- Sitemaps
- Canonical URLs
- Redirects
- Performance
- Robots.txt
- International SEO

## Metadata

### Title Tags

- Unique per page
- 50-60 characters
- Primary keyword near the beginning
- Brand name at the end (optional)

### Meta Descriptions

- Unique per page
- 150-160 characters
- Include call-to-action
- Contain relevant keywords

### Open Graph

```html
<meta property="og:title" content="Page Title" />
<meta property="og:description" content="Description" />
<meta property="og:image" content="https://example.com/image.jpg" />
<meta property="og:url" content="https://example.com/page" />
<meta property="og:type" content="article" />
```

### How this repo does it

Meta lives in one place: `src/layouts/Web.astro` renders every tag from its typed `Props`, and pages pass those props in the frontmatter. `seo()` in `src/sanity/seo.ts` merges a document's `seoMetadata` with the `site` singleton's defaults, so a page only supplies what it overrides (it also runs `getOgImageSrc`, which crops the CMS image to 1200x630, and keeps only the social profile URLs `safeHref()` accepts for the Organization `sameAs`).

```astro
---
import Web from "~/layouts/Web.astro";
import { loadSite, seo } from "../sanity/seo";

// `loadSite` is separate from `seo` so the route fetches it alongside its own document query.
const [{ data: page }, { data: site }] = await Promise.all([
  loadQuery<PageQResult>({ query: PageQ, params: { uri }, ...getDraftModeProps(Astro) }),
  loadSite(Astro),
]);

const locale = stegaClean(page.language);
const alternates = buildAlternateLinks({ siteUrl: PUBLIC_SITE_URL, locale, uri, noIndex: page.noIndex, alternates: page.alternates });
const { title, description, image, robots } = page.seoMetadata ?? {};
const seoProps = seo(site, { title, description, image, robots, canonical, lang: locale, alternates });
---

<Web {...seoProps}>
  <Fragment slot="head">
    <!-- per-page extras only; the standard tags are already in Web.astro -->
  </Fragment>
</Web>
```

Two things to keep right: strings that end up in meta tags must be stega-free (`stegaClean`) so invisible preview characters never reach a crawler, and a page's `noindex` has to reach the `robots` prop rather than being handled at the template level.

## Sitemaps

`src/pages/sitemap.xml.ts` is a CMS-driven endpoint: one GROQ query (`SitemapQ`) returns every routed document in every configured language that is not noindex or password protected, `sitemapEntries()` (`src/lib/sitemap.ts`) groups the translations of one page into a cluster (see International SEO below), and `renderSitemap()` serializes it, escaping each value with `escapeXml` (`src/lib/xml.ts`) so a URI such as `/q&a` cannot invalidate the document. The route is exempt from Basic Auth except while the whole site is locked: then the middleware gates it like a page, so the page list needs the password, and the route cache does not store it. Otherwise it is cached with every routed `_type` plus `SITE_WIDE_CACHE_TAGS`, so a publish invalidates it through `/api/revalidate`. Tags are set through `cacheResponse` (`src/lib/cache.ts`), never `cache.set`.

```ts
export const GET: APIRoute = async (context) => {
  cacheResponse(context, { ...CACHE_TTL, tags: ["page", "legalPage", "article", "person", "blog", ...SITE_WIDE_CACHE_TAGS] });

  const { data } = await loadQuery<SitemapQResult>({ query: SitemapQ });
  // ...drop rows without a uri and any section-preview path, then cluster and serialize:
  return new Response(renderSitemap(sitemapEntries(documents, absoluteUrl)), { headers: XML_HEADERS });
};
```

Google ignores `<changefreq>` and `<priority>`, so entries carry only the URL and a content-driven `lastmod`. A new routed document type means adding it to `SitemapQ` and to the cache tags.

## Canonical URLs

Prevent duplicate content issues. The canonical is built with `absoluteUrl` (from `~/lib/env`, the one seam that joins the canonical origin to a path) and passed to `Web.astro` as a prop:

```ts
const canonical = absoluteUrl(uri);
```

Because the pages model stores a full `uri` per document, language prefix included (`/it/chi-siamo`), the canonical is always derivable from the document, never from the request URL (which can carry query strings or a preview path). Each page answers on one URL: the default language is never prefixed, so `/en/about` answers `301` to `/about`, and a file spelling (`/about.html`) answers 404.

## Redirects

CMS-managed redirects live on the `siteSettings` document (read by `_id`) and are fetched once at config load, filtered by `toConfigRedirects()` (`scripts/build/cms-redirects.mjs`), then handed to Astro's `redirects` config:

```js
// astro.config.mjs
export default defineConfig({
  redirects: await fetchRedirects(),
});
```

The fetch is fail-soft: a fresh clone with no env (or an unreachable Sanity) builds with no redirects instead of crashing. Only exact same-site paths pass the filter (a destination may add a plain query, a section anchor, or be an `https` URL on the site's apex or `www`); a source under `/api`, the Studio path or `/_`, a pattern, a `%` escape in the source, or a destination that loops back is dropped and logged rather than failing the deploy, and the Studio's **From** and **To** fields refuse every entry the build would drop. Because they are baked in at build time, a redirect added in the Studio needs a redeploy. See `docs/features/redirects.md`.

## Performance

[Core Web Vitals](https://web.dev/articles/defining-core-web-vitals-thresholds) impact rankings:

- **LCP (Largest Contentful Paint):** < 2.5s
- **INP (Interaction to Next Paint):** < 200ms
- **CLS (Cumulative Layout Shift):** < 0.1

### Image optimization

- Render `SanityMedia.astro` (or `SanityImage.astro` directly); it builds a responsive `srcset` through `src/features/sanity/media/image/utils.ts` and never upscales.
- The URL builder requests `auto=format`, so Sanity's CDN serves WebP/AVIF where supported.
- LQIP is in the image fragment; `SanityImage.astro` paints it behind the `<img>` through `getLqipStyle` (skipped for images with transparency, and for any value that is not a base64 image data URI, via `safeLqip()`), and its `sanity-image` element (`SanityImageElement.ts`) removes it once the image loads.
- Dimensions come from the asset metadata, so images reserve their box and do not shift layout.

### Font loading

Geist is self-hosted (`@fontsource-variable` plus the pixel faces in `public/fonts/geist-pixel/`) and every `@font-face` declares `font-display: swap`. Nothing is fetched from a third-party font host, so there is no extra connection on the critical path.

## Robots.txt

`src/pages/robots.txt.ts` renders it through `renderRobotsTxt()` (`src/features/agents/ai-crawlers.ts`). The Studio path is `PUBLIC_SANITY_STUDIO_BASE_PATH` without a trailing slash, because `Disallow` is a prefix match and `/studio/` would miss the bare route. With the default env the route emits:

```
# Search and citation are welcome. Training is not.
# Declared in the codebase so the policy travels with the site, not with the host.

User-agent: *
Content-Signal: search=yes,ai-train=no,use=reference
Allow: /
Disallow: /api/
Disallow: /studio

User-agent: CCBot
User-agent: ChatGPT-User
User-agent: Claude-SearchBot
User-agent: Claude-User
User-agent: ClaudeBot
User-agent: OAI-SearchBot
User-agent: Perplexity-User
User-agent: PerplexityBot
Allow: /
Disallow: /api/
Disallow: /studio

User-agent: Amazonbot
User-agent: Applebot-Extended
User-agent: Bytespider
User-agent: GPTBot
User-agent: Google-Extended
User-agent: meta-externalagent
Disallow: /

Sitemap: https://example.com/sitemap.xml
```

**AI crawler policy:** search and citation yes, training no. The citation crawlers (`AI_CITATION_CRAWLERS`) get their own group because a crawler obeys only its most specific group, so each named group repeats the site's own disallows. The training crawlers (`AI_TRAINING_CRAWLERS`) are blocked, which costs no search visibility: `Google-Extended` never governs Search or AI Overviews. To change the policy, edit those arrays and `CONTENT_SIGNAL`, not the route.

## International SEO (hreflang)

For multi-language sites, hreflang tags tell search engines which URLs are the same page in another language.

`LOCALES` in `sanity/i18n.ts` lists the languages. English is the default and lives at unprefixed URLs; every other language lives under its own prefix. Each translation is its own document with its own stored `uri`, linked to its siblings through `translation.metadata`, so no URL is ever built from a locale and a slug. With a single entry in `LOCALES` there is no hreflang output at all.

A routed query projects `${AlternatesFragment}` (`src/features/i18n/fragment.ts`): the document's published, unprotected translations in a configured language that have a URI. The route turns it into links with `buildAlternateLinks()` (`src/features/i18n/alternates.ts`) and hands them to `seo()`, and `Web.astro` renders them, so a route never writes the tags by hand:

```html
<link rel="alternate" hreflang="en" href="https://example.com/about" />
<link rel="alternate" hreflang="it" href="https://example.com/it/chi-siamo" />
<link rel="alternate" hreflang="x-default" href="https://example.com/about" />
```

- The set includes the page itself, so every page in a cluster lists the same links (reciprocal), and `x-default` points at the default language's URL, which is unprefixed.
- A noindex page gets no set, and a noindex translation is left out of its siblings' sets.
- `Web.astro` also sets `<html lang>` to the bare locale id, `og:locale` from `getOgLocale()` (`it_IT`) with one `og:locale:alternate` per other language, and the JSON-LD builders take `inLanguage`.
- The sitemap carries the same clusters: rows sharing a translation group list each other as `<xhtml:link rel="alternate" hreflang>`, plus `x-default`, under a declared `xmlns:xhtml`.
- The RSS feed is the default language's only, and `/it/feed.xml` answers 404.

The full mechanism is in `docs/features/internationalization.md` and the `i18n` skill.
