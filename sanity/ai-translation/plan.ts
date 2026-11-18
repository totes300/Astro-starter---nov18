// The free plan: every source, its status in each language, the run order and the exact number of AI requests.
// Statuses come from content hashes, so a re-check on the server answers the same as the plan the Studio showed.

import { getPublishedId } from "@sanity/client/csm";
import { AI_TRANSLATION_FIELD, LOCALIZED_FIELDS, SANITY_SINGLETON_HOMEPAGE_ID } from "../constants";
import { run } from "../lib/run";
import { fixedPlace, SYSTEM_FIELDS } from "../translation-stub";
import { isPlainObject } from "./fields";
import { type Fingerprint, fingerprint, movedReferences, type SameDocument } from "./fingerprint";
import {
  inPlaceSourceKey,
  isFilledArm,
  isInPlaceDocumentType,
  missingArms,
  sourceFields,
  translatedInPlaceFields,
  valueAtPath,
} from "./in-place";
import { LABEL_BATCH_SIZE, labelProblem } from "./labels";
import type { BulkPolicy, TranslationLanguage } from "./style-guide";

/** In precedence order: the first that holds is the pair's status. */
export const TRANSLATION_STATUSES = [
  "editedByHand",
  "translatedByHand",
  "englishChanged",
  "layoutChanged",
  "copyOfEnglish",
  "notTranslated",
  "upToDate",
] as const;

export type TranslationStatus = (typeof TRANSLATION_STATUSES)[number];

/** Worth an AI request without asking: a missing translation, a copy of the source, or a source whose text changed. */
const NEEDS_WORK: ReadonlySet<TranslationStatus> = new Set(["notTranslated", "copyOfEnglish", "englishChanged"]);

const BULK: Record<BulkPolicy, ReadonlySet<TranslationStatus>> = {
  missing: new Set(["notTranslated", "copyOfEnglish"]),
  refresh: new Set(["notTranslated", "copyOfEnglish", "englishChanged"]),
};

/** Someone's own text: never overwritten in bulk, and in the dialog only once the editor acknowledges it is replaced. */
const HAND_WRITTEN: ReadonlySet<TranslationStatus> = new Set(["editedByHand", "translatedByHand"]);

/** The server's re-check before it spends: anything else answers `skipped` unless the run asked to overwrite. */
export function needsWork(status: TranslationStatus, overwrite = false): boolean {
  return overwrite || NEEDS_WORK.has(status);
}

export function inBulk(status: TranslationStatus, policy: BulkPolicy): boolean {
  return BULK[policy].has(status);
}

export function requiresOverwrite(status: TranslationStatus): boolean {
  return HAND_WRITTEN.has(status);
}

/** The provenance record an AI write leaves on a translation (`aiTranslation`); a copy's stamp holds the `source*` ones. */
export type AiTranslationRecord = {
  sourceId?: string;
  sourceLanguage?: string;
  sourceRev?: string;
  sourceTextHash?: string;
  sourceLayoutHash?: string;
  /** Hashes of what was written, so a later hand edit shows. */
  textHash?: string;
  layoutHash?: string;
  translatedAt?: string;
  requestedBy?: string;
};

export function readRecord(document: Record<string, unknown> | null | undefined): AiTranslationRecord | undefined {
  const record = document?.[AI_TRANSLATION_FIELD];

  return isPlainObject(record) ? (record as AiTranslationRecord) : undefined;
}

export type AiWriteState = "none" | "asWritten" | "edited";

function writeState(document: Record<string, unknown>, print: Fingerprint): AiWriteState {
  const record = readRecord(document);

  if (typeof record?.textHash !== "string" || typeof record.layoutHash !== "string") {
    return "none";
  }

  return print.textHash === record.textHash && print.layoutHash === record.layoutHash ? "asWritten" : "edited";
}

/** `none` without a record that holds both hashes; `edited` once the document no longer hashes as the AI wrote it. */
export function aiWriteState(document: Record<string, unknown>): AiWriteState {
  return writeState(document, fingerprint(document));
}

