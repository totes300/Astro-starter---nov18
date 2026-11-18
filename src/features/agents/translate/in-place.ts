import type { Mutation, SanityClient } from "@sanity/client";
import { isConflict } from "~/features/agents/ai-ledger";
import { translationMarkdown } from "~/features/agents/translation-markdown";
import { isPlainObject } from "~/sanity/ai-translation/fields";
import {
  buildInPlaceRequest,
  inPlaceSourceKey,
  isFilledArm,
  missingArms,
  sourceFields,
  translatedArms,
  translatedInPlaceFields,
  valueAtPath,
} from "~/sanity/ai-translation/in-place";
import type { LabelItem } from "~/sanity/ai-translation/plan";
import { buildStyleGuide, mergeProtectedPhrases, type TranslationSettings } from "~/sanity/ai-translation/style-guide";
import { type LabelsResult, TRANSLATE_MESSAGES } from "~/sanity/ai-translation/wire";
import { LOCALIZED_FIELDS, SANITY_AGENT_SCHEMA_ID } from "~/sanity/constants";
import { DEFAULT_LOCALE, getLocaleTitle } from "~/sanity/i18n";
import { toPatchPath } from "~/sanity/lib/patch-path";
import { localizeDocumentPath } from "~/sanity/sections";
import type { TranslationDocument } from "~/sanity/translation-stub";
import { agentFailure, spendOneCredit } from "./credit";
import { keepIfPublishedUnchanged } from "./publish";
import { byPublishedId, readDocuments } from "./reads";
import { draftOf, revisionOf, SOURCE_LANGUAGE, type TranslateDeps, uriOf } from "./shared";

const FIELDS: Readonly<Record<string, readonly string[]>> = LOCALIZED_FIELDS;

const MARKDOWN_FIELD = "agentMarkdown.content";

/** A paid answer not written yet, by `<id>:<language>`, with the source it was made from. */
export type SavedDocuments = Record<string, { source: string; arms: Record<string, unknown> }>;

export const savedDocumentKey = (id: string, language: string) => `${id}:${language}`;

export type InPlaceDone = {
  written: Record<string, Record<string, string>>;
  conflicts: string[];
  failed: string[];
  created: Map<string, { rev?: string; publishedRev?: string }>;
};

type InPlaceContext = {
  item: LabelItem;
  language: string;
  settings: TranslationSettings;
  siteName?: string;
  personNames: readonly string[];
  saved: { documents: SavedDocuments; rejected: Record<string, string> };
  done: InPlaceDone;
  /** Kept before anything is written, as a pair's paid result is. */
  keep: () => Promise<void>;
  remaining: number;
};

type Outcome = Partial<LabelsResult> & Pick<LabelsResult, "status">;

/** The document as it reads in `language`: its page's URL there, and the arms about to be written. */
function inLanguage(current: TranslationDocument, arms: Record<string, unknown>, language: string): TranslationDocument {
  const document = structuredClone(current);
  const uri = uriOf(document);

  for (const [field, value] of Object.entries(arms)) {
    const path = [...field.split("."), language];
    let parent: Record<string, unknown> = document;

    for (const key of path.slice(0, -1)) {
      parent[key] = isPlainObject(parent[key]) ? parent[key] : {};
      parent = parent[key] as Record<string, unknown>;
    }

    parent[path.at(-1) as string] = value;
  }

  return uri
    ? { ...document, uri: { ...(document.uri as object), current: localizeDocumentPath(document._type, language, uri) } }
    : document;
}

/** The language's own agent Markdown from the arms being written; none when serving is off or it is already there. */
async function markdownArm(
  deps: TranslateDeps,
  current: TranslationDocument,
  arms: Record<string, unknown>,
  language: string
): Promise<Record<string, unknown>> {
  const fields = FIELDS[current._type] ?? [];
  const serving = (current.agentMarkdown as { enabled?: boolean } | undefined)?.enabled !== false;
  const stored = valueAtPath(current, MARKDOWN_FIELD);

  if (!fields.includes(MARKDOWN_FIELD) || !serving || (isPlainObject(stored) && isFilledArm(stored[language]))) {
    return {};
  }

  try {
    const text = await translationMarkdown(deps.client, inLanguage(current, arms, language), { language, siteUrl: deps.siteUrl });

    return text ? { [MARKDOWN_FIELD]: text } : {};
  } catch (error) {
    console.error(`[ai-translate] The ${language} agent Markdown of ${current._id} was left to Generate:`, error);

    return {};
  }
}

