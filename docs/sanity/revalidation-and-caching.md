# Revalidation and Caching

This stack caches rendered routes with **tag-based invalidation**, built on Astro's route caching API (`Astro.cache` / `context.cache`, configured in `astro.config.mjs`). The policy is the app's (`src/lib/route-cache/`): it decides which renders may be kept and under which tags. Cloudflare's **Workers Cache** stores them, in front of the Worker's renderer, so a hit is answered from the nearest datacenter without running the Worker at all. A signed Sanity webhook at `/api/revalidate` purges the right tags on publish, so cached pages refresh a few seconds after content changes. A deploy starts an empty cache.

## The tag model

Tags follow one convention, shared by the pages that set them (`src/lib/cache.ts`) and the webhook that purges them:

| Tag | Example | Set on |
| --- | --- | --- |
| Document `_type` | `page`, `article`, `site`, `siteSettings` | Every response rendered from that type |
| `doc:<publishedId>` | `doc:homepage` | The document's own routes |
| The routed `uri` | `/about` | The document's page |

Two structural rules make the model work:

- **Every page also carries both site-wide singletons.** The header, footer, and SEO fallbacks come from the Site singleton, and the favicon comes from Settings; all of them render on every page, so each page response is tagged with both `_type`s (`SITE_WIDE_CACHE_TAGS` in `src/lib/cache.ts`). Publishing either singleton therefore purges the whole site through one tag. With more than one language, the same list also carries each non-default language's home URI (`/it`), because the language switchers link that homepage from any page without a translation.
- **List-like routes carry every contributing type.** `sitemap.xml` is tagged with every routed type (`page`, `legalPage`, `article`, `person`, `blog`) and both site-wide types, so any routed document's publish refreshes it. The blog index adds `article` and `articleCategory` on top of its own document tags, so publishing any post or category refreshes the listing. `llms.txt` carries the same set as the sitemap (its content lives on `siteSettings`, which is one of the site-wide types), so a publish that protects a page also drops that page's link from the served file.

Where tags are set: `src/pages/[...uri].astro`, `src/pages/blog/[slug].astro`, `src/pages/blog/index.astro` and the author pages (`cacheResponse(Astro, …)` from `src/lib/cache.ts`, with `CACHE_TTL` and `docCacheTags(page)` + `SITE_WIDE_CACHE_TAGS`; no page or endpoint calls `cache.set` itself, and `src/lib/cache.test.ts` fails if one under `src/pages` does), plus `src/pages/llms.txt.ts`, `src/pages/sitemap.xml.ts`, `src/pages/feed.xml.ts`, `src/pages/openapi.json.ts` and `src/pages/favicon.ico.ts`, which call the same `cacheResponse(context, …)`. The agent-Markdown route is not cached: its answer depends on the eligibility snapshot, which no tag tracks.

Freshness is publish-driven only. Nothing expires on a timer except `/robots.txt`, which depends only on env, carries no tags and keeps a one-day `maxAge`. `CACHE_TTL` sets a nominal year-long `maxAge` because the cache API requires one, so in practice a cached page lives until a publish purges it or a deploy replaces the cache.

## The front door

The Workers Cache answers a hit before any code runs, so whatever the middleware would decide has to be decided before the cache sees the request. That is why `src/worker.ts` has two entrypoints, one Worker:

- **The front door** (the default export, Workers Cache off) runs on every request and reads no state. `routeRequest()` (`src/lib/route-cache/front-door.ts`) either renders the request itself, uncached, exactly as the middleware would, or turns it into a **canonical request** and forwards it to the renderer through `ctx.exports.Renderer.fetch()`.
- **The renderer** (the `Renderer` entrypoint, Workers Cache on) renders the canonical request inside the cache. No route points at it, so every request it sees is one the front door built. The provider marks its answer (below), and `forWorkersCache()` hands it to the cache with its tags.