/** The record for a write: the source as translated, and the translation as written (hash it after the merge and the patch). */
export function translationRecord(options: {
  source: Record<string, unknown> & { _id: string };
  written: Record<string, unknown>;
  sourceLanguage: string;
  translatedAt: string;
  requestedBy?: string;
}): AiTranslationRecord {
  const { source, written, sourceLanguage, translatedAt, requestedBy } = options;
  const sourcePrint = fingerprint(source);
  const writtenPrint = fingerprint(written);

  return {
    sourceId: getPublishedId(source._id),
    sourceLanguage,
    ...(typeof source._rev === "string" ? { sourceRev: source._rev } : {}),
    sourceTextHash: sourcePrint.textHash,
    sourceLayoutHash: sourcePrint.layoutHash,
    textHash: writtenPrint.textHash,
    layoutHash: writtenPrint.layoutHash,
    translatedAt,
    ...(requestedBy ? { requestedBy } : {}),
  };
}

/** A copy's stamp, set where it is made (`sanity:add-language`, the Translations menu): the copy as made, no `textHash`. */
export function copyRecord(
  copy: Record<string, unknown>,
  options: { sourceId: string; sourceLanguage: string }
): AiTranslationRecord {
  const print = fingerprint(copy);

  return {
    sourceId: getPublishedId(options.sourceId),
    sourceLanguage: options.sourceLanguage,
    sourceTextHash: print.textHash,
    sourceLayoutHash: print.layoutHash,
  };
}

/** No AI wrote it: a stamped copy is compared with itself as made, an unstamped one with the source, both exactly. */
function copyStatus(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  prints: { source: Fingerprint; target: Fingerprint },
  sameDocument: SameDocument | undefined
): TranslationStatus {
  const record = readRecord(target);
  const made =
    typeof record?.sourceTextHash === "string" && typeof record.sourceLayoutHash === "string"
      ? { textHash: record.sourceTextHash, layoutHash: record.sourceLayoutHash }
      : prints.source;

  if (prints.target.textHash !== made.textHash) {
    return "translatedByHand";
  }

  // Its own settings or links changed (password protected, a section hidden, a link re-pointed): a bulk run would reset them.
  if (prints.target.layoutHash !== made.layoutHash || movedReferences(source, target, sameDocument).length > 0) {
    return "editedByHand";
  }

  return "copyOfEnglish";
}

/** `target` is the translation as an editor sees it: its draft when there is one, else its published copy. */
export function translationStatus({
  source,
  target,
  sameDocument,
}: {
  source: Record<string, unknown>;
  target?: Record<string, unknown> | null;
  /** The translation groups around both: a copy's link moved to a variant is no edit. Unset, only the same id is. */
  sameDocument?: SameDocument;
}): TranslationStatus {
  if (!target) {
    return "notTranslated";
  }

  const targetPrint = fingerprint(target);
  const state = writeState(target, targetPrint);

  if (state === "edited") {
    return "editedByHand";
  }

  const record = readRecord(target);
  const sourcePrint = fingerprint(source);

  if (state === "none" || !record) {
    return copyStatus(source, target, { source: sourcePrint, target: targetPrint }, sameDocument);
  }

  if (sourcePrint.textHash !== record.sourceTextHash) {
    return "englishChanged";
  }

  if (sourcePrint.layoutHash !== record.sourceLayoutHash) {
    return "layoutChanged";
  }

  return "upToDate";
}

/** Labels first, then what other documents point at, the Site last: published targets get linked straight away. */
export const RUN_ORDER = [
  "labels",
  "person",
  "article",
  "legalPage",
  // PLOP: Add Run Step
  "page",
  "blog",
  "homepage",
  "site",
] as const;

export type RunStep = (typeof RUN_ORDER)[number];

/** A translated type the order does not name runs with the pages that link to it, just before them. */
export function runStep(type: string, id: string, homepageId: string = SANITY_SINGLETON_HOMEPAGE_ID): RunStep {
  if (type === "page" && getPublishedId(id) === homepageId) {
    return "homepage";
  }

  return (RUN_ORDER as readonly string[]).includes(type) && type !== "labels" ? (type as RunStep) : "legalPage";
}

export type CreditEstimate = { pairs: number; labels: number; labelBatches: number; credits: number };

/** One AI request per pair whatever its length, one per batch of names covering every language, one per person and language. */
export function estimateCredits(pairs: number, labels: number, documentLanguages = 0): CreditEstimate {
  const labelBatches = Math.ceil(labels / LABEL_BATCH_SIZE) + documentLanguages;

  return { pairs, labels, labelBatches, credits: pairs + labelBatches };
}

export type PlanDocument = { _id: string; _type: string; [field: string]: unknown };

