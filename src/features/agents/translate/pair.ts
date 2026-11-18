import { getPublishedId } from "@sanity/client/csm";
import { acquireLease, readResult, releaseLease, type SavedResult, saveResult } from "~/features/agents/ai-ledger";
import type { AgentMarkdownStatus } from "~/features/agents/translation-markdown";
import { fingerprint } from "~/sanity/ai-translation/fingerprint";
import { needsWork, readRecord, requiresOverwrite } from "~/sanity/ai-translation/plan";
import { buildTranslateRequest } from "~/sanity/ai-translation/request";
import { buildStyleGuide, mergeProtectedPhrases } from "~/sanity/ai-translation/style-guide";
import {
  type ApplyInput,
  type DiscardInput,
  type DiscardResult,
  type PairInput,
  type PairResult,
  TRANSLATE_MESSAGES,
  type TranslateCode,
} from "~/sanity/ai-translation/wire";
import { I18N_DOCUMENT_TYPES, SANITY_AGENT_SCHEMA_ID } from "~/sanity/constants";
import { DEFAULT_LOCALE, getLocaleTitle } from "~/sanity/i18n";
import type { TranslationDocument } from "~/sanity/translation-stub";
import { agentFailure, spendOneCredit } from "./credit";
import { reportedPaths, type WriteContext, writeTranslation } from "./pair-write";
import { discardOwnDraft, publishDraft } from "./publish";
import { currentTarget, findHolder, type PairReads, pairStatus, readPair } from "./reads";
import { isString, retried, SOURCE_LANGUAGE, type TranslateDeps } from "./shared";
import { deleteScratch, markTimeout, TOO_LARGE_AFTER_MS } from "./timeout";

/** A pair's answer: the contract's fields, and what the write did with the translation's agent Markdown. */
export type TranslatedPair = PairResult & { agentMarkdown?: AgentMarkdownStatus };

type Outcome = Omit<TranslatedPair, "sourceId" | "language" | "durationMs">;

export function refused(code: TranslateCode, error: string, extra: Partial<Outcome> = {}): Outcome {
  return { status: "refused", code, error, creditSpent: false, ...extra };
}

/** Writes the guarded result, publishes it when asked, and deletes the scratch copy once it is in. */
async function commit(
  deps: TranslateDeps,
  context: WriteContext,
  reads: PairReads,
  /** `replacesSaved`: an older saved result for the pair, stale once this one is written. */
  options: { publish: boolean; creditSpent: boolean; saved: boolean; replacesSaved?: boolean }
): Promise<Outcome> {
  const { client } = deps;
  const pair = { sourceId: getPublishedId(context.source._id), language: context.language };
  const outcome = await writeTranslation(client, context, reads);
  const stats = outcome.merge
    ? {
        stats: outcome.merge.stats,
        keptPaths: reportedPaths(outcome.merge.keptPaths),
        guardedPaths: reportedPaths(outcome.merge.guardedPaths),
      }
    : {};

  if (!outcome.ok) {
    if (!options.saved) {
      return {
        status: "failed",
        code: "write_failed",
        error: TRANSLATE_MESSAGES.lost,
        creditSpent: options.creditSpent,
        ...stats,
      };
    }

    return {
      status: "saved_result",
      code: outcome.code,
      message: TRANSLATE_MESSAGES[outcome.code],
      creditSpent: options.creditSpent,
      ...(outcome.statusNow ? { statusNow: outcome.statusNow } : {}),
      ...(outcome.unlinkedId ? { unlinkedId: outcome.unlinkedId } : {}),
      ...stats,
    };
  }

  const publishing = options.publish ? await publishDraft(client, outcome.draftId, outcome.rev, outcome.publishedRev) : undefined;

  // Refused because its published copy changed after the write: discarded, as the write itself would have been.
  if (
    publishing === "conflict" &&
    outcome.publishedRev &&
    options.saved &&
    (await discardOwnDraft(client, outcome.draftId, outcome.rev))
  ) {
    return {
      status: "saved_result",
      code: "conflict",
      message: TRANSLATE_MESSAGES.conflict,
      creditSpent: options.creditSpent,
      ...stats,
    };
  }

  const published = publishing === "published";

  if (options.saved || options.replacesSaved) {
    await retried(() => deleteScratch(client, pair)).catch((error: unknown) =>
      console.error("[ai-translate] Scratch result kept:", error)
    );
  }

  return {
    status: "translated",
    creditSpent: options.creditSpent,
    targetId: outcome.targetId,
    draftId: outcome.draftId,
    ...(outcome.uri ? { uri: outcome.uri } : {}),
    created: outcome.created,
    published,
    ...(outcome.agentMarkdown ? { agentMarkdown: outcome.agentMarkdown } : {}),
    ...stats,
  };
}

