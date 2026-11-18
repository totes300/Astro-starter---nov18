// The whole path a request takes on Cloudflare: the front door, the Workers Cache (faked here: it stores what the
// provider marks and purges by tag) and the provider around the render. These tests are the caching contract.

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { perspectiveCookieName } from "@sanity/preview-url-secret/constants";
import type { CacheOptions, CacheProvider } from "astro";
import { basicAuthorizationHeader } from "~/features/auth/basic-auth";
import { DRAFT_SESSION_COOKIE } from "~/features/auth/draft-session";
import { LOCALE_COOKIE_NAME } from "~/features/i18n/locale";
import { SECTION_PREVIEW_BASE_PATH } from "~/sanity/constants";
import { DEFAULT_LOCALE, IS_I18N_ENABLED, LOCALE_IDS } from "~/sanity/i18n";
import { encodeCacheTags } from "./cache-tags";
import { createContentVersion, createMemoryVersionStore, INITIAL_CONTENT_VERSION } from "./content-version";
import {
  CACHE_TAG,
  CDN_CACHE_CONTROL,
  createRouteCacheProvider,
  forWorkersCache,
  PENDING_CACHE_TAG,
  type RouteCacheDeps,
} from "./create-provider";
import { cachedRender, fromCachedRequest, routeRequest } from "./front-door";
import { purgeOptions, ROUTE_CACHE_ALL_TAG } from "./purge-queue";
import { capRouteCacheTtl } from "./render-scope";

const realDateNow = Date.now;

let now = 1_000_000;

/** Stands in for the content version, which the revalidate webhook bumps before it purges tags. */
let version = "v1";

beforeEach(() => {
  now = 1_000_000;
  version = "v1";
  Date.now = () => now;
});

afterEach(() => {
  Date.now = realDateNow;
});

const AUTH_HEADER = basicAuthorizationHeader("editor", "s3cret") ?? "";

const SECONDARY = LOCALE_IDS.find((id) => id !== DEFAULT_LOCALE) ?? DEFAULT_LOCALE;

const SILENT_LOGGER = { info() {}, warn() {}, error() {} };

/** Stands in for the published Basic Auth state the renderer consults before marking a public copy. */
type Access = { protectedPaths: Set<string>; known: boolean };

const PUBLIC: Access = { protectedPaths: new Set(), known: true };

type Stored = { status: number; headers: [string, string][]; body: Uint8Array; tags: Set<string>; expiresAt: number };

type Pipeline = {
  provider: CacheProvider;
  cache: Map<string, Stored>;
  queued: string[][];
  background: Promise<unknown>[];
  forwarded: Request[];
};

function makePipeline(access: Access = PUBLIC, deps: Partial<RouteCacheDeps> = {}): Pipeline {
  const queued: string[][] = [];

  return {
    provider: createRouteCacheProvider({
      isPublicPath: async (path) => access.known && !access.protectedPaths.has(path),
      contentVersion: { read: async () => version, readFresh: async () => version },
      purge: async (tags) => {
        queued.push(encodeCacheTags(tags));
      },
      ...deps,
    }),
    cache: new Map(),
    queued,
    background: [],
    forwarded: [],
  };
}

/** What the Queue consumer does, against the fake cache. */
async function flushPurges(pipeline: Pipeline): Promise<void> {
  await Promise.all(pipeline.background);

  const options = purgeOptions(pipeline.queued.map((tags) => ({ tags })));

  pipeline.queued.length = 0;

  if (!options) {
    return;
  }

  if ("purgeEverything" in options) {
    pipeline.cache.clear();

    return;
  }

  for (const [key, stored] of pipeline.cache) {
    if (options.tags.some((tag) => stored.tags.has(tag))) {
      pipeline.cache.delete(key);
    }
  }
}

type ServeInput = {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  /** A function renders the body inside the request, so it can read what the page's queries would. */
  body?: string | (() => Promise<string>);
  status?: number;
  responseHeaders?: Record<string, string>;
  options?: CacheOptions | false;
  renders?: { count: number };
  rewriteTo?: string;
  /** Stands in for `Astro.cookies` writes, which reach the headers only after the provider returns. */
  astroCookies?: string[];
  /** Runs inside the render, after its content is read. */
  duringRender?: () => Promise<void>;
  /** Runs while the body streams, after `next()` resolved, the way a section further down the page renders. */
  whileStreaming?: () => void;
};