/** A `translation.metadata` document as read: rows of `{ _key, language, value: { _ref } }`. */
export type PlanGroup = {
  _id: string;
  _rev?: string;
  _createdAt?: string;
  translations?: unknown;
  /** How many groups link the id it was read for: more than one is a plugin create raced by an AI write. */
  groupCount?: number;
};

/** Why a whole-site run leaves a pair out whatever its status: docs/features/ai-translation.md#held-out-of-bulk */
export type TargetHold = "inRelease" | "twoGroups" | "timedOut";

export type PlanTarget = {
  language: string;
  status: TranslationStatus;
  /** Published id of the linked translation, when its document still exists. */
  targetId?: string;
  hasDraft: boolean;
  /** The draft is as an AI run wrote it and not published yet: "Publish N AI drafts" takes `targetId`. */
  aiDraft?: true;
  uri?: string;
  /** A link whose document is gone: replace this row instead of adding a second one for the language. */
  staleRowKey?: string;
  /** An unlinked document already at this language's fixed URI, or its singleton copy: link it, never translate. */
  unlinkedId?: string;
  /** Its title or name, so an editor can confirm it is the same page or person before linking it. */
  unlinkedTitle?: string;
  hold?: TargetHold;
  /** Picked by a whole-site run under the plan's policy. */
  bulk: boolean;
};

export type PlanRow = {
  sourceId: string;
  type: string;
  title: string;
  uri?: string;
  step: RunStep;
  /** What a run translates; unset when the row is skipped. */
  version?: "published" | "draft";
  /** A draft whose text or layout differs from the published copy. */
  hasUnpublishedChanges: boolean;
  skipped?: "notPublished";
  metadataId?: string;
  metadataRev?: string;
  targets: PlanTarget[];
};

export type LabelItem = {
  id: string;
  type: string;
  field: string;
  /** The name; for a document translated in place, its title, shown while its fields go in one call. */
  text: string;
  missing: string[];
  /** Never sent: the English name fails the checks itself, or the AI's answer for it failed them before. */
  handFix?: "sourceFailsChecks" | "rejectedBefore";
  /** A shared routed document (a person): one call per language for every field in `fields`, not a batch of names. */
  kind?: "document";
  fields?: string[];
};

export type TranslationPlan = {
  rows: PlanRow[];
  labels: LabelItem[];
  /** The labels without `handFix`, names in batches of 50 and a document once per missing language: what a run sends. */
  labelBatches: LabelItem[][];
  /** Ids whose translated-in-place field is still a plain string: `npm run sanity:migrate-localize-fields` first. */
  plainLabels?: string[];
  /** Sources with no language yet: `npm run sanity:migrate-backfill-language` first. */
  missingLanguage: string[];
  summary: Record<string, Record<TranslationStatus, number>>;
  estimate: CreditEstimate;
  /** Unpublished AI drafts, whatever run left them: translations as written, category drafts that only fill names. */
  aiDrafts?: string[];
};

export type PlanOptions = {
  /** Published and draft copies of the translated types; release versions are left out. */
  documents: readonly PlanDocument[];
  groups: readonly PlanGroup[];
  /** Published and draft copies of the types with fields translated in place. */
  labelDocuments?: readonly PlanDocument[];
  locales: readonly TranslationLanguage[];
  defaultLocale: string;
  /** The target languages; empty or unset means every one but the default. */
  languages?: readonly string[];
  policy?: BulkPolicy;
  /** Translate the source's unpublished changes (one document's modal); a whole-site run reads published copies only. */
  useDraft?: boolean;
  /** One document's plan: the source itself or any of its translations. */
  documentId?: string;
  localizedFields?: Readonly<Record<string, readonly string[]>>;
  /** Label ids the AI's answer failed the checks for, each with the English name it failed on. */
  rejectedLabels?: Readonly<Record<string, string>>;
  homepageId?: string;
  /** Release versions of the translated types (`versions.<release>.<id>`): proof a linked translation exists. */
  versions?: readonly PlanDocument[];
  /** Groups beyond `groups`, as published ids (a one-document plan reads its references' groups separately). */
  referenceGroups?: readonly (readonly string[])[];
  /** The source text hash each pair's last call timed out on, by `pairKey`. */
  timedOut?: Readonly<Record<string, string>>;
};

/** The key `timedOut` and the timeout markers use for one source in one language. */
export function pairKey(sourceId: string, language: string): string {
  return `${sourceId}\u0000${language}`;
}

