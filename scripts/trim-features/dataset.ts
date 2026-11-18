/**
 * What a feature costs in live content, and what it takes to remove it.
 *
 * The report runs before the trim asks anything, so "remove the blog" is answered knowing there are
 * twelve articles in `development`. The purge that follows is deliberately loud about the three
 * things a naive delete gets wrong:
 *
 * - **Strong references block deletion.** Everything goes in one transaction, so references between
 *   doomed documents are fine; one from a survivor makes Sanity refuse the lot, so it is refused here
 *   first. Translation links are the exception: they are repaired or deleted in that same transaction.
 * - **Weak references dangle.** `internal.link` is `weak: true` and can point at any routed document
 *   from the Site singleton, a person's links, a CTA section or any rich text annotation. Deleting
 *   the target leaves a live `_ref` to nothing, so every holder is listed instead of quietly broken.
 * - **Section anchors are not references at all.** `internal.sectionTarget` stores a section item's
 *   `_key` as a plain string, so removing a section silently degrades those links to a bare page
 *   URL. The keys that are about to disappear are collected and reported.
 *
 * Every write comes from one plan (`language-removal.ts`), for a type and a language alike. The query
 * builders and the formatting are pure and unit tested; only the readers and `purge` talk to Sanity.
 */

import type { SanityClient } from "@sanity/client";
import { buildListArgs, captureSanityCommand } from "../sanity-dataset/lib";
import { censusConfig, type I18nContext, removalConfig } from "./language";
import {
  dedupeHolders,
  describeLanguageCount,
  formatLanguageRemovalPlan,
  hasLanguageLeftovers,
  LANGUAGE_ID,
  type LanguageCensus,
  type LanguageCount,
  type LanguageRemovalConfig,
  type LanguageRemovalInput,
  type LanguageRemovalPlan,
  languageCensus,
  languageRemovalMutations,
  planGrowth,
  planLanguageRemoval,
  publishedIdOf,
  type RawDocument,
  readLanguageRemovalInput,
  readLanguageScan,
  refusalReasons,
  strandedLanguages,
} from "./language-removal";
import {
  fieldLabel,
  findOrphanTypes,
  findStrandedSectionTypes,
  findUndeclaredFields,
  type LiveType,
  parseAllTypeNames,
  parseRegisteredTypes,
  type StoredField,
  type StrandedField,
  type StrandedSection,
  storedTotal,
  unpublishedSuffix,
} from "./schema";

export { dedupeHolders, publishedIdOf, referenceStrength } from "./language-removal";

/**
 * Sanity type names, including the dotted form plugins use (`mux.videoAsset`).
 *
 * These no longer only come from the manifest: the orphan report discovers them in the dataset, so
 * anything interpolated into a query is checked against this first and skipped if it does not match.
 */
const TYPE_NAME = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)*$/;

/** A top-level field name, interpolated into GROQ as a bare path, so never anything but an identifier. */
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Where a document lives, told apart by its `_id`: `drafts.<id>`, `versions.<release>.<id>`, or the
 * bare published id. A version is neither published nor a draft, so each is its own bucket.
 */
const PUBLISHED = `!(_id in path("drafts.**")) && !(_id in path("versions.**"))`;
const DRAFT = `_id in path("drafts.**")`;
const VERSION = `_id in path("versions.**")`;

/** The script `runQuery` hands to `sanity exec`, relative to the project root it runs from. */
const RAW_QUERY_SCRIPT = "scripts/trim-features/raw-query.ts";

export type DocumentUsage = {
  type: string;
  published: number;
  drafts: number;
  versions: number;
};

export type SectionUsage = {
  type: string;
  /** One entry per page that still uses the section, with how many times. */
  pages: { _id: string; uri?: string; count: number }[];
};

export type ReferenceHolder = {
  _id: string;
  _type: string;
  uri?: string;
};

export type Usage = {
  dataset: string;
  documents: DocumentUsage[];
  sections: SectionUsage[];
  /** Fields on documents that stay, and how many of those documents still store them. */
  fields: StrandedField[];
  /** Documents holding a weak reference to something about to be deleted. */
  weakReferenceHolders: ReferenceHolder[];
  /** Documents whose `internal.sectionTarget` names a section key about to disappear. */
  sectionAnchorHolders: ReferenceHolder[];
  /** Documents carrying generated Markdown that goes stale the moment content is deleted. */
  staleMarkdownHolders: ReferenceHolder[];
  /** Doomed documents something outside the delete set still references. */
  blocked: BlockedDocument[];
  /** The plan every write comes from. The purge re-makes it from fresh reads and stops if it grew. */
  plan?: LanguageRemovalPlan;
  scope?: LanguageScope;
  /** What each language this run takes out still holds, and the Settings redirects that land in one. */
  languages?: { counts: LanguageCount[]; redirectsInto: RedirectRule[] };
};

/**
 * The languages a run takes out of the dataset. Without a context nothing is read by language, and the
 * plan only judges references, translation links and releases for the types going.
 */