/** One render through the provider, as Astro's pipeline drives it; `rewriteTo` stands in for the locale rewrite. */
async function render(pipeline: Pipeline, request: Request, input: ServeInput): Promise<Response> {
  const {
    body = "rendered",
    status = 200,
    responseHeaders = {},
    options = { maxAge: 60, tags: ["page", "doc:about"] },
    renders,
    rewriteTo,
    astroCookies,
    duringRender,
    whileStreaming,
  } = input;
  const renderedRequest = rewriteTo ? new Request(rewriteTo, request) : request;

  const next = async () => {
    if (renders) {
      renders.count++;
    }

    await duringRender?.();

    if (options !== false) {
      pipeline.provider.setHeaders?.(options, renderedRequest);
    }

    const text = typeof body === "string" ? body : await body();
    const streamed = whileStreaming
      ? new ReadableStream<Uint8Array>({
          async pull(controller) {
            await new Promise((resolve) => setTimeout(resolve, 0));
            whileStreaming();
            controller.enqueue(new TextEncoder().encode(text));
            controller.close();
          },
        })
      : null;
    const response = new Response(streamed ?? text, { status, headers: responseHeaders });

    if (astroCookies) {
      Reflect.set(response, Symbol.for("astro.cookies"), {
        *headers() {
          yield* astroCookies;
        },
      });
    }

    return response;
  };

  const onRequest = pipeline.provider.onRequest;

  assert.ok(onRequest);

  return onRequest(
    {
      request,
      url: new URL(request.url),
      logger: SILENT_LOGGER,
      waitUntil: (promise) => {
        pipeline.background.push(promise);
      },
    },
    next
  );
}

function cdnMaxAge(response: Response): number | null {
  const match = response.headers.get(CDN_CACHE_CONTROL)?.match(/^public, max-age=(\d+)/);

  return match ? Number(match[1]) : null;
}

/** Answers with `cf-cache-status` as Cloudflare would: DYNAMIC off the cache, else HIT, MISS (stored) or BYPASS. */
async function serve(pipeline: Pipeline, input: ServeInput = {}): Promise<Response> {
  const { url = "https://example.com/about", method = "GET", headers = {} } = input;
  const request = new Request(url, { method, headers });
  const route = routeRequest(request, AUTH_HEADER);

  if (route.kind === "render") {
    const rendered = await render(pipeline, request, input);

    rendered.headers.set("cf-cache-status", "DYNAMIC");

    return rendered;
  }

  pipeline.forwarded.push(route.request);

  const key = route.request.url;
  const stored = pipeline.cache.get(key);

  if (stored && now < stored.expiresAt) {
    const hit = new Response(stored.body.slice(), { status: stored.status, headers: stored.headers });

    hit.headers.set("cf-cache-status", "HIT");

    return hit;
  }

  const forwarded = fromCachedRequest(route.request);
  const response = forWorkersCache(
    await cachedRender.run({ gated: forwarded.gated }, () => render(pipeline, forwarded.request, input))
  );
  const maxAge = cdnMaxAge(response);

  if (maxAge === null) {
    response.headers.set("cf-cache-status", "BYPASS");

    return response;
  }

  const body = new Uint8Array(await response.arrayBuffer());
  const tags = new Set((response.headers.get(CACHE_TAG) ?? "").split(",").map((tag) => tag.toLowerCase()));
  const kept = [...response.headers].filter(([name]) => ![CDN_CACHE_CONTROL, CACHE_TAG].some((n) => n.toLowerCase() === name));

  pipeline.cache.set(key, { status: response.status, headers: kept, body, tags, expiresAt: now + maxAge * 1000 });

  const miss = new Response(body, { status: response.status, headers: kept });

  miss.headers.set("cf-cache-status", "MISS");

  return miss;
}

const status = (response: Response) => response.headers.get("cf-cache-status");

test("caches out of the box: the first request renders and is stored, the second never reaches the Worker", async () => {
  const pipeline = makePipeline();
  const renders = { count: 0 };

  const first = await serve(pipeline, { renders, body: "v1" });

  assert.equal(status(first), "MISS");
  assert.equal(await first.text(), "v1");

  const second = await serve(pipeline, { renders, body: "v2 (must not render)" });

  assert.equal(status(second), "HIT");
  assert.equal(await second.text(), "v1");
  assert.equal(renders.count, 1);
});