/** Ids that share a translation group are one page or person in different languages. */
export function sameDocumentIn(groups: readonly (readonly string[])[]): SameDocument {
  const memberOf = new Map<string, Set<number>>();

  groups.forEach((ids, index) => {
    for (const id of ids) {
      memberOf.set(id, new Set([...(memberOf.get(id) ?? []), index]));
    }
  });

  return (a, b) => a === b || [...(memberOf.get(a) ?? [])].some((index) => memberOf.get(b)?.has(index) === true);
}

/** Sorted keys at every depth, so two reads of one document compare equal whatever order the API sent. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }

  if (isPlainObject(value)) {
    const keys = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort();

    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }

  return JSON.stringify(value) ?? "null";
}

/** A copy without its system fields and without each localized path, an object a path empties dropped too. */
function withoutLocalized(document: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const copy = structuredClone(
    Object.fromEntries(Object.entries(document).filter(([key]) => !SYSTEM_FIELDS.includes(key) && key !== "_id"))
  );

  for (const field of fields) {
    const [top, nested] = field.split(".") as [string, string | undefined];
    const parent = copy[top];

    if (nested === undefined) {
      delete copy[top];
    } else if (isPlainObject(parent)) {
      delete parent[nested];

      if (Object.keys(parent).length === 0) {
        delete copy[top];
      }
    }
  }

  return copy;
}

/** A draft that only fills empty arms of its published copy, in other languages: a labels or in-place pass's. */
export function isFilledNamesDraft(
  draft: Record<string, unknown>,
  published: Record<string, unknown>,
  fields: readonly string[],
  defaultLocale: string
): boolean {
  let filled = 0;

  for (const field of fields) {
    const was = valueAtPath(published, field);
    const before = isPlainObject(was) ? was : {};
    const after = valueAtPath(draft, field);

    // Neither copy has it (a person with no SEO title): nothing filled, nothing changed.
    if (after === undefined && was === undefined) {
      continue;
    }

    if (!isPlainObject(after) || Object.keys(before).some((key) => !Object.hasOwn(after, key))) {
      return false;
    }

    for (const [key, value] of Object.entries(after)) {
      const arm = before[key];

      if (key === defaultLocale || key.startsWith("_") || isFilledArm(arm)) {
        if (stableJson(value) !== stableJson(arm)) {
          return false;
        }
      } else if (isFilledArm(value)) {
        filled += 1;
      } else if (stableJson(value) !== stableJson(arm)) {
        return false;
      }
    }
  }

  return filled > 0 && stableJson(withoutLocalized(draft, fields)) === stableJson(withoutLocalized(published, fields));
}

type Copies = { published?: PlanDocument; draft?: PlanDocument };

function byPublishedId(documents: readonly PlanDocument[]): Map<string, Copies> {
  const copies = new Map<string, Copies>();

  for (const document of documents) {
    if (document._id.startsWith("versions.")) {
      continue;
    }

    const id = getPublishedId(document._id);
    const entry = copies.get(id) ?? {};

    if (document._id === id) {
      entry.published = document;
    } else {
      entry.draft = document;
    }

    copies.set(id, entry);
  }

  return copies;
}

type Row = { key?: string; language?: string; ref?: string };

function rowsOf(group: PlanGroup): Row[] {
  return (Array.isArray(group.translations) ? group.translations : []).filter(isPlainObject).map((row) => ({
    key: typeof row._key === "string" ? row._key : undefined,
    language: typeof row.language === "string" ? row.language : undefined,
    ref: isPlainObject(row.value) && typeof row.value._ref === "string" ? getPublishedId(row.value._ref) : undefined,
  }));
}

function stringField(document: PlanDocument | undefined, ...fields: string[]): string | undefined {
  for (const field of fields) {
    const value = document?.[field];

    if (typeof value === "string" && value.trim() !== "") {
      return value;
    }
  }

  return undefined;
}

function uriOf(document: PlanDocument | undefined): string | undefined {
  const uri = document?.uri;

  return isPlainObject(uri) && typeof uri.current === "string" ? uri.current : undefined;
}

function emptySummary(): Record<TranslationStatus, number> {
  return Object.fromEntries(TRANSLATION_STATUSES.map((status) => [status, 0])) as Record<TranslationStatus, number>;
}

