// All page content fetches go through here. Draft mode uses the "drafts" perspective with stega for the
// overlays; stega is requested per call so it never leaks into published HTML.

import type { ClientPerspective, QueryParams } from "@sanity/client";
import { CONTENT_VERSION_PARAM, contentVersion } from "~/lib/content-version";
import { SANITY_API_VIEW_TOKEN } from "~/lib/env";
import type { Locale } from "~/sanity/i18n";
import { sanityClient } from "./client";
import { fetchSanity } from "./fetch";

// Cookie holds either "drafts" or a JSON array of Content Release ids.
function parsePerspective(raw: string | undefined): ClientPerspective | undefined {
  if (!raw) {
    return undefined;
  }
  const decoded = decodeURIComponent(raw);
  if (decoded.startsWith("[")) {
    try {
      return JSON.parse(decoded) as ClientPerspective;
    } catch {
      return undefined;
    }
  }
  return decoded as ClientPerspective;
}

export async function loadQuery<QueryResponse>({
  query,
  params,
  perspectiveCookie,
  locale,
}: {
  query: string;
  params?: QueryParams;
  perspectiveCookie?: string | undefined;
  /** From `getDraftModeProps`: bound as `$language` unless `params` names one. */
  locale?: Locale | undefined;
}): Promise<{ data: QueryResponse; perspective: ClientPerspective }> {
  const draftMode = Boolean(perspectiveCookie);

  if (draftMode && !SANITY_API_VIEW_TOKEN) {
    throw new Error("SANITY_API_VIEW_TOKEN is required for Visual Editing (Sanity draft mode).");
  }

  const perspective: ClientPerspective = draftMode ? (parsePerspective(perspectiveCookie) ?? "drafts") : "published";

  // Token applied per request. Draft reads always hit the live API: editors must never see CDN-stale drafts.
  let client = SANITY_API_VIEW_TOKEN ? sanityClient.withConfig({ token: SANITY_API_VIEW_TOKEN }) : sanityClient;

  if (draftMode) {
    client = client.withConfig({ useCdn: false });
  }

  // The page locale unless `params` names one; the seam binds it in both modes, so a preview never shows what publishing hides.
  const baseParams = { language: locale, ...params };

  // Published reads go through the CDN, keyed to the last publish by the version (~/lib/content-version).
  const queryParams = draftMode ? baseParams : { ...baseParams, [CONTENT_VERSION_PARAM]: await contentVersion.read() };

  const data = await fetchSanity<QueryResponse>(client, query, queryParams, { perspective, stega: draftMode });

  return { data, perspective };
}
