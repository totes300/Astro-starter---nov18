import { sequence } from "astro:middleware";
import type { MiddlewareHandler } from "astro";
import { rewriteToAgentMarkdown } from "~/features/agents/markdown-rewrite";
import { notFoundRender } from "~/features/agents/serve-agent-markdown";
import { DRAFT_SESSION_COOKIE, verifyDraftSession } from "~/features/auth/draft-session";
import { runExemptRoute } from "~/features/auth/exempt-route";
import { gateAlways, gateByCms } from "~/features/auth/gates";
import { classifyRequest, classifyRequestSpelling, requestPathname, type SpellingRefusal } from "~/features/auth/request-gate";
import { localeRouting } from "~/features/i18n/locale-routing";
import { isSectionPreviewRequestPath, SECTION_PREVIEW_ROBOTS } from "~/features/page-builder/section-preview-path";
import { IS_DEV } from "~/features/utils/constants";
import { PUBLIC_SANITY_PROJECT_ID, PUBLIC_SANITY_STUDIO_BASE_PATH, PUBLIC_SITE_URL, SANITY_API_VIEW_TOKEN } from "~/lib/env";
import { securityHeaders } from "~/lib/security-headers";

// Runtime gates: locale routing, CMS-managed HTTP Basic Auth and agent content negotiation, keyed on one canonical path.
// The order is the contract (docs/features/basic-auth.md); each step's logic lives in its feature module.

const SECURITY_HEADERS = securityHeaders({
  siteUrl: PUBLIC_SITE_URL,
  sanityProjectId: PUBLIC_SANITY_PROJECT_ID,
  isDev: IS_DEV,
});

const SITEMAP_ROUTE = "/sitemap.xml";

function isStudioRequest(routePattern: string): boolean {
  const base = PUBLIC_SANITY_STUDIO_BASE_PATH.replace(/\/$/, "");

  return routePattern === base || routePattern.startsWith(`${base}/`);
}

/** An empty 404 makes Astro render the 404 page, whose own pass through here gates it as the page it names. */
function refusalResponse(refusal: SpellingRefusal): Response {
  return refusal === "bad-request" ? new Response("Bad Request", { status: 400 }) : new Response(null, { status: 404 });
}

const responseHeaders: MiddlewareHandler = async (context, next) => {
  // Read before `next()`, which swaps the request and the route for the locale rewrite's.
  const isSectionPreview = isSectionPreviewRequestPath(requestPathname(context.request));
  const isStudio = isStudioRequest(context.routePattern);
  const response = await next();

  // Every answer under the specimen's prefix, the 401 and 404 included, so nothing indexes or follows it.
  if (isSectionPreview) {
    response.headers.set("X-Robots-Tag", SECTION_PREVIEW_ROBOTS);
  } else if (context.locals.draftSession) {
    // A draft render is one editor's preview, never a page to index; the session is set by a later step.
    response.headers.set("X-Robots-Tag", "noindex");
  }

  for (const [name, value] of SECURITY_HEADERS.always) {
    response.headers.set(name, value);
  }

  // The Studio loads its own set of origins; it gets a policy of its own or none.
  if (!isStudio) {
    response.headers.set("Content-Security-Policy-Report-Only", SECURITY_HEADERS.reportOnly);
  }

  return response;
};

/** The request as sent, judged before locale routing rewrites it away. */
const requestSpelling: MiddlewareHandler = (context, next) => {
  const refusal = classifyRequestSpelling({
    routePattern: context.routePattern,
    pathname: requestPathname(context.request),
    studioBasePath: PUBLIC_SANITY_STUDIO_BASE_PATH,
  });

  return refusal ? refusalResponse(refusal) : next();
};

/** A Studio preview session is only one the draft-mode enable route signed; the preview cookies alone are forgeable. */
const draftSession: MiddlewareHandler = async (context, next) => {
  context.locals.draftSession =
    !context.isPrerendered && (await verifyDraftSession(SANITY_API_VIEW_TOKEN, context.cookies.get(DRAFT_SESSION_COOKIE)?.value));
  return next();
};

const runtimeGates: MiddlewareHandler = async (context, next) => {
  // The public path, not the rewritten one: it is what Sanity stores in `uri.current` and what the route queries by.
  const decision = classifyRequest({
    routePattern: context.routePattern,
    path: context.locals.path,
    studioBasePath: PUBLIC_SANITY_STUDIO_BASE_PATH,
  });

  // The sitemap lists every page, so a locked site locks it too; it opens with the site, and the other files stay open.
  if (decision.kind === "exempt") {
    return context.routePattern === SITEMAP_ROUTE
      ? gateByCms(context, () => runExemptRoute(next), SITEMAP_ROUTE)
      : runExemptRoute(next);
  }

  if (decision.kind === "bad-request" || decision.kind === "not-found") {
    return refusalResponse(decision.kind);
  }

  if (decision.kind === "section-preview") {
    return gateAlways(context, next, "The section preview");
  }

  // A signed Studio preview session: Basic Auth must not run, and drafts must not reach the cache.
  if (context.locals.draftSession) {
    context.cache.set(false);
    return next();
  }

  const notFound = notFoundRender(context, PUBLIC_SITE_URL, next);

  // An agent's 404 is the Markdown recovery map, still behind the gate, so a locked site or protected page never gets it.
  if (notFound) {
    return gateByCms(context, notFound, decision.path);
  }

  // Ahead of the gate but deferring to it: a page Basic Auth covers is never rewritten to Markdown, nor is a panel.
  const markdown = decision.panel ? null : await rewriteToAgentMarkdown(context, decision.path);

  if (markdown) {
    return markdown;
  }

  return gateByCms(context, next, decision.path);
};

export const onRequest = sequence(responseHeaders, requestSpelling, localeRouting, draftSession, runtimeGates);