export type LanguageScope = {
  context?: I18nContext;
  removed: readonly string[];
  /** Clear text on what stays and flatten asset text to one locale: a language run does, a type purge does not. */
  cleanText: boolean;
  /** Clear text in every language outside those kept, not only in `removed`: asked for, never implied by a removal. */
  strayText?: boolean;
};

export const TYPES_ONLY: LanguageScope = { removed: [], cleanText: false };

/** A redirect from Settings, read through a reference when it is one. */
export type RedirectRule = { from: string; to: string };

/** A doomed document, and what still points at it from outside the delete set. */
export type BlockedDocument = {
  _id: string;
  _type: string;
  blockedBy: ReferenceHolder[];
};

function assertTypeNames(types: string[]): void {
  for (const type of types) {
    if (!TYPE_NAME.test(type)) {
      throw new Error(`Refusing to build a query for the unexpected type name "${type}".`);
    }
  }
}

function assertFields(fields: readonly StoredField[]): void {
  assertTypeNames(fields.map((field) => field.documentType));

  for (const { name } of fields) {
    if (!FIELD_NAME.test(name)) {
      throw new Error(`Refusing to build a query for the unexpected field name "${name}".`);
    }
  }
}

/** A GROQ string literal, single-quoted because the shell already owns the double quotes. */
function literal(value: string): string {
  return `'${value.replace(/'/g, "\\'")}'`;
}

/** Published, draft and release version counts for one type, each in its own bucket. */
function countsEntry(type: string): string {
  const count = (where: string) => `count(*[_type == ${literal(type)} && ${where}])`;

  return `${literal(type)}: { "published": ${count(PUBLISHED)}, "drafts": ${count(DRAFT)}, "versions": ${count(VERSION)} }`;
}

/**
 * One query for the whole report. Published documents, drafts and release versions are counted in
 * separate buckets by `_id`, which only sees all three because `runQuery` reads the raw perspective.
 */
export function buildUsageQuery(documentTypes: string[], sectionTypes: string[], fields: readonly StoredField[] = []): string {
  assertTypeNames([...documentTypes, ...sectionTypes]);

  const documents = documentTypes.map(countsEntry).join(", ");

  const sections = sectionTypes
    .map(
      (type) =>
        `${literal(type)}: *[count(pageBuilder.sectionsArray[_type == ${literal(type)}]) > 0]{ _id, "uri": uri.current, "count": count(pageBuilder.sectionsArray[_type == ${literal(type)}]) }`
    )
    .join(", ");

  if (fields.length === 0) {
    return `{ "documents": { ${documents} }, "sections": { ${sections} } }`;
  }

  return `{ "documents": { ${documents} }, "sections": { ${sections} }, "fields": ${buildFieldUsageQuery(fields)} }`;
}

/** How many documents of each field's type still store it, drafts and release versions included, keyed by `fieldLabel`. */
export function buildFieldUsageQuery(fields: readonly StoredField[]): string {
  assertFields(fields);

  const entries = fields
    .map((field) => `${literal(fieldLabel(field))}: count(*[_type == ${literal(field.documentType)} && defined(${field.name})])`)
    .join(", ");

  return `{ ${entries} }`;
}

/** The Markdown generated for agents, which describes whatever content existed when it was generated. */
export function buildGeneratedMarkdownQuery(): string {
  return `*[defined(agentMarkdown.content) || defined(llms.content)]{ "agent": agentMarkdown.content, "llms": llms.content }`;
}

/**
 * Documents whose `internal.sectionTarget` names one of the section keys about to be removed. The
 * anchor is a plain string rather than a reference, so nothing in Sanity would ever report these as
 * broken; without this query they degrade silently to a bare page URL.
 *
 * GROQ has no "find this string anywhere in the document" operator, so the scan covers where the
 * schema actually puts a link: a page-builder section's own `appLink`. A `sectionTarget` written
 * into a rich text annotation is not reachable here, which is why the closing report says the
 * anchor check is a floor rather than a guarantee.
 */
export function buildSectionAnchorQuery(sectionKeys: string[]): string {
  if (sectionKeys.length === 0) {
    return "[]";
  }

  const keys = sectionKeys.map(literal).join(", ");

  return `*[
  count(pageBuilder.sectionsArray[sectionContent.appLink.internal.sectionTarget in [${keys}]]) > 0
]{ _id, _type, "uri": uri.current }`;
}

/**
 * Every `_key` a removed section occupies, so the anchors pointing at them can be reported. Returned
 * alongside the owning document, because a `_key` is only unique within its own array.
 */
export function buildSectionKeyQuery(sectionTypes: string[]): string {
  assertTypeNames(sectionTypes);

  const types = sectionTypes.map(literal).join(", ");

  return `*[count(pageBuilder.sectionsArray[_type in [${types}]]) > 0]{
  _id,
  "uri": uri.current,
  "keys": pageBuilder.sectionsArray[_type in [${types}]]._key
}`;
}