test("the renderer sees one canonical request: no cookies, one Accept, credentials only when gated", async () => {
  const pipeline = makePipeline();

  await serve(pipeline, {
    url: "https://example.com//about/?utm_source=x",
    headers: { cookie: "theme=dark", accept: "text/html", "accept-language": "de" },
  });
  await serve(pipeline, { headers: { authorization: AUTH_HEADER } });

  const [anonymous, gated] = pipeline.forwarded;

  assert.equal(anonymous?.url, "https://example.com/about");
  assert.equal(anonymous?.headers.has("cookie"), false);
  assert.equal(anonymous?.headers.has("accept-language"), false);
  assert.equal(anonymous?.headers.has("authorization"), false);
  assert.equal(gated?.url, "https://example.com/__gated/about");
  assert.equal(gated?.headers.get("authorization"), AUTH_HEADER);
  assert.equal(anonymous?.redirect, "manual", "a redirect comes back as one, never followed into another page");
});

test("a cached response carries its tags, the page's path and the purge-all tag, never a Vary", async () => {
  const pipeline = makePipeline();
  const request = routeRequest(new Request("https://example.com/%C3%BCber-uns"), AUTH_HEADER);

  assert.equal(request.kind, "cached");

  const forwarded = fromCachedRequest(request.request);
  const response = forWorkersCache(
    await cachedRender.run({ gated: false }, () =>
      render(pipeline, forwarded.request, { options: { maxAge: 60, tags: ["page", "doc:uber", "/über-uns"] } })
    )
  );

  assert.equal(response.headers.get(CDN_CACHE_CONTROL), "public, max-age=60, stale-if-error=86400");
  assert.equal(
    response.headers.get(CACHE_TAG),
    "page,doc:uber,/%C3%BCber-uns,astro-path:/%C3%BCber-uns,route-cache:all",
    "a non-ASCII tag is percent-encoded rather than dropped"
  );
  assert.equal(response.headers.has(PENDING_CACHE_TAG), false, "the stand-in header never reaches the cache or a visitor");
  assert.equal(response.headers.has("vary"), false);
});

test("a page the middleware rewrote is stored under the URL the visitor asked for", async () => {
  const pipeline = makePipeline();
  const renders = { count: 0 };
  const localized = { renders, url: `https://example.com/${SECONDARY}/blog/post`, rewriteTo: "https://example.com/blog/post" };

  await serve(pipeline, { ...localized, body: "localized" });

  const second = await serve(pipeline, { ...localized, body: "must not render" });
  const original = await serve(pipeline, { renders, url: "https://example.com/blog/post", body: "en" });

  assert.equal(status(second), "HIT");
  assert.equal(await second.text(), "localized");
  assert.equal(await original.text(), "en");
  assert.equal(renders.count, 2);
});

test("past the TTL the entry is gone and the next request renders fresh", async () => {
  const pipeline = makePipeline();
  const renders = { count: 0 };

  await serve(pipeline, { renders, body: "old" });

  now += 61_000;

  const response = await serve(pipeline, { renders, body: "new" });

  assert.equal(status(response), "MISS");
  assert.equal(await response.text(), "new");
});

test("the webhook path: invalidating a tag or a path purges the entry once the queue runs", async () => {
  const pipeline = makePipeline();

  await serve(pipeline, { url: "https://example.com/about" });
  await serve(pipeline, { url: "https://example.com/blog/post", options: { maxAge: 60, tags: ["article"] } });

  await pipeline.provider.invalidate({ tags: ["doc:about"] });
  await pipeline.provider.invalidate({ path: "/blog/post" });

  assert.equal(status(await serve(pipeline)), "HIT", "a purge is queued, not run inline");

  await flushPurges(pipeline);

  assert.equal(status(await serve(pipeline, { url: "https://example.com/about" })), "MISS");
  assert.equal(status(await serve(pipeline, { url: "https://example.com/blog/post" })), "MISS");
});