function planLabels(
  documents: readonly PlanDocument[],
  fields: Readonly<Record<string, readonly string[]>>,
  defaultLocale: string,
  languages: readonly string[],
  rejected: Readonly<Record<string, string>>
): { labels: LabelItem[]; plain: string[]; drafts: string[] } {
  const labels: LabelItem[] = [];
  const plain: string[] = [];
  const drafts: string[] = [];

  for (const [id, { published, draft }] of byPublishedId(documents)) {
    const document = draft ?? published;
    const own = document ? (fields[document._type] ?? []) : [];

    if (draft && published && own.length > 0 && isFilledNamesDraft(draft, published, own, defaultLocale)) {
      drafts.push(id);
    }

    if (document && isInPlaceDocumentType(document._type)) {
      const translated = translatedInPlaceFields(own);
      const sources = sourceFields(document, translated, defaultLocale);
      const missing = languages.filter((language) => missingArms(document, translated, language, defaultLocale).length > 0);
      const isPlain = own.some((field) => {
        const value = valueAtPath(document, field);

        return typeof value === "string" || Array.isArray(value);
      });

      if (isPlain) {
        plain.push(id);
      }

      if (sources.length > 0 && missing.length > 0) {
        const key = inPlaceSourceKey(document, sources, defaultLocale);

        labels.push({
          id,
          type: document._type,
          field: sources[0] as string,
          fields: sources,
          kind: "document",
          text: stringField(document, "title", "name", "heading") ?? id,
          missing,
          ...(rejected[id] === key ? { handFix: "rejectedBefore" as const } : {}),
        });
      }

      continue;
    }

    for (const field of own) {
      const value = document?.[field];
      const arms = isPlainObject(value) ? value : {};
      const text = typeof arms[defaultLocale] === "string" ? (arms[defaultLocale] as string).trim() : "";
      const missing = languages.filter(
        (language) => typeof arms[language] !== "string" || (arms[language] as string).trim() === ""
      );

      if (typeof value === "string" && value.trim() !== "") {
        plain.push(id);
      }

      if (!document || text === "" || missing.length === 0) {
        continue;
      }

      const handFix = run(() => {
        if (labelProblem(text)) {
          return "sourceFailsChecks";
        }
        if (rejected[id] === text) {
          return "rejectedBefore";
        }
        return undefined;
      });

      labels.push({ id, type: document._type, field, text, missing, ...(handFix ? { handFix } : {}) });
    }
  }

  return { labels: labels.sort((a, b) => (a.id < b.id ? -1 : 1)), plain: [...new Set(plain)].sort(), drafts: drafts.sort() };
}

type GroupRows = { group: PlanGroup; rows: Row[] };

/** Oldest first, as the server picks the group of a source that sits in two. */
function groupRowsOf(groups: readonly PlanGroup[]): GroupRows[] {
  return groups
    .filter(({ _id }) => getPublishedId(_id) === _id)
    .map((group) => ({ group, rows: rowsOf(group) }))
    .sort(
      (a, b) =>
        String(a.group._createdAt ?? "").localeCompare(String(b.group._createdAt ?? "")) || (a.group._id < b.group._id ? -1 : 1)
    );
}

type TargetContext = {
  copies: ReadonlyMap<string, Copies>;
  holders: HolderIndex;
  releaseIds: ReadonlySet<string>;
  sameDocument: SameDocument;
  policy: BulkPolicy;
  timedOut: Readonly<Record<string, string>>;
};

function holdOf(
  context: TargetContext,
  pair: { sourceId: string; language: string; source?: PlanDocument },
  facts: { inRelease: boolean; groups: number; status: TranslationStatus }
): TargetHold | undefined {
  if (facts.inRelease) {
    return "inRelease";
  }

  if (facts.groups > 1) {
    return "twoGroups";
  }

  const timedOutOn = context.timedOut[pairKey(pair.sourceId, pair.language)];

  return pair.source && timedOutOn === fingerprint(pair.source).textHash && needsWork(facts.status) ? "timedOut" : undefined;
}

