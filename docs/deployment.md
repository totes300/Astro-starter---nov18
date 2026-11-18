# Deployment

The app is SSR on Cloudflare Workers. `npm run build` produces one Worker that renders every page on
demand and also serves the embedded Studio (at `PUBLIC_SANITY_STUDIO_BASE_PATH`, default `/studio`),
the `/api/*` endpoints and the middleware (Basic Auth, agent Markdown negotiation). Static files
(`public/`, `/_astro/*`) are Workers static assets, served before the Worker runs. Rendered pages are
kept in the Workers Cache in front of the Worker and purged by tag on publish (see
[Revalidation and Caching](./sanity/revalidation-and-caching.md)).

## The Worker

`wrangler.jsonc` declares one Worker, production: `tca-astro`, with the D1 database `tca-astro-route-cache`
and the purge queue `tca-astro-route-cache-purge`, the names the starter's own demo runs under. Rename all
four to the project's names before the first deploy (the naming convention is in the `cloudflare-setup`
skill). There is no
staging Worker; a change is checked in CI before it goes live, and the Worker has no version URLs
(`preview_urls: false`), so no untested copy of the site is ever public. A staging Worker would be an
`env.staging` block named `staging`, with its own `-staging-` D1 database and queue. Until a custom domain
is attached the Worker answers on `prod.<subdomain>.workers.dev`; then `workers_dev` turns off, so the site
answers only behind the zone's firewall.

`src/worker.ts` is the entry (`main`). It has two entrypoints: the default one, the front door, runs on
every request, and `Renderer`, the only one behind the Workers Cache, renders what the front door
forwards. The D1 database holds the content version and the Queue carries tag purges; both are
explained in [Revalidation and Caching](./sanity/revalidation-and-caching.md#the-front-door). No
`account_id` is committed: Wrangler takes the account from `CLOUDFLARE_ACCOUNT_ID`, so the repository
deploys to whichever account the environment names.

The account needs **Workers Paid**: a render needs more CPU than the free plan allows, and it also covers
D1, Queues and the Workers Cache. With caching on, every request to the Worker is billed, cache hits and
static assets included.

### First setup

Once per account, with `CLOUDFLARE_ACCOUNT_ID` set and Wrangler logged in (`npx wrangler login`) or a
`CLOUDFLARE_API_TOKEN`:

```bash
npx wrangler queues create <brand>-prod-route-cache-purge
npx wrangler d1 create <brand>-prod-route-cache --location weur
```

Create the D1 database with the location hint nearest the audience and Sanity's region (`weur` is
Western Europe). It needs no migration, since the route cache creates its one table on first use.
Wrangler binds both by name, so their ids stay out of the repository. Then set the secrets (below), the
Sanity CORS origin and webhook, and the Turnstile widget, and deploy. The whole sequence, in order, is the
`cloudflare-setup` skill.

### Building and deploying

Every push to `main` deploys once the repository is connected (see
[CI and deploys](./features/ci.md)). By hand, the build bakes `PUBLIC_SITE_URL` and the other public
variables into the bundle, and it reads them from the `.env` files only: the Cloudflare build loads the
Worker's environment the way Wrangler does, so a `PUBLIC_SITE_URL=... npm run build` from the shell is
ignored and the site would name itself `http://localhost:4321` in every canonical. Put the live origin and
the live Turnstile site key (`.env` holds the test one) in a `.env.local` (it overrides `.env`, and is
gitignored), build, and remove it:

```bash
printf 'PUBLIC_SITE_URL=https://<live origin>\nPUBLIC_TURNSTILE_SITE_KEY=<the live site key>\n' > .env.local
npm run build && rm .env.local
npx wrangler deploy
```

`wrangler deploy` reads the config the build wrote (`.wrangler/deploy/config.json` points at it) and makes
the new version live at once. Never set `CLOUDFLARE_INCLUDE_PROCESS_ENV`: it writes the whole shell
environment into the build. Never pass the build around either: `dist/server/.dev.vars` holds the secrets
from `.env`. Nothing uploads a version to test (`wrangler versions upload` is not part of the pipeline).
Cloudflare cannot delete a version, so every old one stays on the account, with no URL of its own, as a
rollback: `npx wrangler versions list` names them, and `npx wrangler versions deploy <version-id>@100% --yes`
makes one live again, together with what it had cached while it was live.

