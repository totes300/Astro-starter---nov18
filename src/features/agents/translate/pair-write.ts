import type { Mutation, SanityClient } from "@sanity/client";
import { getPublishedId } from "@sanity/client/csm";
import { acquireLease, isConflict, type Lease, releaseLease } from "~/features/agents/ai-ledger";
import { AiTranslationRedirectSourcesQuery, AiTranslationTakenUrisQuery } from "~/features/agents/query";
import { type AgentMarkdownStatus, stubAsWritten, translationMarkdown } from "~/features/agents/translation-markdown";
import { isPlainObject } from "~/sanity/ai-translation/fields";
import { fnv1a64 } from "~/sanity/ai-translation/fingerprint";
import { type MergeResult, mergeTranslation } from "~/sanity/ai-translation/merge";
import { type AiTranslationRecord, type TranslationStatus, translationRecord } from "~/sanity/ai-translation/plan";
import { AI_TRANSLATION_FIELD, TRANSLATION_EXCLUDED_FIELDS } from "~/sanity/constants";
import { DEFAULT_LOCALE } from "~/sanity/i18n";
import { toPatchPath } from "~/sanity/lib/patch-path";
import { localizeDocumentPath } from "~/sanity/sections";
import { collectReferences, type PathSegment, type TranslationGroup } from "~/sanity/translation-references";
import {
  isFixedUri,
  newTranslationUriProblem,
  planTranslationRefresh,
  planTranslationStub,
  refreshMutations,
  stubMutations,
  type TranslationDocument,
  translatedSlugUri,
  translationGroupId,
  uniqueUri,
} from "~/sanity/translation-stub";
import { fetchSanity } from "../../../sanity/lib/fetch";
import { keepIfPublishedUnchanged } from "./publish";
import { findHolder, type PairReads, pairStatus, readPair, readVariantGroups } from "./reads";
import { type Copies, RAW, revisionOf, uriOf } from "./shared";

/** Suffixes tried for a new translation's URI before the write gives up and keeps the paid result. */
const URI_CLAIM_ATTEMPTS = 10;

/** A conflict on the translation group alone is retried this often; any other conflict stops at once. */
const WRITE_ATTEMPTS = 3;

/** Per list, so a response stays small; the full lists are the merge's to recompute. */
const MAX_REPORTED_PATHS = 50;

export function reportedPaths(paths: readonly PathSegment[][]): string[] {
  return paths.slice(0, MAX_REPORTED_PATHS).map((path) => toPatchPath(path));
}

export type WriteContext = {
  source: TranslationDocument;
  result: unknown;
  language: string;
  slugs: "translate" | "keep";
  translatedAt: string;
  siteUrl: string;
  studioPaths: readonly string[];
  /** Applying a saved result: the source as it was when the call was paid for. */
  sourcePrint?: Pick<AiTranslationRecord, "sourceRev" | "sourceTextHash" | "sourceLayoutHash">;
};

type Written = {
  created: boolean;
  targetId: string;
  draftId: string;
  uri?: string;
  rev?: string;
  /** Set when the draft was made from the published copy: publishing it is refused once that copy changed. */
  publishedRev?: string;
  agentMarkdown?: AgentMarkdownStatus;
};

type WriteOutcome =
  | ({ ok: true; merge: MergeResult } & Written)
  | {
      ok: false;
      code: "conflict" | "write_failed" | "unlinked_translation";
      statusNow?: TranslationStatus;
      merge?: MergeResult;
      unlinkedId?: string;
    };

function recordFor(context: WriteContext, written: Record<string, unknown>): AiTranslationRecord {
  const record = translationRecord({
    source: context.source,
    written,
    sourceLanguage: DEFAULT_LOCALE,
    translatedAt: context.translatedAt,
  });
  const print = Object.fromEntries(Object.entries(context.sourcePrint ?? {}).filter(([, value]) => typeof value === "string"));

  return { ...record, ...print };
}

type UriClaim = { uri?: string; lease?: Lease };

/** The lease key a URI is claimed under: hashed, since a path cannot sit in a document id. */
const URI_LEASE_SOURCE = "uri";

async function takenUris(client: SanityClient, prefix: string): Promise<string[]> {
  return (await fetchSanity<string[] | null>(client, AiTranslationTakenUrisQuery, { uri: prefix }, RAW)) ?? [];
}

async function redirectSources(client: SanityClient): Promise<string[]> {
  const sources = await fetchSanity<(string | null)[] | null>(client, AiTranslationRedirectSourcesQuery, {}, RAW);

  // A From matches in any letter case, and a URI is lowercase.
  return (sources ?? []).flatMap((from) => {
    const path = typeof from === "string" ? from.trim().replace(/(.)\/+$/, "$1") : "";

    return path === "" ? [] : [path.toLowerCase()];
  });
}