function planTarget(
  context: TargetContext,
  row: { sourceId: string; source?: PlanDocument; shown: PlanDocument; entry?: GroupRows; groups: number },
  language: string
): PlanTarget {
  const { copies } = context;
  const { sourceId, source, entry } = row;
  const links = entry?.rows.filter((link) => link.language === language) ?? [];
  const live = links.find(({ ref }) => ref !== undefined && copies.has(ref));
  const inRelease = !live && links.some(({ ref }) => ref !== undefined && context.releaseIds.has(ref));
  const translation = live?.ref ? copies.get(live.ref) : undefined;
  const current = translation ? (translation.draft ?? translation.published) : undefined;
  const status = source ? translationStatus({ source, target: current, sameDocument: context.sameDocument }) : "notTranslated";
  // A row whose document is only in a release is never replaced: unsetting it would orphan that version.
  const stale = live || inRelease ? undefined : links.find(({ key }) => key !== undefined)?.key;
  const unlinked = live || inRelease ? undefined : unlinkedHolder(context.holders, source ?? row.shown, sourceId, language);
  const hold = holdOf(context, { sourceId, language, source }, { inRelease, groups: row.groups, status });
  const aiDraft = translation?.draft !== undefined && aiWriteState(translation.draft) === "asWritten";

  return {
    language,
    status,
    ...(live?.ref ? { targetId: live.ref } : {}),
    hasDraft: translation?.draft !== undefined,
    ...(aiDraft ? { aiDraft: true as const } : {}),
    ...(uriOf(current) ? { uri: uriOf(current) } : {}),
    ...(stale ? { staleRowKey: stale } : {}),
    ...(unlinked ? { unlinkedId: unlinked.id, ...(unlinked.title ? { unlinkedTitle: unlinked.title } : {}) } : {}),
    ...(hold ? { hold } : {}),
    bulk: source !== undefined && !unlinked && !hold && inBulk(status, context.policy),
  };
}

/** Pure over what the route read: no query here, so the GET and the server re-check agree by construction. */
export function planTranslations(options: PlanOptions): TranslationPlan {
  const { documents, groups, locales, defaultLocale, policy = "missing", useDraft = false } = options;
  const homepageId = options.homepageId ?? SANITY_SINGLETON_HOMEPAGE_ID;
  const targets = locales
    .map(({ id }) => id)
    .filter((id) => id !== defaultLocale && (!options.languages?.length || options.languages.includes(id)));
  const copies = byPublishedId(documents);
  const versions = options.versions ?? [];
  const groupRows = groupRowsOf(groups);
  const groupsOf = (id: string) => groupRows.filter(({ rows }) => rows.some(({ ref }) => ref === id));
  const context: TargetContext = {
    copies,
    holders: holderIndex(copies, versions),
    releaseIds: new Set(versions.map(({ _id }) => getPublishedId(_id))),
    sameDocument: sameDocumentIn([
      ...groupRows.map(({ rows }) => rows.flatMap(({ ref }) => (ref ? [ref] : []))),
      ...(options.referenceGroups ?? []),
    ]),
    policy,
    timedOut: options.timedOut ?? {},
  };
  const languageOf = (id: string) => {
    const entry = copies.get(id);

    return (entry?.published ?? entry?.draft)?.language;
  };
  const scope = options.documentId ? getPublishedId(options.documentId) : undefined;
  const inScope = scope ? [scope, ...(groupsOf(scope)[0]?.rows.map(({ ref }) => ref) ?? [])] : undefined;
  const sourceIds = [...copies.keys()].filter((id) => languageOf(id) === defaultLocale && (!inScope || inScope.includes(id)));
  const missingLanguage = [...copies.keys()].filter((id) => typeof languageOf(id) !== "string" || languageOf(id) === "");
  const summary = Object.fromEntries(targets.map((language) => [language, emptySummary()]));
  const rows: PlanRow[] = sourceIds.map((sourceId) => {
    const { published, draft } = copies.get(sourceId) as Copies;
    const source = useDraft ? (draft ?? published) : published;
    const shown = (draft ?? published) as PlanDocument;
    const type = shown._type;
    const entries = groupsOf(sourceId);
    const entry = entries[0];
    const hasUnpublishedChanges =
      draft !== undefined &&
      published !== undefined &&
      JSON.stringify(fingerprint(draft)) !== JSON.stringify(fingerprint(published));
    const groupCount = Math.max(entries.length, entry?.group.groupCount ?? 0);

    return {
      sourceId,
      type,
      title: stringField(shown, "title", "name", "heading") ?? sourceId,
      uri: uriOf(shown),
      step: runStep(type, sourceId, homepageId),
      hasUnpublishedChanges,
      ...(source ? { version: source === draft ? "draft" : "published" } : { skipped: "notPublished" as const }),
      ...(entry ? { metadataId: entry.group._id, ...(entry.group._rev ? { metadataRev: entry.group._rev } : {}) } : {}),
      targets: targets.map((language) => planTarget(context, { sourceId, source, shown, entry, groups: groupCount }, language)),
    };
  });

  for (const row of rows) {
    for (const target of row.version ? row.targets : []) {
      (summary[target.language] as Record<TranslationStatus, number>)[target.status] += 1;
    }
  }

  rows.sort(
    (a, b) =>
      RUN_ORDER.indexOf(a.step) - RUN_ORDER.indexOf(b.step) ||
      a.title.localeCompare(b.title) ||
      (a.sourceId < b.sourceId ? -1 : 1)
  );

  const inLabelScope = ({ id }: { id: string }) => !options.documentId || id === getPublishedId(options.documentId);
  const planned = planLabels(
    options.labelDocuments ?? [],
    options.localizedFields ?? LOCALIZED_FIELDS,
    defaultLocale,
    targets,
    options.rejectedLabels ?? {}
  );
  const labels = planned.labels.filter(inLabelScope);
  const plainLabels = planned.plain.filter((id) => inLabelScope({ id }));
  const askable = labels.filter(({ handFix, kind }) => !handFix && kind !== "document");
  const documentsInPlace = labels.filter(({ handFix, kind }) => !handFix && kind === "document");
  const labelBatches = [
    ...Array.from({ length: Math.ceil(askable.length / LABEL_BATCH_SIZE) }, (_, index) =>
      askable.slice(index * LABEL_BATCH_SIZE, (index + 1) * LABEL_BATCH_SIZE)
    ),
    ...documentsInPlace.flatMap((item) => item.missing.map((language) => [{ ...item, missing: [language] }])),
  ];
  const pairs = rows.reduce((total, row) => total + row.targets.filter(({ bulk }) => bulk).length, 0);
  const translationDrafts = rows.flatMap(({ targets: cells }) =>
    cells.flatMap(({ aiDraft, targetId }) => (aiDraft && targetId ? [targetId] : []))
  );

  return {
    rows,
    labels,
    labelBatches,
    ...(plainLabels.length > 0 ? { plainLabels } : {}),
    missingLanguage,
    summary,
    estimate: estimateCredits(
      pairs,
      askable.length,
      documentsInPlace.reduce((total, { missing }) => total + missing.length, 0)
    ),
    aiDrafts: [...new Set([...translationDrafts, ...planned.drafts.filter((id) => inLabelScope({ id }))])],
  };
}

