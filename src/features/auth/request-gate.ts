// What `src/middleware.ts` decides before any Basic Auth state is read. Locale routing rewrites the request
// between its two checks, so the spelling is judged as sent and the page after. Pure, so every bypass is tested.

import { canonicalRequestPath, isPageAliasSpelling } from "~/features/auth/canonical-path";
import { isExcludedPath } from "~/features/auth/excluded-paths";
import { isSectionPreviewPath, isSectionPreviewRequestPath } from "~/features/page-builder/section-preview-path";
import { decodePathname, normalizePathname } from "~/features/utils/pathname";
import { NOT_FOUND_PATH } from "~/sanity/constants";
import { splitLocalePrefix } from "~/sanity/i18n";

/** The route Astro renders a 404 through, middleware included; on it the request path is not this route's own. */
export const NOT_FOUND_ROUTE = NOT_FOUND_PATH;

/** Unused here, and it would re-serve any same-origin body under a type the caller picks. */
const ASTRO_IMAGE_ROUTE = "/_image";

/** The segment a panel partial adds to the page it renders (`/blog/authors/<slug>/modal`). */
const PANEL_SEGMENT = "/modal";

export type SpellingRefusal = "bad-request" | "not-found";

export type GateDecision =
  | { kind: "exempt" }
  | { kind: "bad-request" }
  | { kind: "section-preview" }
  | { kind: "not-found" }
  /** `panel`: a partial view of the page at `path`, locked with it but never served as that page's Markdown. */
  | { kind: "page"; path: string; panel?: true };

type SpellingInput = {
  routePattern: string;
  /** `requestPathname(context.request)` before locale routing, never `context.url.pathname`. */
  pathname: string;
  studioBasePath: string;
};

type RouteInput = {
  routePattern: string;
  /** `locals.path`: the public path, locale prefix included, that the rendered route queries Sanity by. */
  path: string;
  studioBasePath: string;
};

/** The path as the URL parser resolves it, nothing decoded, which the route cache keys on; `context.url` has turned a decoded `\` into `/`. */
export function requestPathname(request: Request): string {
  return new URL(request.url).pathname;
}

/** `locals.path`, from Astro's decoded `context.url` before the rewrite: the stored `uri.current` form the route and the gate share. */
export function publicRequestPath(url: URL): string {
  return normalizePathname(decodePathname(url.pathname));
}

/** The page a panel partial path renders, which it is gated and cached as; any other path is its own page. */
export function panelHostPath(path: string): string {
  return path.endsWith(PANEL_SEGMENT) ? path.slice(0, -PANEL_SEGMENT.length) || "/" : path;
}

/** A route defined to serve one file (`/feed.xml`, `/robots.txt`); a page route's pattern never carries an extension. */
function isFileRoute(routePattern: string): boolean {
  return /\.[a-z0-9]+$/i.test(routePattern);
}

/** Before locale routing rewrites it away: one URL per page, and no spelling the router and a gate read apart. */
export function classifyRequestSpelling({ routePattern, pathname, studioBasePath }: SpellingInput): SpellingRefusal | null {
  if (isExcludedPath(routePattern, studioBasePath)) {
    return null;
  }

  if (canonicalRequestPath(pathname) === null) {
    return "bad-request";
  }

  // One URL per page, so a second spelling can never be the one a gate or the cache keys differently.
  if (routePattern !== NOT_FOUND_ROUTE && isPageAliasSpelling(pathname)) {
    return "not-found";
  }

  return null;
}

/** After locale routing: the route the router renders, gated as the page it queries; the 404 route gates as the page it names. */
export function classifyRequest({ routePattern, path, studioBasePath }: RouteInput): GateDecision {
  if (routePattern === ASTRO_IMAGE_ROUTE) {
    return { kind: "not-found" };
  }

  // A prefix names pages only: an endpoint or file keeps one path, so a rule on it holds and the feed stays one language.
  if (splitLocalePrefix(path).localeInPath && (isExcludedPath(routePattern, studioBasePath) || isFileRoute(routePattern))) {
    return { kind: "not-found" };
  }

  if (isExcludedPath(routePattern, studioBasePath)) {
    return { kind: "exempt" };
  }

  const gatePath = canonicalRequestPath(path);

  if (gatePath === null) {
    return { kind: "bad-request" };
  }

  // Ahead of every bypass: neither the CMS toggles nor a preview cookie opens the specimen.
  if (isSectionPreviewPath(routePattern) || isSectionPreviewRequestPath(path)) {
    return { kind: "section-preview" };
  }

  // A panel route serves a view of the page above it, so that page's lock is the one that applies.
  if (routePattern.endsWith(PANEL_SEGMENT)) {
    return { kind: "page", path: panelHostPath(gatePath), panel: true };
  }

  return { kind: "page", path: gatePath };
}
