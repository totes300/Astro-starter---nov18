// Route cache provider (wired in astro.config.mjs): the policy in ./create-provider.ts, with the gate state,
// the content version in D1 and the purge Queue. See docs/sanity/revalidation-and-caching.md

import { env } from "cloudflare:workers";
import type { CacheProviderFactory } from "astro";
import { isPublicPath } from "~/features/auth/sanity-basic-auth-proxy";
import { contentVersion } from "~/lib/content-version";
import { createRouteCacheProvider } from "./create-provider";
import { enqueuePurge } from "./purge-queue";

const factory: CacheProviderFactory = () =>
  createRouteCacheProvider({
    isPublicPath,
    contentVersion,
    purge: (tags) => enqueuePurge(env.ROUTE_CACHE_PURGE, tags),
  });

export default factory;
