---
name: cloudflare-setup
description: Setting up, naming and deploying a site's Cloudflare Worker on a client's account. Covers the naming convention (account subdomain, a Worker per environment, D1 and queue names, the Turnstile widget), the first setup in order, secrets, connecting the GitHub workflow, verifying the cache on the live URL, renaming safely, and adding a staging Worker or a custom domain later. Use before creating, renaming or deleting anything on a Cloudflare account, editing `wrangler.jsonc`, or deploying by hand.
---

# Cloudflare setup

The Worker, its caching and its purge path are described in `docs/deployment.md` and
`docs/sanity/revalidation-and-caching.md`; the workflow in `docs/features/ci.md`. This skill is the
account side: what things are called, in what order they are made, and what bites.

## Naming convention

One convention for every resource, so the next site is a rename, not a redesign. `<brand>` is the client's
short name, lowercase. `<site>` is the site's one slug, `<brand>-web` unless the person picks another
(a demo, or a second site for one brand): chosen once, before step 1, and every name below follows it.
Names are lowercase words joined by `-`, with no spaces and no words like "button" or "token".

| Thing | Pattern | Example (`acme`) |
| --- | --- | --- |
| Account `workers.dev` subdomain | `<site>` (the bare brand is usually taken; it is global) | `acme-web` |
| Worker | the environment: `prod`, later `staging` | `prod` |
| Its URL before a custom domain | `<env>.<site>.workers.dev` | `prod.acme-web.workers.dev` |
| D1 database (content version) | `<brand>-<env>-route-cache` | `acme-prod-route-cache` |
| Queue (tag purges) | `<brand>-<env>-route-cache-purge` | `acme-prod-route-cache-purge` |
| Turnstile widget (every form's human check) | `<brand>-<env>-forms`, listing each hostname the forms run on | `acme-prod-forms` |
| Deploy token (the workflow's only Cloudflare credential) | `<site>-github-deploy` | `acme-web-github-deploy` |
| Turnstile token (optional, for the agent to create the widget) | `<site>-turnstile` | `acme-web-turnstile` |
| GitHub token for the Studio's Redeploy site button | `<site>-redeploy` | `acme-web-redeploy` |
| GitHub environment | `production` | `production` |
| Sanity webhook | `<site>-revalidate` | `acme-web-revalidate` |

The starter ships `wrangler.jsonc` with its own demo's names: the Worker `tca-astro`, the D1 database
`tca-astro-route-cache` and the queue `tca-astro-route-cache-purge`. Rename all four places to the names
above before the first deploy.

The environment lives in the Worker's name, never in the account subdomain: the subdomain covers every
Worker on the account, so `prod` in it would put staging at `staging.<brand>-prod.workers.dev`.

### The tokens, field by field

Made in a dashboard by the person, or by an agent driving the person's browser: either way, these exact
values, so every site's tokens read the same.

| Field | Deploy token | Turnstile token (optional) | Redeploy token |
| --- | --- | --- | --- |
| Where | Cloudflare, My Profile (or Manage Account for an account-owned token), API Tokens, Create Custom Token | the same | GitHub, Settings, Developer settings, Fine-grained tokens |
| Name | `<site>-github-deploy` | `<site>-turnstile` | `<site>-redeploy` |
| Scope | Account resources: this account only | Account resources: this account only | resource owner the repository's owner, **Only select repositories** with this one |
| Permissions | Account: Workers Scripts Edit, D1 Edit, Queues Edit | Account: Turnstile Sites Write | **Actions: Read and write**, nothing else (GitHub adds Metadata read) |
| Expiry | 1 year | 1 day: it is used once, in step 5 | 1 year, or the owner's maximum (366 days on an organization that caps it) |
| Description | none | none | `Lets the <site> Studio's Redeploy site button start the deploy workflow.` |
| Goes to | GitHub, `production` environment secret `CLOUDFLARE_API_TOKEN` (step 11) | the agent's shell for step 5, then deleted | Worker secret `DEPLOY_GITHUB_TOKEN` (step 6) |

A dashboard may ask for the person's passkey or a code before it creates a token: the agent waits for it.
The value is shown once. Once a token exists, an agent never screenshots, reads or searches that page: a search returns the value inside the copy button's label. The person presses copy, and the agent pipes the clipboard to the destination and empties it in the same command (`pbpaste | gh secret set CLOUDFLARE_API_TOKEN --env production; printf '' | pbcopy`), then proves the token works with a read-only call before moving on. A value an agent saw anyway is rolled (or the token deleted and remade) before it is used. A token made by mistake (wrong scope, wrong
name) is deleted from the same page once its replacement works.

`wrangler.jsonc`'s top level is production. A staging Worker is an `env.staging` block that overrides
`name` (`staging`) and both resource names (`-staging-`), and builds with `CLOUDFLARE_ENV=staging`.

## First setup, in order

Every step names who does it. **Person** steps need a login, a payment method or a dashboard an agent has
no access to: ask for them and wait. **Agent** steps run from the repository root with the CLIs already in
`devDependencies` (`wrangler`, `sanity`) and `gh`. Creating, renaming or deleting anything on a client's
account, and writing GitHub secrets, acts on someone else's infrastructure: confirm each with the person
before running it. Never print a secret: pass values on stdin or in a file, never as an argument (it
lands in shell history and the process list).

What the agent needs before it starts:

- `CLOUDFLARE_ACCOUNT_ID`, and either a logged-in Wrangler (`npx wrangler login`, which the person
  completes in a browser) or a `CLOUDFLARE_API_TOKEN` exported in the shell. `npx wrangler whoami` proves
  it.
- `gh auth status` showing admin on the repository (environments and secrets need it).
- A Sanity CLI login with access to the project (`npm run sanity:cli -- login`, done by the person).
- The brand, the live origin (the `workers.dev` address until a custom domain), and the server secrets
  from `.env` (the Sanity tokens, the webhook secret, Basic Auth, Resend).

1. **Person.** Workers Paid on the account (a render needs more CPU than Free allows; it also covers D1,
   Queues and the Workers Cache), and the account subdomain set to `<site>` (Workers & Pages, Account
   details, Subdomain; it is checked as you type).
2. **Person, or an agent in the person's browser.** The tokens, exactly as **The tokens, field by field**
   says. If a deploy fails with an authorization error, remake the deploy token from Cloudflare's "Edit
   Cloudflare Workers" template, add D1 Edit and Queues Edit, and keep its name. Make it account-owned when
   a Super Administrator can, so it survives anyone leaving. The redeploy token can start the workflow and
   nothing else; the repository it dispatches on comes with every deploy (`--var DEPLOY_REPOSITORY`),
   never as a secret. Neither value ever goes into the chat: each goes straight to where it belongs,
   through the clipboard or a private file outside the repository.
3. **Agent.** Rename the shipped `tca-astro` names in `wrangler.jsonc` to this site's (the Worker, the D1 name and both queue names; the
   change belongs in the repository), and confirm the account with `npx wrangler whoami`. No `account_id`
   is committed, so the repository moves between owners as is.
