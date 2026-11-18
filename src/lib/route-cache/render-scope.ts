// What one render tells the route cache about itself, carried by the request's async context rather than its
// `Request`, which a middleware rewrite swaps. The provider reads it only after the whole body is in.

import { AsyncLocalStorage } from "node:async_hooks";
import type { CacheOptions } from "astro";

export type RenderScope = {
  /** The route's cache options, as `setHeaders` hands them over. */
  options?: CacheOptions;
  /** Seconds a render that fell back after a transient upstream failure may be kept, at most. */
  maxTtl?: number;
};

// Module scope, not per provider: the pages and sections that write to it import it too.
export const renderScope = new AsyncLocalStorage<RenderScope>();

/** A render that fell back after a transient upstream failure: stored briefly, so the outage does not outlive itself. */
export function capRouteCacheTtl(seconds: number): void {
  const scope = renderScope.getStore();

  if (scope) {
    scope.maxTtl = Math.min(scope.maxTtl ?? seconds, seconds);
  }
}