`npm run start` (`astro build && astro preview`) runs the built Worker locally in workerd, the runtime
Cloudflare runs: the front door, the gates and the rendering behave as deployed, but there is no Workers
Cache, so a hit, a purge and tiering are only provable on a deployed Worker. Test a burst of uncached
requests there, not against a warm deployment, where the cache hides concurrency bugs.

### Time budget

A Worker has no wall-clock limit on a request, only a CPU one, and waiting on Sanity or an AI call costs
no CPU. The app still keeps its own 60-second budget, `FUNCTION_MAX_DURATION_SECONDS` in
`src/lib/function-cap.ts`, so every long route answers JSON in predictable time. The SEO screenshot
route's steps all end within 55 seconds, and Translate with AI (`/api/agents/translate`) counts its budget
from the moment a request arrives: the AI call gets what is left minus 10 seconds kept for saving and
writing the result, a request with too little left answers `out_of_time` before spending anything, and its
free passes stop at the same reserve. Automatic alt text (`/api/agents/image-alt-text`) budgets each
description the same way, keeping 15 seconds for its save. Sanity reads give up after 10 seconds, the
translate route's writes too, so a stalled Sanity fails a request well inside the budget. Work a route
leaves to `waitUntil` (the contact form's notification email) gets 30 seconds after the response.

### Deploy the schema with schema changes

Deploying the site never deploys the Sanity schema, and Agent Actions resolve fields against the
**deployed** schema, not the code. Translate with AI compares every translated type's fields in the two
before every run and refuses all of them (`schema_drift`) while they differ, asking editors to get a
developer to deploy; a new section or rich text block is not part of that check, so runs go on against a
schema without it. Automatic alt text needs its scratch type deployed. So run, from the commit you deploy:

```bash
npm run sanity:schema-deploy
```

Once before the first launch, then alongside every deploy that changes the schema: a new or changed
document type or field, a trim, a section, prefix route or rich text block from `npm run plop`. A deploy
that only changes code or styling needs none. In the gap between the two deploys Translate with AI
refuses runs or translates against the old schema, so run them back to back.

### Checking the deployed schema

Nothing deploys the schema for you, so make a forgotten deploy loud instead:

```bash
npm run sanity:schema-check
```

It reads the deployed schema with `SANITY_API_VIEW_TOKEN`, compares every document type field by field
with the `sanity-schema.json` this commit carries (the rule Translate with AI applies before a run), and
exits 1 on any difference. It writes nothing, so run it before deploying and after every schema
change. It cannot see a new section or rich text block, which change no document's fields; deploy the
schema with those anyway. Details: [`scripts/sanity-schema-check/README.md`](../scripts/sanity-schema-check/README.md).

| It says | What it means | Who acts |
| --- | --- | --- |
| The deployed schema matches this code | Agent Actions see what the code declares | Nobody |
| Differs, and Translate with AI refuses every run | A translated type's fields differ; editors see `schema_drift` on every plan | A developer: `npm run sanity:schema-deploy` from the deployed commit |
| Differs | Another document type differs, for example automatic alt text's scratch type, or a type a trim removed | A developer: the same deploy |
| No schema is deployed | Never deployed to this dataset: Translate with AI refuses every run and alt text describes nothing | A developer: the same deploy |
| `SANITY_API_VIEW_TOKEN` is not set, or could not read the deployed schema | The token, project or dataset is missing or wrong | Whoever holds `.env` |
| Could not read `sanity-schema.json` | The extract is missing | A developer: `npm run sanity:typegen` |


## Environment variables

Set the secrets on the Worker with `npx wrangler secret put <NAME>` (or `wrangler secret bulk
<file.json>`, or `--secrets-file <file>` on the first `wrangler deploy`), and give the build the same
values: public (`PUBLIC_*`) vars are validated by the env schema in `astro.config.mjs` and baked into the
build, so they must be present at **build** time. `SANITY_API_VIEW_TOKEN` and `SANITY_API_EDIT_TOKEN` are
**required** and validated at build / dev-start (`env.validateSecrets: true`), so a missing one fails the
build. The remaining server secrets are optional and their features check at use time. Locally, `.env`
serves both Astro and Wrangler.

| Variable                                      | When    | Purpose                                              |
| --------------------------------------------- | ------- | ---------------------------------------------------- |
| `PUBLIC_SITE_URL`                             | build   | Canonical site URL (`Astro.site`, absolute links). Must be an absolute URL or the build fails; a trailing slash is stripped |
| `PUBLIC_SANITY_PROJECT_ID`                    | build   | Sanity project                                       |
| `PUBLIC_SANITY_DATASET`                       | build   | Sanity dataset                                       |
| `PUBLIC_SANITY_API_VERSION`                   | build   | API version (default `2025-02-19`)                   |
| `PUBLIC_SANITY_STUDIO_BASE_PATH`              | build   | Public Studio path (default `/studio`)               |
| `PUBLIC_UMAMI_WEBSITE_ID`                     | build   | Umami analytics (tracking off when unset)            |
| `PUBLIC_TURNSTILE_SITE_KEY`                   | build   | **Required.** The Turnstile widget's site key, rendered into every form (see [Turnstile](./features/turnstile.md)) |
| `SANITY_API_VIEW_TOKEN`                       | build + runtime | **Required.** Draft-mode preview (the preview session cookie's signing key is derived from it) and authenticated reads (every page read, which a private dataset needs; the Basic Auth and agent Markdown gate state; the contact form's recipients) |
| `SANITY_API_EDIT_TOKEN`                       | build + runtime | **Required.** Contact form writes, AI generation, SEO screenshot |
| `SANITY_REVALIDATE_SECRET`                    | runtime | Signs the `/api/revalidate` webhook and is the `/api/cache-purge` bearer token (only if you use them); 32+ characters, checked at build too |
| `TURNSTILE_SECRET_KEY`                        | runtime | The Turnstile widget's secret; unset refuses every form submission as unavailable |
| `RESEND_API_KEY` / `RESEND_EMAIL_FROM`        | runtime | Contact form notification emails                     |
| `BASIC_AUTH_USERNAME` / `BASIC_AUTH_PASSWORD` | runtime | HTTP Basic Auth credentials (toggles live in Sanity) |
| `DEPLOY_GITHUB_TOKEN`                         | runtime | The Studio's Redeploy site button: a GitHub token that can only run this repository's Actions (see [The Redeploy site button](#the-redeploy-site-button)) |
| `DEPLOY_REPOSITORY`                           | runtime | `owner/repo`, set by every deploy with `--var` (the workflow, or the first deploy by hand); locally only to try the button |

`SANITY_API_VIEW_TOKEN` is also read at build time in `astro.config.mjs` (the redirects fetch, and
only needed there if the dataset is private). See `.env.example` for the full list. The values the build
needs in CI live in the GitHub `production` environment; see [CI and deploys](./features/ci.md).

`SANITY_REVALIDATE_SECRET`, when set, must be at least 32 characters: `astro.config.mjs` declares it
with `min: 32`, and Astro checks that at build, at `astro dev` start and at runtime. **Upgrading a
site first deployed with a shorter secret:** generate a new one with `openssl rand -hex 32` and set
it on the Worker (`npx wrangler secret put SANITY_REVALIDATE_SECRET`), in the build's environment, your
local `.env` and the Sanity webhook's **Secret** field before deploying, or the build fails with
`EnvInvalidVariables`. Unsetting the variable also builds, with webhook revalidation off.

## Content freshness

Pages render on demand and are kept in the Workers Cache in front of the renderer, with tag-based
invalidation: the Sanity publish webhook (`/api/revalidate`, secured by `SANITY_REVALIDATE_SECRET`)
purges the affected routes a few seconds after content changes (about 3 seconds of settle wait, then up to
10 seconds while the purge queue gathers a batch), and publishing either site-wide singleton purges the
whole site. Nothing that holds content expires on a timer, so the webhook is what makes publishing live:
without it, a published change reaches a cached route only on the next deploy. A deploy empties the cache
on its own, because the Workers Cache is keyed per Worker version. Details and the full tag model:
[Revalidation and Caching](./sanity/revalidation-and-caching.md).

The one exception is **redirects**: they are fetched from Sanity in `astro.config.mjs` at build
time and baked in, so a redirect change in the Studio needs a rebuild and deploy: push to `main`, or run
the deploy workflow by hand, or press **Redeploy site** in the Studio.

### The Redeploy site button

The Settings document's **Redeploy site** button (`sanity/inputs/redeploy-input.tsx`, on the Redirects
field) posts to `/api/redeploy` with the `studioFetch` that `useStudioFetch()` returns. The route
(`src/pages/api/redeploy.ts`, logic in `src/features/api/redeploy.ts`, tested beside it) dispatches the
deploy workflow on `main`, which checks the commit and deploys it with the redirects read fresh:

1. `authorizeStudioRequest` runs first (see [Studio API auth](./features/studio-api-auth.md)), so only a
   signed-in editor with publish access reaches the rest, and an anonymous caller cannot even learn
   whether redeploy is set up.
2. It reads no body: nothing a caller sends can change the repository, the ref or the token.
3. It answers `500` (`deploy_not_configured`) while `DEPLOY_GITHUB_TOKEN` or `DEPLOY_REPOSITORY` is
   unset, and `500` (`deploy_misconfigured`) when `DEPLOY_REPOSITORY` is not an `owner/repo` name, so it
   can only ever address a repository on `api.github.com`.
4. It posts to `https://api.github.com/repos/<owner>/<repo>/actions/workflows/deploy.yml/dispatches`
   with the token as a bearer, GitHub's headers and `{ "ref": "main" }`, within 10 seconds.
5. It answers `200` when GitHub accepts, and a fixed `502` otherwise (`deploy_rejected` or
   `deploy_unreachable`). Neither the token nor GitHub's answer reaches the response or the log.

There is no hook URL to configure. The deploy workflow passes the repository with every deploy
(`npx wrangler deploy ... --var DEPLOY_REPOSITORY:<owner>/<repo>`, from `github.repository`), so it is
always the repository that deployed the Worker, and moving the repository changes nothing by hand. The
only value set by hand is `DEPLOY_GITHUB_TOKEN`, a Worker secret: a fine-grained GitHub token for that
one repository with **Actions: Read and write** and nothing else.

```bash
npx wrangler secret put DEPLOY_GITHUB_TOKEN
```

A deploy by hand without the same `--var` drops `DEPLOY_REPOSITORY` (a deploy replaces the Worker's plain
variables, and `keep_vars` is off), so the button answers `deploy_not_configured` until the next workflow
deploy. Never put the token in Studio code or in a `PUBLIC_*` or `SANITY_STUDIO_*` variable: everything
in the Studio bundle is public, and anyone holding it can start deploys.

## Live preview (Presentation tool)

The embedded Studio's Presentation tool renders the frontend in an iframe with click-to-edit
overlays; on-demand rendering is what lets a page read the draft-mode cookies per request and return
draft content. The flow:

1. An editor opens Presentation. The Studio loads the same-origin frontend in an iframe and calls
   `/api/draft-mode/enable` with a signed secret.
2. `enable` validates the secret, sets the `sanity-preview-perspective` cookie plus the signed httpOnly `__draft_session` (the only proof of a preview session the middleware trusts; see [Studio API auth](./features/studio-api-auth.md)), and redirects back.
3. With both cookies present, `loadQuery` (`src/sanity/lib/load-query.ts`) fetches the `drafts`
   perspective with stega encoding, and `<VisualEditing />` (mounted in `Web.astro`, draft mode only)
   draws the overlays. Editing a field reloads the page to pull fresh draft content (Astro has no live
   re-render API).

Editors also get per-document actions in the Studio (`sanity/actions.tsx`), shown only on documents
with a public page: **Open live page** (the published page), **Open draft page** (the draft
full-page, with a fresh preview secret per click), and **Open in presentation** / **Open in
Structure** to move a document between the preview iframe and the form editor.

Notes:

- `SANITY_API_VIEW_TOKEN` (Viewer) must be set on the Worker and in the build: it validates the
  preview secret and reads drafts. Preview is the main reason the token is required.
- The Studio and the site share an origin, so Presentation needs no CORS between them: the Studio uses
  browser routing (a server catch-all at `/studio/[...]`), and `stega.studioUrl` is the relative `/studio`
  path, so the overlay's links into the Studio resolve against whatever origin serves the site.
- The Studio itself calls Sanity's API from the site's origin, so that origin must be a CORS origin of the
  project, with credentials allowed (sanity.io/manage, API, CORS origins): the `workers.dev` address
  first, then the custom domain. A new domain goes on that list before it serves the site, or the Studio,
  and preview with it, stops working there.
- Every draft render answers `X-Robots-Tag: noindex` (`src/middleware.ts`) and `no-store`, so a preview
  is never indexed or cached.