/** Documents carrying generated Markdown, which is stored verbatim and goes wrong after a purge. */
export function buildStaleMarkdownQuery(): string {
  return `*[defined(agentMarkdown.content) || defined(llms.content)]{ _id, _type, "uri": uri.current }`;
}

/** Ids of every document of the doomed types, drafts and release versions included. */
export function buildDeleteIdsQuery(documentTypes: string[]): string {
  assertTypeNames(documentTypes);

  const types = documentTypes.map(literal).join(", ");

  return `*[_type in [${types}]]{ _id, _type }`;
}

/**
 * Every distinct `_type` stored in the dataset.
 *
 * The other half of the orphan report: the schema says what is declared, this says what is actually
 * stored, and the difference is what nothing can render.
 */
export function buildLiveTypesQuery(): string {
  return `array::unique(*[]._type)`;
}

/** Every section item type pages store, declared or not: the other half of the stranded-section check. */
export function buildLiveSectionTypesQuery(): string {
  return `array::unique(*[defined(pageBuilder.sectionsArray)].pageBuilder.sectionsArray[]._type)`;
}

/** Published, draft and release version counts for a set of types, counted separately so none hides another. */
export function buildTypeCountsQuery(types: string[]): string {
  const usable = types.filter((type) => TYPE_NAME.test(type));

  if (usable.length === 0) {
    return "{}";
  }

  return `{ ${usable.map(countsEntry).join(", ")} }`;
}

/** Above this, one transaction may be too large for Sanity to accept; nothing has measured the real limit yet. */
const TRANSACTION_WARNING = 2000;

/** Without i18n nothing is read by language, so any valid code stands in for a default no plan consults. */
const WITHOUT_LANGUAGES: LanguageRemovalConfig = {
  defaultLocale: "en",
  keep: ["en"],
  removed: [],
  i18nTypes: [],
  localizedFields: {},
};

/** The planner's config for a scope. A type purge leaves text in other languages alone, so it reads none. */
export function scopeConfig(scope: LanguageScope): LanguageRemovalConfig {
  if (!scope.context) {
    if (scope.removed.length > 0 || scope.cleanText) {
      throw new Error("Languages cannot be removed without reading sanity/i18n.ts.");
    }

    return WITHOUT_LANGUAGES;
  }

  const config = { ...removalConfig(scope.context, scope.removed), strayText: scope.strayText === true };

  return scope.cleanText ? config : { ...config, localizedFields: {} };
}

/** The plan for one scope. A type purge is planned without the asset text it never touches. */
export function planScope(input: LanguageRemovalInput, scope: LanguageScope): LanguageRemovalPlan {
  return planLanguageRemoval(scope.cleanText ? input : { ...input, assets: [] }, scopeConfig(scope));
}

/**
 * Ids of every copy a section strip or a field unset patches, drafts and release versions included, so a
 * version in a release Sanity would refuse to write stops the purge before the export rather than halfway.
 */
export function buildPatchTargetsQuery(sectionTypes: string[], fields: readonly StoredField[]): string {
  assertTypeNames(sectionTypes);
  assertFields(fields);

  const conditions = [
    ...(sectionTypes.length > 0
      ? [`count(pageBuilder.sectionsArray[_type in [${sectionTypes.map(literal).join(", ")}]]) > 0`]
      : []),
    ...fields.map(({ documentType, name }) => `(_type == ${literal(documentType)} && defined(${name}))`),
  ];

  return conditions.length > 0 ? `*[${conditions.join(" || ")}]._id` : "[]";
}

/** What a purge writes besides the plan's own writes. */
type PatchTargets = { sectionTypes: string[]; fields: readonly StoredField[] };

/** Every copy of the doomed types, drafts and release versions included, plus what the scope adds and what points in. */
async function readPlanInput(
  read: (query: string) => unknown,
  documentTypes: string[],
  scope: LanguageScope,
  targets: PatchTargets
): Promise<{ input: LanguageRemovalInput; typeIds: { _id: string; _type: string }[] } | undefined> {
  const [typeIds, patched] = await Promise.all([
    documentTypes.length > 0 ? read(buildDeleteIdsQuery(documentTypes)) : [],
    read(buildPatchTargetsQuery(targets.sectionTypes, targets.fields)),
  ]);

  if (!Array.isArray(typeIds) || !Array.isArray(patched)) {
    return undefined;
  }

  const ids = typeIds as { _id: string; _type: string }[];
  const input = await readLanguageRemovalInput(
    read,
    scopeConfig(scope),
    ids.map(({ _id }) => _id)
  );

  return input ? { input: { ...input, alsoPatching: patched as string[] }, typeIds: ids } : undefined;
}

/** A blocked document of a type the language scan does not read takes its type from the delete list. */
function namedBlocked(plan: LanguageRemovalPlan, typeIds: readonly { _id: string; _type: string }[]): BlockedDocument[] {
  const types = new Map(typeIds.map(({ _id, _type }) => [publishedIdOf(_id), _type]));

  return plan.blocked.map((entry) => ({ ...entry, _type: entry._type || types.get(entry._id) || "" }));
}

