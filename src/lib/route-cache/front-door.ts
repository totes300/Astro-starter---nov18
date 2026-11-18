// The Worker's front door: which requests the Workers Cache may answer, decided on every request and before
// the cache sees them, so it reads no state. See docs/sanity/revalidation-and-caching.md#the-front-door

import { AsyncLocalStorage } from "node:async_hooks";
import { canonicalRequestPath } from "~/features/auth/canonical-path";
import { landingLocale } from "~/features/i18n/locale";
import { isSectionPreviewRequestPath } from "~/features/page-builder/section-preview-path";
import { entryTarget } from "./entry";
import { isAuthenticatedRequest, shouldBypassCache } from "./rules";

/** Keys gated renders apart from public ones; only the front door adds it, after the credentials matched. */
export const GATED_KEY_PREFIX = "/__gated";

/** The one `Accept` a cached render sees, so no browser's own spelling becomes part of what it renders. */
const CANONICAL_ACCEPT = "text/html,application/xhtml+xml,*/*;q=0.8";

export type FrontDoorRoute = { kind: "render" } | { kind: "cached"; request: Request };

/** What the renderer entrypoint tells the provider about the render it wraps; absent outside the cache. */
export type CachedRender = { gated: boolean };

export const cachedRender = new AsyncLocalStorage<CachedRender>();

/** `cached` hands the renderer a canonical request: the key spelled once, no cookies, the credentials only when gated. */
export function routeRequest(request: Request, expectedAuthorization: string | null): FrontDoorRoute {
  const url = new URL(request.url);

  // GET only, as a missed HEAD would store an empty page; the middleware decides drafts, Markdown and the language redirect.
  if (request.method !== "GET" || shouldBypassCache(request) || landingLocale(request) !== null) {
    return { kind: "render" };
  }

  const gated = isAuthenticatedRequest(request, expectedAuthorization);
  const target = entryTarget(url);
  const gatePath = canonicalRequestPath(url.pathname);

  if ((!gated && request.headers.has("authorization")) || target === null || gatePath === null) {
    return { kind: "render" };
  }

  // Never public, in any spelling: the env credentials gate it, and the CMS state the renderer checks knows nothing of them.
  if ((!gated && isSectionPreviewRequestPath(gatePath)) || target.path.startsWith(GATED_KEY_PREFIX)) {
    return { kind: "render" };
  }

  // The setter, not a string: a decoded `?` or `#` in the path stays in the path.
  const cachedUrl = new URL(url.origin);
  cachedUrl.pathname = `${gated ? GATED_KEY_PREFIX : ""}${target.path}`;
  cachedUrl.search = target.query;

  const headers = new Headers({ accept: CANONICAL_ACCEPT });
  const authorization = request.headers.get("authorization");

  if (gated && authorization) {
    headers.set("authorization", authorization);
  }

  // `manual`: a fetch through `ctx.exports` follows redirects, which would store the target's page under this key.
  return { kind: "cached", request: new Request(cachedUrl, { headers, redirect: "manual" }) };
}

/** The renderer's half: the request Astro renders, and whether its render is gated. */
export function fromCachedRequest(request: Request): { request: Request; gated: boolean } {
  const url = new URL(request.url);
  const gated = url.pathname === GATED_KEY_PREFIX || url.pathname.startsWith(`${GATED_KEY_PREFIX}/`);

  if (!gated) {
    return { request, gated };
  }

  url.pathname = url.pathname.slice(GATED_KEY_PREFIX.length) || "/";

  return { request: new Request(url, request), gated };
}
