import type { Mutation, SanityClient } from "@sanity/client";
import { acquireLease, deleteResult, isConflict, readResult, releaseLease, saveResult } from "~/features/agents/ai-ledger";
import { isPlainObject } from "~/sanity/ai-translation/fields";
import { buildLabelsPrompt, LABEL_BATCH_SIZE, validateLabelsResult } from "~/sanity/ai-translation/labels";
import { planTranslations } from "~/sanity/ai-translation/plan";
import { mergeProtectedPhrases } from "~/sanity/ai-translation/style-guide";
import { type LabelsInput, type LabelsResult, labelsForHandMessage, TRANSLATE_MESSAGES } from "~/sanity/ai-translation/wire";
import { LOCALIZED_FIELDS } from "~/sanity/constants";
import { DEFAULT_LOCALE, LOCALES } from "~/sanity/i18n";
import { toPatchPath } from "~/sanity/lib/patch-path";
import type { TranslationDocument } from "~/sanity/translation-stub";
import { agentFailure, spendOneCredit } from "./credit";
import { type InPlaceDone, type SavedDocuments, translateInPlace } from "./in-place";
import { discardOwnDraft, keepIfPublishedUnchanged, publishDraft } from "./publish";
import { byPublishedId, readDocuments, readDocumentsOfTypes, readSettings } from "./reads";
import {
  defaultTargets,
  draftOf,
  isTargetLanguage,
  languagesOf,
  pastDeadline,
  revisionOf,
  SOURCE_LANGUAGE,
  type TranslateDeps,
} from "./shared";

/** `all` is never a locale, so this lease never collides with a pair's. */
export const LABELS_LEASE = { sourceId: "labels", language: "all" } as const;

type Names = Record<string, Record<string, string>>;

/** The labels pass's scratch result, under its lease: paid names not written yet, and names the AI failed or left out. */
type SavedLabels = {
  /** Paid names still to write, by id then language: the next `labels` request writes them first, for free. */
  pending: Names;
  /** The translated-in-place field each pending id's names go in. */
  fields: Record<string, string>;
  /** The English name each pending id's names translate: changed since, they are dropped and asked for again. */
  sources: Record<string, string>;
  /** Ids whose answer failed the checks, with the English name it failed on: never asked for again until it changes. */
  rejected: Record<string, string>;
  /** Ids the last answer left out, with their English name: a second miss in a row is rejected. */
  missed: Record<string, string>;
  /** A shared routed document's paid fields not written yet, by `<id>:<language>`. */
  documents: SavedDocuments;
};

function stringRecord(value: unknown): Record<string, string> {
  return isPlainObject(value)
    ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
    : {};
}

export async function readSavedLabels(client: SanityClient): Promise<SavedLabels> {
  const saved = await readResult<unknown>(client, LABELS_LEASE);
  const value = isPlainObject(saved?.result) ? saved.result : {};
  const pending = isPlainObject(value.pending) ? value.pending : {};
  const documents = isPlainObject(value.documents) ? value.documents : {};

  return {
    pending: Object.fromEntries(Object.entries(pending).map(([id, names]) => [id, stringRecord(names)])),
    fields: stringRecord(value.fields),
    sources: stringRecord(value.sources),
    rejected: stringRecord(value.rejected),
    missed: stringRecord(value.missed),
    documents: Object.fromEntries(
      Object.entries(documents).flatMap(([key, entry]) =>
        isPlainObject(entry) && typeof entry.source === "string" && isPlainObject(entry.arms)
          ? [[key, { source: entry.source, arms: entry.arms }]]
          : []
      )
    ),
  };
}

/** Deleted once nothing is left in it. */
async function storeSavedLabels(client: SanityClient, saved: SavedLabels, now: Date): Promise<void> {
  const pendingOnly = (map: Record<string, string>) =>
    Object.fromEntries(Object.entries(map).filter(([id]) => Object.hasOwn(saved.pending, id)));

  if ([saved.pending, saved.rejected, saved.missed, saved.documents].every((map) => Object.keys(map).length === 0)) {
    await deleteResult(client, LABELS_LEASE);

    return;
  }

  await saveResult(client, {
    ...LABELS_LEASE,
    result: { ...saved, fields: pendingOnly(saved.fields), sources: pendingOnly(saved.sources) },
    now,
  });
}

