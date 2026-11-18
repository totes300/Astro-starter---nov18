# Studio Config and Structure

## Public URL and reserved paths

- **Source of truth:** `PUBLIC_SANITY_STUDIO_BASE_PATH` in the environment (default `/studio`). Both `astro.config.mjs` (the `@sanity/astro` integration's `studioBasePath`) and `sanity.config.ts` (`basePath`, via the `sanity/config.ts` seam) read it, so the two never drift.
- **How the route exists:** the Studio is **embedded by `@sanity/astro`**. Passing `studioBasePath` to the integration injects a server-rendered catch-all route at that path which serves the Studio bundle. There are no rewrites and no internal mount segment; the public path is the only path. The integration uses browser routing (`studioRouterHistory: 'browser'`), so nested Studio routes (structure, tools, presentation) are real URLs under the base path.
- **Conflict with a site page:** the Studio owns every path under its base. You cannot put a page served by `[...uri]` at the same path. If a real marketing page must live at `/studio`, set `PUBLIC_SANITY_STUDIO_BASE_PATH` to a different path (e.g. `/admin`) in `.env` and as a variable of the `production` environment in GitHub (see [Continuous integration](../features/ci.md)).
- **URI validation:** the slug/URI field (`create-uri-field`) reserves the public Studio path (from `sanityConfig.studioBasePath`) and every path under it, so editors cannot create a page that collides with it. It refuses the other addresses a route of the site's own answers first too: `/404`, anything under `/section-preview`, and `/blog/<slug>`, `/blog/authors/<slug>` or the author panel's `/blog/authors/<slug>/modal` for a page (an article must be `/blog/<slug>`, a person `/blog/authors/<slug>`). Each is read with the language prefix stripped, so `/it/studio` is refused like `/studio`. The full order of checks is in [URI Rules](./schema-and-content-model.md#uri-rules). It also flags URI shapes another route shadows or the gate refuses (`uriGateProblem` in `sanity/schemas/fields/uri-gate.ts`): whitespace, a control character, a backslash, `%`, a colon, a dot, a path under `/api` or any `/_` prefix, and `/index`. That check is a warning, and an error once **Password protect** is on; a write through the API skips it. The reasons: [URIs the gate cannot cover](../features/basic-auth.md#uris-the-gate-cannot-cover).

## Studio Entrypoints

- Studio route: injected by the `@sanity/astro` integration in `astro.config.mjs` (no file under `src/pages/`)
- Studio config: `sanity.config.ts` (assembles the portable `sanity/` folder's exports)
- Runtime config seam: `sanity/config.ts` (env reads + endpoint paths; see [Standalone Sanity folder](./standalone-folder.md))
- CLI config: `sanity.cli.ts`

The embedded Studio uses the same config as typegen and the CLI, so local Studio behavior mirrors production config.

## Studio Plugins and Configuration

Defined in `sanity.config.ts`:

- `structureTool` with custom structure from `buildStructure`
- `media` plugin with `maximumUploadSize: 10000000` (10MB); with more than one language it also gets one tab per language for an asset's alt text (`mediaLocaleOptions`)
- `muxInput` plugin for video ingestion
- `autoAltTextPlugin` (`sanity/auto-alt-text.tsx`) for [Automatic alt text](../features/auto-alt-text.md)
- The translation plugin (`@sanity/document-internationalization`), only with more than one language (`translationPlugins`). It adds the language menu that creates a translation, writes `language`, and links translations through `translation.metadata`. The three spreads come from `sanity/i18n-studio.ts`; see [Internationalization](../features/internationalization.md#the-studio)
- `presentationTool` for preview/presentation workflows
- `visionTool` for GROQ inspection (dev only)

Additional form behavior:

- Image fields use `mediaAssetSource`
- File fields explicitly exclude `mediaAssetSource`

## Content Structure

Custom structure is built in `sanity/structure.tsx`.

Main groups:

- Homepage singleton (`page` schema with fixed ID from `SINGLETON_IDS.homepage`)
- Pages list (excludes singleton IDs and every language's homepage, by URI)
- Legal list (`legalPage` documents)
- Blog folder: the **Index** singleton (`blog` schema, `SINGLETON_IDS.blog`, the `/blog` page), then Articles, Authors (`person`) and Article Categories
- Form submissions grouped from `API_ONLY_DOCUMENTS`
- Site singleton (`SINGLETON_IDS.site`): the copy that renders on every page
- Settings singleton (`SINGLETON_IDS.siteSettings`, schema type `siteSettings`): site-wide configuration (redirects, Basic Auth, favicon, agent surfaces, translations, notification emails)
- **Other languages**: last, and only while some document is in a language the site does not serve

With more than one language, the translated documents open one folder per language:

- Homepage, Blog Index and Site are per-language folders (`localeGroupedSingleton`). The default language keeps the fixed id; another language's document is found through `translation.metadata` when the folder opens, drafts and release versions included, and an untranslated language shows an empty list. A homepage made outside the translation menu is found by its home URI, since Pages leaves every home URI out.
- Pages, Legal, Articles and Authors are one list per language (`localeGroupedList`), and the "+" in a language's list creates in that language. An edit intent that carries a `language` (Open in Structure, Open in the Translate with AI dialog and the whole-site panel) opens in that language's list only; one without it is taken by the first list of the type.
- Settings and Article Categories stay one shared document and one shared list. A category's name is translated in place.

With one language, each list shows only documents in a configured language (`CONFIGURED_LANGUAGE_FILTER` in `sanity/structure-groups.ts`).

**Other languages** appears only when the Studio loads with at least one translated document in a language `LOCALES` does not list (a failed check shows it anyway). It lists every translated document whose `language` is not in `LOCALES`, drafts and release versions included, one list per stored language with a help pane that asks a developer to run `npm run trim`. An empty `language` is listed as "Missing language, run the backfill", and a value that is not a string as "Not a language code". The grouping is read when the item opens; each group's list is then live.

## Singletons

Singleton IDs and routes are centralized in `sanity/constants.ts`:

- `SINGLETON_IDS`
- `SINGLETON_ROUTES`
- `TEMPLATE_IDS`

Why this matters:

- Structure list, actions, and templates all derive behavior from the same constants
- Keeping IDs here avoids drift across Studio features

## Document Actions and Templates

- Custom actions: `sanity/actions.tsx`
- Custom templates: `sanity/templates.tsx`

Current behavior:

- Singletons are restricted to `publish`, `discardChanges`, `restore`, and so is a translated homepage (matched by its URI in its release version, draft or published document, since its id is generated)
- **Delete translation** (the translation plugin's action, which also removes the document from `translation.metadata`) is offered only on a translated type, never on a singleton type, a fixed singleton id or any language's homepage in any variant (`offersDeleteTranslation` in `sanity/utils.ts`)
- **Translate with AI** (`sanity/ai-translation/translate-action.tsx`) is offered on every translated type and on a type that translates a field in place (the category), only with a second language in `LOCALES`, after the open-page actions and before Delete translation. See [Translate with AI](../features/ai-translation.md#one-document-translate-with-ai)
- A `translation.metadata` document keeps only `discardChanges` and `restore`: the plugin's **Delete all translations** would delete every document in the group, singletons included, and deleting the group would hide the singleton translations the desk finds through it
- API-only and agent scratch document types (`API_ONLY_DOCUMENTS`, `AGENT_SCRATCH_DOCUMENTS`) are restricted to `delete`, `discardChanges`
- Page documents expose quick actions:
  - Open live page (draft mode disabled)
  - Open draft page (draft mode enabled)
  - Open in Presentation
  - Open in Structure (from Presentation mode; it passes the document's `language`, so a translation opens in its own language's list)

## Presentation Tool Mapping

`presentationTool` in `sanity.config.ts` maps routes to documents:

- `/` maps to the homepage singleton
- `/*uri` maps to documents where `uri.current` equals the current path, at any depth and in any language (`/it/blog/<slug>`), and whose language is configured (`CONFIGURED_LANGUAGE_FILTER`)

Preview endpoints (from `sanity/config.ts`):

- Enable draft mode: `/api/draft-mode/enable`
- Disable draft mode: `/api/draft-mode/disable`
