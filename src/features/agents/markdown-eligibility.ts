// Which routes may be served as agent Markdown: an allowlist, so a route missing from the snapshot is never served.
// Pure, so the middleware rewrite and the Markdown route share it and it runs under `node --test`.

import { canonicalUri } from "~/features/auth/canonical-path";
import { ConfiguredLocaleFilter } from "~/features/i18n/fragment";
import { isSharedRoutedType, sharedLocalePaths } from "~/features/i18n/shared-documents";
import { SANITY_SINGLETON_SITE_SETTINGS_ID, SHARED_ROUTED_DOCUMENT_TYPES } from "~/sanity/constants";
import { LOCALE_IDS } from "~/sanity/i18n";

/** A page that must not reach an agent (a ghost in a language no longer served included): never served, never linked. */
export const GATED_ROUTE_FILTER = `seoMetadata.noIndex == true || passwordProtected == true || !(${ConfiguredLocaleFilter})`;

type AgentMarkdownRoute = {
  uri?: string | null;
  type?: string | null;
  excluded?: boolean | null;
  gated?: boolean | null;
  /** A shared routed document: whether each language holds its own Markdown. */
  filled?: Record<string, boolean | null> | null;
};

type AgentMarkdownRoutes = (AgentMarkdownRoute | null)[] | null | undefined;

export type AgentMarkdownPayload = { siteLocked?: boolean | null; routes?: AgentMarkdownRoutes } | null;

/** Request-facing shape: paths pre-normalized into Sets once per fetch (O(1) per request). */
export type AgentMarkdownState = {
  siteLocked: boolean;
  eligiblePathSet: ReadonlySet<string>;
  /** Protected or `noIndex` now, so Markdown stored before the change must stop linking them. */
  gatedPathSet: ReadonlySet<string>;
};

/** A shared routed document is one route per language, at that language's URL, eligible only where its Markdown is. */
function expanded(routes: AgentMarkdownRoutes): (AgentMarkdownRoute & { uri: string })[] {
  return (routes ?? [])
    .filter((route): route is AgentMarkdownRoute & { uri: string } => Boolean(route) && typeof route?.uri === "string")
    .flatMap((route) =>
      isSharedRoutedType(route.type)
        ? sharedLocalePaths(route.type, route.uri).map(({ language, uri }) => ({
            ...route,
            uri,
            excluded: !(route.excluded === false && route.filled?.[language] === true),
          }))
        : [route]
    );
}

function pathSet(routes: AgentMarkdownRoutes, keep: (route: AgentMarkdownRoute) => boolean): Set<string> {
  return new Set(
    expanded(routes)
      .filter(keep)
      .map((route) => canonicalUri(route.uri))
  );
}

export function toAgentMarkdownState(payload: AgentMarkdownPayload): AgentMarkdownState {
  return {
    siteLocked: payload?.siteLocked === true,
    // `excluded === false`, not `!excluded`: a flag the query could not evaluate must not open a route.
    eligiblePathSet: pathSet(payload?.routes, (route) => route.excluded === false),
    gatedPathSet: pathSet(payload?.routes, (route) => route.gated === true),
  };
}

export function isAgentMarkdownEligible(state: AgentMarkdownState, path: string): boolean {
  return !state.siteLocked && state.eligiblePathSet.has(canonicalUri(path));
}

// Project over the STABLE set, never filter: membership changes on first generation and even the live API misses it.
export const AGENT_MARKDOWN_STATE_QUERY = `{
  "siteLocked": *[_id == "${SANITY_SINGLETON_SITE_SETTINGS_ID}"][0].basicAuth.siteWideEnabled,
  "routes": *[defined(uri.current)]{
    "uri": uri.current,
    "type": _type,
    "filled": select(_type in ${JSON.stringify(SHARED_ROUTED_DOCUMENT_TYPES)} => {
      ${LOCALE_IDS.map((id) => `"${id}": defined(agentMarkdown.content.${id}) && agentMarkdown.content.${id} != ""`).join(",\n      ")}
    }),
    "excluded": ${GATED_ROUTE_FILTER}
      || agentMarkdown.enabled == false
      || !defined(agentMarkdown.content)
      || agentMarkdown.content == "",
    "gated": ${GATED_ROUTE_FILTER}
  }
}`;