/** Drafts this request created (`created`), with the revision it left and the published copy's it was made from. */
type LabelsWrite = InPlaceDone;

/** Each category's draft made from its published copy if need be, then only the empty arms filled: an editor's text wins. */
async function writeLabels(
  client: SanityClient,
  labels: Names,
  fields: Record<string, string>,
  sources: Record<string, string>,
  done: LabelsWrite,
  deadline?: number
): Promise<Names> {
  const copies = byPublishedId(await readDocuments(client, Object.keys(labels)));
  // Not written (out of time, a conflict, a refused write): kept for the next request.
  const left: Names = {};

  for (const [id, names] of Object.entries(labels)) {
    if (pastDeadline(deadline)) {
      left[id] = names;
      continue;
    }

    const { published, draft } = copies.get(id) ?? {};
    const current = draft ?? published;
    const field = fields[id];
    const arms = field && current && isPlainObject(current[field]) ? (current[field] as Record<string, unknown>) : undefined;

    if (!current || !field || !arms) {
      continue;
    }

    const english = typeof arms[DEFAULT_LOCALE] === "string" ? arms[DEFAULT_LOCALE].trim() : "";

    // Translated from an English name changed since: dropped, so the plan asks for the new one.
    if (Object.hasOwn(sources, id) && sources[id] !== english) {
      continue;
    }

    const setIfMissing: Record<string, string> = {};
    const set: Record<string, string> = {};

    // A language taken out of LOCALES since these were paid for is never written back.
    for (const [language, name] of Object.entries(names).filter(([locale]) => isTargetLanguage(locale))) {
      const path = toPatchPath([field, language]);
      const arm = arms[language];

      if (arm === undefined || arm === null) {
        setIfMissing[path] = name;
      } else if (typeof arm !== "string" || arm.trim() === "") {
        // The plan counts anything but text as missing: skipping it here would bill the same name on every run.
        set[path] = name;
      }
    }

    if (Object.keys(setIfMissing).length === 0 && Object.keys(set).length === 0) {
      continue;
    }

    const draftId = `drafts.${id}`;
    const publishedRev = typeof published?._rev === "string" ? published._rev : undefined;
    // `create`, so an editor's draft that appeared since the read conflicts rather than taking these names.
    const mutations: Mutation[] = [
      ...(draft ? [] : [{ create: draftOf(published as TranslationDocument) }]),
      {
        patch: {
          id: draftId,
          ...(draft && typeof draft._rev === "string" ? { ifRevisionID: draft._rev } : {}),
          ...(Object.keys(setIfMissing).length > 0 ? { setIfMissing } : {}),
          ...(Object.keys(set).length > 0 ? { set } : {}),
        },
      },
    ];

    try {
      const documents = await client.mutate(mutations, { returnDocuments: true, visibility: "sync" });

      if (!draft) {
        const rev = revisionOf(documents, draftId);

        if (!(await keepIfPublishedUnchanged(client, draftId, { rev, publishedRev }))) {
          left[id] = names;
          done.conflicts.push(id);
          continue;
        }

        done.created.set(id, { rev, publishedRev });
      }

      done.written[id] = names;
    } catch (error) {
      left[id] = names;

      if (isConflict(error)) {
        done.conflicts.push(id);
      } else {
        console.error(`[ai-translate] The names of ${id} could not be written; the next labels request tries again:`, error);
        done.failed.push(id);
      }
    }
  }

  return left;
}

/** Category names (`LOCALIZED_FIELDS`): one `prompt` per batch of 50, every language at once, checked strictly; then a
 * shared routed document (a person), one schema-aware call per language (`translateInPlace`). */