The canonical request is the cache key spelled once: the path the router renders and only the query parameters the route reads (`entry.ts`, below), no cookies, one fixed `Accept`, and the `Authorization` header only when the request is gated. So the cache needs no `Vary`, and a browser's own headers can never become part of a stored page. It is forwarded with `redirect: "manual"`, so a redirect comes back as one rather than storing its target's page under this key.

| Module | Role |
| --- | --- |
| `front-door.ts` | `routeRequest()`: render here, or forward the canonical request; `fromCachedRequest()` and `cachedRender`, the renderer's half |
| `provider.ts` | The configured provider: wires the gate state (`isPublicPath()`), the content version and the purge queue into the policy |
| `create-provider.ts` | The policy: which renders the cache may keep, for how long, under which tags; `forWorkersCache()` |
| `rules.ts` | The bypass predicates and the Basic Auth credential match |
| `entry.ts` | Key normalization (`entryTarget()`: the path the router renders plus the query parameters its route reads, `ROUTE_QUERY_PARAMS`) and the lifetime rule (`entryTtl()`) |
| `render-scope.ts` | What one render tells the provider about itself, held in an `AsyncLocalStorage` the provider opens around the render: the route's cache options and a lowered lifetime (`capRouteCacheTtl()`). It is also the key the content version dedupes its read by, so no read is shared across requests |
| `cache-tags.ts` | Our tags in the form Cloudflare accepts (printable ASCII, no space or comma, 1,024 characters, case-insensitive): anything else in a URI is percent-encoded |
| `purge-queue.ts` | `enqueuePurge()` and the Queue consumer, `consumePurgeBatch()` |
| `d1-version-store.ts`, `content-version.ts` | The content version policy (`read` / `readFresh` / `bump`, `CONTENT_VERSION_PARAM`) and its D1 store (see **The Sanity CDN**) |

The front door renders these itself, so they never reach the cache:

- **Draft mode** (the signed `__draft_session` cookie or the `sanity-preview-perspective` cookie; a forged one only costs its sender the cache): editors always see fresh draft renders. The session cookie counts on its own because it outlives the session-scoped perspective cookie and still skips Basic Auth. Pages set their cache through `cacheResponse()` (`src/lib/cache.ts`), which turns caching off under a draft session rather than re-enabling it after the middleware's `cache.set(false)`.
- **Agent Markdown negotiation** (`Accept` mentions markdown): the middleware's rewrite must run; a cached HTML hit would answer first.
- **Unmatched `Authorization` headers** (wrong password, unrelated Bearer token): the middleware decides, and nothing is stored.
- **A first visit the middleware may send to its language**: a page request for `/`, a hover prefetch included, with no locale cookie whose `Accept-Language` prefers another configured language (`landingLocale()`). The front door reads no state, so it does not check whether that homepage is published: such a visit always renders, and the middleware redirects or renders `/` as it would anyway. Only with more than one language.
- **Anything but `GET`**: writes, and `HEAD`, because a `HEAD` that missed would leave an empty body where the `GET`'s page belongs.
- **A request the key refuses**: a query parameter the route does not read, a spelling the router and the gates could read differently, the section preview without matching credentials, or a path under the gated key prefix.

What the renderer marks: only a plain `200` that sets no cookie, with a lifetime the route asked for and a body under 1&nbsp;MB, rendered under a content version that did not move (see **The Sanity CDN**), on a path that is public now or a gated request. It gets `Cloudflare-CDN-Cache-Control: public, max-age=<ttl>, stale-if-error=86400` and its tags. Everything else the renderer answers gets `Cloudflare-CDN-Cache-Control: no-store`, explicitly, because the Workers Cache otherwise keeps an unmarked `200` for two hours by its own heuristics. Browsers see neither header on a stored response (Cloudflare strips both), and no response carries a `Cache-Control` a shared cache downstream could act on. Cookies written through `Astro.cookies` become `Set-Cookie` headers only after the provider returns, so `entry.ts` reads them off the response itself. A response's tags are its route's tags, its path tag (`astro-path:<path>`, which `cache.invalidate({ path })` purges) and `route-cache:all`.