4. **Agent, after a yes.** Create the two resources. Wrangler binds both by name; no ids go in the
   repository.

   ```bash
   npx wrangler queues create <brand>-prod-route-cache-purge
   npx wrangler d1 create <brand>-prod-route-cache --location weur
   ```

   `--location` is the hint nearest the audience (`weur`, `eeur`, `apac`, and the others `--help` lists).
   The database needs no migration: the route cache creates its one table on first use.
5. **Agent with a Turnstile token, after a yes; else person.** A Managed widget named `<brand>-prod-forms`,
   listing every hostname the forms run on. By API, the answer carries the site key and the secret, so it
   goes to a private file outside the repository and only the site key reaches the terminal:

   ```bash
   umask 077
   curl -sS -X POST "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/challenges/widgets" \
     -H "Authorization: Bearer $TURNSTILE_API_TOKEN" -H "Content-Type: application/json" \
     --data '{"name":"<brand>-prod-forms","mode":"managed","domains":["prod.<site>.workers.dev"]}' \
     > <widget answer file>
   jq '{success, sitekey: .result.sitekey}' <widget answer file>
   ```

   Step 6 takes `.result.secret` from that file, then deletes it. In the dashboard it is Application
   security, Turnstile; the person hands over the site key and puts the secret in the secrets file
   themselves. Without the secret on the Worker every form submission is refused.
6. **Agent.** The secrets file, outside the repository and as JSON (a dotenv file expands `$VAR` inside
   values, which corrupts a password containing `$`): every server secret from `.env` plus
   `TURNSTILE_SECRET_KEY` and `DEPLOY_GITHUB_TOKEN`, written under `umask 077` (`jq` builds it without the values passing through
   the terminal).
