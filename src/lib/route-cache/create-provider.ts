// The route cache policy: which renders the Workers Cache may keep, under which tags, and how a tag is purged.
// The gate state, the content version and the purge are injected, so it is tested the same as it runs.

import type { CacheProvider } from "astro";
import { collectInvalidationTags, pathTag } from "astro/cache/provider-utils";
import { canonicalRequestPath, decodeRequestPath } from "~/features/auth/canonical-path";
import { panelHostPath } from "~/features/auth/request-gate";
import { isSectionPreviewRequestPath } from "~/features/page-builder/section-preview-path";
import { cacheTagHeader } from "./cache-tags";
import type { ContentVersion } from "./content-version";
import { ENTRY_MAX_BYTES, entryTtl } from "./entry";
import { cachedRender } from "./front-door";
import { ROUTE_CACHE_ALL_TAG } from "./purge-queue";
import { type RenderScope, renderScope } from "./render-scope";

/** Read by the Workers Cache before `Cache-Control`, and stripped before the response leaves Cloudflare. */
export const CDN_CACHE_CONTROL = "Cloudflare-CDN-Cache-Control";

export const CACHE_TAG = "Cache-Tag";

/** Astro deletes `Cache-Tag` from a runtime provider's answer, so the tags reach the renderer entrypoint under this. */
export const PENDING_CACHE_TAG = "X-Route-Cache-Tag";

/** A short entry (the fallback renders, `robots.txt`) outlives an outage of the render behind it by this much. */
const STALE_IF_ERROR_SECONDS = 86_400;

export type RouteCacheDeps = {
  /** True only when the published Basic Auth state is known and leaves this canonical page path open to anyone. */
  isPublicPath: (path: string) => Promise<boolean>;
  /** `read` for the baseline, never newer than what the render's queries join; `readFresh` for the checks after. */
  contentVersion: Pick<ContentVersion, "read" | "readFresh">;
  /** Queues a purge of these tags; resolves once it is queued, not once it ran. */
  purge: (tags: string[]) => Promise<void>;
};

// Astro keeps a response's pending `Astro.cookies` writes on this property; a rebuilt response has to carry it over.
const ASTRO_COOKIES = Symbol.for("astro.cookies");

/** In place where the headers allow it; a rebuilt response (immutable headers) keeps the pending cookies. */
function withHeaders(response: Response, headers: Record<string, string>): Response {
  try {
    for (const [name, value] of Object.entries(headers)) {
      response.headers.set(name, value);
    }

    return response;
  } catch {
    const target = new Response(response.body, response);
    const cookies = Reflect.get(response, ASTRO_COOKIES);

    if (cookies !== undefined) {
      Reflect.set(target, ASTRO_COOKIES, cookies);
    }

    for (const [name, value] of Object.entries(headers)) {
      target.headers.set(name, value);
    }

    return target;
  }
}

/** Explicit, because the Workers Cache keeps an unmarked `200` for two hours by its own heuristics. */
function notStored(response: Response): Response {
  return withHeaders(response, { [CDN_CACHE_CONTROL]: "no-store" });
}

export function createRouteCacheProvider({ isPublicPath, contentVersion, purge }: RouteCacheDeps): CacheProvider {
  return {
    name: "route-cache",
    invalidate: (options) => purge(collectInvalidationTags(options)),
    setHeaders(options) {
      // The request's async context, not its `Request`: a middleware rewrite swaps the Request before this runs.
      const scope = renderScope.getStore();

      if (scope) {
        scope.options = options;
      }

      return new Headers();
    },
    async onRequest(context, next) {
      const cached = cachedRender.getStore();

      // The front door's own renders sit behind no cache; marked anyway, so a misconfigured entrypoint stores nothing.
      if (!cached) {
        return notStored(await next());
      }

      const { url, waitUntil } = context;
      const entryPath = decodeRequestPath(url.pathname);
      const gatePath = canonicalRequestPath(url.pathname);

      if (entryPath === null || gatePath === null) {
        return notStored(await next());
      }

      const isPublic = (path: string) => isPublicPath(path).catch(() => false);
      // The route is unknown here, so a path a panel partial could serve also needs the page it renders to be open.
      const hostPath = panelHostPath(gatePath);
      // A cached copy answers before any gate: public only while the state says so, never the section preview.
      const isServable = async () =>
        cached.gated ||
        (!isSectionPreviewRequestPath(gatePath) &&
          (await isPublic(gatePath)) &&
          (hostPath === gatePath || (await isPublic(hostPath))));
      const renderedUnder = await contentVersion.read().catch(() => null);
      const versionNow = () => contentVersion.readFresh().catch(() => null);
      const scope: RenderScope = {};
      const response = await renderScope.run(scope, next);
      const { options } = scope;
      const ttl = entryTtl(response, options);

      if (ttl === null || renderedUnder === null || !(await isServable())) {
        return notStored(response);
      }

      // Read only once the body is in: a section that falls back renders while it streams.
      const body = await response.arrayBuffer();
      const rendered = new Response(body, response);
      const tags = cacheTagHeader([...(options?.tags ?? []), pathTag(entryPath), ROUTE_CACHE_ALL_TAG]);

      // A moved version means a publish landed mid-render, and its purge may already have run.
      if (body.byteLength > ENTRY_MAX_BYTES || tags === null || (await versionNow()) !== renderedUnder) {
        return notStored(rendered);
      }

      // The cache stores this only after it leaves, so a publish that bumps from here on is purged once it has.
      waitUntil?.(
        versionNow()
          .then((version) => (version === renderedUnder ? undefined : purge([pathTag(entryPath)])))
          .catch((error: unknown) => {
            console.error("route-cache: the purge after a straddled publish failed", error);
          })
      );

      const lifetime = Math.min(ttl, scope.maxTtl ?? ttl);

      return withHeaders(rendered, {
        [CDN_CACHE_CONTROL]: `public, max-age=${lifetime}, stale-if-error=${STALE_IF_ERROR_SECONDS}`,
        [PENDING_CACHE_TAG]: tags,
      });
    },
  };
}

/** The renderer entrypoint's last step: the tags under the name the Workers Cache reads, and `no-store` on anything unmarked. */
export function forWorkersCache(response: Response): Response {
  const tags = response.headers.get(PENDING_CACHE_TAG);

  // A redirect route or a static asset answers before the provider; the cache's own heuristics must not keep it.
  if (tags === null) {
    return response.headers.has(CDN_CACHE_CONTROL) ? response : notStored(response);
  }

  const target = withHeaders(response, { [CACHE_TAG]: tags });

  target.headers.delete(PENDING_CACHE_TAG);

  return target;
}
