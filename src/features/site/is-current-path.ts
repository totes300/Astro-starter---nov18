import { stegaClean } from "@sanity/client/stega";
import { normalizePathname } from "~/features/utils/pathname";
import { homeUris } from "~/sanity/i18n";

/** Pass `Astro.locals.path`, never `Astro.url` (the locale rewrite strips its prefix); stegaClean, as preview hrefs carry marks. */
export function isCurrentPath(pathname: string | undefined, href: string | null | undefined): boolean {
  const target = stegaClean(href ?? "");

  // No path when Astro renders an error page without middleware, and nothing is current there.
  if (!pathname || !target) {
    return false;
  }

  return normalizePathname(pathname) === normalizePathname(target.split(/[?#]/)[0] || "/");
}

/** The current page or any page under it, so a section's own link stays current on its articles. Home only matches itself. */
export function isWithinPath(pathname: string | undefined, href: string | null | undefined): boolean {
  if (isCurrentPath(pathname, href)) {
    return true;
  }

  const target = normalizePathname(stegaClean(href ?? "").split(/[?#]/)[0] || "/");

  if (!pathname || homeUris().includes(target) || /^[a-z][a-z0-9+.-]*:/i.test(target)) {
    return false;
  }

  return normalizePathname(pathname).startsWith(`${target}/`);
}