export async function translateLabels(deps: TranslateDeps, input: LabelsInput): Promise<LabelsResult> {
  const started = Date.now();
  const { client, deadline } = deps;
  const now = deps.now ?? (() => new Date());
  const { settings, siteName, personNames } = await readSettings(client);
  const languages = input.languages ?? defaultTargets(settings);
  const base = { languages: [...languages], creditSpent: false, remaining: 0 };
  const finish = (result: Partial<LabelsResult> & Pick<LabelsResult, "status">): LabelsResult => ({
    ...base,
    ...result,
    durationMs: Date.now() - started,
  });

  if (languages.length === 0 || !languages.every(isTargetLanguage)) {
    return finish({ status: "refused", code: "bad_input", error: "Name at least one target language." });
  }

  // One lease for every batch: two batches over overlapping languages would both pay for the same names.
  const claim = await acquireLease(client, { ...LABELS_LEASE, now: now() });

  if (!claim.acquired) {
    return finish({ status: "busy", code: "busy", message: TRANSLATE_MESSAGES.busy });
  }

  try {
    const publish = input.publish ?? settings.defaults.afterTranslate === "publish";
    const saved = await readSavedLabels(client);
    const done: LabelsWrite = { written: {}, conflicts: [], failed: [], created: new Map() };
    let stored = JSON.stringify(saved);
    const keep = async () => {
      const next = JSON.stringify(saved);

      if (next !== stored) {
        await storeSavedLabels(client, saved, now())
          .then(() => {
            stored = next;
          })
          .catch((error: unknown) => console.error("[ai-translate] The paid category names could not be kept:", error));
      }
    };
    // Only drafts this request created: publishing an existing draft would publish an editor's unfinished work.
    const settle = async (result: Partial<LabelsResult> & Pick<LabelsResult, "status">): Promise<LabelsResult> => {
      const published: string[] = [];
      const drafts: Record<string, string> = {};

      for (const [id, { rev, publishedRev }] of done.created) {
        const draftId = `drafts.${id}`;
        const outcome = publish && !pastDeadline(deadline) ? await publishDraft(client, draftId, rev, publishedRev) : undefined;

        if (outcome === "published") {
          published.push(id);
        } else if (outcome === "conflict" && done.written[id] && (await discardOwnDraft(client, draftId, rev))) {
          // Its published copy changed since the draft was made from it: the paid names wait for the next request.
          saved.pending[id] = done.written[id];
          delete done.written[id];
          done.conflicts.push(id);
        } else if (rev) {
          drafts[id] = rev;
        }
      }

      await keep();

      const written = Object.keys(done.written);

      return finish({
        ...(written.length > 0 || result.status === "translated"
          ? { labels: done.written, written, conflicts: done.conflicts, published }
          : {}),
        ...(done.failed.length > 0 ? { failed: done.failed } : {}),
        ...(Object.keys(drafts).length > 0 ? { drafts } : {}),
        ...result,
      });
    };

    // A paid answer an earlier request could not finish writing goes in first, for free.
    if (Object.keys(saved.pending).length > 0) {
      saved.pending = await writeLabels(client, saved.pending, saved.fields, saved.sources, done, deadline);
      await keep();
    }

    const labelTypes = Object.keys(LOCALIZED_FIELDS);
    const documents = input.ids ? await readDocuments(client, input.ids) : await readDocumentsOfTypes(client, labelTypes);
    const plan = planTranslations({
      documents: [],
      groups: [],
      labelDocuments: documents.filter((document) => labelTypes.includes(document._type)),
      locales: LOCALES.map(({ id, title }) => ({ id, title })),
      defaultLocale: DEFAULT_LOCALE,
      languages,
      rejectedLabels: saved.rejected,
    });
    const stillRejected = new Set(plan.labels.filter(({ handFix }) => handFix === "rejectedBefore").map(({ id }) => id));
    const stillMissing = new Set(plan.labels.map(({ id }) => id));
    const inScope = (id: string) => !input.ids || input.ids.includes(id);

    // A name changed, filled by hand or gone is not left for a hand fix any more.
    for (const id of Object.keys(saved.rejected)) {
      if (inScope(id) && !stillRejected.has(id)) {
        delete saved.rejected[id];
      }
    }

    for (const id of Object.keys(saved.missed)) {
      if (inScope(id) && !stillMissing.has(id)) {
        delete saved.missed[id];
      }
    }

    await keep();

    const askable = plan.labels.filter(({ handFix, kind }) => !handFix && kind !== "document");
    const inPlace = plan.labels.filter(({ handFix, kind }) => !handFix && kind === "document");
    const documentLanguages = inPlace.reduce((total, { missing }) => total + missing.length, 0);
    const batch = askable.slice(0, LABEL_BATCH_SIZE);
    const remaining = askable.length - batch.length + documentLanguages;
    const forHand = plan.labels.filter(({ handFix }) => handFix).length;

    if (batch.length === 0) {
      const next = inPlace[0];
      const language = next?.missing[0];

      // Names first: a document's own call waits for a request with no batch of names left to send.
      if (next && language) {
        return settle(
          await translateInPlace(deps, {
            item: next,
            language,
            settings,
            siteName,
            personNames,
            saved,
            done,
            keep,
            remaining: documentLanguages - 1,
          })
        );
      }

      if (Object.keys(done.written).length > 0) {
        return settle({ status: "translated" });
      }

      return settle(
        forHand > 0
          ? { status: "skipped", code: "labels_left_for_hand", message: labelsForHandMessage(forHand) }
          : { status: "skipped", code: "nothing_missing", message: TRANSLATE_MESSAGES.nothing_missing }
      );
    }

    const prompt = buildLabelsPrompt({
      labels: batch.map(({ id, text }) => ({ id, text })),
      from: SOURCE_LANGUAGE,
      to: languagesOf(languages),
      styleGuide: settings.styleGuide,
      protectedPhrases: mergeProtectedPhrases(settings.protectedPhrases, siteName ? [siteName] : [], personNames),
    });
    const spend = await spendOneCredit(
      deps,
      { maxCreditsPerDay: settings.defaults.maxCreditsPerDay, label: `labels -> ${languages.join(",")}` },
      (agent) => agent.agent.action.prompt(prompt)
    );

    if (!spend.ok) {
      switch (spend.reason) {
        case "out_of_time":
          return settle({
            status: "busy",
            code: "out_of_time",
            message: TRANSLATE_MESSAGES.out_of_time,
            ...(spend.credits ? { credits: spend.credits } : {}),
            remaining: askable.length + documentLanguages,
          });
        case "daily_cap":
          return settle({
            status: "refused",
            code: "daily_cap",
            error: TRANSLATE_MESSAGES.daily_cap,
            credits: spend.credits,
            remaining: askable.length + documentLanguages,
          });
        case "agent_error":
          return settle({ ...agentFailure(spend.error, spend.credits), remaining: askable.length + documentLanguages });
      }
    }

    const { value: answer, credits } = spend;
    const check = validateLabelsResult(answer, {
      ids: batch.map(({ id }) => id),
      languages,
      sources: Object.fromEntries(batch.map(({ id, text }) => [id, text])),
    });
    const spent = { creditSpent: true, credits };
    const valid = Object.keys(check.labels);
    const rejected: string[] = [];
    const missed: string[] = [];

    for (const { id, field, text } of batch) {
      const isMissing = check.missing.includes(id);

      if (check.labels[id]) {
        saved.pending[id] = check.labels[id];
        saved.fields[id] = field;
        saved.sources[id] = text;
        delete saved.missed[id];
      } else if (check.invalid.includes(id) || (isMissing && saved.missed[id] === text)) {
        // A name that failed the checks, or one left out twice running: asking again would bill for the same answer.
        saved.rejected[id] = text;
        delete saved.missed[id];
        rejected.push(id);
      } else if (isMissing) {
        saved.missed[id] = text;
        missed.push(id);
      }
    }

    const checked = {
      ...(check.problems.length > 0 ? { problems: check.problems.length } : {}),
      ...(rejected.length > 0 ? { invalid: rejected } : {}),
    };

    // Kept before anything is written, as a pair's paid result is.
    await keep();

    if (valid.length === 0) {
      return settle({
        status: "failed",
        code: "invalid_labels",
        error: TRANSLATE_MESSAGES.invalid_labels,
        remaining: askable.length - rejected.length + documentLanguages,
        ...checked,
        ...spent,
      });
    }

    const fields = Object.fromEntries(batch.map(({ id, field }) => [id, field]));
    const left = await writeLabels(client, check.labels, fields, saved.sources, done, deadline);

    for (const id of valid) {
      if (!Object.hasOwn(left, id)) {
        delete saved.pending[id];
      }
    }

    await keep();

    return settle({
      status: "translated",
      remaining: remaining + Object.keys(left).length + missed.length,
      ...(rejected.length > 0 ? { message: TRANSLATE_MESSAGES.labels_left_for_hand } : {}),
      ...checked,
      ...spent,
    });
  } finally {
    await releaseLease(client, claim.lease).catch((error: unknown) => console.error(error));
  }
}