/** The lease around a pair: claimed before anything is read, released however the pair ends. */
export async function withLease<T extends { status: string; creditSpent: boolean }>(
  deps: TranslateDeps,
  pair: { sourceId: string; language: string },
  run: () => Promise<T>,
  busy: () => T
): Promise<T> {
  const now = deps.now ?? (() => new Date());
  const claim = await acquireLease(deps.client, { ...pair, now: now() });

  if (!claim.acquired) {
    return busy();
  }

  try {
    return await run();
  } finally {
    await releaseLease(deps.client, claim.lease).catch((error: unknown) => {
      console.error("[ai-translate] The lease could not be released; it expires on its own:", error);
    });
  }
}

function sourceVersion(reads: PairReads, version: "published" | "draft"): TranslationDocument | undefined {
  return version === "draft" ? reads.source.draft : reads.source.published;
}

/** Why `source` cannot be translated from, if it cannot. */
export function sourceProblem(source: TranslationDocument | undefined): Outcome | undefined {
  if (!source) {
    return refused("source_not_found", TRANSLATE_MESSAGES.source_not_found);
  }

  if (!I18N_DOCUMENT_TYPES.includes(source._type)) {
    return refused("not_a_source", TRANSLATE_MESSAGES.not_a_source);
  }

  if (typeof source.language !== "string" || source.language === "") {
    return refused("missing_language", TRANSLATE_MESSAGES.missing_language);
  }

  return source.language === DEFAULT_LOCALE ? undefined : refused("not_a_source", TRANSLATE_MESSAGES.not_a_source);
}

/** A row naming another language's document (a hand-edited group), one only a release holds, or a second group. */
function targetProblem(reads: PairReads, language: string): Outcome | undefined {
  const current = currentTarget(reads);

  if (reads.releaseOnly) {
    return refused("in_release", TRANSLATE_MESSAGES.in_release, { targetId: reads.releaseOnly });
  }

  // The oldest group has no translation here, but the other may: a new one could be a second document.
  if (!current && (reads.group?.groupCount ?? 0) > 1) {
    return refused("two_groups", TRANSLATE_MESSAGES.two_groups);
  }

  return current && current.language !== language
    ? refused("wrong_target_language", TRANSLATE_MESSAGES.wrong_target_language)
    : undefined;
}

/** The translation carries the `translatedAt` this result writes: it is in, and only deleting its scratch copy failed. */
export function isAppliedResult(
  saved: Pick<SavedResult<unknown>, "meta" | "savedAt">,
  target: Record<string, unknown> | undefined
): boolean {
  const translatedAt = typeof saved.meta.translatedAt === "string" ? saved.meta.translatedAt : saved.savedAt;

  return isString(translatedAt) && readRecord(target)?.translatedAt === translatedAt;
}

/** A saved result is free to apply: answer with it unless `overwrite` asks to pay again. */
function savedResultProblem(
  saved: Pick<SavedResult<unknown>, "meta" | "savedAt"> | null,
  target: Record<string, unknown> | undefined,
  overwrite: boolean
): Outcome | undefined {
  if (!saved || overwrite || isAppliedResult(saved, target)) {
    return undefined;
  }

  return {
    status: "saved_result",
    code: "saved_result_exists",
    message: TRANSLATE_MESSAGES.saved_result_exists,
    creditSpent: false,
  };
}

async function schemaProblem(deps: TranslateDeps): Promise<Outcome | undefined> {
  const check = deps.schemaCheck ? await deps.schemaCheck() : undefined;

  return check && check.drift.length > 0
    ? refused("schema_drift", TRANSLATE_MESSAGES.schema_drift, { drift: check.drift })
    : undefined;
}

/** No new translation where one in that language already sits unlinked: it would be a second homepage, person or Site. */
async function unlinkedProblem(deps: TranslateDeps, reads: PairReads, source: TranslationDocument, language: string) {
  if (reads.target) {
    return undefined;
  }

  const unlinkedId = await findHolder(deps.client, source, language);

  return unlinkedId ? refused("unlinked_translation", TRANSLATE_MESSAGES.unlinked_translation, { unlinkedId }) : undefined;
}

