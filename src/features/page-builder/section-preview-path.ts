// The section specimen's path test for the middleware gate and the sitemap (the base path is in `~/sanity/constants`).
// Its own module so both can read it without the preview registry, which reaches for Vite's `import.meta.glob`.

import { canonicalRequestPath } from "~/features/auth/canonical-path";
import { SECTION_PREVIEW_BASE_PATH } from "~/sanity/constants";
import { splitLocalePrefix } from "~/sanity/i18n";

/** Sent on every response under the route, its 401 and 404 included, so nothing indexes or follows it. */
export const SECTION_PREVIEW_ROBOTS = "noindex, nofollow";

/** The route and everything under it, with or without a leading slash, never a path that only starts alike. */
export function isSectionPreviewPath(path: string) {
  const pathname = `/${path.replace(/^\/+/, "")}`;

  return pathname === SECTION_PREVIEW_BASE_PATH || pathname.startsWith(`${SECTION_PREVIEW_BASE_PATH}/`);
}

/** A request path under the route in any spelling or language, so its 401 and 404 answers are covered too. */
export function isSectionPreviewRequestPath(pathname: string) {
  const path = canonicalRequestPath(pathname);

  return isSectionPreviewPath(pathname) || (path !== null && isSectionPreviewPath(splitLocalePrefix(path).pathname));
}