type HolderIndex = {
  byUri: Map<string, string[]>;
  byTypeAndLanguage: Map<string, string[]>;
  titles: Map<string, string>;
};

/** Release versions hold a place too: a translation made inside a release would otherwise be made twice. */
function holderIndex(copies: ReadonlyMap<string, Copies>, versions: readonly PlanDocument[]): HolderIndex {
  const index: HolderIndex = { byUri: new Map(), byTypeAndLanguage: new Map(), titles: new Map() };
  const add = (map: Map<string, string[]>, key: string, id: string) => {
    map.set(key, [...new Set([...(map.get(key) ?? []), id])]);
  };
  const entries: [string, PlanDocument | undefined][] = [
    ...[...copies].flatMap(([id, { published, draft }]): [string, PlanDocument | undefined][] => [
      [id, draft],
      [id, published],
    ]),
    ...versions.map((version): [string, PlanDocument] => [getPublishedId(version._id), version]),
  ];

  for (const [id, copy] of entries) {
    const uri = uriOf(copy);
    const title = stringField(copy, "title", "name", "heading");

    if (uri) {
      add(index.byUri, uri, id);
    }

    if (copy && typeof copy.language === "string") {
      add(index.byTypeAndLanguage, `${copy._type}\u0000${copy.language}`, id);
    }

    if (title && !index.titles.has(id)) {
      index.titles.set(id, title);
    }
  }

  return index;
}

/** The unlinked document a new translation would duplicate: same fixed URI, or the singleton's copy in that language. */
function unlinkedHolder(
  holders: HolderIndex,
  source: PlanDocument,
  sourceId: string,
  language: string
): { id: string; title?: string } | undefined {
  const place = fixedPlace(source, language);

  if (!place) {
    return undefined;
  }

  const ids =
    "uri" in place ? holders.byUri.get(place.uri) : holders.byTypeAndLanguage.get(`${place.singleton}\u0000${language}`);
  const id = ids?.find((candidate) => candidate !== sourceId);

  return id ? { id, title: holders.titles.get(id) } : undefined;
}
