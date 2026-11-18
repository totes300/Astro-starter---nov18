/**
 * Canonical pathname form: no trailing slash, `/` stays `/`. Request pathnames and Sanity `uri.current`
 * values must go through this or set lookups silently miss.
 */
export function normalizePathname(pathname: string): string {
  if (pathname === "/") {
    return "/";
  }

  return pathname.replace(/\/$/, "");
}

/** The path as Sanity stores it (`/it/caffè`, not `/it/caff%C3%A8`); reserved escapes like `%2F` stay encoded. */
export function decodePathname(pathname: string): string {
  try {
    return decodeURI(pathname);
  } catch {
    return pathname;
  }
}
