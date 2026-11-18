---
name: i18n
description: Languages end to end. `LOCALES` in `sanity/i18n.ts` is the one switch; English is the unprefixed default and every other language (Italian in the starter) lives under its own prefix. A document's `uri` stores its full public path, prefix included, and locale routing strips the prefix only to pick a route file, keeping the public path on `Astro.locals.path`. Covers the invariants, the three read seams and the ghost guard that hides documents in a language the site no longer serves, the routed query and route recipe (hreflang, the language switcher), translated document types and fields translated in place, the UI dictionary, launching and removing a language, and testing both locale modes. Use when adding or removing a language, adding a translated type or field, writing a query, a route or an endpoint, adding copy a visitor reads, or touching hreflang, the sitemap, the switcher or the locale steps of the middleware.
---

# Internationalization

Every routed document exists once per language with its own `uri`; a shared document translates a
field in place. One file declares the languages, the stored `uri` says where a page lives, and the
translations a page reports feed its head, the switcher and the sitemap alike.

Full reference: `docs/features/internationalization.md`.

## Core Rules

- **One switch.** `LOCALES` in `sanity/i18n.ts` is the only place a language is declared. Import
  `LOCALES`, `DEFAULT_LOCALE`, `LOCALE_IDS`, `IS_I18N_ENABLED` and `isLocale` from it; never hardcode a
  locale id, a prefix, a region or a list of languages anywhere else. Dates and numbers format with
  `getIntlLocale(locale)` and Open Graph takes `getOgLocale(locale)`, never a literal tag; lists and
  plurals go through `formatList` and `counted`, which take the bare id. With one entry i18n is off
  (no prefixes, no detection, no switcher), but every read still binds its locale params and the ghost
  guard still runs. A build reads `IS_I18N_ENABLED` as a literal (`__I18N_ENABLED__`, defined from
  `LOCALE_IDS` in `astro.config.mjs`), so the minifier drops the branches it guards, but never a module
  imported at the top of a file; scripts and tests fall back to `LOCALES.length > 1`.
- **Keep `sanity/i18n.ts` machine-editable.** `DEFAULT_LOCALE` stays a bare string literal: GROQ
  fragments interpolate it and typegen only follows literals. `LOCALES` holds one entry per line with
  no comment or template literal inside an entry, because the toggle (`scripts/sanity-migrations/lib/locales.ts`)
  and the Italian trim rewrite it by syntax tree and refuse anything else.
- **The `uri` is the full public path.** `/it/chi-siamo` is what Sanity stores and what a route queries
  by. Never rebuild a URL from a locale and a slug, and never strip the prefix before querying. The
  prefix is generated, never authored: a field's `slugify` returns the default-language path and
  `createUriField` moves it into the document's language with `localizeDocumentPath`
  (`sanity/sections.ts`), as does the translation callback. The default language is never prefixed:
  `/en/...` answers `301` to the unprefixed path.
- **Section words are per language.** A section with its own route folder (the blog) may name its URL
  word per language in `SECTION_SEGMENTS`, and `SECTION_TYPES` says which types live under it. Route
  folders keep the default word; locale routing maps a language's word back (`resolveSectionRequest`).
  Renaming a word once its language has content is `npm run sanity:migrate-segments`, then a redeploy.
- **Routes read `Astro.locals`.** `const uri = Astro.locals.path`. Locale routing rewrites a prefixed
  request with `next(path)`, which swaps `Astro.url`, `Astro.params` and the `Request`, so never
  `Astro.url.pathname`, `Astro.params.*` (the section preview's `Astro.params.section` is the one
  exception), `Astro.currentLocale` or `Astro.preferredLocale` (wrong under manual routing).
  `src/features/i18n/route-path.test.ts` fails on each. A link back to the requested URL uses
  `normalizePathname(Astro.originPathname)`; the current nav link is `isCurrentPath(Astro.locals.path, href)`.