/** Settings redirects that land under a removed language's prefix, which now answers 404. */
export function buildRedirectsIntoQuery(languages: readonly string[]): string {
  for (const language of languages) {
    if (!LANGUAGE_ID.test(language)) {
      throw new Error(`Refusing to build a query for the unexpected language ${JSON.stringify(language)}.`);
    }
  }

  const into = languages.flatMap((language) => [
    `to == ${literal(`/${language}`)}`,
    `string::startsWith(to, ${literal(`/${language}/`)})`,
  ]);

  return `coalesce(*[_id == "siteSettings"][0].redirects[]{ "from": coalesce(from, @->from), "to": coalesce(to, @->to) }[${into.join(" || ") || "false"}], [])`;
}

/**
 * Whether a feature still has content behind it.
 *
 * The question the dataset-only purge is built on: its files are gone, but is anything left to
 * delete? A type with a schema but no documents is not stranded, and preselecting it would invite
 * someone to confirm a delete that does nothing.
 */
export function isStranded(
  feature: { documentTypes?: string[]; sectionTypes?: string[]; fields?: StoredField[] },
  usage: Usage
): boolean {
  const documentTypes = feature.documentTypes ?? [];
  const sectionTypes = feature.sectionTypes ?? [];
  const fields = (feature.fields ?? []).map(fieldLabel);

  const hasDocuments = usage.documents.some((entry) => documentTypes.includes(entry.type) && storedTotal(entry) > 0);
  const hasSections = usage.sections.some(
    (entry) => sectionTypes.includes(entry.type) && entry.pages.some((page) => page.count > 0)
  );
  const hasFields = usage.fields.some((entry) => fields.includes(fieldLabel(entry)) && entry.documents > 0);

  return hasDocuments || hasSections || hasFields;
}

/** English pluralisation for the report, kept out of the formatter so the formatter stays readable. */
function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Verb agreement for the counted warnings, so a single holder does not read as a typo. */
function verb(count: number, singular: string, plural: string): string {
  return count === 1 ? singular : plural;
}

/** The `📊 Dataset usage` block, printed before the trim asks which features to remove. */
export function formatUsageReport(usage: Usage): string[] {
  const lines = [`📊 Dataset usage (${usage.dataset})`, ""];
  const languages = usage.languages?.counts ?? [];
  const removed = usage.scope?.removed ?? [];

  if (usage.documents.length === 0 && usage.sections.length === 0 && usage.fields.length === 0 && removed.length === 0) {
    return [...lines, "   • nothing to report: none of these features stores content.", ""];
  }

  const labelWidth = Math.max(
    ...usage.documents.map((entry) => entry.type.length),
    ...usage.sections.map((entry) => entry.type.length),
    ...usage.fields.map((entry) => fieldLabel(entry).length),
    0
  );

  for (const entry of usage.documents) {
    const verdict = storedTotal(entry) > 0 ? "⚠️  in use" : "✅ unused";
    const noun = entry.published === 1 ? "document " : "documents";

    lines.push(
      `   • ${entry.type.padEnd(labelWidth)}  ${String(entry.published).padStart(4)} ${noun}${unpublishedSuffix(entry)}  ${verdict}`
    );
  }

  for (const entry of usage.sections) {
    const instances = entry.pages.reduce((sum, page) => sum + page.count, 0);
    const verdict = instances > 0 ? "⚠️  in use" : "✅ unused";

    lines.push(
      `   • ${entry.type.padEnd(labelWidth)}  ${String(instances).padStart(4)} ${instances === 1 ? "instance " : "instances"} across ${plural(entry.pages.length, "page")}  ${verdict}`
    );
  }

  for (const entry of usage.fields) {
    const verdict = entry.documents > 0 ? "⚠️  set" : "✅ unset";

    lines.push(
      `   • ${fieldLabel(entry).padEnd(labelWidth)}  ${String(entry.documents).padStart(4)} ${entry.documents === 1 ? "document " : "documents"}  ${verdict}`
    );
  }

  for (const language of removed) {
    const entry = languages.find((count) => count.language === language);

    lines.push(`   • language ${entry ? describeLanguageCount(entry) : `${language} nothing stored  ✅ unused`}`);
  }

  return [...lines, ""];
}

/** Whether a run takes languages out, or clears text left in them, rather than only purging types. */
function isLanguageRun(usage: Pick<Usage, "scope">): boolean {
  return (usage.scope?.removed.length ?? 0) > 0 || usage.scope?.cleanText === true;
}