test("invalidating a path reaches the entry stored from an encoded spelling of it", async () => {
  const pipeline = makePipeline();

  await serve(pipeline, { url: "https://example.com/%C3%BCber-uns" });
  await pipeline.provider.invalidate({ path: "/über-uns" });
  await flushPurges(pipeline);

  assert.equal(status(await serve(pipeline, { url: "https://example.com/über-uns" })), "MISS");
});

test("gated and public entries never mix", async () => {
  const pipeline = makePipeline();

  await serve(pipeline, { body: "secret page", headers: { authorization: AUTH_HEADER } });

  const anonymous = await serve(pipeline, { body: "public render" });

  assert.equal(status(anonymous), "MISS");
  assert.equal(await anonymous.text(), "public render");

  const gated = await serve(pipeline, { body: "unused", headers: { authorization: AUTH_HEADER } });

  assert.equal(status(gated), "HIT");
  assert.equal(await gated.text(), "secret page");
});

test("a gated key cannot be asked for from outside: the front door renders it like any unknown path", async () => {
  const pipeline = makePipeline();

  await serve(pipeline, { body: "secret page", headers: { authorization: AUTH_HEADER } });

  const forged = await serve(pipeline, { url: "https://example.com/__gated/about", body: "not found", status: 404 });

  assert.equal(status(forged), "DYNAMIC");
  assert.equal(await forged.text(), "not found");
});

test("credentials that match nothing never reach the cache", async () => {
  const pipeline = makePipeline();
  const renders = { count: 0 };
  const headers = { authorization: `Basic ${btoa("editor:wrong")}` };

  await serve(pipeline, { renders, headers });

  assert.equal(status(await serve(pipeline, { renders, headers })), "DYNAMIC");
  assert.equal(renders.count, 2);
});

test("draft mode, Markdown negotiation, HEAD and writes never reach the cache", async () => {
  const pipeline = makePipeline();
  const renders = { count: 0 };

  const inputs: ServeInput[] = [
    { headers: { cookie: `${perspectiveCookieName}=drafts` } },
    { headers: { cookie: `${DRAFT_SESSION_COOKIE}=1700000000.signature` } },
    { headers: { accept: "text/markdown" } },
    { method: "HEAD" },
    { method: "POST" },
  ];

  for (const input of inputs) {
    assert.equal(status(await serve(pipeline, { renders, ...input })), "DYNAMIC");
  }

  assert.equal(renders.count, 5);
  assert.equal(pipeline.forwarded.length, 0);
});

test("responses that must not be stored are marked no-store, so the cache's own heuristics never keep them", async () => {
  const pipeline = makePipeline();
  const renders = { count: 0 };

  for (const input of [
    { status: 404, url: "https://example.com/missing" },
    { responseHeaders: { "set-cookie": "session=1" }, url: "https://example.com/personal" },
    { astroCookies: ["session=1; Path=/"], url: "https://example.com/cookie" },
    { options: false as const, url: "https://example.com/uncached" },
    { body: "x".repeat(1_000_001), url: "https://example.com/huge" },
  ]) {
    const first = await serve(pipeline, { renders, ...input });

    assert.equal(first.headers.get(CDN_CACHE_CONTROL), "no-store", input.url);
    assert.equal(status(await serve(pipeline, { renders, ...input })), "BYPASS", input.url);
  }

  assert.equal(renders.count, 10);
});

test("purging everything empties public and gated entries alike", async () => {
  const pipeline = makePipeline();

  await serve(pipeline, { url: "https://example.com/about" });
  await serve(pipeline, { url: "https://example.com/contact" });
  await serve(pipeline, { headers: { authorization: AUTH_HEADER } });

  await pipeline.provider.invalidate({ tags: [ROUTE_CACHE_ALL_TAG] });
  await flushPurges(pipeline);

  assert.equal(pipeline.cache.size, 0);
});

test("a render under protection is never marked public, while gated traffic still caches", async () => {
  const access: Access = { protectedPaths: new Set(["/about"]), known: true };
  const pipeline = makePipeline(access);

  assert.equal(status(await serve(pipeline, { body: "401 from the gate", status: 401 })), "BYPASS");
  assert.equal(status(await serve(pipeline, { body: "rendered while protected" })), "BYPASS");

  await serve(pipeline, { headers: { authorization: AUTH_HEADER } });

  assert.equal(status(await serve(pipeline, { headers: { authorization: AUTH_HEADER } })), "HIT");
});

