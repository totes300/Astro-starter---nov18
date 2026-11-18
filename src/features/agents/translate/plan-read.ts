import type { SanityClient } from "@sanity/client";
import { listSavedResults, readCreditsToday } from "~/features/agents/ai-ledger";
import { AiTranslationGroupQuery } from "~/features/agents/query";
import { type PlanDocument, type PlanGroup, planTranslations } from "~/sanity/ai-translation/plan";
import { buildStyleGuide } from "~/sanity/ai-translation/style-guide";
import {
  type PlanBlock,
  type PlanRequest,
  type PlanResponse,
  type SchemaCheck,
  TRANSLATE_MESSAGES,
} from "~/sanity/ai-translation/wire";
import { I18N_DOCUMENT_TYPES, LOCALIZED_FIELDS } from "~/sanity/constants";
import { DEFAULT_LOCALE, LOCALES } from "~/sanity/i18n";
import type { TranslationDocument } from "~/sanity/translation-stub";
import { fetchSanity } from "../../../sanity/lib/fetch";
import { LABELS_LEASE, readSavedLabels } from "./labels";
import { isAppliedResult } from "./pair";
import {
  byPublishedId,
  type Holder,
  readAllGroups,
  readDocuments,
  readDocumentsOfTypes,
  readHoldersOf,
  readReferenceGroups,
  readSettings,
  readTimeouts,
  readVersions,
  rowsOf,
} from "./reads";
import { deployedSchemaCheck } from "./schema-check";
import { defaultTargets, isTargetLanguage, languagesOf, RAW, TARGET_LANGUAGES } from "./shared";

type ScopedRead = { documents: TranslationDocument[]; groups: PlanGroup[]; referenceGroups: string[][] };

/** One document's group only, so the groups its references sit in are read too: a link moved to a variant is no edit. */
async function readScopedDocuments(client: SanityClient, documentId: string): Promise<ScopedRead> {
  const group = await fetchSanity<PlanGroup | null>(client, AiTranslationGroupQuery, { id: documentId }, RAW);
  const ids = [documentId, ...rowsOf(group).flatMap(({ ref }) => (ref ? [ref] : []))];
  const documents = await readDocuments(client, ids);

  return { documents, groups: group ? [group] : [], referenceGroups: await readReferenceGroups(client, documents) };
}

/** One document's plan reads its group only, so the documents its new translations would duplicate are read here. */
async function readHolders(
  client: SanityClient,
  documents: readonly TranslationDocument[],
  languages: readonly string[]
): Promise<Holder[]> {
  const sources = [...byPublishedId(documents).values()].flatMap(({ published, draft }) => {
    const source = published ?? draft;

    return source?.language === DEFAULT_LOCALE ? [source] : [];
  });
  const found = await Promise.all(
    sources.flatMap((source) => languages.map((language) => readHoldersOf(client, source, language)))
  );

  return found.flat();
}

async function readSiteDocuments(client: SanityClient): Promise<ScopedRead> {
  const [documents, groups] = await Promise.all([
    readDocumentsOfTypes(client, [...I18N_DOCUMENT_TYPES, ...Object.keys(LOCALIZED_FIELDS)]),
    readAllGroups(client),
  ]);

  return { documents, groups, referenceGroups: [] };
}

/** Free: every source and its status per language, the order, the estimate, and whatever would refuse a run. */
export async function readPlan(
  client: SanityClient,
  request: PlanRequest,
  options: { loadLocalSchema?: () => Promise<unknown>; now?: Date } = {}
): Promise<PlanResponse> {
  const now = options.now ?? new Date();
  const [{ settings }, scoped, savedResults, savedLabels, schema, versions, timedOut] = await Promise.all([
    readSettings(client),
    request.documentId ? readScopedDocuments(client, request.documentId) : readSiteDocuments(client),
    listSavedResults(client),
    readSavedLabels(client),
    options.loadLocalSchema
      ? deployedSchemaCheck(client, options.loadLocalSchema, { fresh: true, now: now.getTime() })
      : Promise.resolve<SchemaCheck>({ deployedAt: null, drift: [] }),
    readVersions(client),
    readTimeouts(client),
  ]);
  const languages = request.languages ?? defaultTargets(settings);
  const [creditsToday, holders] = await Promise.all([
    readCreditsToday(client, { maxCreditsPerDay: settings.defaults.maxCreditsPerDay, now }),
    request.documentId ? readHolders(client, scoped.documents, languages) : Promise.resolve([]),
  ]);
  const isLabel = (document: PlanDocument) => Object.hasOwn(LOCALIZED_FIELDS, document._type);
  const plan = planTranslations({
    documents: [...scoped.documents.filter((document) => !isLabel(document)), ...holders],
    groups: scoped.groups,
    labelDocuments: scoped.documents.filter(isLabel),
    locales: LOCALES.map(({ id, title }) => ({ id, title })),
    defaultLocale: DEFAULT_LOCALE,
    languages,
    policy: request.policy ?? settings.defaults.policy,
    useDraft: request.useDraft,
    documentId: request.documentId,
    rejectedLabels: savedLabels.rejected,
    versions,
    referenceGroups: scoped.referenceGroups,
    timedOut,
  });
  const blocked: PlanBlock | null =
    schema.drift.length > 0 ? { code: "schema_drift", message: TRANSLATE_MESSAGES.schema_drift } : null;
  const inScope = new Set([...plan.rows.map(({ sourceId }) => sourceId), ...plan.labels.map(({ id }) => id)]);
  const copies = byPublishedId(scoped.documents);
  const rows = new Map(plan.rows.map((row) => [row.sourceId, row]));
  const targetOf = (sourceId: string, language: string) => {
    const targetId = rows.get(sourceId)?.targets.find((target) => target.language === language)?.targetId;
    const copy = targetId ? copies.get(targetId) : undefined;

    return copy?.draft ?? copy?.published;
  };

  return {
    defaultLocale: DEFAULT_LOCALE,
    locales: LOCALES.map(({ id, title }) => ({ id, title })),
    settings: {
      defaults: settings.defaults,
      styleGuideLength: settings.styleGuide.length,
      styleGuideByLanguage: Object.fromEntries(
        languagesOf(TARGET_LANGUAGES).map((language) => [language.id, buildStyleGuide(settings, language).length])
      ),
      protectedPhrases: settings.protectedPhrases.length,
      glossaryTerms: settings.glossary.length,
      languageNotes: Object.keys(settings.languageNotes),
    },
    plan,
    creditsToday,
    schema: { ...schema, ok: schema.drift.length === 0 },
    blocked,
    // A result for a language no longer served, or a source since deleted, can never be applied: not offered.
    savedResults: savedResults
      .filter(({ language }) => language !== LABELS_LEASE.language && isTargetLanguage(language))
      .filter(({ sourceId }) => rows.has(sourceId))
      .filter(({ sourceId }) => !request.documentId || inScope.has(sourceId))
      .filter((saved) => !isAppliedResult(saved, targetOf(saved.sourceId, saved.language)))
      .map(({ sourceId, language, savedAt }) => ({ sourceId, language, savedAt })),
  };
}
