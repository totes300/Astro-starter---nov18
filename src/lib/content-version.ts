// The content version every published read carries (see ./route-cache/content-version.ts), kept in D1 so a
// publish reaches every isolate at once and a deploy does not reset it.

import { env } from "cloudflare:workers";
import { createContentVersion } from "./route-cache/content-version";
import { createD1VersionStore } from "./route-cache/d1-version-store";
import { renderScope } from "./route-cache/render-scope";

export { CONTENT_VERSION_PARAM } from "./route-cache/content-version";

export const contentVersion = createContentVersion(createD1VersionStore(env.ROUTE_CACHE_DB), () => renderScope.getStore());