/** Only the empty arms, in a draft made from the published copy if need be: an editor's text always wins. */
async function writeArms(
  client: SanityClient,
  id: string,
  language: string,
  arms: Record<string, unknown>,
  done: InPlaceDone
): Promise<"written" | "conflict" | "failed" | "nothing"> {
  const { published, draft } = byPublishedId(await readDocuments(client, [id])).get(id) ?? {};
  const current = draft ?? published;

  if (!current) {
    return "nothing";
  }

  const parents: Record<string, unknown> = {};
  const setIfMissing: Record<string, unknown> = {};
  const set: Record<string, unknown> = {};

  for (const [field, value] of Object.entries(arms)) {
    const segments = field.split(".");
    const arm = valueAtPath(current, [...segments, language].join("."));

    segments.forEach((_, index) => {
      parents[toPatchPath(segments.slice(0, index + 1))] = {};
    });

    if (arm === undefined || arm === null) {
      setIfMissing[toPatchPath([...segments, language])] = value;
    } else if (!isFilledArm(arm)) {
      set[toPatchPath([...segments, language])] = value;
    }
  }

  if (Object.keys(setIfMissing).length === 0 && Object.keys(set).length === 0) {
    return "nothing";
  }

  const draftId = `drafts.${id}`;
  const publishedRev = typeof published?._rev === "string" ? published._rev : undefined;
  // `create`, so an editor's draft that appeared since the read conflicts rather than taking these arms.
  const mutations: Mutation[] = [
    ...(draft ? [] : [{ create: draftOf(published as TranslationDocument) }]),
    {
      patch: {
        id: draftId,
        ...(draft && typeof draft._rev === "string" ? { ifRevisionID: draft._rev } : {}),
        setIfMissing: parents,
      },
    },
    {
      patch: {
        id: draftId,
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
        done.conflicts.push(id);

        return "conflict";
      }

      done.created.set(id, { rev, publishedRev });
    }

    return "written";
  } catch (error) {
    if (isConflict(error)) {
      done.conflicts.push(id);

      return "conflict";
    }

    console.error(`[ai-translate] The ${language} fields of ${id} could not be written; the next request tries again:`, error);
    done.failed.push(id);

    return "failed";
  }
}

/** One shared routed document into one language: at most one billed call, its answer kept until it is written. */
export async function translateInPlace(deps: TranslateDeps, context: InPlaceContext): Promise<Outcome> {
  const { client } = deps;
  const { item, language, saved, done } = context;
  const { published, draft } = byPublishedId(await readDocuments(client, [item.id])).get(item.id) ?? {};
  const current = draft ?? published;
  const fields = translatedInPlaceFields(current ? (FIELDS[current._type] ?? []) : []);
  const missing = missingArms(current, fields, language, DEFAULT_LOCALE);
  const key = savedDocumentKey(item.id, language);

  if (!current || missing.length === 0) {
    delete saved.documents[key];

    return {
      status: "skipped",
      code: "nothing_missing",
      message: TRANSLATE_MESSAGES.nothing_missing,
      remaining: context.remaining,
    };
  }

  const source = inPlaceSourceKey(current, missing, DEFAULT_LOCALE);
  const pending = saved.documents[key]?.source === source ? saved.documents[key]?.arms : undefined;
  let spent: Pick<LabelsResult, "creditSpent" | "credits"> = { creditSpent: false };
  let arms = pending;

  if (!arms) {
    const to = { id: language, title: getLocaleTitle(language) };
    const guide = buildStyleGuide(context.settings, to);

    if (!guide.ok) {
      return { status: "refused", code: "style_guide_too_long", error: guide.message, remaining: context.remaining };
    }

    const request = buildInPlaceRequest({
      schemaId: SANITY_AGENT_SCHEMA_ID,
      documentId: current._id,
      fields: missing,
      from: SOURCE_LANGUAGE,
      to,
      styleGuide: guide.styleGuide,
      protectedPhrases: mergeProtectedPhrases(
        context.settings.protectedPhrases,
        context.siteName ? [context.siteName] : [],
        context.personNames
      ),
    });
    const spend = await spendOneCredit(
      deps,
      { maxCreditsPerDay: context.settings.defaults.maxCreditsPerDay, label: `${item.id} in place -> ${language}` },
      (agent) => agent.agent.action.translate(request)
    );
    const left = context.remaining + 1;

    if (!spend.ok) {
      switch (spend.reason) {
        case "out_of_time":
          return {
            status: "busy",
            code: "out_of_time",
            message: TRANSLATE_MESSAGES.out_of_time,
            ...(spend.credits ? { credits: spend.credits } : {}),
            remaining: left,
          };
        case "daily_cap":
          return {
            status: "refused",
            code: "daily_cap",
            error: TRANSLATE_MESSAGES.daily_cap,
            credits: spend.credits,
            remaining: left,
          };
        case "agent_error":
          return { ...agentFailure(spend.error, spend.credits), remaining: left };
      }
    }

    spent = { creditSpent: true, credits: spend.credits };

    const check = translatedArms(spend.value, current, missing, DEFAULT_LOCALE);

    // A refused field would be refused again for the same English: left for a hand fix until it changes.
    if (check.refused.length > 0) {
      saved.rejected[item.id] = inPlaceSourceKey(current, sourceFields(current, fields, DEFAULT_LOCALE), DEFAULT_LOCALE);
    }

    if (Object.keys(check.arms).length === 0) {
      await context.keep();

      return {
        status: "failed",
        code: "invalid_labels",
        error: TRANSLATE_MESSAGES.invalid_labels,
        invalid: [item.id],
        remaining: context.remaining,
        ...spent,
      };
    }

    arms = check.arms;
    saved.documents[key] = { source, arms };
    await context.keep();
  }

  const written = await writeArms(
    client,
    item.id,
    language,
    { ...arms, ...(await markdownArm(deps, current, arms, language)) },
    done
  );

  if (written === "written" || written === "nothing") {
    delete saved.documents[key];
  }

  if (written === "written") {
    const text = Object.values(arms).find((value): value is string => typeof value === "string");

    done.written[item.id] = { ...done.written[item.id], [language]: text ?? item.text };
  }

  // Not written (a conflict, a refused write): the paid answer stays saved, and the next request writes it for free.
  const unwritten = written === "failed" || written === "conflict" ? 1 : 0;

  return { status: "translated", remaining: context.remaining + unwritten, ...spent };
}
