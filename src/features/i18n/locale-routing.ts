// The locale pipeline step for `src/middleware.ts`: strips the prefix to pick a page file, redirects the
// default locale's prefix away, and sends a first visit to its language. See docs/features/internationalization.md

import type { APIContext, MiddlewareHandler } from "astro";
import { isExcludedPath } from "~/features/auth/excluded-paths";
import { NOT_FOUND_ROUTE, publicRequestPath } from "~/features/auth/request-gate";
import { landingHomeUri } from "~/features/i18n/homepage-locales";
import { landingLocale, landingResponse } from "~/features/i18n/locale";
import { PUBLIC_SANITY_STUDIO_BASE_PATH } from "~/lib/env";
import { DEFAULT_LOCALE, IS_I18N_ENABLED, type Locale, splitLocalePrefix, withLocalePrefix } from "~/sanity/i18n";
import { resolveSectionRequest } from "~/sanity/sections";

/** The prefix is stripped only to pick a page file; `locals.path` keeps the full public path every route queries by. */
export const localeRouting: MiddlewareHandler = async (context, next) => {
  context.locals.path = publicRequestPath(context.url);
  context.locals.locale = DEFAULT_LOCALE;

  if (!IS_I18N_ENABLED || isExcludedPath(context.routePattern, PUBLIC_SANITY_STUDIO_BASE_PATH)) {
    return next();
  }

  const { locale, localeInPath, pathname } = splitLocalePrefix(context.url.pathname);

  // Language only: a rewrite would 404 again, and Astro's retry renders the 404 page with no middleware at all.
  if (context.routePattern === NOT_FOUND_ROUTE) {
    context.locals.locale = locale;

    return next();
  }

  // One indexable URL per page: no document stores `/en/about`, so without this it would simply 404.
  if (localeInPath === DEFAULT_LOCALE) {
    return context.redirect(`${withLocalePrefix(DEFAULT_LOCALE, pathname)}${context.url.search}`, 301);
  }

  context.locals.locale = locale;

  if (!localeInPath) {
    const target = landingLocale(context.request);
    const redirect = target ? await redirectToLanding(context, target) : null;

    return redirect ?? next();
  }

  // Section folders keep the default word, so a language's own word is mapped back to the folder that serves it.
  const section = resolveSectionRequest(locale, pathname);

  if (section && "redirect" in section) {
    return context.redirect(`${section.redirect}${context.url.search}`, 301);
  }

  return next(`${section?.rewrite ?? pathname}${context.url.search}`);
};

/** The preferred language's published homepage, or `null` while it is unpublished: a cookie set now would go stale at launch. */
async function redirectToLanding(context: APIContext, locale: Locale): Promise<Response | null> {
  let homeUri: string | undefined;

  try {
    homeUri = await landingHomeUri(locale);
  } catch (error) {
    console.error("middleware: homepage locales fetch failed", error);
    return null;
  }

  return homeUri ? landingResponse(context.request, locale, homeUri, context.cookies) : null;
}