function outOfTime(extra: Partial<Outcome> = {}): Outcome {
  return { status: "busy", code: "out_of_time", message: TRANSLATE_MESSAGES.out_of_time, creditSpent: false, ...extra };
}

function busyPair(): Outcome {
  return { status: "busy", code: "busy", message: TRANSLATE_MESSAGES.busy, creditSpent: false };
}

function decorate(pair: { sourceId: string; language: string }, started: number) {
  return (outcome: Outcome): TranslatedPair => ({
    ...pair,
    ...outcome,
    durationMs: Date.now() - started,
  });
}

/** One source into one language, at most one billed call. Steps: docs/features/ai-translation.md */
export async function translatePair(deps: TranslateDeps, input: PairInput): Promise<TranslatedPair> {
  const pair = { sourceId: input.sourceId, language: input.language };
  const finish = decorate(pair, Date.now());

  return finish(await withLease(deps, pair, () => runPair(deps, input), busyPair));
}

async function runPair(deps: TranslateDeps, input: PairInput): Promise<Outcome> {
  const { client } = deps;
  const now = deps.now ?? (() => new Date());
  const reads = await readPair(client, input.sourceId, input.language);
  const source = sourceVersion(reads, input.version);
  const problem = sourceProblem(source);

  if (problem || !source) {
    return problem ?? refused("source_not_found", TRANSLATE_MESSAGES.source_not_found);
  }

  const mislinked = targetProblem(reads, input.language);

  if (mislinked) {
    return mislinked;
  }

  const status = pairStatus(reads, source);

  if (!needsWork(status, input.overwrite)) {
    return {
      status: "skipped",
      code: "skipped",
      message: TRANSLATE_MESSAGES.skipped,
      previousStatus: status,
      creditSpent: false,
    };
  }

  const unlinked = await unlinkedProblem(deps, reads, source, input.language);

  if (unlinked) {
    return { ...unlinked, previousStatus: status };
  }

  const savedBefore = await readResult(client, { sourceId: input.sourceId, language: input.language });
  const waiting = savedResultProblem(savedBefore, currentTarget(reads), input.overwrite);

  if (waiting) {
    return { ...waiting, previousStatus: status };
  }

  const to = { id: input.language, title: getLocaleTitle(input.language) };
  const guide = buildStyleGuide(reads.settings, to, input.instructions);

  if (!guide.ok) {
    return refused("style_guide_too_long", guide.message);
  }

  const drifted = await schemaProblem(deps);

  if (drifted) {
    return drifted;
  }

  if (deps.signal?.aborted) {
    return {
      status: "skipped",
      code: "aborted",
      message: TRANSLATE_MESSAGES.aborted,
      previousStatus: status,
      creditSpent: false,
    };
  }

  const request = buildTranslateRequest({
    schemaId: SANITY_AGENT_SCHEMA_ID,
    documentId: source._id,
    type: source._type,
    document: source,
    from: SOURCE_LANGUAGE,
    to,
    styleGuide: guide.styleGuide,
    protectedPhrases: mergeProtectedPhrases(
      reads.settings.protectedPhrases,
      reads.siteName ? [reads.siteName] : [],
      reads.personNames
    ),
  });
  const spend = await spendOneCredit(
    deps,
    { maxCreditsPerDay: reads.settings.defaults.maxCreditsPerDay, label: `${input.sourceId} -> ${input.language}` },
    (agent) => agent.agent.action.translate(request)
  );

  if (!spend.ok) {
    switch (spend.reason) {
      case "out_of_time":
        return outOfTime({ previousStatus: status, ...(spend.credits ? { credits: spend.credits } : {}) });
      case "daily_cap":
        return refused("daily_cap", TRANSLATE_MESSAGES.daily_cap, { credits: spend.credits });
      case "agent_error":
        if (spend.error.code === "timeout" && spend.ranMs >= TOO_LARGE_AFTER_MS) {
          await retried(() => markTimeout(client, input, fingerprint(source).textHash, now())).catch((error: unknown) =>
            console.error("[ai-translate] The timeout could not be noted; a bulk run may try this pair again:", error)
          );
        }

        return { ...agentFailure(spend.error, spend.credits), previousStatus: status };
    }
  }

  const { value: result, credits } = spend;
  const translatedAt = now().toISOString();
  const print = fingerprint(source);
  const slugs = input.slugs ?? reads.settings.defaults.slugs;
  const publish = input.publish ?? reads.settings.defaults.afterTranslate === "publish";
  const saved = await retried(() =>
    saveResult(client, {
      sourceId: input.sourceId,
      language: input.language,
      result,
      now: now(),
      meta: {
        version: input.version,
        sourceRev: typeof source._rev === "string" ? source._rev : null,
        sourceTextHash: print.textHash,
        sourceLayoutHash: print.layoutHash,
        slugs,
        publish,
        translatedAt,
      },
    })
  )
    .then(() => true)
    .catch((error: unknown) => {
      console.error("[ai-translate] The paid result could not be kept:", error);

      return false;
    });
  const context = {
    source,
    result,
    language: input.language,
    slugs,
    translatedAt,
    siteUrl: deps.siteUrl,
    studioPaths: deps.studioPaths ?? [],
  };
  const outcome = await commit(deps, context, reads, {
    publish,
    creditSpent: true,
    saved,
    replacesSaved: savedBefore !== null,
  });

  return { ...outcome, previousStatus: status, credits };
}