/** A new translation's URI off reserved paths, redirects and taken URIs, leased until written; none when fixed. */
async function claimTranslationUri(
  client: SanityClient,
  context: WriteContext,
  document: TranslationDocument
): Promise<UriClaim> {
  const sourceUri = uriOf(context.source);
  const type = context.source._type;

  if (!sourceUri) {
    return {};
  }

  const localized = localizeDocumentPath(type, context.language, sourceUri);

  if (isFixedUri(type, localized)) {
    return {};
  }

  const translated =
    context.slugs === "translate"
      ? translatedSlugUri({ type, uri: localized, title: document.title ?? document.name })
      : localized;
  const fits = (uri: string | undefined): uri is string =>
    uri !== undefined &&
    newTranslationUriProblem({ uri, type, locale: context.language, studioPaths: context.studioPaths }) === null;
  const base = [translated, localized].find(fits) ?? localized;
  const [taken, redirects] = await Promise.all([takenUris(client, base), redirectSources(client)]);
  const blocked = new Set([...taken, ...redirects]);

  // The pair's own lease makes it the only request writing it, so a URI it left leased (a killed write) is still its own.
  const owner = `${getPublishedId(context.source._id)}.${context.language}`;

  for (let attempt = 0; attempt < URI_CLAIM_ATTEMPTS; attempt++) {
    const uri = uniqueUri(base, blocked);
    const claim = await acquireLease(client, { sourceId: URI_LEASE_SOURCE, language: fnv1a64(uri), owner });

    if (claim.acquired) {
      // Another lane may have written it between the first read and this lease.
      if (!(await takenUris(client, uri)).includes(uri)) {
        return { uri, lease: claim.lease };
      }

      await releaseUriLease(client, claim.lease);
    }

    blocked.add(uri);
  }

  throw new Error("[ai-translate] Every URI tried for the new translation was taken.");
}

async function releaseUriLease(client: SanityClient, lease: Lease) {
  await releaseLease(client, lease).catch((error: unknown) => {
    console.error("[ai-translate] A URI lease could not be released; it expires on its own:", error);
  });
}

/** Best effort: a failure costs the translation its agent Markdown, never the paid write. */
async function markdownFor(
  client: SanityClient,
  context: WriteContext,
  document: TranslationDocument
): Promise<{ text?: string; failed?: true }> {
  try {
    const text = await translationMarkdown(client, document, { language: context.language, siteUrl: context.siteUrl });

    return text ? { text } : {};
  } catch (error) {
    console.error(`[ai-translate] ${getPublishedId(document._id)} is written without agent Markdown:`, error);

    return { failed: true };
  }
}

function markdownStatus(markdown: { text?: string; failed?: true }, changed: boolean): { agentMarkdown?: AgentMarkdownStatus } {
  if (markdown.failed) {
    return { agentMarkdown: "failed" };
  }

  if (!markdown.text) {
    return {};
  }

  return { agentMarkdown: changed ? "written" : "unchanged" };
}

async function planStubWrite(
  client: SanityClient,
  context: WriteContext,
  merge: MergeResult,
  reads: PairReads,
  groups: readonly TranslationGroup[],
  uri: string | undefined
): Promise<{ mutations: Mutation[]; written: Written }> {
  const sourceId = getPublishedId(context.source._id);
  const stub = planTranslationStub({
    source: merge.document,
    locale: context.language,
    sourceLocale: DEFAULT_LOCALE,
    metadataId: reads.group?._id,
    newMetadataId: reads.group ? undefined : await translationGroupId(sourceId),
    uri,
    excludedFields: TRANSLATION_EXCLUDED_FIELDS,
    groups,
  });

  stub.document[AI_TRANSLATION_FIELD] = recordFor(context, stub.document);

  const markdown = await markdownFor(client, context, stubAsWritten(stub));

  if (markdown.text) {
    stub.document.agentMarkdown = { content: markdown.text };
  }

  const mutations = stubMutations(stub, { metadataRev: reads.group?._rev });

  if (reads.group && reads.staleKeys.length > 0) {
    mutations.push({
      patch: { id: reads.group._id, unset: reads.staleKeys.map((key) => toPatchPath(["translations", { _key: key }])) },
    });
  }

  return {
    mutations,
    written: {
      created: true,
      targetId: getPublishedId(stub.document._id),
      draftId: stub.document._id,
      uri: stub.uri,
      ...markdownStatus(markdown, true),
    },
  };
}

