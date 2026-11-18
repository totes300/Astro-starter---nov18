import type { Mutation, SanityClient } from "@sanity/client";
import { getPublishedId } from "@sanity/client/csm";
import { isConflict } from "~/features/agents/ai-ledger";
import { AiTranslationGroupQuery } from "~/features/agents/query";
import type { PlanGroup } from "~/sanity/ai-translation/plan";
import { type LinkInput, type LinkResult, TRANSLATE_MESSAGES } from "~/sanity/ai-translation/wire";
import { DEFAULT_LOCALE } from "~/sanity/i18n";
import { toPatchPath } from "~/sanity/lib/patch-path";
import { metadataRow, TRANSLATION_METADATA, type TranslationDocument, translationGroupId } from "~/sanity/translation-stub";
import { fetchSanity } from "../../../sanity/lib/fetch";
import { sourceProblem, withLease } from "./pair";
import { byPublishedId, type PairReads, readDocuments, readPair, readVersions } from "./reads";
import { RAW, type TranslateDeps } from "./shared";

type LinkOutcome = Omit<LinkResult, "sourceId" | "language" | "targetId">;

/** A group that changed between the read and the write is read again once; a second change answers `link_taken`. */
const LINK_ATTEMPTS = 2;

function refusedLink(code: keyof typeof TRANSLATE_MESSAGES, extra: Partial<LinkOutcome> = {}): LinkOutcome {
  return { status: "refused", code, error: TRANSLATE_MESSAGES[code], creditSpent: false, ...extra };
}

function titleOf(document: TranslationDocument): string | undefined {
  const title = [document.title, document.name, document.heading].find((value) => typeof value === "string" && value.trim());

  return typeof title === "string" ? title : undefined;
}

/** The document to link as it reads now: its draft, its published copy, or a release version. */
async function readLinkTarget(client: SanityClient, targetId: string): Promise<TranslationDocument | undefined> {
  const copies = byPublishedId(await readDocuments(client, [targetId])).get(targetId);
  const current = copies?.draft ?? copies?.published;

  if (current) {
    return current;
  }

  return (await readVersions(client)).find(({ _id }) => getPublishedId(_id) === targetId) as TranslationDocument | undefined;
}

/** The group write: join the source's group in place of any row whose document is gone, or create its group. */
async function linkMutations(reads: PairReads, input: LinkInput, type: string): Promise<{ id: string; mutations: Mutation[] }> {
  const row = metadataRow(input.language, input.targetId, type);

  if (!reads.group) {
    const id = await translationGroupId(input.sourceId);

    return {
      id,
      mutations: [
        {
          create: {
            _id: id,
            _type: TRANSLATION_METADATA,
            schemaTypes: [type],
            translations: [metadataRow(DEFAULT_LOCALE, input.sourceId, type), row],
          },
        },
      ],
    };
  }

  const stale = reads.staleKeys.map((key) => toPatchPath(["translations", { _key: key }]));

  return {
    id: reads.group._id,
    mutations: [
      {
        patch: {
          id: reads.group._id,
          ...(reads.group._rev ? { ifRevisionID: reads.group._rev } : {}),
          setIfMissing: { translations: [] },
          ...(stale.length > 0 ? { unset: stale } : {}),
          insert: { after: "translations[-1]", items: [row] },
        },
      },
    ],
  };
}

async function runLink(client: SanityClient, input: LinkInput): Promise<LinkOutcome> {
  for (let attempt = 1; ; attempt++) {
    const [reads, target, targetGroup] = await Promise.all([
      readPair(client, input.sourceId, input.language),
      readLinkTarget(client, input.targetId),
      fetchSanity<PlanGroup | null>(client, AiTranslationGroupQuery, { id: input.targetId }, RAW),
    ]);
    const source = reads.source.published ?? reads.source.draft;
    const problem = sourceProblem(source);

    if (problem || !source) {
      return refusedLink(
        problem?.code === "not_a_source" || problem?.code === "missing_language" ? problem.code : "source_not_found"
      );
    }

    if (!target) {
      return refusedLink("link_not_found");
    }

    const title = titleOf(target);

    if (target._type !== source._type || target.language !== input.language) {
      return refusedLink("link_mismatch", title ? { title } : {});
    }

    // Already in a group (this one or another), or this language already has a translation linked.
    if (targetGroup || reads.target || reads.releaseOnly) {
      return refusedLink("link_taken", title ? { title } : {});
    }

    if (input.preview) {
      return { status: "preview", ...(title ? { title } : {}), creditSpent: false };
    }

    const { id, mutations } = await linkMutations(reads, input, source._type);

    try {
      await client.mutate(mutations, { visibility: "sync" });

      return { status: "linked", ...(title ? { title } : {}), metadataId: id, creditSpent: false };
    } catch (error) {
      if (!isConflict(error) || attempt >= LINK_ATTEMPTS) {
        if (isConflict(error)) {
          return refusedLink("link_taken", title ? { title } : {});
        }

        throw error;
      }
    }
  }
}

/** Free: an editor's own translation, made before Translate with AI or outside it, joins the source's group. */
export async function linkTranslation(deps: TranslateDeps, input: LinkInput): Promise<LinkResult> {
  const pair = { sourceId: input.sourceId, language: input.language };
  const outcome = await withLease<LinkOutcome>(
    deps,
    pair,
    () => runLink(deps.client, { ...input, targetId: getPublishedId(input.targetId) }),
    () => ({ status: "busy", code: "busy", message: TRANSLATE_MESSAGES.busy, creditSpent: false })
  );

  return { ...pair, targetId: getPublishedId(input.targetId), ...outcome };
}
