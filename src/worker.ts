// The Worker: a front door on every request, and the renderer behind the Workers Cache it forwards cacheable
// reads to. Why two entrypoints: docs/sanity/revalidation-and-caching.md#the-front-door

import { WorkerEntrypoint } from "cloudflare:workers";
import { handle } from "@astrojs/cloudflare/handler";
import { basicAuthorizationHeader } from "~/features/auth/basic-auth";
import { BASIC_AUTH_PASSWORD, BASIC_AUTH_USERNAME } from "~/lib/env";
import { forWorkersCache } from "~/lib/route-cache/create-provider";
import { cachedRender, fromCachedRequest, routeRequest } from "~/lib/route-cache/front-door";
import { consumePurgeBatch, type PurgeBatch, type PurgeOptions, type PurgeResult } from "~/lib/route-cache/purge-queue";

let expectedAuthorization: string | null | undefined;

function getExpectedAuthorization(): string | null {
  expectedAuthorization ??= basicAuthorizationHeader(BASIC_AUTH_USERNAME ?? "", BASIC_AUTH_PASSWORD ?? "");

  return expectedAuthorization;
}

export default {
  fetch(request: Request, env: Env, ctx: WorkerContext): Promise<Response> {
    const route = routeRequest(request, getExpectedAuthorization());

    return route.kind === "cached" ? ctx.exports.Renderer.fetch(route.request) : handle(request, env, ctx);
  },
  queue(batch: PurgeBatch, _env: Env, ctx: WorkerContext): Promise<void> {
    return consumePurgeBatch(batch, (options) => ctx.exports.Renderer.purge(options));
  },
};

/** Only reachable through `ctx.exports`: no route points at it, so its requests are the front door's. */
export class Renderer extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    const forwarded = fromCachedRequest(request);
    const response = await cachedRender.run({ gated: forwarded.gated }, () => handle(forwarded.request, this.env, this.ctx));

    return forWorkersCache(response);
  }

  /** Purges are scoped to the entrypoint whose cache they empty, so they run here. */
  async purge(options: PurgeOptions): Promise<PurgeResult> {
    // Local runs have no Workers Cache; on a deployed Worker this means the entrypoint's cache is off.
    if (!this.ctx.cache) {
      console.warn("route-cache: no Workers Cache on the renderer entrypoint, nothing to purge");

      return { success: true, errors: [] };
    }

    return this.ctx.cache.purge(options);
  }
}