/** The purge plan: what goes in the one transaction, then everything the purge cannot fix and will not pretend to. */
export function formatPurgePlan(usage: Usage, documentTypes: string[], titles: Readonly<Record<string, string>> = {}): string[] {
  const lines = ["🗑️  Dataset purge plan", ""];

  const setFields = usage.fields.filter((entry) => entry.documents > 0);
  const languageRun = isLanguageRun(usage);

  if (documentTypes.length === 0 && usage.sections.length === 0 && setFields.length === 0 && !languageRun) {
    lines.push("   • nothing to delete.");
    return [...lines, ""];
  }

  if (documentTypes.length > 0) {
    // One transaction, so a strong reference between two doomed documents is not a problem and no
    // ordering is needed. What matters is anything outside the set still pointing in, which is
    // reported separately because no ordering could fix it.
    lines.push(`   Types: ${documentTypes.join(", ")}`);

    const total = usage.documents.reduce((sum, entry) => sum + storedTotal(entry), 0);
    const including = usage.documents.some((entry) => entry.versions > 0) ? "drafts and release versions" : "drafts";

    lines.push(`   ${plural(total, "document")} including ${including}, deleted in one transaction.`);
  }

  for (const { type, pages } of usage.sections.filter((entry) => entry.pages.length > 0)) {
    const uses = pages.reduce((sum, page) => sum + page.count, 0);
    lines.push(`   ${type}: ${plural(uses, "section use")} stripped from ${plural(pages.length, "page")}; the pages stay.`);
  }

  for (const entry of setFields) {
    lines.push(`   ${fieldLabel(entry)}: unset on ${plural(entry.documents, "document")}; the documents stay.`);
  }

  const links = usage.plan ? usage.plan.metadataPatches.length + usage.plan.metadataDeletes.length : 0;

  if (!languageRun && usage.plan && links > 0) {
    lines.push(
      `   Translation links: ${plural(usage.plan.metadataDeletes.length, "group")} deleted, ${usage.plan.metadataPatches.length} repaired, in the same transaction.`
    );
  }

  const writes = usage.plan ? languageRemovalMutations(usage.plan).transaction.length : 0;

  if (writes > TRANSACTION_WARNING) {
    lines.push(`   ⚠️  ${writes} writes in one transaction: Sanity may refuse one this large. Purge fewer types at a time.`);
  }

  if (lines.length > 2) {
    lines.push("");
  }

  if (languageRun && usage.plan) {
    lines.push(...formatLanguageRemovalPlan(usage.plan, titles));
  } else {
    lines.push(...blockedLines(usage));
  }

  const redirects = usage.languages?.redirectsInto ?? [];

  if (redirects.length > 0) {
    lines.push(
      `   ⚠️  ${plural(redirects.length, "redirect")} in Settings ${verb(redirects.length, "lands", "land")} in a language that now answers 404:`,
      ...redirects.map(({ from, to }) => `      - ${from} → ${to}`),
      ""
    );
  }

  if (usage.sectionAnchorHolders.length > 0) {
    const count = usage.sectionAnchorHolders.length;
    lines.push(`   ⚠️  ${plural(count, "link")} ${verb(count, "anchors", "anchor")} to a section that is being removed:`);

    for (const holder of usage.sectionAnchorHolders) {
      lines.push(`      - ${holder._type} ${holder.uri ?? holder._id} (falls back to the bare page URL)`);
    }

    lines.push("");
  }

  const deletes =
    documentTypes.length > 0 || usage.sections.some((entry) => entry.pages.length > 0) || (usage.plan?.deleteIds.length ?? 0) > 0;

  if (deletes && usage.staleMarkdownHolders.length > 0) {
    const count = usage.staleMarkdownHolders.length;

    lines.push(
      `   ⚠️  ${plural(count, "document")} ${verb(count, "carries", "carry")} generated Markdown that will describe deleted content.`,
      "      Regenerate from the Agents tab after the purge.",
      ""
    );
  }

  return lines;
}

/** A type purge's blockers, refusals and dangling holders; a language run prints them with its own plan. */
function blockedLines(usage: Usage): string[] {
  const lines: string[] = [];

  if (usage.blocked.length > 0) {
    lines.push(
      `   ⛔ ${plural(usage.blocked.length, "document")} ${verb(usage.blocked.length, "is", "are")} held by a strong reference from something that survives.`,
      "      Sanity would refuse the whole purge and delete nothing. Remove these references first:"
    );

    for (const entry of usage.blocked.slice(0, 10)) {
      const holders = entry.blockedBy.map((holder) => `${holder._type} ${holder.uri ?? holder._id}`).join(", ");
      lines.push(`      - ${entry._type} ${entry._id} ← ${holders}`);
    }

    if (usage.blocked.length > 10) {
      lines.push(`      … and ${usage.blocked.length - 10} more`);
    }

    lines.push("");
  }

  const refusals = usage.plan?.refusals ?? [];

  if (refusals.length > 0) {
    lines.push("   ⛔ Sanity would refuse these writes, so nothing is exported or deleted until they are fixed:");
    lines.push(...refusals.map(({ id, reason }) => `      - ${id}: ${reason}`), "");
  }

  if (usage.weakReferenceHolders.length > 0) {
    const count = usage.weakReferenceHolders.length;
    lines.push(`   ⚠️  ${plural(count, "document")} ${verb(count, "holds", "hold")} a weak reference that will dangle:`);

    for (const holder of usage.weakReferenceHolders) {
      lines.push(`      - ${holder._type} ${holder.uri ?? holder._id}`);
    }

    lines.push("");
  }

  return lines;
}

