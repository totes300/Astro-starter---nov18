# Continuous integration and deploys

One workflow, `.github/workflows/deploy.yml`, ships with the starter and with every project made from it. It has two jobs. `checks` runs on every push and pull request: a clean install and the unit tests, plus types and lint on a release. `deploy` builds the commit and makes it live on the Cloudflare Worker, on a push to `main` or a manual run, and only once the repository is connected to a Cloudflare account. A push that only touches words (`docs/`, `.agents/`, `.claude/`, any `*.md`) runs nothing.

The starter repository itself is connected to nothing, and neither is a new project until its first setup. There the workflow stays useful and green: `checks` runs with placeholder values, and `deploy` is skipped before it starts.

## The shape of a run

| Trigger | `checks` | `deploy` |
| --- | --- | --- |
| Push to a working branch | tests | |
| Pull request into `main` | tests, types and lint | |
| Push to `main` | tests, types and lint | build and deploy, when connected |
| Run workflow (Actions tab), or **Redeploy site** in the Studio | the same | the same, when connected |
| Docs or skills only | | |

`deploy` waits for `checks`, so nothing that failed a test or the type check reaches the Worker. A newer push to a pull request cancels the older run; a run on `main` is never cut short, so a deploy never stops halfway, and two deploys never race.

## Connecting a repository

One switch: the **repository variable** `CLOUDFLARE_ACCOUNT_ID` (Settings, Secrets and variables, Actions, Variables). It is a variable rather than a secret because a job's `if` cannot read secrets, and it is the account Wrangler deploys to, so the switch is a value the deploy needs anyway. Unset, `deploy` never starts, so an unconnected repository gets no `production` environment and no deployment record.

Then create the `production` environment (Settings, Environments) with:

| Name | Kind | Value |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | secret | An API token with Workers Scripts Edit, D1 Edit and Queues Edit on the site's account (if a deploy fails with an authorization error, Cloudflare's "Edit Cloudflare Workers" template plus D1 Edit and Queues Edit) |
| `PUBLIC_SITE_URL` | variable | The live `https://` origin: the `workers.dev` address until the custom domain is attached |
| `PUBLIC_SANITY_PROJECT_ID` | variable | The Sanity project id |
| `PUBLIC_SANITY_DATASET` | variable | The dataset, usually `production` |
| `PUBLIC_TURNSTILE_SITE_KEY` | variable | The Turnstile widget's site key (its secret is set on the Worker, see [Turnstile](./turnstile.md)) |
| `SANITY_API_VIEW_TOKEN` | secret | The build checks secrets and fetches the redirects |
| `SANITY_API_EDIT_TOKEN` | secret | Required by the build's secret check; nothing in CI writes to Sanity |
| `PUBLIC_UMAMI_WEBSITE_ID` | variable | Optional. The Umami website id; unset, the site builds without the tracker |
| `PUBLIC_SANITY_STUDIO_BASE_PATH` | variable | Optional. The Studio's public path when it is not `/studio` |

The runtime secrets (both Sanity tokens, the Basic Auth pair, the webhook secret, `TURNSTILE_SECRET_KEY`, Resend, `DEPLOY_GITHUB_TOKEN`) are set on the Worker once and survive every deploy; only the two Sanity tokens are also in GitHub, because the build checks them. The first deploy also needs the D1 database and the purge queue on the account; see [Deployment](../deployment.md).

Optionally, repository **secrets** `PUBLIC_SANITY_PROJECT_ID`, `PUBLIC_SANITY_DATASET`, `SANITY_API_VIEW_TOKEN` and `SANITY_API_EDIT_TOKEN` give `checks` the project's own values. Without them it uses placeholders the env schema accepts, which is enough: no check reads Sanity.

Nothing in the repository names the account or the repository, so moving it to another owner means recreating the variable, the environment and those secrets, and nothing else.

## The jobs

- **`checks`**: `npm test` (every unit test, the `scripts/` CLIs' included); on a release also `npm run check` (typegen, `astro check`, Biome). The commit hook already runs types and lint on what a working branch carries, so a working branch skips them here.
- **`deploy`**: first a preflight that fails, naming each one, when a value in the table above is missing, or when `PUBLIC_SITE_URL` is not a public `https://` origin. Then `npm run build` with the `production` values written into `.env`, a check that the build names that origin, and `npx wrangler deploy`, which uploads the build as a new version and makes it live at once. The deploy passes `--var DEPLOY_REPOSITORY:<owner>/<repo>` (`github.repository`), which tells the Studio's **Redeploy site** button which repository's workflow to dispatch (see [The Redeploy site button](../deployment.md#the-redeploy-site-button)).

The build reads the Worker's environment from `.env` files, never from the shell, and silently bakes whatever it finds: a build with no `PUBLIC_SITE_URL` names itself `http://localhost:4321` in every canonical. That is why the setup action (`.github/actions/setup/action.yml`) writes `.env`, and why the preflight and the origin check exist.

`deploy` builds the commit itself rather than taking a build over as an artifact: the build output carries the secrets in `dist/server/.dev.vars`, and an artifact can be downloaded by anyone who can read the repository. Each deploy is one Cloudflare version. Nothing is uploaded to test, and the Worker has no version URLs (`preview_urls: false`), so no untested copy of the site is ever public.

Every action is pinned to a full commit SHA, the workflow's token can only read the repository, and the commit hooks are off on the runner (`LEFTHOOK=0`).

## Running the checks locally

The same commands, from the repository root: `npm run check` and `npm test`. A deploy by hand is in [Deployment](../deployment.md).

## Changing the pipeline

- A new secret the build needs: an input on `.github/actions/setup/action.yml`, the job that passes it, the preflight, and the tables above.
- A rollback: `git revert` the commit and push, which ships the previous code through the same gate. `npx wrangler versions deploy <older id>@100% --yes` is faster (Cloudflare keeps every old version, without a URL, as a rollback) but reactivates that version's old cache, so purge everything right after (`/api/cache-purge`).