- **The page's language is the document's.** A route takes `stegaClean(page.language)`, never the
  URL's; a component with no document reads `Astro.locals.locale`, and so does the one shared routed
  type (`person`, below), whose document serves every language. Never key per-request state on the
  `Request`: the rewrite replaces it (the route cache keeps its state in `src/lib/route-cache/render-scope.ts`).
- **Three read seams, one binding.** Every Sanity read binds `$language` and `$locales` through
  `localeParams()` in exactly one of: `loadQuery` (spread `getDraftModeProps(Astro)`, which carries the
  page locale, so a route or section never passes `language`), `fetchSanity` (an API route's own
  client: the default locale unless `params.language` names another), and the proxy-state HTTP fetch.
  Never call a client's `.fetch(`; `src/sanity/lib/fetch.test.ts` fails on any other read. Pass
  `language` only where a read must differ from the page locale (the feed binds `FEED_LANGUAGE`).
- **API routes are never prefixed.** `/it/api/...`, `/it/studio` and `/it/<file route>` answer `404` at
  the gate, so `Astro.locals.locale` is always the default inside one. An endpoint takes the language
  the client posts (`formLocale(formData)`) or the one the stored URI carries
  (`splitLocalePrefix(uri).locale`, as agent Markdown Generate does).
- **The ghost guard is never off.** A ghost is a document whose `language` is not configured, left
  behind when a language is switched off before its content is deleted. Public and agent reads must
  never return one, and the guard is never gated on `IS_I18N_ENABLED`: one language is exactly when
  ghosts exist. A missing `language` reads as the default, but an empty one (`""`) is hidden too, until
  `npm run sanity:migrate-backfill-language` sets it. `src/features/i18n/ghost-guard.test.ts` enforces:
  - every filter over `*` carries, in its top-level `&&` chain, a locale filter (`ConfiguredLocaleFilter`,
    `LocaleFilter`, `DefaultLocaleFilter` or `LocaleOrDefaultFilter`), an `_id` pin (a literal, or a param
    listed in `ID_PIN_PARAMS`), or a `_type` pin naming only types outside `I18N_DOCUMENT_TYPES`;
  - a list nested inside a document (an author's articles, the blog index's article list) filters with
    `ParentLocaleFilter`, which counts only under a parent a guarded scan let through, or under a whole
    document passed as a param listed in `DOCUMENT_PARAMS` (`$document`, a translation about to be written);
  - every dereference of a path in `GUARDED_REFERENCES` (`sanity/ghost-references.ts`) sits under
    `select(${configuredReference("<path>")} => <path>->{...})`, `LinkFn`'s override, or
    `AlternatesFragment`. A new reference field into a translated type is added there, and
    `sanity/ghost-references.test.ts` fails until it is;
  - a deny-list (the Basic Auth protected paths) never takes the guard: a protected ghost must still
    answer `401`;
  - `loadQuery` and `fetchSanity` receive a `defineQuery` by its own name, never an inline string and
    never one declared in a page `.astro` file, which typegen does not scan.
- **Typegen only follows literals.** Interpolate fragments bare (`${LocaleFilter}`) and pass string
  literals to `configuredReference("author")`, `localized("name")` and `localizedAssetText("altText")`.
  An identifier argument drops the query from `sanity/types.ts` with no error, only a lower query count
  in the `npm run sanity:typegen` output; check the count after every query change. A field translated
  in place behind an array dereference reads `categories[]->{ "name": ${localized("name")} }.name`.
- **Pages are translated, the same thing everywhere is translated in place.** A document a visitor opens
  at its own URL (and the `site` copy behind the header and footer) is one document per language: its
  type is in `I18N_DOCUMENT_TYPES` and its schema carries `createLanguageField()`. A document that is the
  same thing in every language stays one document and translates its fields in place: `LOCALIZED_FIELDS`,
  built with `createLocalizedField`, read with `localized()` (`localizedRichText()` for portable text).
  That is a category, only referenced, and the blog author (`person`), which also has a page: a type in
  `SHARED_ROUTED_DOCUMENT_TYPES` stores its default-language `uri`, is looked up by
  `sharedDocumentPath(Astro.locals.path)`, reads `Astro.locals.locale`, and takes its alternates from
  `sharedAlternates()`; the sitemap, llms.txt and agent Markdown expand it per language. Never both
  models on one type. A setting that holds one value for the whole site belongs on `siteSettings`, which
  is not translated; `site` holds what editors translate.
