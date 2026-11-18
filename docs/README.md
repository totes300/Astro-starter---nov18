# Documentation

This folder contains focused documentation for individual features and workflows.

## Start Here

Use this path if you are new to the repository:

1. Read [Deployment](./deployment.md): SSR on one Cloudflare Worker (pages rendered on demand and kept in the Workers Cache, embedded Studio, `/api/*`, and middleware), deployed from GitHub once a repository is connected
2. Read [Sanity Setup Overview](./sanity/README.md)
3. Read [Contributor Workflow](./sanity/contributor-workflow.md)
4. Use the task index below to jump to your specific job

## Security and access

- **HTTP Basic Auth**: optional site-wide or per-URL gate: **`BASIC_AUTH_USERNAME`** / **`BASIC_AUTH_PASSWORD`** as Worker secrets; **Settings** and per-entry toggles in Sanity. Run by **`src/middleware.ts`** through the gates in **`src/features/auth/gates.ts`**, which read the published toggles with `getSanityBasicAuthState()` (`src/features/auth/sanity-basic-auth-proxy.ts`), keyed on one canonical path per page. Details: [Basic Authentication](./features/basic-auth.md).
- **Security headers**: enforced frame protection (`X-Frame-Options`, `frame-ancestors`) and a Report-Only Content Security Policy built from every origin the site loads. Details: [Security headers](./features/security-headers.md).
- **Studio API routes**: callable only by a person signed in to the Studio with publish access, as Sanity confirms (each verdict is cached for a minute); the preview session that skips Basic Auth is a signed cookie. Details: [Studio API auth](./features/studio-api-auth.md).
- **Rate limits**: nothing in the code limits how often a route is called. Before launch, add the Cloudflare WAF rate limiting rules for the draft-mode handshake ([Draft Mode and Visual Editing](./sanity/draft-mode-and-visual-editing.md#rate-limit-the-handshake)), the Studio routes ([Studio API auth](./features/studio-api-auth.md#rate-limit)) Basic Auth guesses ([Basic Authentication](./features/basic-auth.md#how-it-works)) and contact form posts ([Turnstile](./features/turnstile.md#rate-limiting)). The whole baseline, sizing included, is in the `security-audit` skill (Cloudflare baseline).

## Common Tasks

- Understand the build and how to deploy it -> [Deployment](./deployment.md)
- Connect a project to its Cloudflare account, or see what CI runs on a push -> [Continuous integration and deploys](./features/ci.md)
- Understand overall CMS architecture -> [Sanity Setup Overview](./sanity/README.md)
- Configure the embedded Studio, its public path, and reserved paths -> [Studio Config and Structure](./sanity/studio-and-structure.md)
- Change document/field models -> [Schema and Content Model](./sanity/schema-and-content-model.md)
- Update queries or generated type contracts -> [Fetching, GROQ, and Types](./sanity/fetching-groq-and-types.md)
- Troubleshoot preview and draft content -> [Draft Mode and Visual Editing](./sanity/draft-mode-and-visual-editing.md)
- Understand why content is stale and how it refreshes -> [Revalidation and Caching](./sanity/revalidation-and-caching.md)
- Back up, restore, or copy Sanity datasets -> [Dataset export, import, and migration](./sanity/dataset-migration.md)
- Seed a new dataset with the bundled starter content -> [Seed dataset](./sanity/seed-dataset.md)
- Bootstrap a new Sanity project (tokens, CORS, `.env`) -> [Sanity project setup](./sanity/project-setup.md)
- Scaffold a new route/section/block -> [Code Generation (Plop)](./features/code-generation.md)
- Give the Studio's "add section" menu real pictures -> [Section previews](./features/section-previews.md)
- Remove a feature you do not need (blog, legal pages, contact form, the form layer, announcement bar, analytics, the OpenAPI description, a media kind, a section, Italian, Translate with AI) -> [Trimming features](./features/trimming-features.md)
- See what of the starter this project still has and uses -> [Trimming features](./features/trimming-features.md#it-knows-what-your-project-has)
- Clean up Sanity content left behind by an earlier trim -> [Trimming features](./features/trimming-features.md#you-can-purge-later-in-any-project)
- Set up HTTP Basic Auth (staging / optional site or per-URL protection) -> [Basic Authentication](./features/basic-auth.md)
- Allow a new third-party origin, or check the frame and CSP headers -> [Security headers](./features/security-headers.md)
- Manage redirect behavior -> [Redirects](./features/redirects.md)
- Serve a page in another language, or name a section's URL word in one -> [Internationalization](./features/internationalization.md)
- Change a UI string (labels, form messages, counts), or add a language's copy -> [Internationalization](./features/internationalization.md#ui-strings)
- Launch a language (translate it, publish its Site first) -> [Internationalization](./features/internationalization.md#launching-a-language)
- Draft translations with Sanity AI (a document or the whole site, using your Sanity organization's AI credits in `astro dev` too) -> [Translate with AI](./features/ai-translation.md)
- Switch a language off, or remove its content from the dataset -> [Internationalization](./features/internationalization.md#turning-a-language-off)
- Prove the locale mode you are not running still builds and passes its tests -> [Internationalization](./features/internationalization.md#testing-both-modes)
- Build a validated form (shared schema, inline errors) -> [Forms](./features/forms.md)
- Add the human check to a form, or the contact form's rate limit before launch -> [Turnstile](./features/turnstile.md)
- Configure contact form email notifications -> [Contact Form Notifications](./features/contact-form-notifications.md)
- Add analytics tracking events -> [Umami Tracking](./features/umami-tracking.md)
- Offer an RSS feed of the blog -> [RSS feed](./features/rss-feed.md)
- Generate and serve an llms.txt for AI assistants -> [llms.txt and AI agents](./features/llms-txt.md)
- Auto-generate image alt text on upload (Sanity AI) -> [Automatic alt text](./features/auto-alt-text.md)
- Serve a Markdown version of pages to AI agents (content negotiation) -> [Agent Markdown](./features/agent-markdown.md)
- Describe the public endpoints to agents (OpenAPI, JSON error shape) -> [OpenAPI document](./features/openapi.md)
- Add an AI-generated field (Sanity Agent Actions pattern) -> [Agent Actions](./sanity/agent-actions.md)
- Let AI agents query the Astro docs -> [MCP Servers](./features/mcp-servers.md)
- Let AI agents drive Chrome against the running site (screenshots, animations, accessibility, gated deployments) -> [Browser automation](./features/browser-automation.md)
- Add a modal, or open a page as an overlay over another -> [Dialogs and overlay routes](./features/dialogs-and-overlay-routes.md)
- Change route view transitions or page fades -> [View transitions](./features/view-transitions.md)
- Maintain animated content / motion entrances -> [Animated content](./features/animated-content.md)

## Deployment

- [Deployment](./deployment.md): the Worker, its first setup, building and deploying by hand, the time budget, the env var table (build time vs runtime, where each secret lives), content freshness, and live preview.
- [Continuous integration and deploys](./features/ci.md): the shipped workflow, dormant until a repository sets `CLOUDFLARE_ACCOUNT_ID`, and the `production` environment it reads.

## Sanity Docs

- [Sanity Setup Overview](./sanity/README.md)
- [Studio Config and Structure](./sanity/studio-and-structure.md)
- [Schema and Content Model](./sanity/schema-and-content-model.md)
- [Fetching, GROQ, and Types](./sanity/fetching-groq-and-types.md)
- [Draft Mode and Visual Editing](./sanity/draft-mode-and-visual-editing.md)
- [Revalidation and Caching](./sanity/revalidation-and-caching.md)
- [Agent Actions (Sanity AI generation)](./sanity/agent-actions.md)
- [Dataset export, import, and migration](./sanity/dataset-migration.md)
- [Seed dataset (starter content)](./sanity/seed-dataset.md)
- [Sanity project setup](./sanity/project-setup.md)
- [Standalone Sanity folder](./sanity/standalone-folder.md)
- [Contributor Workflow](./sanity/contributor-workflow.md)

## Feature Docs

- [Basic Authentication](./features/basic-auth.md): env credentials + CMS toggles (`src/middleware.ts`, `src/features/auth/sanity-basic-auth-proxy.ts`)
- [Security headers](./features/security-headers.md): frame protection and the Report-Only CSP inventory (`src/lib/security-headers.ts`)
- [Studio API auth](./features/studio-api-auth.md): who may call the Studio-backed API routes (verified Sanity session and publish access) and the signed preview session that skips Basic Auth
- [Redirects](./features/redirects.md)
- [Internationalization](./features/internationalization.md): `LOCALES` in `sanity/i18n.ts`, prefixed URLs, locale routing in the middleware, the locale params every Sanity read binds and the ghost guard they carry, hreflang and the sitemap's language clusters, the UI string dictionaries and the language switcher, launching and removing a language, the migrations and the seed
- [Translate with AI](./features/ai-translation.md): `/api/agents/translate`, one Agent Actions `translate` call per document and language behind a lease and a daily AI request ledger, the merge guard, translation statuses, Settings > Translations, and the limits that keep a run, local or deployed, within bounds
- [Code Generation (Plop)](./features/code-generation.md)
- [Section previews](./features/section-previews.md): photographs of the real sections for the Studio's "add section" menu, taken by `npm run sections:thumbs` against the specimen route `/section-preview/<section>` (always behind Basic Auth on a deployment)
- [Trimming features](./features/trimming-features.md): `npm run trim`, the interactive feature removal for this superset starter (code, docs, dependencies and Sanity content)
- [Forms](./features/forms.md): one `defineForm(schema)` shared by markup, element and endpoint; the form components in `src/components/Form/`
- [Turnstile](./features/turnstile.md)
- [Contact Form Notifications](./features/contact-form-notifications.md)
- [Umami Tracking](./features/umami-tracking.md)
- [Animated content](./features/animated-content.md): line-split intros via `AnimatedText` (`src/components/AnimatedText/`), on the painted-line splitter [kugiri](https://github.com/edoardolunardi/kugiri)
- [View transitions](./features/view-transitions.md): Astro's `<ClientRouter />` + Web Animations API presets in `src/lib/transitions/`
- [Dialogs and overlay routes](./features/dialogs-and-overlay-routes.md): the reusable `Dialog` (native `<dialog>`, no focus-trap dependency) and the blog author panel that opens a real URL over the page it was linked from
- [RSS feed](./features/rss-feed.md): `/feed.xml`, the blog as RSS 2.0 with full article bodies, autodiscovered from the blog pages
- [llms.txt and AI agents](./features/llms-txt.md): AI-generated `/llms.txt`, editable in the Settings Agents tab (Sanity Agent Actions)
- [Automatic alt text](./features/auto-alt-text.md): images described on upload and written to `sanity.imageAsset.altText`, with a backfill panel in the Settings Agents tab
- [Agent Markdown](./features/agent-markdown.md): per-page Markdown for agents via `Accept`-header content negotiation (`src/middleware.ts`); generated and stored per page, toggled in the Agents tab
- [OpenAPI document](./features/openapi.md): `/openapi.json` description of the public machine surface, plus the shared JSON error shape for API endpoints
- [Git Hooks](./features/git-hooks.md)
- [Agent Skills](./features/agent-skills.md)
- [MCP Servers](./features/mcp-servers.md): the project-scoped `.mcp.json` server (Astro Docs) for framework documentation
- [Browser automation](./features/browser-automation.md): the pinned `agent-browser` CLI agents use to drive Chrome