/** Why a purge must not start: a strong reference from a survivor, or a write Sanity would refuse. */
export function purgeRefusals(usage: Pick<Usage, "blocked" | "plan">): string[] {
  const blocked = usage.blocked.map(
    ({ _id, _type, blockedBy }) =>
      `${_type} ${_id} is strongly referenced by ${blockedBy.map((holder) => `${holder._type} ${holder.uri ?? holder._id}`).join(", ")}.`
  );

  return [...new Set([...blocked, ...refusalReasons({ blocked: [], refusals: usage.plan?.refusals ?? [] })])];
}

/**
 * The `sanity exec` call behind `runQuery`. `documents query` cannot set a perspective, and from API
 * version 2025-02-19 the default is `published`, which hides every draft and release version.
 */
export function buildRawQueryArgs(query: string, dataset: string, apiVersion = "2025-02-19"): string[] {
  return ["exec", RAW_QUERY_SCRIPT, "--with-user-token", "--", query, dataset, apiVersion];
}

/**
 * Reads a GROQ query under the raw perspective on the machine's `sanity login`, no token needed.
 * `undefined` means the read failed; a query answering `null` or `0` comes back as that value.
 */
export function runQuery<Result>(query: string, dataset: string, apiVersion = "2025-02-19"): Result | undefined {
  const result = captureSanityCommand(buildRawQueryArgs(query, dataset, apiVersion));

  if (!result.ok) {
    return undefined;
  }

  try {
    return JSON.parse(result.stdout) as Result;
  } catch {
    return undefined;
  }
}

type RawCounts = { published: number; drafts: number; versions: number };

type RawUsage = {
  documents: Record<string, RawCounts>;
  sections: Record<string, { _id: string; uri?: string; count: number }[]>;
  fields?: Record<string, number>;
};

/** The raw reader for one dataset, in the shape the language plan reads through. */
function datasetReader(dataset: string): (query: string) => unknown {
  return (query) => runQuery(query, dataset);
}

/**
 * The whole report. Returns `undefined` when Sanity is unreachable, so the caller can carry on with
 * the code trim and say plainly that the choice is uninformed.
 */
export async function readUsage(
  dataset: string,
  documentTypes: string[],
  sectionTypes: string[],
  fields: readonly StoredField[] = [],
  scope: LanguageScope = TYPES_ONLY
): Promise<Usage | undefined> {
  const raw = runQuery<RawUsage>(buildUsageQuery(documentTypes, sectionTypes, fields), dataset);
  const planned =
    raw === undefined ? undefined : await readPlanInput(datasetReader(dataset), documentTypes, scope, { sectionTypes, fields });

  if (raw === undefined || planned === undefined) {
    return undefined;
  }

  const sectionKeyDocs =
    sectionTypes.length > 0
      ? (runQuery<{ _id: string; uri?: string; keys?: string[] }[]>(buildSectionKeyQuery(sectionTypes), dataset) ?? [])
      : [];
  const sectionKeys = sectionKeyDocs.flatMap((entry) => entry.keys ?? []);
  const plan = planScope(planned.input, scope);
  const removed = new Set(scope.removed);
  const counts =
    scope.context && removed.size > 0
      ? languageCensus(planned.input, censusConfig(scope.context)).languages.filter((entry) => removed.has(entry.language))
      : [];
  const redirectsInto = readRedirectsInto(dataset, [...removed]);

  return {
    dataset,
    documents: documentTypes.map((type) => ({
      type,
      published: raw.documents?.[type]?.published ?? 0,
      drafts: raw.documents?.[type]?.drafts ?? 0,
      versions: raw.documents?.[type]?.versions ?? 0,
    })),
    sections: sectionTypes.map((type) => ({ type, pages: raw.sections?.[type] ?? [] })),
    fields: fields.map((field) => ({ ...field, documents: raw.fields?.[fieldLabel(field)] ?? 0 })),
    weakReferenceHolders: plan.dangling,
    sectionAnchorHolders: dedupeHolders(
      sectionKeys.length > 0 ? (runQuery<ReferenceHolder[]>(buildSectionAnchorQuery(sectionKeys), dataset) ?? []) : []
    ),
    staleMarkdownHolders: dedupeHolders(runQuery<ReferenceHolder[]>(buildStaleMarkdownQuery(), dataset) ?? []),
    blocked: namedBlocked(plan, planned.typeIds),
    plan,
    scope,
    languages: removed.size > 0 ? { counts, redirectsInto } : undefined,
  };
}

/** One dataset's languages: the raw scan and what each language holds against what is configured now. */
export type LanguageReading = { dataset: string; documents: RawDocument[]; assets: RawDocument[]; census: LanguageCensus };

export async function readLanguages(dataset: string, context: I18nContext): Promise<LanguageReading | undefined> {
  const scan = await readLanguageScan(datasetReader(dataset), context);

  return scan
    ? { dataset, documents: scan.documents, assets: scan.assets, census: languageCensus(scan, censusConfig(context)) }
    : undefined;
}

