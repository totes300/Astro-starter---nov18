# Repository Guidelines

The Content Architecture (Astro) is mainly Astro, Tailwind, and TypeScript with a Sanity CMS. Public pages are Astro plus Tailwind plus vanilla TypeScript (custom HTML elements). React is used only inside the embedded Sanity Studio and must never bleed into, or be used on, public-facing pages.

## Agent Workflow

1. Scope first: find the smallest set of files to change and avoid unrelated edits.
2. Before substantive edits, name the skill(s) that apply (a one-line Skill Preflight) and read each one under `.agents/skills/<name>/SKILL.md` first.
3. When docs and code disagree, current repository code is the source of truth.
4. Reuse-first: prefer existing components, patterns, and helpers before adding new ones.
5. After Sanity schema changes, run `npm run sanity:typegen`. Generated files (`sanity/types.ts`, `sanity-schema.json`) are never edited by hand.
6. Prefer the Plop generators (`npm run plop`) for new page builder sections, prefix routes, and rich text blocks.

## Project Structure

- `src/pages/`: Astro routes. `[...uri].astro` is the pages model (every `page` document renders here, homepage included); `blog/[slug].astro` is the prefix-route pattern (`blog/authors/[slug].astro` adds the overlay-route pattern: a page that also renders as a panel over the one that linked to it); `llms.txt.ts`, `sitemap.xml.ts` and `feed.xml.ts` are CMS-driven endpoints; `robots.txt.ts` is built from code and env.
- `src/layouts/`: the page shell (`Web.astro`: head/SEO/OG, JSON-LD, transitions, Umami, draft-mode overlay).
- `src/components/`: shared UI. A component with no companion files is a flat `Component.astro`; with companions (a paired `ComponentElement.ts` custom element, sub-components, or assets) it is a PascalCase folder. A folder that also owns a data layer (`query.ts`, `fragment.ts`) is a kebab-case module instead (`src/features/site/site-header/`); see `code-style`.
- `src/features/`: product feature modules, grouped by domain: `page-builder/` (section components + queries + `PageSections.astro` registry), `site/` (shell, header, footer, language switcher, error, announcement bar), `forms/` (the shared form layer: `defineForm` rules, the `FormElement` base class, the request guard every form endpoint reads its body through, endpoint responses), `sanity/` (link + media GROQ fragments, image URL builders, `safeHref`), `rich-text/` (fragments), `agents/` (llms.txt + agent Markdown + auto alt text + Translate with AI, and `agent-client.ts`, the one Agent Actions client, which uses your Sanity organization's AI credits in `astro dev` too), `feed/` (the blog RSS feed: query, HTML and XML serializers), `api/` (the Studio route gate, webhook verification, the shared JSON error shape), `auth/` (the Basic Auth gates and the one canonical path they decide on), `i18n/` (locale routing, first-visit language detection, the GROQ locale fragments and `localeParams`, hreflang and the switcher's options, the UI string dictionaries; see `i18n`), `turnstile/` (the Cloudflare Turnstile human check every form runs: the browser loader and the server verify), `umami/`, `utils/`.
- `src/sanity/`: the app-side Sanity layer: `lib/load-query.ts` (page fetches) and `lib/fetch.ts` (`fetchSanity`, for an API route's own client), which both bind the locale params, `lib/draft-mode.ts`, `queries.ts` (route queries), `seo.ts`, `media/` (SanityMedia dispatch: image, Mux, native video, Lottie, Rive), `rich-text/` (astro-portabletext renderers).
- `src/lib/`: framework-free helpers: `env.ts` and `site-url.ts` (the env seam and `absoluteUrl`), `cache.ts` plus `route-cache/` (`cacheResponse`, the route cache policy, the Worker's front door, the D1 content version and the purge queue), `content-version.ts`, `security-headers.ts`, `xml.ts` and `sitemap.ts`, `lazy-hydrate.ts`, `transitions/` (page transitions and scroll restoration).
- `src/pages/api/`: API endpoints (file-based routing, served at `/api/*`).
- `src/worker.ts` and `wrangler.jsonc`: the Cloudflare Worker. The default entrypoint is the front door every request meets; `Renderer`, behind the Workers Cache, renders what it forwards; the `queue` handler purges by tag. The D1 database and the purge queue are bound in `wrangler.jsonc` (see `docs/deployment.md` and `cloudflare-setup`).
- `src/middleware.ts`: the security headers, the request spelling check, locale routing (`src/features/i18n/locale-routing.ts`: strips the language prefix to pick a route file and sets `Astro.locals.path` and `Astro.locals.locale`), CMS-managed HTTP Basic Auth + agent Markdown content negotiation. It holds the request pipeline only; each step lives in `src/lib/security-headers.ts`, `src/features/auth/`, `src/features/i18n/` or `src/features/agents/`.
- `src/styles/`: Tailwind v4 setup (tokens, fluid typography, global, rich text element styles).
- `sanity/` (root): the Studio: schema, structure, actions, templates, inputs. Standalone folder: only relative imports inside, configured through `sanity/config.ts` (see `docs/sanity/standalone-folder.md`). It also holds `i18n.ts` (`LOCALES`, the one language switch, import-free so the app, the Studio, the scripts and `astro.config.mjs` all read it) and `sections.ts` (each routed section's URL word per language).
- `sanity/ai-translation/`: Translate with AI: the merge guard, statuses, the style guide, the request and the route's contract in `wire.ts`, plus the Studio's route client, run queue, the document action with its dialog, and the rules of the Settings > Translations panel; see `docs/features/ai-translation.md`.
- `scripts/`, `seed/`, `templates/`: project-setup and dataset CLIs, starter content, Plop templates. `scripts/sanity-migrations/` holds the language migrations (`npm run sanity:add-language`, `sanity:migrate-*`), and `scripts/i18n-check/` the other-locale-mode check (`npm run i18n:check`). See `scripts/README.md`.
- `scripts/trim-features/`: `npm run trim`, the inverse of `plopfile.mjs`, Italian (`language:it`) and Translate with AI (`ai-translation`) included. Removing a feature from this superset starter means updating the **manifest** (`features.ts`, the starter's), not writing code; `manifest.test.ts` fails the moment a registry it names moves. A project records what it did with the starter in `project.json` (`npm run trim -- --status`, `--reconcile`) and takes starter fixes with `npm run trim:update`. See `docs/features/trimming-features.md`.

Path aliases from `tsconfig.json`: `~/*` resolves into `src/` (`~/components/*`, `~/layouts/*`, `~/features/*`, `~/lib/*`), and `~/sanity/*` resolves into the ROOT `sanity/` folder (constants and generated types). Always import absolutely; keep relative paths only for same-folder siblings and inside the two `sanity/` folders, which stay portable.

## Coding Style & Conventions

These are the global one-liners. Authoritative detail lives in the skill named on each line.

- Language: TypeScript (Astro strict tsconfig). Format and lint with Biome (`biome.jsonc`): double quotes, semicolons, `lineWidth` 130. Run `npm run format`. Biome covers `.astro` frontmatter only; keep template markup tidy by hand. See `code-style`.
- Control flow: braced `if`/`else` with blank-line spacing so code breathes. No one-line `if`. Prefer `type` over `interface`. A ternary chain (more than two branches) fails Biome: use `run` from `~/features/utils/common` with early returns; a single ternary is fine. See `code-style`.
- No arbitrary Tailwind values: use a theme token or an `@utility` in `src/styles/tailwind.css`. See `tailwind`.
- Comments: rare, one line, WHY only. Never inside `.astro` markup. A module header is two lines at most; a longer one is a `docs/` page with a one-line pointer to it. See `comments`.
- No React on public pages: it lives only in the Sanity Studio. Client behavior is a custom HTML element (`Component.astro` markup plus a paired `ComponentElement.ts`); the `.astro` `<script>` only imports the element. See `custom-elements`.
- Pages and routing: compose `Web.astro`, logic in frontmatter; the app is always SSR (on-demand rendering). Cache a route with `cacheResponse()` from `~/lib/cache`, never `Astro.cache.set` (a test fails on it). See `astro`.
- Languages: `LOCALES` in `sanity/i18n.ts` is the one switch. A route looks its document up by `Astro.locals.path` (the stored `uri`, language prefix included), never `Astro.url.pathname`, `Astro.params` or `Astro.currentLocale`; every scan over `*` carries the ghost guard; copy a visitor reads comes from `uiStrings()`, never an English literal. See `i18n`.
- CMS values: a CMS string that reaches an `href` or a `style` goes through an allowlist where it renders (`safeHref()`, `tokenColor()`, `cssAspectRatio()`), because Studio validation never runs on API writes. See `sanity` and `security-audit`.
- Absolute URLs: never concatenate `PUBLIC_SITE_URL`. Build every canonical, sitemap `<loc>`, and share link with `absoluteUrl(path)` from `~/lib/env`, the seam that normalizes the origin (no trailing slash) and joins the path. A test in `src/lib/site-url.test.ts` fails the build on a hand-built one.
- Styling: Tailwind-first. No `<style>` tags for normal styling. `isolate` on parents of z-indexed layers. Merge default + caller classes with `cx` from `~/features/style/utils` (tailwind-merge). See `tailwind`.
- Responsive: mobile-first. Base utilities are the phone; `md:` etc. only add going wider. Never `max-*` variants. See `mobile-first`.
- Scroll: listen to native scroll only (`window` events). No animation library: scroll-linked work measures its range once per layout and maps `window.scrollY` onto a style write, and animation runs on the Web Animations API. Never bind to the Lenis instance; Lenis drives the native scroller and is not mounted in draft mode. Only `src/components/Lenis/` imports `lenis` (Biome-enforced). See `custom-elements`.
- Sanity: define queries with `defineQuery` (from `groq`), fragments live beside their feature, fetch via `loadQuery` (an API route with its own client via `fetchSanity`; never a bare `client.fetch(`), render with the `.astro` helpers; types are generated, not hand-edited. See `sanity`.
- Section previews: a section that appears in the Studio's insert menu is split, and owns a `preview.ts` beside it. Changing a section (new field, new layout, new copy) means updating that fixture and re-running `npm run sections:thumbs <slug>`; `npm test` fails until you do. See `section-previews`.
- Page builder sections self-fetch their own GROQ slice by `docId` + `sectionKey` and register in `PageSections.astro`. Each section renders `SectionFrame.astro` as its outermost element and forwards `sectionSettings`, so shared layout switches (Full Bleed today) reach every section at once. Use the Plop generator. See `section-anatomy`, `section-colocation` and `scaffolding-plop`.
- Server endpoints live in `src/pages/api/` (file-based routing). See `server`.
- Studio-backed API routes: the first step is `const denied = await authorizeStudioRequest(request)` from `~/features/api/auth`, and Studio code calls them with `useStudioFetch()` / `studioFetch()` from `sanity/lib/studio-fetch.ts`. Never gate on `Origin`/`Referer`, and never trust a preview cookie's presence; see `docs/features/studio-api-auth.md`.

## Skills

`AGENTS.md` and `.agents/skills/` are not redundant. This file stays short: workflow, layout, a few global conventions, and an index of skills. Authoritative rules, checklists, and any `references/` live in `.agents/skills/<name>/SKILL.md`. Use this file to orient; use the skill folder for anything non-trivial.

Before substantive edits, read `.agents/skills/<name>/SKILL.md` for each skill in your Skill Preflight. If a skill lists Reference Files, read those before changing related code.

Repo-architecture skills:

- **code-style**: language-level style (breathing control flow, `type` over `interface`, naming, imports, the Biome setup); also the simplicity review (duplication, dead code, hand-rolled stdlib; one-line findings).
- **comments**: comment minimalism; comments are rare, one line, and explain WHY. No comments inside `.astro` markup; a module header is two lines at most and a longer one belongs in `docs/`. Carries the density budget and an audit recipe.
- **conventional-commits**: commit and PR title format (`type(scope): summary`), the type and scope vocabulary in use, imperative subjects, and bodies that explain why. Enforced by a `commit-msg` hook (commitlint); the skill covers what the hook cannot judge. Read before writing any commit message.
- **custom-elements**: the vanilla-TS custom element pattern for all client behavior. No React on public pages.
- **icons**: the `src/components/Icon/` registry; `Icon.astro` is the only module that imports a raw SVG.
- **lazy-hydration**: defer heavy element JS via `lazyCustomElement` (`src/lib/lazy-hydrate.ts`); used by the Mux/Lottie/Rive media renderers.
- **astro**: pages, layouts, routing, SEO/meta, and page-level draft mode.
- **tailwind**: Tailwind v4 `@theme` token system, Tailwind-first, `isolate`, class-string extraction.
- **mobile-first**: base utilities describe the phone; wider-only prefixes; bans `max-*` variants.
- **sanity**: CMS end to end: GROQ + typegen flow, custom GROQ functions (repeated projections are hoisted, not inlined), `loadQuery`, media/rich-text renderers, draft mode, the React-only Studio boundary, and the product conventions (page builder, uri model, singletons).
- **server**: Astro API endpoints in `src/pages/api/`.
- **i18n**: languages end to end: `LOCALES` as the one switch, locale routing and `Astro.locals.path`, the three read seams and the ghost guard, the routed query and route recipe (hreflang, the switcher), translated types and fields translated in place, the UI dictionary, launching and removing a language, and tests in both locale modes.
- **dev-server**: reaching the running site for a visual check: reuse the dev server that is already up, start your own only when there is none, and confirm the client booted before trusting a screenshot. The browser is `agent-browser`, pinned in `devDependencies` and run as `npx --no -- agent-browser`; see `docs/features/browser-automation.md`.
- **browser-testing**: checking a visible change in the browser with `agent-browser` the quiet way: once when the change is done, headless, scoped to the section preview or the route and element that changed, at 390 and 1920, with a before/after baseline so only new problems are reported, and a one-line report.
- **cloudflare-setup**: the account side of the Worker: the naming convention (one `<site>` slug, `<brand>-web` by default, naming the subdomain, the tokens and the Sanity webhook, with each token's exact fields; a Worker per environment, the D1 database, the purge queue and the Turnstile widget), the first setup in order, secrets, connecting the GitHub workflow, verifying the cache, renaming safely, a staging Worker or a custom domain later, and what bites. Read it before creating, renaming or deleting anything on a Cloudflare account, editing `wrangler.jsonc`, or deploying by hand.

Product skills: **agent-markdown**, **section-anatomy**, **section-colocation**, **section-previews**, **scaffolding-plop**, **trim-features** (removing a shipped feature from the code and the dataset, and what of the starter a project still has; run `npm run trim` first and finish only what it reports it could not apply), **seo-aeo-best-practices**, **umami-analytics**, **design-engineering**, **docs-maintenance**, **performance-audit**, **security-audit** (auditing or hardening the middleware gates, route cache, endpoints, CMS-fed hrefs and styles, headers, secrets and the Cloudflare baseline; read it before adding an endpoint, a gate, a cache rule or a secret). General engineering skills: **modern-web-guidance** (vendored; it says to run `npx -y modern-web-guidance@latest`, but pin an exact version instead, see `security-audit` section 13).

When adding or renaming a skill, update this Skills index in the same change.

## Completion Checklist

Before the final response: only in-scope files changed, the skill's required commands were run, every import resolves to a real file, and a change someone can see ran the **browser-testing** pass on its narrowest target after the last edit.

## Quality Gates

- `npm run check.types` (runs typegen, then `astro check` for type checking across `.astro` and `.ts`).
- `npm run check.biome` (Biome, errors only; braces enforced via `useBlockStatements`). `npm run format` applies fixes.
- `npm run check` (runs every `check.*` in parallel).
- `npm test` (unit tests for the `scripts/` CLIs, `src/` features, and `sanity/` schema utils). Renaming a schema registry, a routed constant or a page-builder section also means updating `scripts/trim-features/features.ts`: in the starter, `manifest.test.ts` asserts every anchor it names still resolves. A project's own sections and types are recorded in `scripts/trim-features/project.json` (plop does it for scaffolded ones).
- Tests must pass in both locale modes. `npm test` covers the configured one; `npm run i18n:check` checks the other locally, with `LOCALES` switched in a throwaway copy of the tree (typegen, `astro check` and `npm test` there; one locale with no commented candidate has no other mode). Run it after changes to locales, queries or the schema. A multi-locale-only test runs with `{ skip: !IS_I18N_ENABLED }` and takes its second language from `LOCALE_IDS`.
- CI: `.github/workflows/deploy.yml` runs the tests on every push, types and lint on a release, and deploys `main` to the Worker once the repository variable `CLOUDFLARE_ACCOUNT_ID` is set; see `docs/features/ci.md`.
- `npm run sanity:schema-check` compares the schema deployed to Sanity with `sanity-schema.json` (read-only); run it before deploying or after a schema change.
- `knip` is installed but deliberately **not** in `npm run check`: this starter is a superset on purpose (`createIconField` has no call sites by design), so a standing gate would fight that. It runs as the opt-in second pass of `npm run trim`.
- Commit messages are checked by the `commit-msg` hook (commitlint, rules in `commitlint.config.mjs`). See the `conventional-commits` skill.