- **Copy a visitor reads comes from the dictionary.** Every string the CMS does not own (labels,
  accessibility text, validation and status messages, counts) is a key in `src/features/i18n/strings.ts`
  (the English wording) and the same key in every other language's `src/features/i18n/dictionaries/<id>.ts`
  (Italian in `it.ts`). Copy an editor authors stays in Sanity.
- **The feed is the default language's only.** `hasFeed(locale)` (`src/features/feed/constants.ts`)
  decides where it is advertised, and `/it/feed.xml` is a `404`. Never point a link at a prefixed feed.

## Trigger Conditions

Apply when adding, launching or removing a language; adding a translated document type, a field
translated in place or a reference field into a translated type; writing or editing any GROQ query;
adding a route, a component with visible copy, a custom element that shows text, or an endpoint that
answers a visitor; touching canonicals, hreflang, the sitemap, the feed, the language switcher, or
`src/middleware.ts` and `src/features/i18n/`.

## Execution Checklist

1. **A routed query** matches `uri.current == $uri && ${ConfiguredLocaleFilter}` and projects
   `${LocaleField}`, `"noIndex": seoMetadata.noIndex == true` and `${AlternatesFragment}`. A chrome
   singleton reads `(*[_type == "site" && ${LocaleOrDefaultFilter}] | ${LocaleFirstOrder})[0]`; a
   collection filters with `LocaleFilter`; a default-language-only read with `DefaultLocaleFilter`.
   Run `npm run sanity:typegen` and check the query count did not drop.
2. **A route** follows `src/pages/[...uri].astro`:
   - `const uri = Astro.locals.path`, then `loadQuery({ query, params: { uri }, ...getDraftModeProps(Astro) })`;
   - `const locale = stegaClean(page.language)` and `canonical = absoluteUrl(uri)`;
   - `buildAlternateLinks({ siteUrl: PUBLIC_SITE_URL, locale, uri, noIndex: page.noIndex, alternates: page.alternates })`,
     passed with `lang: locale` to `seo(site, { ..., canonical, lang: locale, alternates })`;
   - `<SiteShell translations={page.alternates}>`, which `src/features/i18n/route-wiring.test.ts` checks;
   - a breadcrumb's Home rung is `absoluteUrl(homeUriByLocale.get(locale) ?? "/")` named
     `uiStrings(locale).home`, with `readHomeUriByLocale()` in the route's `Promise.all`; JSON-LD
     builders take `inLanguage: locale`;
   - a link to another document in the same language comes from a join, never a constant: an article
     reads `"blog": *[_type == "blog" && ${ParentLocaleFilter}][0]{ title, "uri": uri.current }`
     rather than `SANITY_BLOG_INDEX_URI`.

   The Plop "Prefix Page Route" template scaffolds the lookup, the locale, the canonical, hreflang and
   `translations`; a breadcrumb or JSON-LD added to it follows the rest of this list.
