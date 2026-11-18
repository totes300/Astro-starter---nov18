// The slice of the Workers runtime this app touches, by hand: the generated runtime types are global and
// would retype `Request` and `Response` in the browser code too. The bindings mirror wrangler.jsonc.

interface Env {
  ROUTE_CACHE_DB: import("~/lib/route-cache/d1-version-store").D1Like;
  ROUTE_CACHE_PURGE: import("~/lib/route-cache/purge-queue").PurgeQueue;
}

type PurgeOptions = import("~/lib/route-cache/purge-queue").PurgeOptions;
type PurgeResult = import("~/lib/route-cache/purge-queue").PurgeResult;

type WorkerContext = {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
  readonly exports: {
    Renderer: { fetch(request: Request): Promise<Response>; purge(options: PurgeOptions): Promise<PurgeResult> };
  };
  readonly cache?: { purge(options: PurgeOptions): Promise<PurgeResult> };
};

declare module "cloudflare:workers" {
  export const env: Env;

  export abstract class WorkerEntrypoint<E = Env> {
    protected ctx: WorkerContext;
    protected env: E;
    constructor(ctx: WorkerContext, env: E);
  }
}
