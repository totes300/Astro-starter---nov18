# Internationalization

The site serves several languages from one Sanity dataset. The default language lives at unprefixed
URLs and every other language under its own prefix (`/it/...`). Each language's page is a document of
its own, with its own URL, SEO fields and publish state.

The starter is configured for English and Italian, English the default. Italian has the whole
structure (routing, its UI dictionary, the Studio's translation tools, tests in both modes) and
content: the bundled seed holds a published Italian translation of every translated English
document, made with Translate with AI and proofread (see [The seed](#the-seed)). A site that serves English only turns Italian
off with `npm run trim` (see [Turning a language off](#turning-a-language-off)).

## The model

Everything below follows from these, and the tests hold the code to them:

- **One switch.** `LOCALES` in `sanity/i18n.ts` lists the languages. With one entry, i18n is off: no
  prefixes, no hreflang, no language switcher, no browser-language detection. The code, the queries
  and the params they bind stay the same.
- **The default language owns no prefix.** `/about` is English, an Italian page sits under `/it`, and
  `/en/about` answers a `301` to `/about`, so each page has one indexable URL.
- **A URI is stored, never built.** A document's `uri.current` holds its full public path, prefix
  included. A route looks its document up by that path (`Astro.locals.path`), and a link renders the
  stored `uri`. The one exception is a [shared person](#a-shared-person): it stores its default-language
  path and is served under every prefix.
- **One document per language** for the translated types (`site`, `page`, `blog`, `article`,
  `legalPage`), linked as translations through a `translation.metadata` document. Every other type is
  shared by all languages, and its words are translated in place: a category's name, and a person's
  role, bio, SEO text and agent Markdown.
- **A page is in its document's language**, never the URL's. A document written before the `language`
  field existed counts as the default language everywhere (`coalesce(language, "en")`).
- **Every read binds the language.** Each Sanity read passes `$language` and `$locales` through one of
  three seams. `$locales` is always every configured locale, so a document in a language the site no
  longer serves is never read (the [ghost guard](#the-ghost-guard)).
- **Copy the CMS does not own comes from a dictionary**, `uiStrings(locale)`, never an English literal.

## The locale config: `sanity/i18n.ts`

```ts
export const LOCALES = [
  { id: "en", title: "English", region: "GB", flag: "🇬🇧" },
  { id: "it", title: "Italiano", region: "IT", flag: "🇮🇹" },
] as const;

export const DEFAULT_LOCALE = "en";
export const IS_I18N_ENABLED: boolean =
  typeof __I18N_ENABLED__ === "boolean" ? __I18N_ENABLED__ : LOCALES.length > 1;
```

- `id` is a BCP 47 tag, and also the URL prefix and the `hreflang` value. The default locale stays
  first. `title` is the language's own name, which the switcher and llms.txt show. `region` sets how
  dates and numbers format (`en-GB`). `flag` is the region's flag emoji, set once here: the Studio
  shows it beside the language's name in its folders, the Translations menu, the media library's
  language tabs and the inputs of fields translated in place (`getStudioLocaleTitle`). The public
  site never shows it, and `npm test` fails when a flag does not match its region.
- `DEFAULT_LOCALE` is a bare literal on purpose: GROQ fragments interpolate it, and typegen only
  follows literals, so a computed value would drop every query that uses one.
- The file imports nothing and reads no env, so the app, the Studio, the CLI scripts and
  `astro.config.mjs` all import it.
- `IS_I18N_ENABLED` is a literal in a build: `astro.config.mjs` defines `__I18N_ENABLED__` from
  `LOCALE_IDS` through `vite.define`, so the minifier drops the branches it guards. It does not drop a
  module imported at the top of a file: the bundler picks its modules before it folds a constant from
  another file, and keeps a package that does not declare `sideEffects: false` for its top-level code.
  So a one-language Studio still ships the translation plugin and the Translate with AI action, switched
  off; the `ai-translation` trim removes the action (see [Turning a language off](#turning-a-language-off)).
  Scripts, tests and the config itself have no such constant and read `LOCALES.length > 1`, so
  `LOCALES` stays the one switch; `src/features/i18n/build-constant.test.ts` holds the two together.

The helpers beside it: `LOCALE_IDS`, `isLocale`, `getLocaleTitle`, `getIntlLocale` (`en-GB`),
`getOgLocale` (`en_GB`), `localePrefix`, `withLocalePrefix(locale, path)` (the full public path a `uri`
stores), `splitLocalePrefix(path)` (`{ locale, localeInPath, pathname }`), `isHomeUri` and `homeUris`.

### The `LOCALES` toggle

`LOCALES` holds one entry per line. A language that is switched off stays in the array as a commented
candidate, `// { id: "it", title: "Italiano", region: "IT", flag: "🇮🇹" },`, which is both the way back and what the
other-mode checks switch on. `scripts/sanity-migrations/lib/locales.ts` is the one toggle that
`npm run i18n:check` and the Italian trim's round-trip test use. It reads `LOCALES` by
its syntax tree, and a commented line counts as a candidate only when its text parses as one whole
`{ id }` object:

- `disableLocales(source, keep)` folds every other entry to that commented line, `id` first, with a
  trailing `//` comment moved to its own line above. It never touches the default.
- `enableCommentedLocales(source, ids?)` reverses it, adding the comma the entry before a candidate
  needs, and `otherLocaleMode(source)` flips to the mode the config does not run.
- It refuses, and says why, an entry that shares its line, has its comma on the next line, or holds a
  comment or a template literal, and a `LOCALES` that is not a literal array. `npm run i18n:check`
  also refuses a candidate whose id is not a language code.

## URLs

| Document | Stored `uri` in English | In Italian, once translated |
| --- | --- | --- |
| Homepage | `/` | `/it` |
| Page | `/about` | `/it/chi-siamo` |
| Blog index | `/blog` | `/it/blog` |
| Article | `/blog/<slug>` | `/it/blog/<slug>` |
| Author | `/blog/authors/<slug>` | `/it/blog/authors/<slug>` |
| Legal page | `/legal/<slug>` | `/it/legal/<slug>` |

A translation's slug is its own: the Italian page's `uri` is authored independently of the English
one. Only the prefix, and a section's word, are fixed by the language.

### Section segments

A section with its own route folder (today only the blog) puts a word in front of every URL under it,
and each language may name its own word in `SECTION_SEGMENTS` (`sanity/sections.ts`). Italian keeps
`blog`.

- **The key is the route folder and the default word.** `src/pages/blog/` serves the section in every
  language. A language with no word of its own keeps the key.
- **`SECTION_TYPES` says what lives there:** the index singleton, the item type, and `nested` types
  routed under the same word (people at `/blog/authors/<slug>`).
- **One rule moves a path between languages.** `localizeDocumentPath(type, locale, path)` swaps the
  prefix and, for a section's documents, the first segment, and keeps the rest:
  `/blog/authors/jane` becomes `/it/blog/authors/jane`.
- **Locale routing maps a language's word back to the folder.** After stripping the prefix,
  `resolveSectionRequest()` rewrites a language's own word to the folder that serves it, and answers
  the default word under a language that renamed it with a `301` to that language's own.
- **`sectionPathIssue()` says where a document must sit:** an index at its section path, routed types
  under their word in their language, and anything else outside every section word.
- **A new section** from the Plop "Prefix Page Route" generator is registered with no words, so it
  keeps its default word in every language until you add them.
- `sanity/sections.test.ts` fails when two sections share a word in a language, when a word is not a
  clean slug, when a section has no route folder, or when a type is filed under two sections.

**Renaming a word** once its language has content takes one migration,
`npm run sanity:migrate-segments`:

- It moves every section document (the index, its items and nested types such as people at
  `/blog/authors/<slug>`) to its language's current word, every copy included.
- It adds one `301` per old public URL to Settings > Redirects, on the published and the draft
  settings alike, and re-aims an existing redirect that pointed at a moved URL, keeping its anchor, so
  none chains.
- It stops if a move would land where a document or an existing redirect already answers, and lists a
  section document with no slug under a word instead of guessing.

Redirects are read when the app is built, so redeploy the app afterwards.

## Routing

### Astro config

`astro.config.mjs` declares the locales from `sanity/i18n.ts` with `routing: "manual"`. Routes are
CMS-driven, so there is no route folder per language for Astro's own i18n routing to match, and it
would answer `/en/about` with a 404 instead of letting the middleware redirect it.

### Middleware

`src/middleware.ts` runs `sequence(responseHeaders, requestSpelling, localeRouting, draftSession, runtimeGates)`.
The spelling check runs on the request as sent, before `localeRouting` can rewrite it, and the gates
run after it, on the public path (see
[Basic Authentication](./basic-auth.md#one-path-per-page)). `localeRouting`
(`src/features/i18n/locale-routing.ts`) sets two values on every request, exempt routes included:

- `Astro.locals.path`: the decoded, normalized public path (`/it/chi-siamo`, no trailing slash). It is
  what Sanity stores in `uri.current`, so every route and every gate keys on it.
- `Astro.locals.locale`: the prefix's locale, or the default.

Then, with i18n on, on any route but an exempt one (the Studio, `/api/`, a file route) or the 404 page:

1. `/en/...` answers `301` to the unprefixed path, query string kept.
2. An unprefixed path runs [browser-language detection](#browser-language-detection), then renders.
3. A prefixed path renders through `next(path)` with the prefix stripped and the section word mapped
   back, so `/it/blog/<slug>` renders `src/pages/blog/[slug].astro`. Stripping only picks the route
   file. `next(path)` rewrites in place, so the middleware chain is not re-entered and request bodies
   stay readable.

On the 404 page it only sets the locale, so the page renders in the request's language: a rewrite
there would 404 again, and Astro's retry renders the 404 page with no middleware.

A prefix names pages only: an exempt route or a file route under a prefix (`/it/api/contact-form`,
`/it/studio`, `/it/sitemap.xml`, `/it/feed.xml`) answers `404`, so each keeps one path.

### The route contract

The rewrite swaps `Astro.request`, `Astro.url`, `Astro.params` and the matched route. So a route reads:

```ts
const uri = Astro.locals.path; // "/it/chi-siamo", never Astro.url.pathname or Astro.params

const { data: page } = await loadQuery<PageQResult>({ query: PageQ, params: { uri }, ...getDraftModeProps(Astro) });
```

- `getDraftModeProps(Astro)` returns `{ perspectiveCookie, locale }`, so the page locale is bound
  centrally and no route or section passes `language` itself.
- A link back to the page the visitor asked for uses `normalizePathname(Astro.originPathname)`
  (decoded, and it may carry a trailing slash). The draft-mode "Exit preview" link does.
- Never `Astro.currentLocale` or `Astro.preferredLocale`: under manual routing neither is the page's
  language. Read `Astro.locals.locale`, or the document's own `language`.
- `isCurrentPath(Astro.locals.path, href)` (`src/features/site/is-current-path.ts`) marks the current
  navigation link, stega marks and trailing slashes ignored.
- An author panel opens in place under any prefix: `authorPathPrefix(locale)` and `isAuthorPath()`
  (`src/features/blog/author/constants.ts`) understand `/it/blog/authors/<slug>`.
- `src/features/i18n/route-path.test.ts` fails on a route, component or template that reads
  `Astro.url.pathname`, `Astro.params`, `Astro.currentLocale` or `Astro.preferredLocale`, and on one
  that looks a document up by URI from anything but `Astro.locals.path`.

The Plop page-route template scaffolds the same shape.

### Browser-language detection

On the homepage only. `landingLocale(request)` (`src/features/i18n/locale.ts`) picks a language when
the request is a GET or HEAD for `/` that asks for HTML (or is a prefetch), carries neither the
`locale` cookie nor the preview perspective cookie, and whose `Accept-Language` prefers a configured
language other than the default. Entries rank by q-value, q=0 is refused, and the exact tag matches
before the base subtag, so `it-CH` counts as `it`.

The middleware then looks up that language's published homepage (`landingHomeUri()`,
`src/features/i18n/homepage-locales.ts`):

- **Published:** the visitor gets the `locale` cookie and a `302` to it, query string kept, sent
  `private, no-store` so no cache keeps one visitor's redirect. A prefetch or prerender gets an empty
  `204` instead, so a hover decides nothing.
- **Unpublished, password protected or unreadable:** `/` renders as usual and no cookie is set, so the
  redirect starts working the day that homepage is published.

The front door renders every first visit that may be redirected (`landingLocale()` in
`src/features/i18n/locale.ts`) instead of answering it from the cache, so a cached `/` never answers them
first. It does not check whether that homepage is published: such a visit always renders, and the
middleware redirects or renders `/`. Detection is confined to `/` because responses are cached by URL: a
redirect decided from a header on any other path would be stored and served to everyone. The cookie
only suppresses detection, it never redirects, so a visitor who chose Italian and lands on `/` again
gets the English homepage. The footer switcher is the way back.

## Reading content in a language

### Three read seams

Every Sanity read binds `$language` and `$locales` in exactly one of three places:

- `loadQuery()` (`src/sanity/lib/load-query.ts`), for pages and sections. It passes the locale from
  `getDraftModeProps`, or the default when there is none, to `fetchSanity`, in draft and published
  mode alike.
- `fetchSanity(client, query, params, options)` (`src/sanity/lib/fetch.ts`), for an API route that
  holds its own client. It binds the default locale unless `params.language` names another.
- The proxy-state HTTP fetch (`src/features/sanity/proxy-state.ts`), which the middleware and the route
  cache read before any page renders. It sends the same params as `$name=<json>` search parameters.

A caller passes `language` only for a read that must differ from the page locale (the feed, an agent
endpoint). It still wins over the page locale and is still validated.

`fetchSanity` holds the only client `.fetch(`. `src/sanity/lib/fetch.test.ts` scans `src/`,
`templates/` and `astro.config.mjs` and fails on a Sanity read outside the seams:

- a client `.fetch(` outside `fetch.ts`, and any `.getDocument(`, `.getDocuments(` or `.listen(`;
- a raw `/data/query/` URL outside the proxy state and the build-time redirects read in
  `astro.config.mjs`, which is pinned by `_id`;
- a raw `api.sanity.io` or `apicdn.sanity.io` host outside the proxy state, `astro.config.mjs`,
  `src/features/api/studio-auth.ts` (the Access and users APIs, which hold no content) and
  `src/lib/security-headers.ts` (CSP origins, never requested);
- an Agent Action param of `type: "groq"` anywhere, since it would read with no locale params bound:
  fetch through `fetchSanity` and pass the result as a constant.

Each allowed file must still hold its read, so a read moved elsewhere cannot hide behind an old
allowance.

### The ghost guard

`localeParams(params)` (`src/features/i18n/fragment.ts`) is what every seam binds. It strips stega
marks from `$language`, throws when it is not a configured locale, and spreads `$locales` (every
configured locale) last, so no caller can widen it.

A document whose `language` is no longer configured (a ghost, left behind when a language is switched
off before its content is deleted) is hidden from every public and agent read, from the first request
after the deploy. Deleting the content is then hygiene, not a safety step. The guard is never switched
off with i18n: one language is exactly when ghosts exist. On the Content Lake an unbound `$locales` is
a `400`, so a missing binding fails closed; groq-js returns an empty result instead, so tests assert
the binding itself.

What the guard does on each kind of read:

- **A scan over `*`** (a routed lookup, a list, the sitemap, the llms.txt inventory) carries
  `ConfiguredLocaleFilter` or a stricter locale filter.
- **A dereference into a translated type** goes through `select(configuredReference(path) => ...)`: a
  removed language's author is never named, and an internal link to a ghost resolves to an empty href
  (see [Links](#links-and-category-names)).
- **A gated set names ghosts.** The agent Markdown state and llms.txt's `gatedPaths` mark a ghost's URI
  gated, so stored llms.txt and Markdown drop links to it when they are served.
- **A deny-list never reads `$locales`.** The Basic Auth protected paths keep every document, ghosts
  included, so a protected ghost answers `401`, then `404`.
- **Drafts and Content Releases** of a ghost do not render in preview either: `loadQuery` binds the
  guard in draft mode too.

Two structural tests keep the guard on every read, including the ones a later change adds:

- **`src/features/i18n/ghost-guard.test.ts`** parses every query typegen finds
  (`inventoryQueries()` in `src/features/i18n/query-inventory.ts`, over exactly the paths in
  `sanity.cli.ts`) and the three proxy-state queries.
  - **Reads.** Every `loadQuery` and `fetchSanity` call in `src/` and the Plop templates passes a query
    `defineQuery` declares where typegen scans, by its own name, and every `createProxySanityState`
    passes one of the three state queries. A query written inline, or in a page `.astro` file, fails
    here, since neither this rule nor the minifier's check would ever see it.
  - **Scans.** Every filter over `*` carries, in its top-level `&&` chain, a locale filter, an `_id`
    pin, or a `_type` pin that names only types outside `I18N_DOCUMENT_TYPES` (`articleCategory`,
    `siteSettings`, `sanity.imageAsset`). An `_id` pin is a literal, or a param listed in
    `ID_PIN_PARAMS` with where its ids come from (`$docId` from a guarded route query, `$ids` from the
    guarded backlog, `$assetId` for an image asset), so an id taken from a request is reviewed before it
    counts. `ParentLocaleFilter` counts only under a document a passing scan let through, or under a
    param listed in `DOCUMENT_PARAMS`: `$document`, the translation Translate with AI is about to write,
    into a language the route checked is configured. Its fields are read as a document's, so a
    dereference below it follows the reference rule; any other param read as a document is no field path.
  - **References.** Every dereference of a path in `GUARDED_REFERENCES` (`internal.link`, `author`,
    `translations[].value`) sits under `select(configuredReference(path) => ...)`, in a passing scan's
    filter, under `LinkFn`'s override, or under a `ConfiguredLocaleFilter` on the documents it reaches
    (`AlternatesFragment`). The path is followed however it is reached: through a projection, a filter
    or an index on the array (`translations[_key == "it"].value->`), parentheses, or a chain
    (`internal.link->author->`). A dereference of anything but a field path (`coalesce(a, b)->`) fails
    on its own, since it could be any of them.
  - **Exemptions,** each with its own check: the Basic Auth protected paths (which must never read
    `$locales`), and the agent Markdown state's `routes` and llms.txt's `gatedPaths`, which must name
    ghosts through `!(ConfiguredLocaleFilter)`. An exemption covers the one scan it was reviewed for, so
    a second unguarded scan beside it fails, and so does an exemption no longer needed.
  - Both Plop query templates must start guarded.
- **`sanity/ghost-references.test.ts`** walks the registered schema for every reference field into a
  translated type, plus the translation plugin's `translations[].value`, and fails on one missing from
  `GUARDED_REFERENCES` (`sanity/ghost-references.ts`). That list is also what `ghost-guard.test.ts`
  watches, so adding a new reference to it puts every read of the reference under the rule above.

What the guard does not cover: a CMS redirect that points at a ghost's URL (it now lands on a `404`),
and anyone who queries the Content Lake directly. A public dataset still serves a ghost to a direct
query; only deleting it removes access.

## Queries and fragments

### The fragments

All of them live in `src/features/i18n/fragment.ts`:

| Fragment | Use |
| --- | --- |
| `LocaleFilter` | The document is in `$language` |
| `DefaultLocaleFilter` | The document is in the default locale |
| `LocaleOrDefaultFilter` + `LocaleFirstOrder` | A per-language singleton, else the default's |
| `ParentLocaleFilter` | Inside a sub-query: the enclosing document's language |
| `ConfiguredLocaleFilter` | The document's language is configured (the guard on a scan over `*`) |
| `configuredReference("author")` | The same test on a dereference, inside `select(...)` |
| `localized("name")` | A field translated in place, else its default, else a plain string written before translation |
| `LocaleField` | Projects `language`, defaulting documents written before the field existed |
| `AlternatesFragment` | The document's translations that have a URI, are not password protected and are in a configured language |

Every language test among them reads `coalesce(language, "en")`, so a document written before the
`language` field existed counts as the default. Interpolate them as they are and pass string literals
to the functions: typegen evaluates the template, and anything it cannot follow drops the whole query
(a call with an identifier argument, `fn(SANITY_SINGLETON_SITE_ID)`, drops it too). After a query
change, run `npm run sanity:typegen` and compare the query count it prints.

Two of them are deliberately tolerant:

- **`localized(path)`** reads `coalesce(string(path[$language]), path.en, string(path))`: the
  language's text, then the default's, then a plain string stored before the field was translated, so
  a dataset that has not run `npm run sanity:migrate-localize-fields` still renders. `string()` keeps
  typegen from reading `[$language]` as an array filter. Behind a reference, project it
  (`categories[]->{ "name": ${localized("name")} }.name`): `->` cannot be followed by a function call.
- **`LocaleOrDefaultFilter` + `LocaleFirstOrder`** keep a page from rendering bare. The site chrome
  (header, footer, announcement, SEO defaults, the error copy) reads the page language's Site, else the
  default language's, so a language whose Site is not published yet shows the default Site's header and
  footer.

### Links and category names

- **Internal links:** `LinkFn` (`src/features/sanity/link/fragment.ts`) ends with one override: an
  internal link whose target's language is not configured resolves to `href: ""` and its custom text
  only. It is the ghost guard for links, carried once per `LinkFn`, so every projection that spreads it
  inherits it. `SiteHeader` and `SiteFooter` drop any link without a safe href, so a header or footer
  whose links all drop out renders no nav.
- **Category names** are read as `categories[]->{ "name": ${localized("name")} }.name`.
- **A person reference** is read as `select(${configuredReference("author")} => author->{...})`.

An image's alt text, title and description are read in the page's language too; see
[Alt text and asset text](#alt-text-and-asset-text).

### GET or POST

`@sanity/client` sends a query with GET below 11,264 characters of encoded query string (the query and
its `$params`), and with POST above it. The API CDN caches both, but only a GET reaches its global
edge. The language fragments pushed the longest page queries over that line, so `fetchSanity` sends
`minifyGroq(query)` (`src/sanity/lib/fetch.ts`): `//` comments and whitespace outside string literals
are dropped, and a space is kept only where dropping it would fuse two tokens: two words
(`in $locales`), two operator characters that would read as one (`-` then `>`), or a digit beside a
dot. Whitespace means GROQ's own set (space, tab, the line breaks, form feed, NEL, no-break space); any
other character outside a string stays where it was.

- Every query reads with GET. The longest, `AuthorPageQ`, is about 10,100 of the 11,264 characters with
  its params bound, and `ArticlePageQ`, `BlogArticleListQ` and `PageQ` follow within about 800.
- `src/sanity/lib/query-budget.test.ts` measures the minified text, params included, and fails when any
  query reaches the limit. Its `POST_QUERIES` list, for a POST read accepted on purpose, holds one:
  `AiTranslationMarkdownQuery`, which sends a whole translation as `$document`, on the edit client,
  which no CDN serves.
- `src/sanity/lib/fetch.test.ts` proves, for every query, that the minified text parses to the same
  tree as the original. "Every query" holds because `ghost-guard.test.ts` fails on a read that passes
  any query typegen does not find.
- The proxy-state reads send their short queries as they are.

## Rendering a page

### The route recipe

Every routed query (`PageQ`, `ArticlePageQ`, `BlogPageQ`, `AuthorPageQ`, and what the Plop "Prefix
Page Route" generator scaffolds) matches `uri.current == $uri && ${ConfiguredLocaleFilter}` and
projects `${LocaleField}`, `"noIndex": seoMetadata.noIndex == true` and `${AlternatesFragment}`. The
route then does the same five things:

```ts
const locale = stegaClean(page.language); // the document's language, never the URL's
const canonical = absoluteUrl(uri);
const alternates = buildAlternateLinks({ siteUrl: PUBLIC_SITE_URL, locale, uri, noIndex: page.noIndex, alternates: page.alternates });
const seoProps = seo(site, { /* title, description, image, robots */ canonical, lang: locale, alternates });
// <SiteShell ... translations={page.alternates}>
```

- `stegaClean` matters in draft mode: the stega marks would otherwise reach `<html lang>` and
  `uiStrings()`.
- `src/features/i18n/route-wiring.test.ts` fails when a route or the page-route template builds
  hreflang without handing `translations={page.alternates}` to `<SiteShell>`, which the
  [language switcher](#language-switcher) needs.
- **The blog index** is one document per language, found by its `uri` like any other page
  (`BlogPageQ`). Its article list reads the articles in the page's language (`BlogArticleListQ`).
- **Articles** join their own language's blog index:
  `"blog": *[_type == "blog" && ${ParentLocaleFilter}][0]{ title, "uri": uri.current }`, and the
  author page joins the URL's with `LocaleFilter`. The
  breadcrumb's Blog rung, the author page's "Back to" link and an article's fallback href come from it,
  never from `SANITY_BLOG_INDEX_URI`. Without a blog in that language the rung drops out and the back
  link is not rendered.
- `ArticleList` takes the index's own path as `blogUri`, its fallback href for an article whose stored
  href is unsafe.
- An author's article list joins with `LocaleFilter` (the person is shared, so its page's language is
  the URL's), so `/it/blog/authors/<slug>` lists only the Italian articles.
- **The breadcrumb's Home rung** is `absoluteUrl(homeUriByLocale.get(locale) ?? "/")`, with
  `homeUriByLocale` from `readHomeUriByLocale()` (`src/features/i18n/homepage-locales.ts`) in the
  route's own `Promise.all`. A language whose homepage is unpublished or password protected falls back
  to `/`.

### Head: `lang`, hreflang, Open Graph and JSON-LD

`Web.astro` renders all of it from what `seo()` passes through:

- `<html lang>` is the page's `lang`, else `Astro.locals.locale`, else the default. It is always a bare
  locale id (`it`, never `it-IT`): the forms post it as `_locale`, and the client reads its dictionary
  from it.
- One `<link rel="alternate" hreflang>` per entry of `buildAlternateLinks()`
  (`src/features/i18n/alternates.ts`): every indexable translation, the page itself, and `x-default` on
  the default language's URL. A noindex page, a page with no indexable translation, or a site with one
  language gets none.
- `og:locale` from `getOgLocale(lang)` (`it_IT`), and one `og:locale:alternate` per other language in
  the set.
- The JSON-LD builders (`src/features/site/seo/structured-data.ts`) take `inLanguage`: required on
  `webPageLd`, `blogLd`, `profilePageLd` and `blogPostingLd`, and optional on `webSiteLd` (the default
  language when left out).
- The `BreadcrumbList` starts at the page language's published homepage, else the default one (see
  [the route recipe](#the-route-recipe)), labelled with that language's "Home"
  (`uiStrings(locale).home`).
- The 404 page is titled `uiStrings(Astro.locals.locale).notFound` and renders in the request's
  language.

### The sitemap

One sitemap lists every language. `SitemapQ` carries the guard, leaves out noindex and
password-protected documents, and projects each document's `language` and `translationGroup` (its
`translation.metadata` id). `sitemapEntries(rows, toUrl)` (`src/lib/sitemap.ts`) is pure and tested:

- Rows sharing a `translationGroup` form a cluster, and each member lists every member as an
  `<xhtml:link rel="alternate" hreflang>`, plus `x-default` on the default language's URL. Clusters are
  built from the filtered rows, so a noindex or protected variant is missing from its siblings too.
- A cluster of one, a site with one language, or a row whose language is not configured gets no
  annotations.
- `renderSitemap()` declares `xmlns:xhtml`, percent-encodes every URL (`/it/caffè` becomes
  `/it/caff%C3%A8`; one that cannot be encoded is left out) and XML-escapes `href` and `hreflang`.
- A section-preview path is left out in every language (`isSectionPreviewRequestPath()`).
- While **Protect entire site** is on, or the lock state cannot be read, it answers an empty
  `<urlset>`, uncached. It is tagged with every routed type, so any routed publish refreshes it.

### The RSS feed

The feed is the default language's only. `FeedXmlQ` reads the default language's Site, blog and
articles through `DefaultLocaleFilter`, `/it/feed.xml` answers `404`, and `hasFeed(locale)`
(`src/features/feed/constants.ts`) keeps both the `<head>` autodiscovery link (`FeedLink`, which takes a
`locale` prop) and the visible RSS link in `ArticleList` off every other language's pages. See
[RSS feed](./rss-feed.md#one-language).

## UI strings

Every string the CMS does not own (labels, controls, form messages, counts) lives in one dictionary per
language:

- `src/features/i18n/strings.ts` holds the API and the English copy: `uiStrings(locale)`,
  `hasUiStrings(locale)`, `UI_STRING_LOCALES`, `formatList(locale, items)` and `type UiStrings = typeof en`.
- Each other language lives in `src/features/i18n/dictionaries/<id>.ts` (Italian is
  `dictionaries/it.ts`, exported as `italian`, since `it` is node:test's) and is registered in
  `UI_STRINGS` by its bare id.
- `src/features/i18n/grammar.ts` holds the helpers a dictionary may import: `counted(language, one, other)`,
  which picks the form with `Intl.PluralRules`, and `joinList(language, items)`. A dictionary never
  imports `strings.ts` at runtime (`import type` is fine).
- Anything with a count, a plural or a value in it is a function: `list.articleCount(n)`,
  `article.minRead(n)`, `contactForm.validation.messageTooShort(min)`.
- `uiStrings()` returns the default dictionary for a locale without one, and for `undefined`, which is
  what an error page Astro renders outside locale routing sees.
- `src/features/i18n/strings.test.ts` fails when a configured locale has no dictionary, when one is
  shaped differently from the default (a missing key, a template with another arity, or one that drops
  an argument), and when a string is empty. `tsc` already catches a missing key.

**Adding a language's copy** is one dictionary file, one import line and one `UI_STRINGS` entry. A new
string goes into `en` first, then into every dictionary.

### Where the locale comes from

| Where | Read |
| --- | --- |
| A route or a server component | `uiStrings(Astro.locals.locale)`; a route that has its document uses `stegaClean(page.language)` |
| A custom element | A server-rendered data attribute (`data-success-message`, `data-error-message` and `data-validation-messages` on `<contact-form>`, `data-label-play` and `data-label-pause` on the video toggle). Never `uiStrings()`: `strings.ts` holds every language, so importing it ships them all; `src/features/i18n/client-dictionary.test.ts` fails on any browser script that reaches it |
| An API endpoint | `uiStrings(formLocale(formData))`: API routes are never prefixed, so `locals.locale` is always the default there |
| The feed | `uiStrings(FEED_LANGUAGE)` |

Formatting follows the same locale: `formatDate(date, locale)` (`src/features/blog/format-date.ts`,
`Intl` with `getIntlLocale`, so English stays `21 Jul 2026`) and `formatReadingTime(blocks, locale)`.
Lists use `formatList(locale, names)`, keyed by the bare id, so English keeps its serial comma.

### Defaults that come from the dictionary

- `Dialog`'s `closeLabel` defaults to `control.close`, and `AuthorDialog` passes `control.closeAuthor`.
- `SubmitButton`'s `pendingLabel` and `doneLabel` default to `form.sending` and `form.done`.
- `FormElement`'s fallback error is `form.error`, which the form's section renders into `data-error-message`.

## Language switcher

`src/features/site/LanguageSwitcher/` renders the current language's name as a button that opens a
native popover listing every language:

- **Where:** in `SiteFooter`'s bottom row beside the copyright, and below `lg` inside the header's mobile
  menu (`MobileMenu.astro`). The footer renders when there are two or more language links, even with no
  CMS links. A page with `showFooter=false` keeps only the menu's switcher; with both off it has none.
- **Options:** `buildLanguageLinks()` (`src/features/i18n/language-links.ts`) takes the page's
  `translations` (`page.alternates`, through `SiteShell`) and, for a language with no translation of
  this page, that language's published homepage from `readHomeUriByLocale()`. A noindex translation is
  still offered. `languageMenu()` (`language-menu.ts` beside the component) drops any row whose href
  fails `safeHref` and returns `null` below two rows; the footer renders the switcher from that menu and
  decides on it, so it never shows a switcher, or stays up for one, with fewer than two languages.
- **Markup:** a `<nav>` labelled with `languageNav`, one link per language with `lang`, `hreflang` and
  `aria-current="true"` on the current one. Each row shows the language's own name, with a round flag
  where the icon set has one. The trigger's label is plain
  text, with no reveal: the footer's switcher is the last thing on the page, where an intro gated on
  the viewport never fires and would leave the pill empty.
- **Behaviour:** `LanguageSwitcherElement` sets the `locale` cookie on click (`LOCALE_COOKIE_NAME`,
  `LOCALE_COOKIE_MAX_AGE` from `src/features/i18n/locale.ts`), so homepage detection stops guessing. It
  plays a rise on open with the Web Animations API, skipped under reduced motion, and closes the
  popover when Tab leaves it; Escape and an outside click close it natively. The links work before the
  element upgrades.
- **Placement:** CSS anchor positioning (`position-area: top span-left` with
  `position-try-fallbacks: flip-inline`), and the popover's default centred placement where that is
  unsupported. The popover sits in the top layer, so there is no z-index.
- `<LanguageSwitcher id>` must be unique on the page: it names the popover and the anchor.

## Forms

The form posts its page's language as `_locale` (`<html lang>`), and the endpoint reads it once with
`formLocale(formData)` (`src/features/forms/locale.ts`), which keeps it only when it is a configured
locale. Everything the visitor reads back is in that language:

- `contactForm(locale)` (`validate-contact-form.ts`) builds the rules with that language's validation
  messages. The rules are the same in every language; only the messages change. The section renders the
  same messages into `data-validation-messages`, so the browser builds its rules without a dictionary.
- `contactFormOptions(locale)` returns the topic, budget and services options. The submitted values
  stay module-private, and each label comes from `contactForm.options.<field>[value]`;
  `validate-contact-form.test.ts` fails when a dictionary misses a label or has an extra one.
- The human check's refusal (`form.humanCheckFailed`) and `formWriteFailed(error, locale)` answer in it.
  `formRefused(locale?)` and `formUnavailable(locale?)` default to the default language, because they
  answer before the body is read.
- The submission stores the locale in its read-only `locale` field. It is deliberately not named
  `language`, so the ghost guard and the language removal, which key on `language` over translated
  types, never touch a submission. The notification email stays in the default language, with the raw
  option values.

See [Forms](./forms.md) and [Contact Form Notifications](./contact-form-notifications.md).

## The Studio

### What is translated

| Registry (`sanity/constants.ts`) | Holds |
| --- | --- |
| `I18N_DOCUMENT_TYPES` | `site`, `page`, `blog`, `article`, `legalPage`: one document per language, linked through `translation.metadata`. Each carries `createLanguageField()`. The Plop "Prefix Page Route" generator adds its type at `// PLOP: Add Translated Type`. |
| `LOCALIZED_FIELDS` | Fields a shared type translates in place: `articleCategory: ["name"]` and `person: ["role", "bio", "seoMetadata.title", "seoMetadata.description", "agentMarkdown.content"]`. One dot nests a field in an object. `createLocalizedField()` accepts only a pair listed here. |
| `SHARED_ROUTED_DOCUMENT_TYPES` | `person`: shared types with a page of their own, served under every language's prefix from one stored `uri` (see [A shared person](#a-shared-person)). |
| `TRANSLATION_EXCLUDED_FIELDS` | `agentMarkdown`: derived from one document's content, so it is never copied: a translation made from the language menu or by `sanity:add-language` starts without it, and [Translate with AI](./ai-translation.md#agent-markdown) writes the translation's own. `aiTranslation`: the record of one AI translation (see [Translate with AI](./ai-translation.md)). |

Everything else is shared by every language: `siteSettings`, `redirect`, `contactFormSubmission`,
`imageAltText`, `articleCategory`, whose slug is shared too, and `person`, whose name, slug, portrait
and links are shared.

`createLocalizedField({ documentType, name, title, type, required, validate })` renders one input per
language, side by side (stacked for `type: "richText"`, one portable text array per language),
required in the default language only. `createSeoField({ localizedFor })` and
`createAgentMarkdownField({ localizedFor })` build their title, description and Markdown with it for a
shared routed type. A category's name is stored as
`{ en, it }` (as `{ en }` with one language) and read with `localized("name")`; its uniqueness check
runs per language, case-insensitively, and reads a plain string written before translation as the
default spelling. With one language the field reads as a plain one: the object's header and frame
are not rendered, the default language's input takes the field's title and description (no flag),
and the uniqueness check runs on that input, where its marker shows, still against the whole
`{ en }` value.

### A shared person

A blog author is always the same person, so `person` is one document for every language rather than one
per language. Its name, slug, portrait and links are shared; its role, bio (portable text), SEO title
and description and agent Markdown are stored as `{ en, it }` and read in the page's language, falling
back to the default's.

- **One stored URI.** The `uri` is the default-language path, `/blog/authors/<slug>`. Every configured
  language serves the same document: `/it/blog/authors/<slug>` renders it with its Italian fields, so
  an Italian byline opens an Italian author page and panel.
- **The route** keeps `const uri = Astro.locals.path` for the canonical, and looks the person up by
  `sharedDocumentPath(uri)` (`sanity/sections.ts`), which undoes the prefix and the section word. The
  language is `Astro.locals.locale`, not the document's, and its lists (the blog index, the articles)
  join with `LocaleFilter`.
- **Alternates** come from `sharedAlternates()` (`src/features/i18n/alternates.ts`): one per
  configured language, so hreflang, `x-default` and the switcher list every language. The sitemap
  expands the person into one row per language (`withSharedRows` in `src/lib/sitemap.ts`), clustered on
  its id; llms.txt lists it once per language, and agent Markdown is served per language from
  `agentMarkdown.content.<lang>` only where that language's arm exists.
- **Bylines and JSON-LD.** An article localizes its author's stored path with `localizeDocumentPath`,
  and every language names the same Person node, `<default URL>#person`.
- **Reads.** `localized("role")` for strings and `localizedRichText("bio")` for the bio; typegen reads
  `[$language]` as a filter, so `localizedBlocks()` narrows the result back to blocks.
- **Gates.** A person has no Password protect switch; the noindex switch is shared, and the sitemap,
  llms.txt and the agent Markdown gates apply it to every language's URL. Never give a shared routed type
  `passwordProtected` without widening the protected-path list to every language's URL.
- **Internal links** to a person from rich text render its stored, default-language path; locale
  routing does not move it to the reader's language.

### The language field

`createLanguageField()` adds a hidden, read-only `language` string. The translation plugin writes it;
a new document starts in the default language. It carries two warnings:

- **Always on:** the document's language is empty or not in `LOCALES`, so it is published nowhere
  (`unconfiguredLanguageIssue`). The message says which developer step fixes it, in "Ask a developer to
  run ..." words, since an editor never runs a command: an empty language is set by
  `npm run sanity:migrate-backfill-language`; an unconfigured one is added back to `LOCALES`, or
  deleted with `npm run trim`, which offers every language the site no longer serves.
  `sanity/editor-copy.test.ts` fails on Studio copy that names an `npm run` without asking a developer.
- **With more than one language:** the document still references a document in another language, for
  example a link the translation had no counterpart for (`crossLanguageReferences`). The warning says to
  pick that language's version or translate it first, and that once the translation is published,
  Update links in Settings > Translations points the reference at it. A failed read is logged and never
  blocks publishing.

### Wiring: `sanity/i18n-studio.ts`

The host config spreads four exports, so `sanity/` stays portable:

```ts
schema: { types: schemaTypes.map((type) => withTranslationExclusions(withAiTranslationRecord(type))) },
plugins: [media({ ...mediaLocaleOptions }), ...translationPlugins, presentationTool(/* ... */)],
```

- `translationPlugins`: `@sanity/document-internationalization` with `supportedLanguages` from
  `LOCALES`, `schemaTypes` from `I18N_DOCUMENT_TYPES`, its metadata documents kept out of search, and
  the callback below. It adds the language menu that creates a translation. Empty with one language,
  so the menu and the `translation.metadata` type go away. Its required peers,
  `sanity-plugin-internationalized-array` and `@sanity/language-filter`, are installed beside it and
  never imported.
- `mediaLocaleOptions`: with more than one language, an asset's text is edited in one tab per language
  (see [Alt text and asset text](#alt-text-and-asset-text)). Empty with one.
- `withTranslationExclusions`: sets the plugin's `exclude` flag on every field in
  `TRANSLATION_EXCLUDED_FIELDS`.
- `withAiTranslationRecord`: adds the hidden `aiTranslation` record to every type in
  `I18N_DOCUMENT_TYPES`. It is applied inside `withTranslationExclusions`, so a translation the language
  menu creates starts without it. See [Translate with AI](./ai-translation.md#status).

### Creating a translation: `sanity/translation-callback.ts`

A translation starts as a copy of its source. `localizeTranslation` makes one patch on the new draft so
it starts in its own language:

- **URI:** moved with `localizeDocumentPath`, prefix and section word included
  (`/blog/authors/jane` becomes `/it/blog/authors/jane`).
- **Share image source:** `seoMetadata.sourceUrl` moves to the new URI when it named the copied page,
  so the translation does not ship the source's screenshot. For the Site, which has no page, a source
  that named the source language's homepage moves to the new language's.
- **References:** every reference that has a counterpart in the new language points at that
  counterpart's **published** document, read through `translation.metadata`. A weak reference to the
  source itself becomes one to the new translation.
- **Stamp:** the hidden `aiTranslation` record gets the copy's own hashes as made (`copyRecord()`), so
  [Translate with AI](./ai-translation.md#status) tells an untouched copy from one an editor translated
  exactly, whatever the source does since.

It logs a failure and never throws, so a failed read leaves a plain copy for the editor to finish.
`npm run sanity:add-language` builds its drafts with the same patch (`translationPatch`).

### Editing in a language

- **URIs:** the generated path is the default-language one, and `createUriField` moves it into the
  document's language. The field refuses a prefix that disagrees with the language (and `/en/...`,
  which redirects), and fixes the homepage and the blog index at their path in the document's own
  language through `fixedPath`. The field locks only while that path holds, judged by what the document
  is rather than by the URI being typed, so `/` on the way to `/about` never locks a page. A homepage
  translation has a generated id, so once its URI moves only `translation.metadata` still names it:
  `homepageTranslationIssue` (`sanity/schemas/documents/page.tsx`) reads it and refuses the move. The
  full order of checks is in [URI Rules](../sanity/schema-and-content-model.md#uri-rules).
- **Password protect** belongs to one document, so to one language's URL. A new translation copies the
  switch from its source, but nothing keeps the two in step after that: protecting `/about` leaves
  `/it/chi-siamo` public until that translation's own switch is on (see
  [Basic Authentication](./basic-auth.md)).
- **Internal links** offer only published documents in the edited document's language, and only while
  that language is configured. **An article's author** picker offers every person, since one person
  serves every language, and never one still carrying a language the site does not serve.
- **Delete translation**, the plugin's action that also unlinks `translation.metadata`, is offered only
  on a translated type, never on a singleton type, a fixed singleton id or any language's homepage
  (`offersDeleteTranslation` in `sanity/utils.ts`). A translated homepage keeps the singleton actions
  only: publish, discard changes and restore. Both checks read every variant (release version, draft
  and published), since the delete removes the published document too.
- A `translation.metadata` document keeps only discard changes and restore. The plugin's **Delete all
  translations** would delete every document in the group, the Site, the Blog Index and the Homepage
  included, and deleting the group would hide the translations the desk finds through it.

### Structure

`sanity/structure.tsx` builds the desk with `buildStructure(S, context)`:

- Authors is one list for every language, like Article Categories: a person is one document whose
  role, bio and SEO sit side by side per language, with no Translations menu.
- `localeGroupedList` gives Pages, Legal and Articles one list per language, whose "+"
  creates in that language through the plugin's `<type>-<language>` template. Pages leaves out every
  language's homepage by URI. Each list's `canHandleIntent` also matches an intent's `language`, so a
  link that names one (Open in Structure, Translate with AI's Open) lands in that language's list.
- `localeGroupedSingleton` gives the Homepage, the Blog Index and the Site one folder per language. The
  default language keeps the fixed id; `fetchTranslationIds` finds the others through
  `translation.metadata` when the folder opens, drafts and release versions included, and an
  untranslated language opens an empty list. A homepage made outside the translation menu (a page given
  `/it` by hand) is found by its home URI and opens in the Homepage folder.
- Settings and Article Categories stay one shared document and one shared list.
- With one language, each list shows only configured languages (`CONFIGURED_LANGUAGE_FILTER` in
  `sanity/structure-groups.ts`, a literal list because Presentation's filter params only take strings).
- **Other languages** is the last item, shown only while some document is in a language the site does not
  serve (checked once when the Studio loads; changing `LOCALES` reloads it). It lists every document of
  `I18N_DOCUMENT_TYPES` whose language is not configured (`UNSERVED_LANGUAGE_FILTER`), read on the raw
  perspective so drafts and release versions count, one list per stored language. An empty language
  reads "Missing language, run the backfill". A help pane asks a developer to run `npm run trim` or
  `npm run sanity:migrate-backfill-language`.

Presentation resolves a page at any depth and in any language: its main-document route is `/*uri`,
filtered to a configured language. See [Studio Config and Structure](../sanity/studio-and-structure.md).

## Alt text and asset text

With more than one language, an asset's alt text, title, description and credit line are stored per
language, `{ en, it }`, and the media library edits them in one tab per language
(`mediaLocaleOptions`). With one language they stay plain strings.

- **Reading:** `localizedAssetText(field)` (`src/features/sanity/media/fragment.ts`) reads the requested
  language, then the default, then a plain string written before translation; `ImageFn` uses it for all
  three. Typegen types the result as `string | string[]`, so a renderer reads it through `assetText()`,
  as `SanityImage` does for `alt`.
- **Generating:** automatic alt text writes one description per configured language the asset lacks
  (`missingAltTextLocales` in `src/features/agents/alt-text.ts`), each asked for in that language by
  name, so with two languages every new image takes two Agent Actions, each saved before the next
  starts and each counted in the daily AI request limit Translate with AI uses. `altTextPatch` writes only the new languages of a stored object, keeps a plain string with
  one language, and turns a legacy string into the default language's arm. The Studio's upload
  listener picks up only an asset with no alt text at all, so clearing one language's text never
  starts a run. See
  [Automatic alt text](./auto-alt-text.md#one-description-per-language).
- **Converting:** `npm run sanity:migrate-asset-fields` turns plain-string asset text into the
  per-language object once a second language is configured (see
  [Existing content and migrations](#existing-content-and-migrations)). Removing a language flattens it
  back when one is left (see [Removing a language from the dataset](#removing-a-language-from-the-dataset)).

## Agents

llms.txt, agent Markdown and automatic alt text read through `fetchSanity`, and every agent read carries
the ghost guard.

- **Gating.** `GATED_ROUTE_FILTER` (`src/features/agents/markdown-eligibility.ts`) ends with
  `!(ConfiguredLocaleFilter)`: a document in a language the site no longer serves is never eligible for
  Markdown, and its URI joins the gated sets (the agent Markdown state and llms.txt's `gatedPaths`), so
  stored llms.txt and Markdown drop links to it when they are served.
- **Guarded reads.** The llms.txt inventory and the agent Markdown content, backlog, backfill and serve
  queries carry `ConfiguredLocaleFilter`. Inside the Markdown projection, the byline is
  `select(configuredReference("author") => author->name)` and the blog index's article list joins with
  `ParentLocaleFilter`.
- **One language per read.** Generate binds `$language` from the page URI's prefix. The backfill groups
  each chunk by language (`tasksByLocale` in `src/features/agents/markdown-backfill.ts`) and reads each
  group, and its published article lists, with that group's `$language`. See
  [Agent Markdown](./agent-markdown.md#languages).
- **Text in the page's language.** Category names come through `localized("name")` and image alt text
  through `localizedAssetText("altText")`. The serializer's untitled-homepage title and byline come from
  `uiStrings(locale)` (`home`, `list.byline`).
- **llms.txt** is one file for every language. The inventory projects `language`, each entry carries the
  language's name (`getLocaleTitle`), and the prompt gives each language its own H2 sections. The
  generator binds the default locale, so category names there are in the default language. See
  [llms.txt](./llms-txt.md).

## Caching

The route cache answers before the middleware, on the URL as requested, so `/it/blog/<slug>` and
`/blog/<slug>` are separate entries, each gated as its own path. Per-render state reaches the store
through the request's async context, because the rewrite swaps the `Request`: keyed by `Request`, every
prefixed page would silently never be stored (`create-provider.test.ts` covers it through a rewrite).
This cannot be seen in `astro dev`, which runs no route cache. A render that fell back after a transient upstream failure is
kept for `FALLBACK_RENDER_TTL` (60 seconds) at most. `ROUTE_QUERY_PARAMS` is keyed by the unprefixed
route path, so `/blog`'s `category` covers `/it/blog`. See
[Revalidation and Caching](../sanity/revalidation-and-caching.md).

A cached page's hreflang and switcher stay current through tags: a translation shares its page's
`_type`, so publishing one busts every page of that type. The switcher's homepage fallback crosses types
(an article links the Italian homepage), so `SITE_WIDE_CACHE_TAGS` also carries every other language's
home URI: publishing or unpublishing `/it` refreshes every page. The default language's homepage is left
out, so editing `/` still busts only the `page` responses and its own path.

## Launching a language

A language is code first, then content. Italian in the starter already has its code, so it starts at
step 2; on a dataset seeded with Italian, its content is in place too.

1. **Configure it.** Add an entry `{ id, title, region, flag }` to `LOCALES` (for Italian after a trim: uncomment its line), and a
   dictionary at `src/features/i18n/dictionaries/<id>.ts` registered in `UI_STRINGS` (see
   [UI strings](#ui-strings)). Give it a word in `SECTION_SEGMENTS` if a section should not keep its
   default word. Run `npm run check`, then deploy.
2. **Deploy the schema.** `npm run sanity:schema-deploy`, so Agent Actions see the new language's
   fields; `npm run sanity:schema-check` confirms it.
3. **Prepare the dataset.** `npm run sanity:add-language` (`--language <id>`, `--dataset <name>`,
   `--dry-run`, `--yes`):
   - It stops if any document already sits under the new prefix in another language. A missing
     language reads as the default, so an English page stored at that prefix is caught.
   - It sets a missing `language` (the [backfill](#existing-content-and-migrations)).
   - It creates a linked **draft** translation of each per-language singleton (the Site, the Homepage,
     the Blog index), moved into the language the way the Studio's "create translation" does
     (`translationPatch` in `sanity/translation-callback.ts`: URI, share-image source, references),
     with `TRANSLATION_EXCLUDED_FIELDS` left out, and stamped as made as the language menu stamps its
     copies.
   - It skips a singleton already translated, or one whose place an unlinked document already holds:
     link that one as the translation from Translate with AI (on the English page, or in the Pages list of
     Settings > Translations), or delete it and run this again.
   - It warns when the app has no UI dictionary for the language, and publishes nothing.
4. **Convert the shared text,** the first time a dataset runs more than one language:
   `npm run sanity:migrate-asset-fields` (asset text becomes one text per language) and, on a dataset
   written before shared fields were translated, `npm run sanity:migrate-localize-fields`.
5. **Size the AI request limits** before a first whole-site run with
   [Translate with AI](./ai-translation.md#ai-usage). It makes one AI request per document and language,
   plus one per 50 category names and one per person and language, so 120 documents into two languages
   is about 240 against the defaults of 25 per run and 100 per day. Settings > Translations shows the
   plan's estimate before anything runs; raise both limits under Defaults to fit it, or plan the run over
   several days.
6. **Translate and publish**, the Site first: until it is published, the language shows the default
   Site's header and footer. Translate the other pages from the Studio's language menu, or draft them
   with [Translate with AI](./ai-translation.md), which writes each translation's agent Markdown with
   it. Then run the alt text backfill in Settings > Agents (one AI request per image and language, inside the
   same daily limit as the translations), and the agent Markdown backfill for the
   translations made from the language menu (or any whose Markdown an AI run could not generate), and
   regenerate llms.txt.

### Turning Italian back on after a trim

1. Restore `src/features/i18n/dictionaries/it.ts` from the starter, with its import and its
   `UI_STRINGS` entry in `src/features/i18n/strings.ts`.
2. Uncomment its line in `LOCALES`.
3. Delete the `language:it` entry from `scripts/trim-features/project.json`.
4. `npm run check`, deploy, `npm run sanity:add-language`.

If its content was never deleted, it comes back as it was.

## Turning a language off

**Italian, the starter's second language**, is turned off with `npm run trim`, picking **Italian**
(`language:it`) like any other feature. The trim:

- comments out the `it` line in `LOCALES`, which stays as the way back and the other-mode candidate;
- deletes `src/features/i18n/dictionaries/it.ts`, and drops its import and its `UI_STRINGS` key.

Everything else switches off by itself through `IS_I18N_ENABLED`, which a build folds to a literal. The
code behind it stays in the bundle, inert (see [The locale config](#the-locale-config-sanityi18nts)). `SECTION_SEGMENTS` keeps its
Italian words, inert while Italian is off. A dormant dictionary would have to keep up with every new
English key, so the file goes and comes back from the starter. If the trim cannot comment the entry out
(it shares a line, holds a comment, or `LOCALES` is computed), it warns, leaves the edit to you, and
keeps Italian's content: the site still serves it.

A run that switches off the last second language also offers **Translate with AI** (`ai-translation`), which only works
beside a second language: accept, and the same run removes its action, its Settings panel, its route,
its ledger and the record it keeps on each translation. Decline to keep it for a language you plan to
add; `npm run trim` offers it on its own later, as it does to a project that keeps two languages and
does not want AI translation. A project cut from the starter before Translate with AI joined it, which
took it afterwards, records that first with `npm run trim -- --reconcile --ported ai-translation`:
until then the trim reads it as never had and offers it in neither case. See
[Trimming features](./trimming-features.md#what-ships-as-removable).

The content is the second half. With `SANITY_API_EDIT_TOKEN` set, the guided run offers to delete it
now, and now is the default when a dataset holds only language content; without the token it says why
and leaves it for later. Either way the [ghost guard](#the-ghost-guard) keeps the site correct from the
first request after the deploy, and `npm run trim -- --dataset-only --language it` deletes it later.
Afterwards:

- deploy, then run `npm run sanity:schema-deploy`;
- regenerate llms.txt from the Agents tab in Settings;
- add the 301s the closing report suggests in Settings > Redirects, publish, and redeploy.

**A language a project added itself** is not in the trim's manifest. Comment its line out of
`LOCALES`, delete its dictionary file, its import and its `UI_STRINGS` line, and deploy. Then
`npm run trim` offers its content, or run `npm run sanity:migrate-remove-language`.

The default language cannot be turned off: changing it is a URI rewrite, not a removal, and the trim
refuses it.

## Removing a language from the dataset

`npm run trim` (Italian, or any language with `--dataset-only --language <id>`) and
`npm run sanity:migrate-remove-language` (any language `LOCALES` no longer configures) share one
planner, `scripts/trim-features/language-removal.ts`. It lives with the trim so `npm run trim:update`
delivers it to every project. It reads the raw dataset (published documents, drafts and release
versions, each its own copy) and plans:

- every copy of each document in the language. Only `I18N_DOCUMENT_TYPES` are scanned, so a type with
  a `language` field of its own is never touched. A draft or version with no language takes its
  document's; a published copy with none is the default;
- its translation links: a link goes with its document, a group left with fewer than two links is
  deleted, and the rest are repaired, in the same transaction as the deletes;
- the removed languages' arms of `LOCALIZED_FIELDS` on every copy that stays;
- localized asset text: the removed languages' arms, or, with one locale left, the text flattened to the
  default language's string, since the media library then edits only a plain string. Text with no
  default version is reported lost; the alt text backfill can write it again.

A removal clears only the removed languages' text. Text left in another language `LOCALES` does not
configure stays until a run cleans it: `npm run trim -- --dataset-only --language` with no id, the
"Text left in other languages" option in the trim's picker, or `npm run sanity:migrate-remove-language`
with no language left to remove.

It reports, and never writes:

- strong references from documents that stay, which stop the run before it exports anything;
- weak references that will dangle;
- documents whose copies disagree on the language, left for a person;
- 301 suggestions for Settings > Redirects, from each removed page to its default-language sibling.

It refuses, before exporting anything:

- the default locale, a configured one, and anything that is not a language code; `npm run trim` also
  re-reads `sanity/i18n.ts` and refuses a language it still configures;
- an empty `language`, which means missing, never removable: `npm run sanity:migrate-backfill-language`
  sets it;
- a write to a version in a release that is not active (scheduled or unreadable), whether a delete or
  a field cleanup: unschedule it first.

Content counts as left behind while documents, links, field arms or asset text in an unconfigured
language remain, so a cleanup-only run finishes what a hand deletion left.

### `npm run sanity:migrate-remove-language`

| Flag | Meaning |
| --- | --- |
| `--language <id...>` | The languages to remove. Without it a picker lists the ones the dataset still holds; with none left, the run only cleans the text a hand deletion left. A `--yes` run needs it while the dataset still holds anything in a language to remove |
| `--dataset <name>` | The dataset to clean (a picker without it, or the `.env` dataset with `--yes` or `--dry-run`) |
| `--allow-live-target <name>` | Needed for a `--yes` run against the `.env` dataset, which otherwise stops before reading; interactively you type the name |
| `--dry-run` | Prints the plan and writes nothing; wins over `--yes` |

The run:

1. Checks `--language` before reading anything, then prints the plan.
2. Refuses before exporting when Sanity would refuse a write.
3. Exports to `backups/<dataset>-pre-remove-language-<timestamp>.tar.gz` with the Sanity CLI login.
4. Re-plans from fresh reads and stops if the plan grew since it was shown.
5. Discards release versions first (nothing can reference a version), then commits one transaction for
   the deletes and the translation links, then the text cleanups in batches of 100.
6. Deletes [Translate with AI](./ai-translation.md)'s saved results and timeout notes in the removed
   languages and takes their pending category names out of the labels result, so no later run writes the
   language back (`scripts/sanity-migrations/lib/ai-results.ts`). Only this command does it; the trim's
   `--dataset-only` purge leaves them, and the plan no longer lists a removed language's saved results.

If a write fails partway, rerunning finishes it, and the message gives the restore command
(`npm run sanity:dataset-import -- --file <backup> --dataset <name> --replace`).

## Existing content and migrations

Documents written before the i18n fields existed, or outside the Studio, are brought into shape by three
idempotent migrations in `scripts/sanity-migrations/` (see its `README.md`). Each reads the raw
perspective with `SANITY_API_EDIT_TOKEN`, so drafts and release versions are planned and written as
documents of their own; a version in a release that is not active is listed and left alone; and each
patch carries the revision it was planned from, so a document edited meanwhile fails its batch instead
of losing the edit.

- **`npm run sanity:migrate-backfill-language`** sets `language` where it is missing or `""`
  (`MISSING_LANGUAGE_QUERY`). A copy takes the language its other copies state, else the default. Copies
  that disagree are listed, never guessed. This is the command the Studio's language warning and its
  "Other languages" list name. A document without a language still renders as the default, but the
  translation plugin cannot translate it: documents created in the Studio get the field's
  `initialValue`, while an import, a script or the MCP does not, so backfill after one.
- **`npm run sanity:migrate-localize-fields`** converts plain-string `LOCALIZED_FIELDS` to
  `{ <default>: "..." }` on every copy, an empty string included. Run it once on a dataset written
  before the fields were translated; the Studio shows the old string as an invalid value.
- **`npm run sanity:migrate-asset-fields`** converts plain-string asset `altText`, `title`,
  `description` and `creditLine` to `{ <default>: "..." }`. It does nothing with one locale configured,
  where the media library keeps plain strings. The site reads both shapes.

Every one takes `--dataset <name>`, `--dry-run` and `--yes`, like the other scripts.

## The seed

The bundled seed (`seed/seed-dataset.tar.gz`) pairs each translated English document with a published
Italian translation, made with Translate with AI and proofread, linked through a `translation.metadata`
group. It is in the shapes the migrations give a dataset: every translated document carries its
`language`, and category names and image alt text are `{ en, it }` objects.

`npm run sanity:dataset-import` and the setup wizard narrow the seed to `LOCALES` before importing, so a
seed that carries more languages than the project configures never brings one back. They read the
archive in memory (`scripts/sanity-dataset/seed-archive.ts`) and plan with the same language-removal
planner (`filterSeedToLocales`):

- documents in other languages, and the translation groups they leave with fewer than two links, are
  left out;
- other languages' text is unset, and with one locale left, asset text is flattened to the default
  string;
- a kept document that strongly references a dropped one stops the import before anything is written.

Backups restore verbatim. `seed.test.ts` checks the seed against `LOCALES` active and commented, so it
stays green after a language is switched off, and checks that its default-language-only form is valid
too. A seed exported before any document carried a language reports its language checks as a TODO.
See [Seed dataset](../sanity/seed-dataset.md#languages).

## Testing both modes

Most i18n code runs in only one mode, so both are tested.

### Writing a test

- A test that only makes sense with more than one language runs with `{ skip: !IS_I18N_ENABLED }`.
- A test takes the second language from `LOCALE_IDS`, never a hardcoded `"it"`, so it holds in a
  project that configures another one.
- A test that reads `sanity/i18n.ts` or a language feature's trim anchors must also pass with the
  language commented out and its dictionary still present: that is the starter's other locale mode.
- groq-js evaluates a query with its params bound at parse time and at evaluation time; without the
  first, `[$language]` reads as a filter.
- **Ghost fixtures.** `src/features/i18n/render-ghosts.test.ts` evaluates every query a page renders
  from over a dataset whose ghosts sort first, in every locale and for every URI, and fails on any ghost
  it returns. `src/features/agents/query.test.ts` does the same for the agent reads, checks that every
  ghost URI is in the gated sets, and widens `$locales` once to prove the guard is what hides them.
- **Structure.** `src/features/i18n/ghost-guard.test.ts` and `sanity/ghost-references.test.ts` hold the
  rules in [The ghost guard](#the-ghost-guard); `src/features/i18n/route-path.test.ts` holds
  [the route contract](#the-route-contract).
- **Budget.** `src/sanity/lib/query-budget.test.ts` keeps every query on GET (see
  [GET or POST](#get-or-post)).
- **Trim and migrations.** The language-removal planner's fixtures use `en`, `fr` and `de`; the
  migrations take the second language from `LOCALE_IDS` and use `zz` for one nobody configures. Neither
  depends on the shipped second language being configured, and the Italian trim's tests iterate only
  features the tree still has, so `npm run trim:verify language:it` stays green after the dictionary is
  gone.

### Checking both modes locally

- **`npm test`** runs the tests in the mode `sanity/i18n.ts` configures.
- **`npm run i18n:check`** checks the other mode. It works in a throwaway copy of the tree (cloned
  where the file system supports it, with `node_modules` and `.env` linked, uncommitted work included),
  runs typegen as configured and switched (a lower query count fails, since typegen silently drops a
  query it cannot evaluate), then `astro check` and `npm test`. Your working tree is never written to,
  and the copy is deleted whatever happens, Ctrl-C included. Run it after a change to locales, queries
  or the schema. `npm run i18n:check -- --dry-run` prints the plan only.
- **The switch** is [the `LOCALES` toggle](#the-locales-toggle): several locales fold to the default,
  and one locale enables its commented candidates. An enabled candidate with no
  `src/features/i18n/dictionaries/<id>.ts` is passed in `I18N_CHECK_UNTRANSLATED`, so the dictionary
  coverage test expects exactly that gap, and fails on an exemption that is not needed.
- **One locale with no candidate** has no other mode: `npm run i18n:check` passes without running
  anything and says so. Keep a commented candidate to keep testing it.
- **What stops the switch:** a candidate whose id is not a language code,
  an entry sharing its line or holding a comment or template literal, and a `LOCALES` that is not a
  literal array.
- **Hooks:** neither check runs in a hook (there is no pre-push hook), so run both before you push.

## Gotchas

- **Never `Astro.url.pathname`, `Astro.params` or `Astro.currentLocale` in a route.** After the
  rewrite they describe the unprefixed route file, so a page would query, link and mark current its
  default-language twin. Read `Astro.locals.path` and `Astro.locals.locale`.
- **`stegaClean(page.language)`.** In draft mode the language carries stega marks, which break
  `<html lang>`, `uiStrings()` and every comparison.
- **A query lives in a `defineQuery` where typegen scans,** passed by its name. One written inline, in a
  `.astro` file, or through a computed fragment escapes the ghost guard test and the minifier's check,
  and typegen silently drops one it cannot evaluate: compare the query count it prints.
- **An endpoint is never prefixed.** `Astro.locals.locale` is always the default under `/api/`; read
  the language the request carries (`formLocale(formData)`, or the page URI's prefix).
- **The 404 page renders outside the rewrite**, so the locale is all it gets; `uiStrings(undefined)` is
  the default dictionary.
- **A language without a published Site** shows the default Site's header and footer. Publish the Site
  first.
- **The feed is the default language's**; `/it/feed.xml` is a `404` by design.
- **A contact submission records `locale`, never `language`,** so nothing reads it as a translated
  document.
- **The route cache cannot be checked in `astro dev`**, which runs none; `create-provider.test.ts`
  renders through a rewrite to cover it.
- **Redirects are read at build time**, so a segment migration or a removal's suggested 301s take a
  redeploy.
- **Do not roll a deployment back past this code** once the dataset holds language shapes (`{ en }`
  category names, per-language asset text, translations): a build from before reads them raw.
- **Changing the default language** is a rewrite of every default URI, not a setting: nothing here does
  it.