Astro deletes `Cache-Tag` from a runtime provider's answer, so the provider writes the tags as `X-Route-Cache-Tag`, and the renderer entrypoint renames it to `Cache-Tag` on the way out (`forWorkersCache()`). Check `cf-cache-status` (`HIT`, `MISS`, `BYPASS`, or `DYNAMIC` for the front door's own renders) on a deployed Worker; locally there is no Workers Cache, and the two headers show what would be stored.

Entries are keyed on the path the router renders, not on the request's spelling: decoded as the router decodes it, doubled slashes collapsed and the trailing slash dropped, so `//about`, `/ab%6fut` and `/about/` share `/about`'s entry, and the host is not part of the key. A spelling the router and the gates could read differently (`%2F`, `%25`, a backslash) is never cached.

Only the query parameters a route reads are part of its key, listed per route in `ROUTE_QUERY_PARAMS` (`src/lib/route-cache/entry.ts`) under its unprefixed path; today that is `category` on `/blog`, which also covers `/it/blog` (the locale prefix is stripped and a language's own section word mapped back before the lookup). Tracking parameters (`utm_*`, `gclid` and the like) are dropped on every route, and a listed parameter's values are deduped and sorted, so order or repetition cannot mint entries. Any other parameter means the request still renders but is never stored: it is refused rather than dropped, so a route that starts reading one can never be answered from an entry keyed without it. A query with more than 16 values or a value over 100 characters is not stored either. **This list is the extension point:** a page that starts reading a new parameter adds it there, or every request carrying it renders uncached.

Entries are keyed on the URL as requested, before the middleware's locale rewrite, so `/it/blog/post` and `/blog/post` are separate entries, each checked against the gate state for its own path. The route's cache options reach the provider through the request's async context (`renderScope` in `render-scope.ts`), not through its `Request`: the rewrite to the unprefixed route file swaps the `Request`, so options keyed by it would never be found and every prefixed page would silently go uncached. This cannot be seen in `astro dev`, which runs no route cache; `create-provider.test.ts` renders through a rewrite to keep it covered, and simulates the front door, the Workers Cache and the renderer together.

A render that fell back after a transient upstream failure (the per-language homepage list the chrome links to, say) calls `capRouteCacheTtl(FALLBACK_RENDER_TTL)` from `src/lib/cache.ts`, and is stored for 60 seconds at most rather than until the next publish. The cap is read once the whole body is in, so a component deep in the page can set it while it streams; outside a render the cache scopes, it does nothing.

A route can also decline to store one render: `cacheResponse(Astro, false)`. The blog index does that unless every requested category is a known one in its canonical spelling (`isCacheableCategoryView` in `src/features/blog/category-view.ts`), so a made-up `?category=` value renders the empty state without becoming an entry. Each of those decisions has to run in the page's frontmatter: the provider reads the cache options once the page returns its response, before the components below it have rendered, so the blog index reads its article list itself and hands it to `ArticleList`.

### Basic Auth traffic is cached too

Shared caches refuse to store a request carrying an `Authorization` header unless the response says `public` (RFC 9111), and they key on the URL alone, so gated traffic needs care:

- **Separate keys.** The front door forwards a gated request under the `/__gated` path prefix (`GATED_KEY_PREFIX`), which only it adds and which the renderer strips before routing, so a gated render can never be read by a request that has not matched the credentials. A request that asks for `/__gated/...` itself is rendered by the front door like any unknown path. Before marking a public render, the renderer checks the published Basic Auth state on the request's canonical page path (`isPublicPath()`, the state the middleware reads): a path that is protected now, a locked site, or a state it cannot read means no public copy, so the request gets the middleware's 401 or 503, which is never stored. The provider cannot see the route, so the page a panel partial renders (`panelHostPath()` in `src/features/auth/request-gate.ts`, `/blog/authors/<slug>` for `/blog/authors/<slug>/modal`) must be public too, the same page the middleware gates that path as. The section preview is never public, in any spelling or language: the deployment's env credentials gate it, and the CMS state knows nothing of them.
- **Exact credential match.** A request only counts as gated when its `Authorization` header matches `BASIC_AUTH_USERNAME` / `BASIC_AUTH_PASSWORD` exactly, compared in constant time over fixed-length SHA-256 digests (`rules.ts`, on the helpers in `src/features/auth/basic-auth.ts`). A browser replays that identical header on every request after the 401, so a gated copy is only ever handed back to a visitor already through the gate. The key is the URL under the gated prefix, not the header, so rotating `BASIC_AUTH_PASSWORD` leaves the old copies reachable only by holders of the new password, and the deploy that applies the new secret starts an empty cache anyway.

A hit answers before any gate, so protection changes rest on the purge. Turning **Password protect** on publishes that document and purges its tags, and **Protect entire site** lives on Settings, whose tag every page carries. Between the publish and the purge (the settle wait plus the queue's batch, a few seconds) a public copy of a newly protected page can still be served; the renders after it are checked against the new state.

### The Workers Cache

Tiered: a lower tier in the datacenter nearest the visitor, an upper tier every lower tier asks on a miss, so a page renders once for the whole network rather than once per datacenter, and concurrent misses for one key in a datacenter collapse into one render. Every request is billed as a Worker request, hit or miss; CPU only when the Worker runs.

**A deploy starts an empty cache.** The Workers Cache keys every entry by the Worker version that stored it (`cross_version_cache` stays off), so a release carrying new markup never serves HTML the previous one rendered, and nothing has to sweep the old entries: no version serves them again. The one exception is a rollback: reactivating an old version brings back what it cached while it was live. Roll back by redeploying the older commit, or purge everything right after (**Clearing the whole cache**).

### Purges go through a Queue

The Workers Cache allows **5 purge calls a minute** (a bucket of 25, at most 100 tags per call), on every plan. A burst of publishes would exhaust that, so purges never run inline. `cache.invalidate()` (the provider's `invalidate`) sends the tags, encoded, to the `ROUTE_CACHE_PURGE` Queue; its consumer, the `queue` handler in `src/worker.ts`, gets them in batches of up to 100 messages or 10 seconds, whichever comes first (at most 6 calls a minute in a steady stream, so the bucket lasts), one batch at a time (`max_concurrency: 1`). `consumePurgeBatch()` turns a batch into one call: its tags, deduped, or `purgeEverything` once they would need more than one call or one of them is `route-cache:all`. A call refused for the rate limit, or one that throws, retries the whole batch 30 seconds later (`PURGE_RETRY_SECONDS`), up to 20 times. Purges are scoped to the entrypoint whose cache they empty, so the consumer asks the renderer to run them (`Renderer.purge()`).

## The webhook

`/api/revalidate` (`src/pages/api/revalidate.ts`) checks each delivery in this order, then purges `[_type, doc:<id>, uri]` for the published document:

1. `SANITY_REVALIDATE_SECRET` unset (or only whitespace): `503` with code `unavailable`. The answer never names the variable.
2. The signed timestamp (`t=` in the `sanity-webhook-signature` header) must be at most one hour old and at most one minute in the future. Anything else, a missing or malformed header included, is `401` with code `stale_signature`. See **Replay window** below.
3. The signature is checked over the raw body text before anything parses it, and compared in constant time (`verifyWebhookDelivery` in `src/features/api/webhook-signature.ts`). A mismatch is `401` with code `invalid_signature`, so an unsigned body, JSON or not, only ever gets a `401`.
4. The verified text must be JSON with non-empty string `_id` and `_type` fields and, when present, a `uri` that is a non-empty string or `null`. Anything else, text that is not JSON included, is `400` with code `invalid_payload`.
5. A document whose `_type` starts with `aiTranslation.` (the lease, the daily ledger and the saved result Translate with AI keeps, see [AI translation](../features/ai-translation.md); automatic alt text writes the ledger too, with one language as well) answers `200` with no tags at once: no page renders it, and a run writes several per translation, each of which would otherwise cost the wait, a content version bump and the CDN misses that follow. The translation plugin's `translation.metadata` is not one of them: pages read it for their alternates, so it revalidates like any document.
6. It waits 3 seconds (`CONTENT_LAKE_SETTLE_MS`), because Sanity fires the webhook before every Content Lake replica has the change. Only then is the content version bumped, and then the tags are queued for purging, whether or not the bump held. The answer is `200`, `{ body, tags }` (the validated projection and the tags it queued), or the `500` below when the bump did not hold.

The wait comes before the bump because the bump sends the next gate-state read and the next render to Sanity: before every replica has the publish, either could read the pre-publish content and keep it under the new version, the gate state for its five-minute TTL and a rendered page until the next publish. A bump that fails (the store did not keep it, see **The Sanity CDN** below, or threw) is reported only after the tags are queued, so a broken store never stops content from refreshing; it then answers `500` with code `internal_error` and logs the cause, so Sanity redelivers the publish and the redelivery bumps again. A purge that throws, or any other unexpected failure, answers the same `500`. A delivery that fails a check never waits, bumps or purges anything.

Every answer is JSON with `cache-control: private, no-store`. Errors use the shared `{ error, code, hint? }` body (`src/features/api/errors.ts`, see [OpenAPI](../features/openapi.md#error-shape)) with fixed text, never the original message. The endpoint checks the secret and passes the wait, the bump and the purge to `handleRevalidateDelivery` (`src/features/api/revalidate.ts`), which runs the rest; `src/features/api/revalidate.test.ts` sends signed deliveries through it and checks the order, that a lost bump still queues the purge before answering `500`, the `500` on a throwing purge, that rejected and malformed deliveries and AI translation bookkeeping move nothing, and that `translation.metadata` still does.

Create the webhook once per project at [sanity.io/manage](https://www.sanity.io/manage) (API, Webhooks):

- **URL**: `<your-site>/api/revalidate`
- **Trigger on**: create, update, delete
- **Projection**: `{_id, _type, "uri": uri.current}`
- **Filter**: `!(_id in path("aiTranslation.**"))`, so Sanity never queues the AI translation bookkeeping ahead of a real publish (the endpoint ignores it anyway, but deliveries run one at a time). It matters from launch, not only once a second language is on: automatic alt text counts every description in the daily ledger even with one language
- **Secret**: the value of `SANITY_REVALIDATE_SECRET` set on the Worker

`SANITY_REVALIDATE_SECRET` is optional: skip the webhook entirely and the build still passes. Leave it unset and `/api/revalidate` answers 503. Without it, a published change reaches a cached route only on the next deploy, since a new version starts an empty cache. The same applies once the secret is set but the webhook is not yet registered in Sanity, so setting up the webhook is the step that makes publishing live without a redeploy.

When set, the secret must be at least 32 characters (`openssl rand -hex 32`): `astro.config.mjs` declares it with `min: 32`, so a shorter value fails Astro's env validation at build and dev start. `/api/cache-purge` reuses it as its bearer token, so the floor covers that endpoint too.

### Replay window

`@sanity/webhook` on its own accepts any signed timestamp after 2021 and compares signatures with `!==`. A delivery captured once (from a log, a proxy, a misrouted request) would then replay forever, and every replay bumps the content version and purges its tags: a replayed `site` delivery empties every page. So the route enforces freshness itself, and a captured delivery works for at most one hour after Sanity signed it. The window is wide on purpose: Sanity delivers one request at a time, so a bulk publish can sit queued for minutes. Inside the hour, a replay can only repeat an invalidation that already happened.

If deliveries start failing with `stale_signature`, check the webhook's delivery log in Manage for a backlog older than an hour.

`src/features/api/webhook-signature.test.ts` covers replayed, old, future-dated, malformed, foreign-signed, altered and one-character-off deliveries; `npm test` runs it.

The webhook answers once the tags are queued, not once they are purged; the purge itself reaches every datacenter (see **Purges go through a Queue** above).

## Clearing the whole cache

Publishing is the normal way to refresh content, and a deploy starts an empty cache on its own. `/api/cache-purge` is the escape hatch for the case neither covers: the cache itself looks wrong and you want everything gone without shipping a release.

```bash
curl -X POST -H "Origin: https://<site>" -H "Authorization: Bearer $SANITY_REVALIDATE_SECRET" https://<site>/api/cache-purge
```

It reuses `SANITY_REVALIDATE_SECRET` rather than introducing a second one. Both endpoints do exactly one thing, bust cache, so sharing the secret grants no capability its holder does not already have: anyone with it can already forge a webhook signature and purge by tag. If you ever want them separated, the endpoint reads one env var and nothing else depends on that choice.

Mechanically it is the same `cache.invalidate()` every publish makes, with `ROUTE_CACHE_ALL_TAG` (`route-cache:all`), which every cached response also carries; the queue consumer turns it into one `purgeEverything` call. Gated and public entries go together. It bumps the content version first, so the pages it empties re-render from the live content rather than from what the API CDN held under the old version.

It answers like the webhook, with `cache-control: private, no-store` and the shared error body: `200` `{ purged: "all" }`; `503` with code `unavailable` while the secret is unset; `401` with code `invalid_secret` for a missing or wrong Bearer token (compared in constant time), which purges nothing; and `500` with code `internal_error`, the cause logged, when the bump does not stick or the purge throws. `handleCachePurge` (`src/features/api/cache-purge.ts`) holds that logic, and `src/features/api/cache-purge.test.ts` checks each answer.

One call clears the whole environment, every datacenter, once the queue runs it. A redeploy also empties everything, which remains the guaranteed reset if the endpoint itself is the thing misbehaving.

## The Sanity CDN

Published reads go through Sanity's API CDN in every environment (`src/sanity/lib/client.ts`), and give up after 10 seconds, so a stalled Sanity fails the render in seconds rather than holding the request open (a Worker has no wall-clock cap of its own). A route-cache miss, which after a deploy is every page's first render, reads from the CDN's edge instead of the live API: faster, cheaper (cached CDN responses are not rate limited and sit in the cheap tier; only misses reach the API), and warm across deploys, since the CDN keys on the request rather than on the build.

The CDN is only safe because freshness never depends on it. Sanity invalidates its CDN when content changes, but with no guarantee of when, and the render that follows a publish would store whatever it read for a year. So every published read carries a **content version** as an extra GROQ parameter (`$contentVersion`, which no query uses). The API CDN keys on the full URL, parameters included, and on the POST body for long queries, so a value it has never seen is a miss by construction: that read goes to origin, and every later read under the same version reuses the CDN copy.

The version is one row in D1 (`route_cache_state`, binding `ROUTE_CACHE_DB`, `src/lib/route-cache/d1-version-store.ts`), read and written on the primary, so a bump is seen by the next read in any datacenter, and neither a deploy nor a purge touches it (`src/lib/content-version.ts`, policy in `src/lib/route-cache/content-version.ts`). The table is created on first use, so a new environment needs no migration. It changes in exactly two places:

- `/api/revalidate` bumps it after the settle wait and **before** queueing the document's purge. A render that starts between the two steps then reads the new version; the other order would let it store a CDN-stale page that nothing purges again. Ordering alone does not cover a render already in flight when the publish lands, or a query that joins its render's version read still in flight from before the bump: it read the old content, and it can finish after the purge. So the provider reads its baseline before the render starts, so it is never newer than the version the render's queries carried, and reads again with `readFresh()` (which never joins a read in flight) before marking the response, marking it `no-store` when the version moved. The check and the store are not atomic (the cache stores the response only after it leaves), so it reads fresh once more off the response (`waitUntil`) and queues a purge of the page's path when the version moved in between: that purge runs after the batch wait, so after the cache has the copy.
- `/api/cache-purge` bumps it too, so a suspect cache re-renders from origin rather than from whatever the CDN holds.

A bump writes the new value, then reads it back, and fails when it does not come back: a lost bump that still answered `200` would leave every read on the old version with no retry. The webhook still queues the purge, then answers `500` and Sanity redelivers: until a redelivery bumps, a page that publish purged may re-render from what the CDN holds under the old version, and the redelivery's purge replaces it. `/api/cache-purge` answers `500` on a lost bump without emptying anything, and is simply run again.

Reads of the version are deduped while one is in flight within one render, so a page render that fans out into a dozen queries costs one D1 read, but never memoized and never shared across requests: `createContentVersion()` keys the read in flight by the render's scope (`renderScope` in `src/lib/route-cache/render-scope.ts`, wired in `src/lib/content-version.ts`), and a read outside a render, or in any other request, goes to D1 itself. A Worker cannot wait on I/O another request started: a request left joined to a read that another request started is cancelled by the runtime as hung, with a 500, once the starting request finishes. Only a read already in flight when a bump lands can answer the version from before it, which is why the provider's checks use `readFresh()`.

What it costs: after a publish, each page that publish purges re-renders with every one of its queries missing the CDN once. Pages the publish did not touch stay in the cache and never re-run their queries. After a deploy, every page renders once from the CDN under the unchanged version. Each render the cache may keep also reads the version up to three times (before rendering, before marking, after the response left); a hit reads it never. Draft-mode reads pin `useCdn: false` and carry no version, so editors always read the live API.

## Where caching also exists

- **Gate state reads.** The Basic Auth and agent-Markdown eligibility reads, and the per-language homepage list behind the landing redirect and the language switchers (header menu and footer), query the **live** Sanity API behind a per-isolate hot cache with in-flight dedupe (`src/features/auth/sanity-basic-auth-proxy.ts`, `src/features/agents/markdown-proxy-state.ts`, `src/features/i18n/homepage-locales.ts`, all over `createProxySanityState()` in `src/features/sanity/proxy-state.ts`). That dedupe still joins one Sanity fetch across requests, which the content version stopped doing for the reason above; it has not failed under test, but it is a known risk, and the first suspect if a burst of cold requests answers 500. All three are tied to the content version, so a publish forces a fresh read on the first request after the webhook's settle wait, and a read already in flight from before the bump is never joined by a request that saw the new version; otherwise five minutes plus a 60-second stale-while-revalidate grace is the propagation ceiling. A failed refresh keeps the last state for up to an hour and is retried at most every 10 seconds, and that includes the read a publish forces: protection published during a Sanity outage takes effect when Sanity recovers. With no state at all, pages answer 503. See [Basic Auth](../features/basic-auth.md#the-gate-state).
- **HTTP cache headers.** No route sends a header that lets a shared cache downstream keep a copy (see **The front door** above); `llms.txt` and `sitemap.xml` live only in the Workers Cache. The agent-Markdown serve route sends `public, max-age=0, must-revalidate` plus `Vary: Accept`, so a shared cache never serves the wrong representation.
- **Sanity API CDN.** Published reads use it in every environment, kept fresh by the content version described above. Draft-mode reads and the preview-url handshake pin `useCdn: false`.

## Redirects Are Build-Time

Redirects are fetched in `astro.config.mjs` (`fetchRedirects()`) and baked into the build.

Implications:

- Updating redirects in Sanity does not hot-update a running Worker
- A rebuild and deploy is required for redirect changes to apply: push to `main`, run the deploy workflow by hand (see [CI and deploys](../features/ci.md)), or press **Redeploy site** under the Settings document's **Redirects** field, which starts the workflow through the Studio-gated `/api/redeploy`. See [The Redeploy site button](../deployment.md#the-redeploy-site-button).