7. **Agent, after a yes.** The first deploy, from a build that names the live origin. The build reads
   `.env` files only, so the live values go in a temporary `.env.local` (set an existing one aside first):

   ```bash
   printf 'PUBLIC_SITE_URL=https://prod.<site>.workers.dev\nPUBLIC_TURNSTILE_SITE_KEY=<site key>\n' > .env.local
   npm run build && rm .env.local
   grep -rlF 'https://prod.<site>.workers.dev' dist/server --include='*.mjs' | head -1
   npx wrangler deploy --secrets-file <secrets file> --var DEPLOY_REPOSITORY:<owner>/<repo>
   rm <secrets file>
   ```

   No grep match means the build named another origin: rebuild before deploying. `--var` gives the
   Redeploy site button its repository, as every workflow deploy does from then on. The secrets stay on the
   Worker across deploys (`npx wrangler secret list` shows the names; `npx wrangler secret put <NAME>`
   reads one from stdin later).
8. **Agent, after a yes.** The Worker's origin as a Sanity CORS origin with credentials, or the embedded
   Studio and its live preview fail there:

   ```bash
   npm run sanity:cli -- cors add https://prod.<site>.workers.dev --credentials
   ```

9. **Person.** The Sanity webhook (sanity.io/manage, API, Webhooks; `sanity hooks create` is interactive):
   name `<site>-revalidate`, URL `<origin>/api/revalidate`, the `production` dataset only, trigger on create, update and delete,
   projection `{_id, _type, "uri": uri.current}`, filter `!(_id in path("aiTranslation.**"))`, and the
   `SANITY_REVALIDATE_SECRET` value as the secret. The agent confirms it with
   `npm run sanity:cli -- hooks list`.
10. **Agent.** Verify the live Worker. While Protect entire site is on, anonymous `/` and `/sitemap.xml`
    answer 401. With the Basic Auth credentials the first request is `cf-cache-status: MISS` and the next
    `HIT`, with no `Cache-Tag` or `Cloudflare-CDN-Cache-Control` in the cached response. A publish in the
    Studio purges the page within about 15 seconds.

    ```bash
    printf 'user = "%s:%s"\n' "$BASIC_AUTH_USERNAME" "$BASIC_AUTH_PASSWORD" \
      | curl -sS -K - -D - -o /dev/null https://prod.<site>.workers.dev/ | grep -iE '^HTTP|cf-cache-status|cache-tag'
    ```

    `-K -` reads the credentials from stdin, so they never reach the process list. `-D - -o /dev/null`
    prints the headers of a GET: never check the cache with `curl -I`, a HEAD the front door always renders
    and never caches. Run it twice: `MISS`, then `HIT`.

11. **Agent, after a yes.** Connect the GitHub workflow (the table in `docs/features/ci.md`). Secrets go in
    on stdin, and the repository variable comes last, because it is the switch that lets a push to `main`
    deploy:

    ```bash
    gh api -X PUT "repos/{owner}/{repo}/environments/production" > /dev/null
    gh variable set PUBLIC_SITE_URL --env production --body https://prod.<site>.workers.dev
    gh variable set PUBLIC_SANITY_PROJECT_ID --env production --body <project id>
    gh variable set PUBLIC_SANITY_DATASET --env production --body production
    gh variable set PUBLIC_TURNSTILE_SITE_KEY --env production --body <site key>
    gh secret set CLOUDFLARE_API_TOKEN --env production < <file holding the deploy token>
    gh secret set SANITY_API_VIEW_TOKEN --env production < <file holding the view token>
    gh secret set SANITY_API_EDIT_TOKEN --env production < <file holding the edit token>
    gh variable set CLOUDFLARE_ACCOUNT_ID --body "$CLOUDFLARE_ACCOUNT_ID"
    ```

    Then `gh workflow run deploy.yml --ref main` and `gh run watch`: the checks pass, the preflight finds
    every value, and the deploy makes a new version live. From then on every push to `main` deploys.

    Then the Redeploy site button: the person presses it under Settings, Redirects, in the Studio on the
    live origin, and the agent confirms a run started from it:

    ```bash
    gh run list --workflow deploy.yml --event workflow_dispatch --limit 1 --json databaseId,createdAt,status
    ```

    A toast naming `deploy_rejected` means GitHub refused the token (its repository, its permission or its
    expiry); `deploy_not_configured` means the token is missing or the running version was deployed
    without the `--var`.
12. **Person.** Preview URLs off under the Worker's Settings, Domains & Routes as well as in
    `wrangler.jsonc` (`preview_urls: false`), so no version ever has a public address.

Later, with a custom domain: the person adds the zone and attaches the domain to the Worker (Settings,
Domains & Routes); the agent, after a yes, adds the hostname to the Turnstile widget (a `PUT` on
`/challenges/widgets/<sitekey>` under the same account path, sending the widget's name, its mode and the
full `domains` list) and to Sanity's CORS origins, points `PUBLIC_SITE_URL` at the domain in the
`production` environment, and sets `workers_dev: false` in `wrangler.jsonc`. The WAF rules and zone
settings are in the `security-audit` skill (section 12).