/**
 * What switching `removed` off leaves a dataset to clean: each language's own content, and the asset text a
 * single locale left can no longer edit, which the same purge flattens. Read against the locales that stay.
 */
export function languageWorkAfter(
  reading: Pick<LanguageReading, "documents" | "assets">,
  context: I18nContext,
  removed: readonly string[]
): { counts: LanguageCount[]; assetsToFlatten: number } {
  if (removed.length === 0) {
    return { counts: [], assetsToFlatten: 0 };
  }

  const census = languageCensus(reading, removalConfig(context, removed));

  return {
    counts: census.languages.filter((entry) => removed.includes(entry.language)),
    assetsToFlatten: census.assetsToFlatten,
  };
}

/** Settings redirects that land in a removed language, or an empty list when they could not be read. */
export function readRedirectsInto(dataset: string, languages: readonly string[]): RedirectRule[] {
  return languages.length > 0 ? (runQuery<RedirectRule[]>(buildRedirectsIntoQuery(languages), dataset) ?? []) : [];
}

/** Whether the Sanity CLI has a session: the pre-purge export needs one, and the reads alone do not prove it. */
export function isCliLoggedIn(): boolean {
  return captureSanityCommand(buildListArgs()).ok;
}

/** How many documents still store each field. A field that could not be read counts as unset. */
function readFieldUsage(dataset: string, fields: readonly StoredField[]): StrandedField[] {
  if (fields.length === 0) {
    return [];
  }

  const counts = runQuery<Record<string, number>>(buildFieldUsageQuery(fields), dataset) ?? {};

  return fields.map((field) => ({ ...field, documents: counts[fieldLabel(field)] ?? 0 }));
}

/** The generated agent Markdown and llms.txt a dataset stores, as one string per document. */
export function readGeneratedMarkdown(dataset: string): string[] | undefined {
  const rows = runQuery<{ agent?: string; llms?: string }[]>(buildGeneratedMarkdownQuery(), dataset);

  return rows?.flatMap((row) => [row.agent, row.llms].filter((text): text is string => typeof text === "string"));
}

/**
 * Documents per type, section instances per section type and documents storing each field, in one
 * read, for the status table. Fields are keyed by `fieldLabel`.
 */
export function readTypeTotals(
  dataset: string,
  documentTypes: string[],
  sectionTypes: string[],
  fields: readonly StoredField[] = []
): Record<string, number> | undefined {
  const raw = runQuery<RawUsage>(buildUsageQuery(documentTypes, sectionTypes, fields), dataset);

  if (raw === undefined) {
    return undefined;
  }

  const none: RawCounts = { published: 0, drafts: 0, versions: 0 };

  return Object.fromEntries([
    ...documentTypes.map((type) => [type, storedTotal({ ...none, ...raw.documents?.[type] })]),
    ...sectionTypes.map((type) => [type, (raw.sections?.[type] ?? []).reduce((sum, page) => sum + page.count, 0)]),
    ...fields.map((field) => [fieldLabel(field), raw.fields?.[fieldLabel(field)] ?? 0]),
  ]);
}

export type Stranded = {
  dataset: string;
  documents: LiveType[];
  sections: StrandedSection[];
  fields: StrandedField[];
  /** What is stored per language, read only when the project has i18n. */
  languages?: LanguageCensus;
};

/** Languages LOCALES does not serve that a purge can take out, and whether text is left to clean without one. */
export function strandedLanguagesOf(entry: Pick<Stranded, "languages">): { removable: LanguageCount[]; leftovers: boolean } {
  return entry.languages
    ? { removable: strandedLanguages(entry.languages), leftovers: hasLanguageLeftovers(entry.languages) }
    : { removable: [], leftovers: false };
}

/**
 * What a dataset stores that the schema no longer declares: whole documents, and section items left
 * inside pages. Needs no manifest, so it finds what any earlier trim, or hand edit, left behind.
 *
 * Fields are the exception, because there is no listing every key a document stores: `candidates`
 * names the ones to look for, and only those the extracted schema has stopped declaring are read.
 * Languages are judged by the config instead: a language LOCALES does not serve is left behind.
 */
export async function readStranded(
  dataset: string,
  schemaJson: string,
  candidates: readonly StoredField[] = [],
  context?: I18nContext
): Promise<Stranded | undefined> {
  const liveTypes = runQuery<string[]>(buildLiveTypesQuery(), dataset);

  if (liveTypes === undefined) {
    return undefined;
  }

  const counts = runQuery<Record<string, RawCounts>>(buildTypeCountsQuery(liveTypes), dataset) ?? {};
  const live = liveTypes.map((type) => ({
    type,
    published: counts[type]?.published ?? 0,
    drafts: counts[type]?.drafts ?? 0,
    versions: counts[type]?.versions ?? 0,
  }));
  const sectionTypes = findStrandedSectionTypes(
    parseAllTypeNames(schemaJson),
    runQuery<string[]>(buildLiveSectionTypesQuery(), dataset) ?? []
  ).filter((type) => TYPE_NAME.test(type));
  const uses = sectionTypes.length > 0 ? runQuery<RawUsage>(buildUsageQuery([], sectionTypes), dataset) : undefined;
  const languages = context ? await readLanguages(dataset, context) : undefined;

  return {
    dataset,
    documents: findOrphanTypes(parseRegisteredTypes(schemaJson), live),
    sections: sectionTypes.map((type) => ({
      type,
      uses: (uses?.sections?.[type] ?? []).reduce((sum, page) => sum + page.count, 0),
    })),
    fields: readFieldUsage(dataset, findUndeclaredFields(schemaJson, candidates)).filter((field) => field.documents > 0),
    languages: languages?.census,
  };
}