test("an unknown Basic Auth state marks nothing public", async () => {
  const pipeline = makePipeline({ protectedPaths: new Set(), known: false });

  await serve(pipeline);

  assert.equal(status(await serve(pipeline)), "BYPASS");
});

test("the state is checked on the canonical page path, so a Unicode or file spelling cannot dodge it", async () => {
  const pipeline = makePipeline({ protectedPaths: new Set(["/über-uns", "/secret", "/", `/${SECONDARY}/secret`]), known: true });
  const renders = { count: 0 };

  for (const url of [
    "https://example.com/%C3%BCber-uns",
    "https://example.com/u%CC%88ber-uns",
    "https://example.com/secret.html",
    "https://example.com/index.html",
    `https://example.com/${SECONDARY}/secret.html`,
    `https://example.com/${SECONDARY}/%73ecret/`,
    "https://example.com/se%09cret",
    "https://example.com/se%0Acret",
  ]) {
    await serve(pipeline, { renders, url });
    await serve(pipeline, { renders, url });
  }

  assert.equal(renders.count, 16);
});

test("a rewritten page is gated as the URL the visitor asked for, never the folder it renders from", async () => {
  const asked: string[] = [];
  const protectedPath = `/${SECONDARY}/blog/post`;
  const pipeline = makePipeline(PUBLIC, {
    isPublicPath: async (path) => {
      asked.push(path);

      return path !== protectedPath;
    },
  });
  const localized = { url: `https://example.com${protectedPath}`, rewriteTo: "https://example.com/blog/post" };

  await serve(pipeline, localized);

  assert.equal(status(await serve(pipeline, localized)), "BYPASS");
  assert.deepEqual([...new Set(asked)], [protectedPath]);
});

test("the section preview is never cached as public, whatever the CMS state says", async () => {
  const pipeline = makePipeline(PUBLIC);
  const renders = { count: 0 };
  const prefixed = IS_I18N_ENABLED ? [`https://example.com/${SECONDARY}${SECTION_PREVIEW_BASE_PATH}/hero`] : [];
  const urls = [`https://example.com${SECTION_PREVIEW_BASE_PATH}/hero`, ...prefixed];

  for (const url of urls) {
    await serve(pipeline, { renders, url });
    assert.equal(status(await serve(pipeline, { renders, url })), "DYNAMIC", url);
  }

  const gated = { url: `https://example.com${SECTION_PREVIEW_BASE_PATH}/hero`, headers: { authorization: AUTH_HEADER } };

  await serve(pipeline, gated);

  assert.equal(status(await serve(pipeline, gated)), "HIT", "an exact credential match may still cache");
});

test("spellings the router renders as one page share its entry; a file spelling or a bad path never reads it", async () => {
  const pipeline = makePipeline();
  const renders = { count: 0 };

  await serve(pipeline, { renders, body: "about" });

  for (const url of [
    "https://example.com//about",
    "https://example.com/ab%6fut",
    "https://example.com/about/",
    "https://example.com/about?utm_source=x",
  ]) {
    const hit = await serve(pipeline, { renders, url });

    assert.equal(status(hit), "HIT", url);
    assert.equal(await hit.text(), "about", url);
  }

  const html = await serve(pipeline, { renders, url: "https://example.com/about.html", status: 404, body: "not found" });

  assert.equal(await html.text(), "not found");

  const encoded = await serve(pipeline, { renders, url: "https://example.com/about%2Fx", status: 400, body: "bad request" });

  assert.equal(status(encoded), "DYNAMIC");
  assert.equal(renders.count, 3);
});

test("only the parameters a route reads key an entry; any other renders and never reaches the cache", async () => {
  const pipeline = makePipeline();
  const renders = { count: 0 };
  const many = Array.from({ length: 17 }, (_, index) => `p${index}=1`).join("&");

  for (const url of [
    "https://example.com/?x=1",
    "https://example.com/blog?page=2",
    "https://example.com/about?q=a",
    `https://example.com/?${many}`,
  ]) {
    assert.equal(status(await serve(pipeline, { renders, url })), "DYNAMIC", url);
  }

  await serve(pipeline, { url: "https://example.com/blog?category=a&category=b" });

  const filtered = await serve(pipeline, { url: "https://example.com/blog?category=b&category=a&utm_source=x" });

  assert.equal(status(filtered), "HIT");
});