/** "Apply saved result (free)": the paid result kept after a conflict or a failed write, written now on purpose. */
export async function applySavedResult(deps: TranslateDeps, input: ApplyInput): Promise<TranslatedPair> {
  const pair = { sourceId: input.sourceId, language: input.language };
  const finish = decorate(pair, Date.now());

  return finish(
    await withLease(
      deps,
      pair,
      async () => {
        const saved = await readResult(deps.client, pair);

        if (!saved) {
          return refused("no_saved_result", TRANSLATE_MESSAGES.no_saved_result);
        }

        const meta = saved.meta;
        const reads = await readPair(deps.client, input.sourceId, input.language);
        // A draft translated then published is the published copy now: the paid result still applies, for free.
        const source = sourceVersion(reads, meta.version === "draft" ? "draft" : "published") ?? reads.source.published;
        const problem = sourceProblem(source);

        if (problem || !source) {
          return problem ?? refused("source_not_found", TRANSLATE_MESSAGES.source_not_found);
        }

        const mislinked = targetProblem(reads, input.language);

        if (mislinked) {
          return mislinked;
        }

        const unlinked = await unlinkedProblem(deps, reads, source, input.language);

        if (unlinked) {
          return unlinked;
        }

        const status = pairStatus(reads, source);

        // Someone's own text since the result was paid for, the edit a conflict kept: replaced only on purpose.
        if (requiresOverwrite(status) && input.overwrite !== true) {
          return refused("needs_overwrite", TRANSLATE_MESSAGES.needs_overwrite, { previousStatus: status });
        }

        const outcome = await commit(
          deps,
          {
            source,
            result: saved.result,
            language: input.language,
            slugs: meta.slugs === "keep" ? "keep" : "translate",
            translatedAt: typeof meta.translatedAt === "string" ? meta.translatedAt : saved.savedAt,
            siteUrl: deps.siteUrl,
            studioPaths: deps.studioPaths ?? [],
            sourcePrint: {
              ...(typeof meta.sourceRev === "string" ? { sourceRev: meta.sourceRev } : {}),
              ...(typeof meta.sourceTextHash === "string" ? { sourceTextHash: meta.sourceTextHash } : {}),
              ...(typeof meta.sourceLayoutHash === "string" ? { sourceLayoutHash: meta.sourceLayoutHash } : {}),
            },
          },
          reads,
          { publish: input.publish ?? meta.publish === true, creditSpent: false, saved: true }
        );

        return { ...outcome, previousStatus: status };
      },
      busyPair
    )
  );
}

/** "Discard saved result (free)": the paid result a conflict or a failed write kept, deleted under the pair's lease. */
export async function discardSavedResult(deps: TranslateDeps, input: DiscardInput): Promise<DiscardResult> {
  const pair = { sourceId: input.sourceId, language: input.language };
  const outcome = await withLease<Omit<DiscardResult, "sourceId" | "language">>(
    deps,
    pair,
    async () => {
      if (!(await readResult(deps.client, pair))) {
        return { status: "refused", code: "no_saved_result", error: TRANSLATE_MESSAGES.no_saved_result, creditSpent: false };
      }

      await retried(() => deleteScratch(deps.client, pair));

      return { status: "discarded", creditSpent: false };
    },
    () => ({ status: "busy", code: "busy", message: TRANSLATE_MESSAGES.busy, creditSpent: false })
  );

  return { ...pair, ...outcome };
}