export type PurgeResult = {
  deletedDocuments: number;
  discardedVersions: number;
  translationLinks: number;
  strippedSections: number;
  unsetFields: number;
  cleanedDocuments: number;
};

export type PurgeRequest = {
  documentTypes: string[];
  sectionTypes: string[];
  fields?: readonly StoredField[];
  scope?: LanguageScope;
  /** The plan the person confirmed. A plan re-made now that would write anything more stops the purge. */
  confirmed?: LanguageRemovalPlan;
};

/** Thrown before any write when the dataset changed between the confirmation and the purge. */
export class PlanChangedError extends Error {
  constructor(readonly reasons: string[]) {
    super(
      `The dataset changed since the plan was confirmed: ${reasons.slice(0, 5).join("; ")}${reasons.length > 5 ? "; …" : ""}`
    );
    this.name = "PlanChangedError";
  }
}

/**
 * Re-plans from fresh raw reads on the edit token and refuses anything the person did not confirm:
 * a write the plan grew by, a strong reference, or a version in a release that is not active.
 */
export async function planPurge(client: SanityClient, request: PurgeRequest): Promise<LanguageRemovalPlan> {
  const scope = request.scope ?? TYPES_ONLY;
  const planned = await readPlanInput((query) => client.fetch(query), request.documentTypes, scope, {
    sectionTypes: request.sectionTypes,
    fields: request.fields ?? [],
  });

  if (!planned) {
    throw new Error("The dataset could not be read again before the purge.");
  }

  const plan = planScope(planned.input, scope);
  const grew = request.confirmed ? planGrowth(request.confirmed, plan) : [];

  if (grew.length > 0) {
    throw new PlanChangedError(grew);
  }

  const refusals = refusalReasons(plan);

  if (refusals.length > 0) {
    throw new PlanChangedError(refusals);
  }

  return plan;
}

/**
 * Deletes every copy the plan names: release versions are discarded first (nothing can reference a
 * version), then translation links are repaired and documents deleted in one transaction. Removed
 * sections are stripped from the pages that stay, fields unset, and text in removed languages
 * cleaned in batches, all of which a rerun finishes if it stops partway.
 */
export async function executePurge(
  client: SanityClient,
  plan: LanguageRemovalPlan,
  request: Pick<PurgeRequest, "sectionTypes" | "fields">
): Promise<PurgeResult> {
  const { sectionTypes, fields = [] } = request;
  const { versionIds, discards, transaction, patches } = languageRemovalMutations(plan);

  for (const batch of discards) {
    await client.action(batch);
  }

  if (transaction.length > 0) {
    await client.transaction(transaction).commit({ visibility: "async" });
  }

  let strippedSections = 0;

  if (sectionTypes.length > 0) {
    assertTypeNames(sectionTypes);

    const pages = await client.fetch<{ _id: string; count: number }[]>(
      `*[count(pageBuilder.sectionsArray[_type in $types]) > 0]{ _id, "count": count(pageBuilder.sectionsArray[_type in $types]) }`,
      { types: sectionTypes }
    );

    for (const page of pages) {
      await client
        .patch(page._id)
        .unset(sectionTypes.map((type) => `pageBuilder.sectionsArray[_type == "${type}"]`))
        .commit({ visibility: "async" });

      strippedSections += page.count;
    }
  }

  let unsetFields = 0;

  assertFields(fields);

  for (const field of fields) {
    // Drafts included: a draft still carrying the field would show it to the next editor.
    const ids = await client.fetch<string[]>(`*[_type == $type && defined(${field.name})]._id`, { type: field.documentType });

    for (const id of ids) {
      await client.patch(id).unset([field.name]).commit({ visibility: "async" });
      unsetFields += 1;
    }
  }

  for (const batch of patches) {
    await client.transaction(batch).commit({ visibility: "async" });
  }

  return {
    deletedDocuments: transaction.filter((mutation) => "delete" in mutation).length,
    discardedVersions: versionIds.length,
    translationLinks: plan.metadataPatches.length + plan.metadataDeletes.length,
    strippedSections,
    unsetFields,
    cleanedDocuments: patches.flat().length,
  };
}

/** The plan re-made from fresh reads, then carried out: nothing is written unless the fresh plan is the confirmed one. */
export async function purge(client: SanityClient, request: PurgeRequest): Promise<PurgeResult> {
  return executePurge(client, await planPurge(client, request), request);
}