test("a prefixed blog index keys the category its route reads, like the default language's", {
  skip: !IS_I18N_ENABLED,
}, async () => {
  const pipeline = makePipeline();
  const renders = { count: 0 };
  const filtered = { renders, rewriteTo: "https://example.com/blog?category=a" };

  await serve(pipeline, { ...filtered, url: `https://example.com/${SECONDARY}/blog?category=a` });

  const second = await serve(pipeline, { ...filtered, url: `https://example.com/${SECONDARY}/blog/?category=a&utm_source=x` });

  assert.equal(status(second), "HIT");
  assert.equal(renders.count, 1);
});

test("a render that straddles a publish is not stored, so the purge it missed cannot leave its HTML behind", async () => {
  const pipeline = makePipeline();

  const straddled = await serve(pipeline, {
    body: "pre-publish",
    duringRender: async () => {
      version = "v2";
      await pipeline.provider.invalidate({ tags: ["doc:about"] });
    },
  });

  assert.equal(status(straddled), "BYPASS");
  assert.equal(await straddled.text(), "pre-publish");

  await flushPurges(pipeline);

  const after = await serve(pipeline, { body: "post-publish" });

  assert.equal(status(after), "MISS");
  assert.equal(await after.text(), "post-publish");
});

test("a publish that lands after the check is caught once the response left, and its path is purged", async () => {
  let reads = 0;
  const pipeline = makePipeline(PUBLIC, {
    contentVersion: {
      read: async () => version,
      readFresh: async () => {
        reads += 1;

        // The check before marking still sees v1; the publish lands before the one after it.
        if (reads === 2) {
          version = "v2";
        }

        return version;
      },
    },
  });

  assert.equal(status(await serve(pipeline, { body: "pre-publish" })), "MISS");

  await flushPurges(pipeline);

  const after = await serve(pipeline, { body: "post-publish" });

  assert.equal(await after.text(), "post-publish");
});

test("an unreadable content version marks nothing, since a straddled render could not be told apart", async () => {
  const down = async (): Promise<string> => {
    throw new Error("version store down");
  };
  const pipeline = makePipeline(PUBLIC, { contentVersion: { read: down, readFresh: down } });

  await serve(pipeline);

  assert.equal(status(await serve(pipeline)), "BYPASS");
});

test("a version read in flight across a publish never lets a pre-publish render be stored", async () => {
  const inner = createMemoryVersionStore();
  let releaseHeldRead: (() => void) | undefined;
  let reads = 0;
  const contentVersion = createContentVersion({
    async get() {
      reads += 1;

      const value = await inner.get();

      // Holds the first read in flight with the pre-publish value, the way a slow store read would.
      if (reads === 1) {
        await new Promise<void>((resolve) => {
          releaseHeldRead = resolve;
        });
      }

      return value;
    },
    set: inner.set,
  });
  const pipeline = makePipeline(PUBLIC, { contentVersion });
  const body = async () => ((await contentVersion.read()) === INITIAL_CONTENT_VERSION ? "pre-publish" : "post-publish");

  const heldRead = contentVersion.read();

  await contentVersion.bump();
  await pipeline.provider.invalidate({ tags: ["doc:about"] });

  const straddled = serve(pipeline, { body });

  await new Promise((resolve) => setImmediate(resolve));
  releaseHeldRead?.();

  assert.equal(await heldRead, INITIAL_CONTENT_VERSION);
  await straddled;
  await flushPurges(pipeline);

  assert.equal(await (await serve(pipeline, { body })).text(), "post-publish");
});

test("a render that fell back after an upstream failure is kept only as long as it asked", async () => {
  const pipeline = makePipeline();
  const options = { maxAge: 31536000, tags: ["page"] };

  const placeholder = await serve(pipeline, { options, body: "placeholder", whileStreaming: () => capRouteCacheTtl(60) });

  assert.equal(status(placeholder), "MISS");
  assert.equal(status(await serve(pipeline, { options })), "HIT");

  now += 61_000;

  const later = await serve(pipeline, { options, body: "form" });

  assert.equal(await later.text(), "form");
});

