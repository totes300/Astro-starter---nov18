import type { APIRoute } from "astro";
import { getAgentMarkdownState } from "~/features/agents/markdown-proxy-state";
import { AgentMarkdownServeQuery } from "~/features/agents/query";
import { serveAgentMarkdown } from "~/features/agents/serve-agent-markdown";
import { normalizePathname } from "~/features/utils/pathname";
import { CONTENT_VERSION_PARAM, contentVersion } from "~/lib/content-version";
import { PUBLIC_SITE_URL } from "~/lib/env";
import { splitLocalePrefix } from "~/sanity/i18n";
import { sharedDocumentPath } from "~/sanity/sections";
import type { AgentMarkdownServeQueryResult } from "~/sanity/types";
import { sanityClient } from "../../../sanity/lib/client";
import { fetchSanity } from "../../../sanity/lib/fetch";

// Serves the stored `agentMarkdown.content` of an eligible routed document; the middleware rewrites
// `Accept: text/markdown` requests here. Not route-cached: the answer follows the eligibility snapshot, which no tag busts.
export const prerender = false;

// Published perspective, stega off: agents get the clean, published Markdown body.
const serveClient = sanityClient.withConfig({ perspective: "published", stega: false });

export const GET: APIRoute = ({ params }) =>
  serveAgentMarkdown({
    uri: normalizePathname(`/${params.uri ?? ""}`),
    siteUrl: PUBLIC_SITE_URL,
    readState: getAgentMarkdownState,
    readStoredMarkdown: async (uri) =>
      fetchSanity<AgentMarkdownServeQueryResult>(serveClient, AgentMarkdownServeQuery, {
        uri,
        sharedUri: sharedDocumentPath(uri),
        language: splitLocalePrefix(uri).locale,
        [CONTENT_VERSION_PARAM]: await contentVersion.read(),
      }),
  });
