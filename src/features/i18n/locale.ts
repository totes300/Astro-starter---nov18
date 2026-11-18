// Request-side locale concerns. The locale list and prefix rule live in `~/sanity/i18n`, because a
// document's `uri` stores the full prefixed path and the Studio builds it from the same helpers.

import { perspectiveCookieName } from "@sanity/preview-url-secret/constants";
import type { AstroCookies } from "astro";
import { requestHasCookie } from "~/lib/cookies";
import { DEFAULT_LOCALE, IS_I18N_ENABLED, LOCALE_IDS, type Locale } from "~/sanity/i18n";

/** Cookie the switcher and the landing detection agree on; a manual choice always wins. */
export const LOCALE_COOKIE_NAME = "locale";

export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/** Astro's `preferredLocale` does the same job but is undefined when prerendered and untestable in isolation. */
export function negotiateLocale(acceptLanguage: string | null | undefined): Locale | null {
  if (!acceptLanguage) {
    return null;
  }

  const ranked = acceptLanguage
    .split(",")
    .map((entry) => {
      const [tag = "", ...params] = entry.trim().split(";");
      const quality = params
        .map((param) => param.trim())
        .find((param) => param.startsWith("q="))
        ?.slice(2);
      const parsed = Number.parseFloat(quality ?? "1");

      return { tag: tag.trim().toLowerCase(), quality: Number.isNaN(parsed) ? 1 : parsed };
    })
    .filter(({ tag, quality }) => tag.length > 0 && quality > 0)
    .sort((a, b) => b.quality - a.quality);

  for (const { tag } of ranked) {
    // `it-CH` and `it-IT` both mean the `it` build; match the base subtag after the exact one.
    const match = LOCALE_IDS.find((id) => id === tag) ?? LOCALE_IDS.find((id) => id === tag.split("-")[0]);

    if (match) {
      return match;
    }
  }

  return null;
}

/**
 * Where a first visit to `/` is sent: a configured language other than the default that the browser prefers.
 * `null` once the visitor has chosen (the cookie) and for anything but a page request for `/`.
 */
export function landingLocale(request: Request): Locale | null {
  if (!IS_I18N_ENABLED || new URL(request.url).pathname !== "/") {
    return null;
  }

  // A prefetch may not ask for HTML, yet what it gets can be reused for the click: it is a candidate too.
  const isPageRequest =
    (request.method === "GET" || request.method === "HEAD") &&
    (request.headers.get("accept")?.includes("text/html") === true || isSpeculativeRequest(request));

  if (!isPageRequest || requestHasCookie(request, LOCALE_COOKIE_NAME) || requestHasCookie(request, perspectiveCookieName)) {
    return null;
  }

  const preferred = negotiateLocale(request.headers.get("accept-language"));

  return preferred && preferred !== DEFAULT_LOCALE ? preferred : null;
}

/**
 * A request the browser made on speculation: a hover prefetch (`<link rel="prefetch">`) or a prerender. Chromium and
 * Firefox send `Sec-Purpose`; `Purpose` and `X-Moz` are what older versions send. A `fetch()` prefetch is not marked.
 */
export function isSpeculativeRequest(request: Request): boolean {
  return ["sec-purpose", "purpose", "x-moz"].some((name) => request.headers.get(name)?.toLowerCase().includes("prefetch"));
}

/**
 * The answer to a first visit whose language has a published homepage: the cookie, then a `302` to that homepage.
 * A speculative request gets an empty `204` the browser cannot keep instead, so a hover decides nothing and the
 * click itself reaches detection.
 */
export function landingResponse(request: Request, locale: Locale, homeUri: string, cookies: Pick<AstroCookies, "set">): Response {
  if (isSpeculativeRequest(request)) {
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  }

  cookies.set(LOCALE_COOKIE_NAME, locale, { path: "/", maxAge: LOCALE_COOKIE_MAX_AGE, sameSite: "lax" });

  // The published URI, 302 not 301 and never stored: the target is this visitor's, revocable, and comes with their cookie.
  return new Response(null, {
    status: 302,
    headers: {
      Location: `${homeUri}${new URL(request.url).search}`,
      Vary: "Accept-Language, Cookie",
      "Cache-Control": "private, no-store",
    },
  });
}