test("a first visit to / that the middleware may send to its language never reaches the cache", {
  skip: !IS_I18N_ENABLED,
}, async () => {
  const pipeline = makePipeline();
  const home = { url: "https://example.com/", headers: { accept: "text/html", "accept-language": SECONDARY } };

  assert.equal(status(await serve(pipeline, home)), "DYNAMIC");
  assert.equal(
    status(
      await serve(pipeline, { ...home, headers: { accept: "*/*", "accept-language": SECONDARY, "sec-purpose": "prefetch" } })
    ),
    "DYNAMIC",
    "a hover prefetch is a first visit too, so the browser never keeps a cached / for the click"
  );
  assert.equal(
    status(await serve(pipeline, { ...home, headers: { ...home.headers, cookie: `${LOCALE_COOKIE_NAME}=${DEFAULT_LOCALE}` } })),
    "MISS"
  );
});

test("a panel partial is marked public only while the page it renders is", async () => {
  const access: Access = { protectedPaths: new Set(["/blog/authors/ada"]), known: true };
  const pipeline = makePipeline(access);
  const panel = { url: "https://example.com/blog/authors/ada/modal" };

  await serve(pipeline, { ...panel, body: "rendered while its page is protected" });
  assert.equal(status(await serve(pipeline, panel)), "BYPASS");

  access.protectedPaths.clear();
  await serve(pipeline, { ...panel, body: "panel" });
  assert.equal(status(await serve(pipeline, panel)), "HIT");

  const prefixed = { url: `https://example.com/${SECONDARY}/blog/authors/ada/modal` };

  access.protectedPaths.add(`/${SECONDARY}/blog/authors/ada`);
  await serve(pipeline, { ...prefixed, body: "rendered while its page is protected" });
  assert.equal(status(await serve(pipeline, prefixed)), "BYPASS");
});

test("a renderer response that sets cookies keeps them pending for Astro, though it is marked no-store", async () => {
  const pipeline = makePipeline();
  const request = routeRequest(new Request("https://example.com/api/draft-mode/disable"), AUTH_HEADER);

  assert.equal(request.kind, "cached");

  const forwarded = fromCachedRequest(request.request);
  const response = await cachedRender.run({ gated: false }, () =>
    render(pipeline, forwarded.request, { status: 307, astroCookies: ["__draft_session=; Max-Age=0"] })
  );

  assert.equal(response.headers.get(CDN_CACHE_CONTROL), "no-store");
  assert.ok(Reflect.get(response, Symbol.for("astro.cookies")), "the pending cookies survive the marking");
});

test("the marking survives immutable headers, pending cookies included", async () => {
  const pipeline = makePipeline();
  const frozen = new Response("asset", { status: 200 });

  Reflect.set(frozen, Symbol.for("astro.cookies"), { headers: () => [][Symbol.iterator]() });
  Object.defineProperty(frozen.headers, "set", {
    value: () => {
      throw new TypeError("immutable");
    },
  });

  const forwarded = fromCachedRequest(new Request("https://example.com/_astro/x.js"));
  const response = await cachedRender.run({ gated: false }, () =>
    render(pipeline, forwarded.request, { options: false, body: "unused" }).then(() => forWorkersCache(frozen))
  );

  assert.notEqual(response, frozen);
  assert.equal(response.headers.get(CDN_CACHE_CONTROL), "no-store");
  assert.ok(Reflect.get(response, Symbol.for("astro.cookies")));
});

test("a renderer answer the provider never saw, a redirect or an asset, leaves marked no-store", () => {
  const redirect = forWorkersCache(new Response(null, { status: 301, headers: { location: "/new" } }));

  assert.equal(redirect.headers.get(CDN_CACHE_CONTROL), "no-store");

  const marked = forWorkersCache(new Response("x", { headers: { [CDN_CACHE_CONTROL]: "public, max-age=60" } }));

  assert.equal(marked.headers.get(CDN_CACHE_CONTROL), "public, max-age=60");
  assert.equal(marked.headers.has(CACHE_TAG), false);
});

test("the front door's own renders are marked no-store too, in case the entrypoint's cache is ever on", async () => {
  const pipeline = makePipeline();
  const response = await serve(pipeline, { method: "POST" });

  assert.equal(response.headers.get(CDN_CACHE_CONTROL), "no-store");
});
