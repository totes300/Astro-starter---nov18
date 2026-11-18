import type { APIRoute } from "astro";
import { pageToMarkdown } from "~/features/agents/markdown";
import { backlogTasks, missingLanguages, tasksByLocale } from "~/features/agents/markdown-backfill";
import { type AgentMarkdownSource, withPublishedArticleLists } from "~/features/agents/published-article-lists";
import { AgentMarkdownBackfillQuery, AgentMarkdownBacklogQuery, AgentMarkdownContentQuery } from "~/features/agents/query";
import { authorizeStudioRequest } from "~/features/api/auth";
import { apiErrorResponse, internalErrorResponse, privateJson } from "~/features/api/errors";
import { PUBLIC_SITE_URL } from "~/lib/env";
import { type Locale, splitLocalePrefix } from "~/sanity/i18n";
import { sharedDocumentPath } from "~/sanity/sections";
import type {
  AgentMarkdownBackfillQueryResult,
  AgentMarkdownBacklogQueryResult,
  AgentMarkdownContentQueryResult,
} from "~/sanity/types";
import { sanityEditClient } from "../../../sanity/lib/client";
import { fetchSanity } from "../../../sanity/lib/fetch";

// Studio-triggered per-page agent Markdown generation, and the backfill of every page still missing it.
export const prerender = false;

/** Serializing is local and free, so a batch is bounded by time, not credits; the Studio panel loops on `remaining`. */
const BACKFILL_TIME_BUDGET_MS = 40_000;
const BACKFILL_CHUNK_SIZE = 10;
const MAX_URI_LENGTH = 2048;

// Drafts and published are separate rows here, and a draft must be filled from its own content.
const rawClient = sanityEditClient.withConfig({ perspective: "raw" });
const publishedClient = sanityEditClient.withConfig({ perspective: "published" });

/** The published article lists of `pages`, read in the language that serialized them. */
function withPublishedLists(pages: AgentMarkdownSource[], language: Locale): Promise<AgentMarkdownSource[]> {
  return withPublishedArticleLists(pages, async (ids) => {
    const published = await fetchSanity<AgentMarkdownBackfillQueryResult>(publishedClient, AgentMarkdownBackfillQuery, {
      ids,
      language,
    });

    return published as AgentMarkdownSource[];
  });
}

/** A page counts once, under its published id, and is missing when any of its versions is. */
async function readBacklog() {
  const versions = await fetchSanity<AgentMarkdownBacklogQueryResult>(rawClient, AgentMarkdownBacklogQuery);
  const pages = new Map<string, boolean>();

  for (const version of versions) {
    const id = version._id.replace(/^drafts\./, "");
    pages.set(id, pages.get(id) === true || missingLanguages(version).length > 0);
  }

  return {
    total: pages.size,
    missing: [...pages.values()].filter(Boolean).length,
    missingVersions: backlogTasks(versions),
  };
}

async function backfill(tasks: ReturnType<typeof backlogTasks>, signal: AbortSignal) {
  const deadline = Date.now() + BACKFILL_TIME_BUDGET_MS;
  const skipped: string[] = [];
  let filled = 0;
  let attempted = 0;

  while (attempted < tasks.length && Date.now() < deadline && !signal.aborted) {
    const chunk = tasks.slice(attempted, attempted + BACKFILL_CHUNK_SIZE);
    const batches = await Promise.all(
      [...tasksByLocale(chunk)].map(async ([language, group]) => {
        const pages = await fetchSanity<AgentMarkdownBackfillQueryResult>(rawClient, AgentMarkdownBackfillQuery, {
          ids: group.map(({ _id }) => _id),
          language,
        });
        const sources = await withPublishedLists(pages as AgentMarkdownSource[], language);

        // A shared document serializes at this language's URL, so its links and locale are this language's.
        return sources.flatMap((source) => {
          const task = group.find(({ _id }) => _id === source._id);

          return task ? [{ source: { ...source, uri: task.uri }, task }] : [];
        });
      })
    );
    const transaction = rawClient.transaction();
    let patched = 0;

    for (const { source, task } of batches.flat()) {
      const text = pageToMarkdown(source, PUBLIC_SITE_URL).trim();

      if (!text) {
        skipped.push(source._id);
        continue;
      }

      transaction.patch(source._id, (patch) =>
        task.arm
          ? patch
              .setIfMissing({ agentMarkdown: {} })
              .setIfMissing({ "agentMarkdown.content": {} })
              .set({ [`agentMarkdown.content.${task.arm}`]: text })
          : patch.setIfMissing({ agentMarkdown: {} }).set({ "agentMarkdown.content": text })
      );
      patched += 1;
    }

    if (patched > 0) {
      await transaction.commit();
    }

    filled += patched;
    attempted += chunk.length;
  }

  return { filled, skipped, attempted };
}

/** Counts for the Studio backfill panel. */
export const GET: APIRoute = async ({ request }) => {
  const denied = await authorizeStudioRequest(request);

  if (denied) {
    return denied;
  }

  try {
    const { total, missing } = await readBacklog();

    return privateJson({ total, missing });
  } catch (error) {
    return internalErrorResponse(error, { error: "Failed to read agent Markdown stats.", code: "internal_error" });
  }
};

/** Two callers: the per-page Generate posts `{ uri }` and gets the text back; `{ backfill: true }` writes every missing version. */
export const POST: APIRoute = async ({ request }) => {
  const denied = await authorizeStudioRequest(request);

  if (denied) {
    return denied;
  }

  try {
    const body = await request.json().catch(() => ({}) as Record<string, unknown>);

    if (body?.backfill === true) {
      const { missingVersions } = await readBacklog();
      const { filled, skipped, attempted } = await backfill(missingVersions, request.signal);

      return privateJson({
        filled,
        skipped: skipped.length,
        remaining: missingVersions.length - attempted,
      });
    }

    const uri = typeof body?.uri === "string" ? body.uri.trim() : "";

    if (!uri || uri.length > MAX_URI_LENGTH) {
      return apiErrorResponse(400, { error: "Missing page URL. Save this page's URL, then try again.", code: "missing_uri" });
    }

    const language = splitLocalePrefix(uri).locale;

    // No eligibility gate: a protected or noindex page may hold Markdown, since serving never returns it.
    const page = await fetchSanity<AgentMarkdownContentQueryResult>(
      sanityEditClient.withConfig({ perspective: "drafts" }),
      AgentMarkdownContentQuery,
      { uri, sharedUri: sharedDocumentPath(uri), language }
    );

    if (!page) {
      return apiErrorResponse(404, {
        error: "No page found at this URL in a language this site serves.",
        code: "page_not_found",
      });
    }

    // A shared document is serialized at the URL asked for, in that URL's language.
    const [source] = await withPublishedLists([{ ...(page as AgentMarkdownSource), uri }], language);
    const text = source ? pageToMarkdown(source, PUBLIC_SITE_URL).trim() : "";

    if (!text) {
      return apiErrorResponse(422, { error: "This page has no content to serialize yet.", code: "empty_page" });
    }

    return privateJson({ text });
  } catch (error) {
    return internalErrorResponse(error, { error: "Generation failed.", code: "internal_error" });
  }
};