/** The target's Markdown is replaced, since it described the text this refresh rewrites; a failure keeps the old one. */
async function planRefreshWrite(
  client: SanityClient,
  context: WriteContext,
  merge: MergeResult,
  target: Copies,
  groups: readonly TranslationGroup[]
): Promise<{ mutations: Mutation[]; written: Written }> {
  const refresh = planTranslationRefresh({
    translated: merge.document,
    target,
    locale: context.language,
    sourceLocale: DEFAULT_LOCALE,
    excludedFields: TRANSLATION_EXCLUDED_FIELDS,
    groups,
  });
  const record = recordFor(context, refresh.document);

  refresh.document[AI_TRANSLATION_FIELD] = record;
  refresh.set[AI_TRANSLATION_FIELD] = record;

  const markdown = await markdownFor(client, context, refresh.document);
  const stored = refresh.document.agentMarkdown;
  const changed = markdown.text !== undefined && (!isPlainObject(stored) || stored.content !== markdown.text);

  if (changed && isPlainObject(stored)) {
    refresh.set["agentMarkdown.content"] = markdown.text;
  } else if (changed) {
    refresh.set.agentMarkdown = { content: markdown.text };
  }

  return {
    mutations: refreshMutations(refresh),
    written: {
      created: false,
      targetId: refresh.targetId,
      draftId: refresh.draftId,
      uri: uriOf(refresh.document),
      ...(refresh.publishedRev ? { publishedRev: refresh.publishedRev } : {}),
      ...markdownStatus(markdown, changed),
    },
  };
}

/** Steps 8 to 10: the guard, then one transaction; only a conflict on the group alone is retried without asking. */
export async function writeTranslation(client: SanityClient, context: WriteContext, initial: PairReads): Promise<WriteOutcome> {
  let merge: MergeResult;
  let groups: TranslationGroup[];

  try {
    merge = mergeTranslation(context.source, context.result);
    groups = await readVariantGroups(
      client,
      collectReferences(merge.document).map(({ ref }) => ref)
    );
  } catch (error) {
    console.error("[ai-translate] The result could not be prepared:", error);

    return { ok: false, code: "write_failed" };
  }

  const sourceId = getPublishedId(context.source._id);

  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
    // Read again before every write: a publish during the agent call leaves no revision for a `create` to conflict on.
    const reads = await readPair(client, sourceId, context.language).catch((error: unknown) => {
      console.error("[ai-translate] The pair could not be re-read before writing:", error);

      return undefined;
    });

    if (!reads) {
      return { ok: false, code: "write_failed", merge };
    }

    // Someone's draft, a publish or a new translation (in a release too) since the first read: keep the paid result.
    if ((attempt > 0 && initial.target) || targetMoved(initial, reads) || reads.releaseOnly) {
      return { ok: false, code: "conflict", statusNow: pairStatus(reads, context.source), merge };
    }

    let claim: UriClaim = {};

    try {
      if (!reads.target) {
        const unlinkedId = await findHolder(client, context.source, context.language);

        if (unlinkedId) {
          return { ok: false, code: "unlinked_translation", merge, unlinkedId };
        }

        claim = await claimTranslationUri(client, context, merge.document);
      }

      const { mutations, written } = reads.target
        ? await planRefreshWrite(client, context, merge, reads.target, groups)
        : await planStubWrite(client, context, merge, reads, groups, claim.uri);
      const documents = await client.mutate(mutations, { returnDocuments: true, visibility: "sync" });
      const rev = revisionOf(documents, written.draftId);
      const { publishedRev } = written;

      // A draft made from a published copy published over since would put that older copy back live.
      if (publishedRev && !(await keepIfPublishedUnchanged(client, written.draftId, { rev, publishedRev }))) {
        return { ok: false, code: "conflict", merge };
      }

      return { ok: true, merge, ...written, rev };
    } catch (error) {
      if (!isConflict(error)) {
        console.error("[ai-translate] The translation could not be written:", error);

        return { ok: false, code: "write_failed", merge };
      }
    } finally {
      if (claim.lease) {
        await releaseUriLease(client, claim.lease);
      }
    }
  }

  return { ok: false, code: "conflict", merge };
}

/** The target appeared, went, or any copy of it changed revision since `before` was read. */
function targetMoved(before: PairReads, after: PairReads): boolean {
  if (!before.target || !after.target) {
    return before.target !== after.target;
  }

  return (
    before.target.id !== after.target.id ||
    before.target.draft?._rev !== after.target.draft?._rev ||
    before.target.published?._rev !== after.target.published?._rev
  );
}