3. **A translated document type**: add `createLanguageField()` to its schema and its name to
   `I18N_DOCUMENT_TYPES` in `sanity/constants.ts` (`// PLOP: Add Translated Type`); show it with
   `localeGroupedList` in `sanity/structure.tsx` so each language gets its own list. A type routed under
   a section word also goes in `SECTION_TYPES`. Its conditionally hidden copy (the SEO title and
   description) goes in `CONDITIONAL_PATHS` (`sanity/ai-translation/fields.ts`), so Translate with AI
   opens it, and it takes its own run step: `RUN_ORDER` (`plan.ts`), `SITE_GROUP_TITLES` (`site-run.ts`)
   and, when its slug comes from its title, `OWN_SLUG_STEPS` (`dialog-model.ts`), or a whole-site run
   orders and groups it as a legal page. The Prefix Page Route generator does all of this, the section's
   `SECTION_SEGMENTS` entry included. `sanity/i18n-schema.test.ts` fails when the registry and the schemas disagree. Never
   filter the type out of `sanity/templates.tsx`: each language's list creates through the translation
   plugin's `<type>-<language>` template. A field derived from one document's own content goes in
   `TRANSLATION_EXCLUDED_FIELDS` (`agentMarkdown` is), so a new translation does not copy it (Translate
   with AI writes the translation's own agent Markdown).
4. **A field translated in place**: list it under its type in `LOCALIZED_FIELDS` (a field name, or one
   nested a level down: `seoMetadata.title`), build it with
   `createLocalizedField({ documentType, name, title, type, required, validate })` (`type: "richText"`
   for portable text), and read it with `localized("<name>")` or `localizedRichText("<name>")`. Existing
   plain values become `{ <default>: ... }` with `npm run sanity:migrate-localize-fields`. The
   language removal and the migrations read the same list.
5. **Visible copy**: add the key to `en` in `strings.ts`, then to every dictionary (`tsc` catches a
   missing key, `strings.test.ts` a different shape). Anything with a count or a value is a function;
   counts use `counted(language, one, other)` from `src/features/i18n/grammar.ts`, and lists
   `formatList(locale, items)`. Read it from:

   | Where | Read |
   | --- | --- |
   | A route or server component | `uiStrings(Astro.locals.locale)`, or `uiStrings(locale)` once the route has its document |
   | A custom element | A data attribute the server rendered (`data-success-message`, `data-error-message`, `data-label-play`), never `uiStrings()`: it holds every language, and `src/features/i18n/client-dictionary.test.ts` fails on a browser script that reaches it |
   | An endpoint | `uiStrings(formLocale(formData))` |
   | The feed | `uiStrings(FEED_LANGUAGE)` |

   `<html lang>` is always a bare id (`it`, never `it-IT`): forms post it as `_locale`.
6. **Launching a language** (the full steps are "Launching a language" in the doc): add
   `{ id, title, region, flag }` to `LOCALES` on its own line, add `src/features/i18n/dictionaries/<id>.ts`
   typed `UiStrings` with its import and `UI_STRINGS` entry in `strings.ts`, and give it its section
   words if it should not keep the default ones. Run `npm run check`, `npm test` and
   `npm run i18n:check`, deploy, run `npm run sanity:schema-deploy`, then
   `npm run sanity:add-language -- --language <id>` (it stops on a URI collision, backfills a missing
   `language` and drafts each per-language singleton), and publish the Site translation first. The
   first time a second language is configured, also run `npm run sanity:migrate-asset-fields`.
7. **Removing a language**: Italian is a trim feature, `language:it`: `npm run trim` and pick Italian,
   or `npm run trim -- --dry-run --feature language:it` first (see `trim-features`). It comments out the
   `LOCALES` line, deletes the dictionary and drops its import and `UI_STRINGS` key, and offers
   Translate with AI (`ai-translation`) too, which only works beside a second language (a project cut
   before it joined the starter records it first with
   `npm run trim -- --reconcile --ported ai-translation`). The guided run offers to delete its content
   too, and `npm run trim -- --dataset-only --language it` deletes it later. A
   language a project added is commented out by hand with its dictionary deleted, then `npm run trim`
   offers its content (or `npm run sanity:migrate-remove-language`). Until the content is deleted the
   ghost guard keeps the site correct. The default language cannot be removed.
8. **Tests**: run `npm test`, then `npm run i18n:check` after a change to locales, queries or the
   schema (typegen, `astro check` and `npm test` in the locale mode the config does not run).

## Scope Guidance

- This skill owns the locale config, locale routing and detection, the read seams' locale binding, the
  ghost guard, the locale fragments, hreflang, the sitemap's language clusters, the UI dictionary, the
  switcher, the translation plugin's Studio wiring and the language migrations.
- Query shape, fragments in general, typegen and schema factories: `sanity`.
- Route and layout composition, the SEO `Props` contract: `astro`.
- The switcher's and every element's client behaviour: `custom-elements`.
- Endpoint conventions for the routes that read a posted locale: `server`.
- The gate passes around the locale rewrite, the prefixed-route `404`s and the route cache: `security-audit`.
- The Italian trim and purging content in a language the site no longer serves: `trim-features`.
- Plop's Prefix Page Route generator: `scaffolding-plop`.

## Non-Goals

- Translating content. Documents are authored per language in the Studio.
- Moving editor-authored copy into the dictionary.
- Deriving a URL from a locale and a slug anywhere in the app, or keeping a second list of languages.
- A feed per language: the feed is the default language's by decision.
- Changing `DEFAULT_LOCALE`: every stored URI would have to be rewritten, so the trim refuses it.

## Done Criteria

- No locale id, prefix, region or language list is hardcoded outside `sanity/i18n.ts`, and no copy a
  visitor reads is hardcoded outside the dictionaries.
- Every route resolves by `Astro.locals.path`, takes its language from its document, sets a
  self-referencing canonical, and passes one `alternates` set to the head and the shell.
- Every new scan carries the guard or a reviewed pin, and every new dereference of a translated type is
  guarded and listed in `GUARDED_REFERENCES`.
- A new translated type is in `I18N_DOCUMENT_TYPES` and carries `createLanguageField()`; a new field
  translated in place is in `LOCALIZED_FIELDS` and read with `localized()`.
- `npm run sanity:typegen` extracts as many queries as before, and `npm run check`, `npm test` and
  `npm run i18n:check` pass.

## Reference Files

- `docs/features/internationalization.md`: the full reference, from URLs and routing to removal, the
  seed and the tests.
- `sanity/i18n.ts`: `LOCALES`, `DEFAULT_LOCALE`, `LOCALE_IDS`, `IS_I18N_ENABLED`, `getIntlLocale`,
  `getOgLocale`, `withLocalePrefix`, `splitLocalePrefix`, `isHomeUri`, `homeUris`.
- `sanity/sections.ts`: `SECTION_SEGMENTS`, `SECTION_TYPES`, `localizeDocumentPath`,
  `resolveSectionRequest`, `sectionPathIssue`.
- `sanity/constants.ts`: `I18N_DOCUMENT_TYPES`, `LOCALIZED_FIELDS`, `SHARED_ROUTED_DOCUMENT_TYPES`,
  `TRANSLATION_EXCLUDED_FIELDS`.
- `src/features/i18n/shared-documents.ts`: a shared routed document's per-language paths and raw arms.
- `sanity/schemas/fields/create-language-field.tsx`, `create-localized-field.tsx`, `create-uri-field.tsx`:
  the language field and its warnings, fields translated in place, and where the prefix is applied and
  checked.
- `sanity/i18n-studio.ts` (what `sanity.config.ts` spreads), `sanity/translation-callback.ts` (a new
  translation's URI, share image and references), `sanity/structure-groups.ts` (the Studio's language
  filters), `sanity/ghost-references.ts` (`GUARDED_REFERENCES`).
- `src/features/i18n/locale-routing.ts`: the middleware step between the spelling check and the gate.
- `src/features/i18n/locale.ts` (`landingLocale`, the `locale` cookie), `homepage-locales.ts`
  (`landingHomeUri`, `readHomeUriByLocale`).
- `src/features/i18n/fragment.ts`: the locale fragments, `configuredReference`, `localized`,
  `AlternatesFragment` and `localeParams`.
- `src/features/i18n/alternates.ts` (`buildAlternateLinks`) and `language-links.ts` (`buildLanguageLinks`).
- `src/features/i18n/strings.ts` (the API and the English copy), `dictionaries/<id>.ts` (every other language), `grammar.ts` (`counted`, `joinList`): the UI dictionary.
- `src/sanity/lib/load-query.ts`, `src/sanity/lib/fetch.ts`, `src/features/sanity/proxy-state.ts`: the
  three read seams.
- `src/features/sanity/media/fragment.ts`: `localizedAssetText` and `assetText`.
- `src/features/site/LanguageSwitcher/`: the switcher pair and `languageMenu`.
- `src/features/forms/locale.ts`: `formLocale`.
- `src/lib/sitemap.ts`: `sitemapEntries`, the `xhtml:link` clusters by translation group.
- `src/features/i18n/ghost-guard.test.ts`, `render-ghosts.test.ts`, `route-path.test.ts`,
  `route-wiring.test.ts`, `strings.test.ts`; `src/sanity/lib/query-budget.test.ts`.
- `scripts/sanity-migrations/README.md`: `sanity:add-language` and the `sanity:migrate-*` commands.
- `scripts/i18n-check/README.md`: the other-mode check, `npm run i18n:check`.

## Detailed conventions

### Why `routing: "manual"`

Routes are CMS-driven, so there is no route folder per language for Astro's own i18n routing to
match, and it would answer `/en/about` with a `404` instead of letting the middleware redirect it.
`astro.config.mjs` declares the locales from `sanity/i18n.ts` with `routing: "manual"`, and
`src/features/i18n/locale-routing.ts` does the work. Stripping the prefix only picks the route file:
`src/pages/blog/[slug].astro` would never match `/it/blog/<slug>` otherwise.

### The gate around the rewrite

The middleware runs `sequence(responseHeaders, requestSpelling, localeRouting, draftSession, runtimeGates)`.
The spelling check (`classifyRequestSpelling()`) judges the request as sent, before the rewrite, and
refuses a control character or an ambiguous encoding; the gate (`classifyRequest()`) runs after it, on
`locals.path`. A gate that read the rewritten URL would key `/it/x` as `/x`, a per-page Basic Auth
bypass. The route cache answers before the middleware on the URL as requested, so `/it/x` and `/x` are
separate entries, each gated as its own path. See `security-audit`.

### Detection is homepage-only

A redirect decided from `Accept-Language` must never be cached, so detection runs only on `/`, only
without a `locale` cookie or a preview cookie, only for a browser preferring another configured
language, and only while that language's homepage is published. The front door never answers a
candidate from the cache (`landingLocale()`), published homepage or not, so the middleware decides. The switcher sets the `locale` cookie, which stops detection
for that visitor. The cookie only suppresses detection, it never redirects: a returning visitor
landing on `/` gets the default homepage, and the switcher is the way back. Do not extend detection to
other paths.

Locale routing runs before the Basic Auth gate, so under site-wide protection the landing redirect
still answers, and an anonymous visitor can learn that a language's homepage is published (never its
content). That is accepted and recorded in `security-audit`.

### Testing both modes

- A test that only makes sense with more than one language runs with `{ skip: !IS_I18N_ENABLED }`.
- The second language comes from `LOCALE_IDS`, typed `string` (with one locale its literal type is the
  default's, and two computed keys collide in `astro check`), never a hardcoded `"it"`. Ghost fixtures
  use `zz`, a language nobody configures.
- groq-js evaluates a query with `localeParams()` bound at parse time and at evaluation time; without
  the first, `[$language]` reads as a filter. An unbound `$locales` is a `400` on the Content Lake but
  an empty result in groq-js, so assert the binding.
- A test that reads `sanity/i18n.ts` or the Italian trim's anchors must also pass with `it` commented
  out and its dictionary still present: that is the starter's other locale mode.
- `npm test` runs the configured mode; `npm run i18n:check` runs typegen, `astro check` and `npm test`
  in the other one, in a throwaway copy, so `sanity/i18n.ts` is never rewritten in place. Run both
  locally after a change to locales, queries or the schema.