## What bites

- The Redeploy site button has no hook URL: `/api/redeploy` builds the dispatch URL from
  `DEPLOY_REPOSITORY`, which the workflow passes with `--var` on every deploy, so a moved or renamed
  repository needs nothing by hand. A deploy by hand without that `--var` drops it (a deploy replaces the
  Worker's plain variables), and the button answers `deploy_not_configured` until the next workflow deploy.
- The button reports success once GitHub accepts the dispatch. If `CLOUDFLARE_ACCOUNT_ID` is not set yet,
  that run only checks and nothing deploys; a failing check stops it the same way.
- The redeploy token is a GitHub credential with an expiry of its own: when it lapses the button answers
  `deploy_rejected`. Make a new one and `npx wrangler secret put DEPLOY_GITHUB_TOKEN` on stdin; a secret
  applies at once without a build, but Wrangler deploys it as a new version, which starts an empty cache.
- The build ignores a `PUBLIC_SITE_URL` set in the shell: the Cloudflare build loads the Worker's
  environment from `.env`, `.env.local` and `.env.<CLOUDFLARE_ENV>` like Wrangler, and takes process
  variables only with `CLOUDFLARE_INCLUDE_PROCESS_ENV=true`, which also writes the whole shell
  environment into `dist/server/.dev.vars`, so never use it. A wrong value shows as
  `http://localhost:4321` in every canonical, silently. The workflow writes `.env` and checks the built
  origin for that reason.
- The build output holds the secrets: `dist/server/.dev.vars` carries every value from `.env`. Never
  upload, share or attach `dist/`.
- With caching on, Cloudflare bills every request to the Worker, cache hits and static assets included,
  at the request rate. Estimate cost on requests, not on renders.
- Never upload a version to test (`wrangler versions upload`) or turn version URLs back on: a version on
  a URL runs with the live secrets, and Cloudflare cannot delete versions, so the URL would outlive the
  test as a crawlable copy of the site. With URLs off, every old version stays on the account as a
  rollback with no address: `npx wrangler versions list`, then `npx wrangler versions deploy <id>@100% --yes`.
- Never share an in-flight promise or an I/O object across requests: a Worker cannot wait on I/O another
  request started, and the runtime cancels a request left waiting on one as hung, with a 500. Values
  cached at module level are fine. The Workers Cache hides this, so test bursts against `npm run start`,
  where nothing is cached.
- `astro preview` (`npm run start`) is the Worker in workerd without the Workers Cache: gates, headers and
  rendering are proven locally; a cache `HIT`, a purge and tiering only on a deployed Worker.
- A D1 database cannot be renamed: create the new one, point `wrangler.jsonc` at it, redeploy, then
  delete the old one (confirm with the owner first, deletes are permanent).
- Renaming the Worker creates a new Worker. A queue takes one consumer, so detach the old one first:
  `npx wrangler queues consumer remove <queue> <old worker>`, `npx wrangler delete --name <old worker>`,
  then deploy the new name with `--secrets-file`, since secrets belong to the old Worker.
- Changing the account subdomain moves every Worker at once and the old URL stops answering
  immediately; the new one can take a few minutes.
- A custom domain needs the domain as a zone on Cloudflare, in the same account. The usual way moves the
  nameservers (full setup, free). A client that must keep its DNS elsewhere has two other ways: a partial
  (CNAME) setup, Business plan or higher, where a Worker custom domain has to be tested first; or
  Cloudflare for SaaS (free to 100 hostnames), which serves a CNAMEd hostname through a second zone that
  is fully on Cloudflare. Either way the bare domain cannot point at Cloudflare from a provider without
  root CNAME flattening, so it keeps redirecting from where it is. Add the domain to the Turnstile
  widget's hostnames first, or every form check fails there, and to Sanity's CORS origins with
  credentials, or the embedded Studio and its live preview fail there. Attach it under the Worker's
  Settings, Domains & Routes, then set `workers_dev: false` so the site answers only behind the zone's
  WAF. Moving nameservers changes who hosts DNS, not where records point: check the imported MX, SPF,
  DKIM and TXT records before switching.
- The Workers Cache runs on `workers.dev` too, so caching is provable before the domain moves.
- A `no-store` response (the 401, a draft) reaches the browser with `Cloudflare-CDN-Cache-Control`
  still on it; only stored responses have it stripped. Harmless, but do not read it as a bug in the purge.
