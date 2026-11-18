// The plan for taking languages out of a dataset, shared by `npm run trim` and `sanity:migrate-remove-language`.
// Import-free: the locale config arrives as arguments, so a project cut before i18n still loads the trim.

/** A language code as `sanity/i18n.ts` writes one (`en`, `pt-BR`). Nothing else is ever removed or interpolated. */
export const LANGUAGE_ID = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

/** A key a patch path can name: a translation link's `_key`, or the arm of a localized field. */
export const KEY = /^[A-Za-z0-9_-]+$/;

export const TRANSLATION_METADATA = "translation.metadata";

export const ASSET_TYPES = ["sanity.imageAsset", "sanity.fileAsset"] as const;

/** The asset fields the media library stores per language once more than one locale is configured. */
export const LOCALIZED_ASSET_FIELDS = ["altText", "title", "description", "creditLine"] as const;

const TYPE_NAME = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)*$/;
/** A `LOCALIZED_FIELDS` entry: a field, or one nested a level down in an object (`seoMetadata.title`). */
const FIELD_PATH = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;

/** The localized value at a registry path, read through own keys only. */
export function valueAt(document: Record<string, unknown>, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>((value, key) => (isPlainObject(value) && Object.hasOwn(value, key) ? value[key] : undefined), document);
}
const DOCUMENT_ID = /^[A-Za-z0-9._-]+$/;

/** A scheduled release, or one mid-transition, refuses every write to its versions. */
const EDITABLE_RELEASE_STATE = "active";

const LISTED = 10;

export type RawDocument = { _id: string; _type?: string; [field: string]: unknown };

export type Release = { name: string; state?: string; title?: string; documents?: number };

export type LocaleConfig = {
  defaultLocale: string;
  /** The locales that stay configured, the default among them. Every arm outside it is unset. */
  keep: readonly string[];
  /** `I18N_DOCUMENT_TYPES`: types with one document per language. */
  i18nTypes: readonly string[];
  /** `LOCALIZED_FIELDS`: shared types and the fields they translate in place. */
  localizedFields: Readonly<Record<string, readonly string[]>>;
};

export type LanguageRemovalConfig = LocaleConfig & {
  /** Languages whose documents are deleted. Empty for a run that only cleans arms and asset text. */
  removed: readonly string[];
  /** Also clear text in every other language outside `keep`, not only in `removed`. A run removing nothing always does. */
  strayText?: boolean;
};

export type LanguageRemovalInput = {
  /** Every copy (published, draft, release version) of the translated and shared types, and `translation.metadata`. */
  documents: readonly RawDocument[];
  /** Whole documents referencing anything doomed (`buildReferrersQuery`, uncapped). */
  holders?: readonly RawDocument[];
  assets?: readonly RawDocument[];
  /** A doomed or patched release version whose release is missing here is refused. */
  releases?: readonly Release[];
  /** Every copy a type purge deletes in the same transaction, so links and cleanups are planned over the union. */
  alsoDeleting?: readonly string[];
  /** Every copy a section strip or a field unset patches in the same run, so a locked release refuses those too. */
  alsoPatching?: readonly string[];
};

export type VersionCounts = { published: number; drafts: number; versions: number };

export type ReferenceHolder = { _id: string; _type: string; uri?: string };

export type BlockedDocument = { _id: string; _type: string; blockedBy: ReferenceHolder[] };

export type GhostGroup = { publishedId: string; type: string; language: string; uri?: string; ids: string[] };

/** A document whose copies disagree on the language: never half-deleted, left for a person. */
export type MixedGroup = { publishedId: string; type: string; languages: string[] };

export type MetadataPatch = { id: string; unsetKeys: string[] };

export type Arm = { field: string; key: string };

export type FieldCleanup = { id: string; type: string; arms: Arm[] };

/** `set` flattens a field to its default text, `unset` drops one with none, `lost` names those that had other text. */
export type AssetCleanup = { id: string; set: Record<string, string>; unset: string[]; arms: Arm[]; lost: string[] };

export type Finding = { id: string; reason: string };

export type RedirectSuggestion = { from: string; to: string };

export type ReleaseImpact = { name: string; title?: string; state?: string; deleting: number; emptied: boolean };

export type LanguageRemovalPlan = {
  removed: string[];
  keep: string[];
  defaultLocale: string;
  /** One locale left: localized asset text collapses to the plain string the media library then writes. */
  flatten: boolean;
  groups: GhostGroup[];
  mixed: MixedGroup[];
  /** Exact ids, drafts and release versions included. */
  deleteIds: string[];
  metadataPatches: MetadataPatch[];
  metadataDeletes: string[];
  fieldCleanups: FieldCleanup[];
  assetCleanups: AssetCleanup[];
  /** Strong references from surviving documents: Sanity would refuse the whole transaction. */
  blocked: BlockedDocument[];
  /** Weak references from surviving documents: they dangle. */
  dangling: ReferenceHolder[];
  /** Writes Sanity would refuse, so a run stops before it exports anything. */
  refusals: Finding[];
  /** Data no write can address safely, left as it is. */
  skipped: Finding[];
  redirects: RedirectSuggestion[];
  releases: ReleaseImpact[];
};

export type LanguageCount = {
  language: string;
  configured: boolean;
  /** Why the language cannot be removed (configured, the default, missing, not a code), or undefined. */
  blocker?: string;
  documents: VersionCounts;
  translationLinks: number;
  sharedFields: number;
  assets: number;
};

export type LanguageCensus = {
  languages: LanguageCount[];
  /** Assets storing text per language while one locale is configured, which the media library cannot edit. */
  assetsToFlatten: number;
};

export type Mutation = { delete: { id: string } } | { patch: { id: string; set?: Record<string, string>; unset?: string[] } };

/** One Actions API discard: a release version cannot be deleted by a mutation. */
export type VersionDiscard = { actionType: "sanity.action.document.version.discard"; versionId: string };

export type LanguageRemovalMutations = {
  versionIds: string[];
  /** `versionIds` as Actions API requests, each a list of up to `batchSize`. */
  discards: VersionDiscard[][];
  transaction: Mutation[];
  patches: Mutation[][];
};

/** One GROQ read under the raw perspective, sync or async; `undefined` means it failed. */
export type QueryReader = (query: string) => unknown;

/** The seed archive's `assets.json`: asset metadata keyed by asset id. */
export type SeedAssets = Readonly<Record<string, Record<string, unknown>>>;

type Copy = { id: string; language?: string };

type Group = { publishedId: string; type: string; uri?: string; copies: Copy[]; language?: string; languages: string[] };

type MetadataRow = { key: unknown; language?: string; ref?: string; strong: boolean };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unique<T>(values: Iterable<T>): T[] {
  return [...new Set(values)];
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** The published id a draft (`drafts.<id>`) or a release version (`versions.<release>.<id>`) belongs to. */
export function publishedIdOf(id: string): string {
  if (id.startsWith("drafts.")) {
    return id.slice("drafts.".length);
  }

  const version = /^versions\.[^.]+\.(.+)$/.exec(id);

  return version?.[1] ?? id;
}

/** The release a version id belongs to; undefined for a published document or a draft. */
export function releaseOf(id: string): string | undefined {
  return /^versions\.([^.]+)\./.exec(id)?.[1];
}

function bucketOf(id: string): keyof VersionCounts {
  if (id.startsWith("drafts.")) {
    return "drafts";
  }

  return releaseOf(id) === undefined ? "published" : "versions";
}

function collectReferences(value: unknown, found = new Map<string, "strong" | "weak">()): Map<string, "strong" | "weak"> {
  if (value === null || typeof value !== "object") {
    return found;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectReferences(item, found);
    }

    return found;
  }

  const entry = value as Record<string, unknown>;

  if (typeof entry._ref === "string" && found.get(entry._ref) !== "strong") {
    found.set(entry._ref, entry._weak === true ? "weak" : "strong");
  }

  for (const child of Object.values(entry)) {
    collectReferences(child, found);
  }

  return found;
}

/** Whether `holder` references `id` strongly, weakly, or not at all. A strong one fails the whole transaction. */
export function referenceStrength(holder: unknown, id: string): "strong" | "weak" | undefined {
  return collectReferences(holder).get(id);
}

function uriOf(document: RawDocument): string | undefined {
  const { uri } = document;

  if (typeof uri === "string") {
    return uri;
  }

  return isPlainObject(uri) && typeof uri.current === "string" ? uri.current : undefined;
}

/** Absent stays undefined, `""` stays (it means missing), and anything not a string reads as its JSON. */
function storedLanguage(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  return typeof value === "string" ? value : JSON.stringify(value);
}

function holderOf(document: RawDocument): ReferenceHolder {
  return { _id: document._id, _type: document._type ?? "", uri: uriOf(document) };
}

/** One entry per document, however many of its copies matched, under the published id. */
export function dedupeHolders(holders: readonly ReferenceHolder[]): ReferenceHolder[] {
  const byId = new Map<string, ReferenceHolder>();

  for (const holder of holders) {
    const _id = publishedIdOf(holder._id);

    if (!byId.has(_id) || holder._id === _id) {
      byId.set(_id, { ...holder, _id });
    }
  }

  return [...byId.values()];
}

/** Why `language` can never be removed, or undefined when it can. `keep` is what stays configured. */
export function removalBlocker(language: string, config: Pick<LocaleConfig, "defaultLocale" | "keep">): string | undefined {
  if (language === "") {
    return "An empty language means the language is missing: `npm run sanity:migrate-backfill-language` sets it.";
  }

  if (!LANGUAGE_ID.test(language)) {
    return `${JSON.stringify(language)} is not a language code, so no removal is keyed on it.`;
  }

  if (language === config.defaultLocale) {
    return `"${language}" is the default locale. Changing the default is a URI rewrite, not a removal.`;
  }

  if (config.keep.includes(language)) {
    return `"${language}" is still configured in sanity/i18n.ts. Comment it out of LOCALES first.`;
  }

  return undefined;
}

function assertLocaleConfig(config: LocaleConfig): void {
  for (const locale of [config.defaultLocale, ...config.keep]) {
    if (!LANGUAGE_ID.test(locale)) {
      throw new Error(`Refusing a locale config with the unexpected locale ${JSON.stringify(locale)}.`);
    }
  }

  if (!config.keep.includes(config.defaultLocale)) {
    throw new Error(`The locales kept must include the default locale "${config.defaultLocale}".`);
  }

  for (const type of [...config.i18nTypes, ...Object.keys(config.localizedFields)]) {
    if (!TYPE_NAME.test(type)) {
      throw new Error(`Refusing a locale config with the unexpected type name ${JSON.stringify(type)}.`);
    }
  }

  for (const field of Object.values(config.localizedFields).flat()) {
    if (!FIELD_PATH.test(field)) {
      throw new Error(`Refusing a locale config with the unexpected field name ${JSON.stringify(field)}.`);
    }
  }
}

/** Own keys only: a stored `_type` such as `constructor` must not reach the object prototype. */
function localizedFieldsOf(config: Pick<LocaleConfig, "localizedFields">, type: string | undefined): readonly string[] {
  return type !== undefined && Object.hasOwn(config.localizedFields, type) ? (config.localizedFields[type] ?? []) : [];
}

function byId(documents: readonly RawDocument[]): Map<string, RawDocument> {
  return new Map(documents.map((document) => [document._id, document]));
}

/** Every copy of a translated document under its published id; `language` is left undefined when copies disagree. */
function groupTranslated(documents: Iterable<RawDocument>, config: LocaleConfig): Map<string, Group> {
  const types = new Set(config.i18nTypes);
  const groups = new Map<string, Group>();

  for (const document of documents) {
    if (!document._type || !types.has(document._type)) {
      continue;
    }

    const publishedId = publishedIdOf(document._id);
    const isPublished = document._id === publishedId;
    const group = groups.get(publishedId) ?? { publishedId, type: document._type, copies: [], languages: [] };
    const uri = uriOf(document);

    group.copies.push({ id: document._id, language: storedLanguage(document.language) });

    if (isPublished) {
      group.type = document._type;
    }

    if (uri !== undefined && (group.uri === undefined || isPublished)) {
      group.uri = uri;
    }

    groups.set(publishedId, group);
  }

  for (const group of groups.values()) {
    // A draft or version without one inherits (an unpublish version stores none); a published copy reads as the default.
    const stated = group.copies.flatMap(({ id, language }) => {
      if (language !== undefined) {
        return [language];
      }

      return id === group.publishedId ? [config.defaultLocale] : [];
    });

    group.languages = unique(stated);

    if (group.languages.length === 0) {
      group.language = config.defaultLocale;
    } else if (group.languages.length === 1) {
      group.language = group.languages[0];
    }
  }

  return groups;
}

function metadataRows(document: RawDocument): MetadataRow[] {
  const rows = Array.isArray(document.translations) ? document.translations : [];

  return rows.map((row) => {
    const entry = isPlainObject(row) ? row : {};
    const value = isPlainObject(entry.value) ? entry.value : {};
    const ref = typeof value._ref === "string" && value._ref !== "" ? value._ref : undefined;

    return {
      key: entry._key,
      language: typeof entry.language === "string" ? entry.language : undefined,
      ref,
      strong: ref !== undefined && value._weak !== true,
    };
  });
}

/** Which arms a run clears: those in `removed`, or every one outside `keep` when it removes nothing or sweeps. */
export function clearsArm(
  config: Pick<LanguageRemovalConfig, "keep"> & Partial<Pick<LanguageRemovalConfig, "removed" | "strayText">>
): (key: string) => boolean {
  const removed = config.removed ?? [];
  const sweep = config.strayText === true || removed.length === 0;

  return (key) => !config.keep.includes(key) && (sweep || removed.includes(key));
}

/** Arms of `value` a run clears. `_` keys are Sanity's own, and a plain string is not localized at all. */
function armsToClear(value: unknown, field: string, clears: (key: string) => boolean, id: string, skipped: Finding[]): Arm[] {
  if (!isPlainObject(value)) {
    return [];
  }

  return Object.keys(value).flatMap((key) => {
    if (key.startsWith("_") || !clears(key)) {
      return [];
    }

    if (!KEY.test(key)) {
      skipped.push({ id, reason: `${field} has an arm ${JSON.stringify(key)} no patch path can name.` });
      return [];
    }

    return [{ field, key }];
  });
}

function hasText(value: Record<string, unknown>): boolean {
  return Object.entries(value).some(([key, text]) => !key.startsWith("_") && typeof text === "string" && text !== "");
}

/**
 * One asset's cleanup: the arms the run clears unset, or, with one locale left, each field flattened to its
 * text, since the media library then edits only a plain string.
 */
export function planAssetCleanup(
  asset: RawDocument,
  config: Pick<LocaleConfig, "defaultLocale" | "keep"> & Partial<Pick<LanguageRemovalConfig, "removed" | "strayText">>,
  skipped: Finding[] = []
): AssetCleanup | undefined {
  const clears = clearsArm(config);
  const cleanup: AssetCleanup = { id: asset._id, set: {}, unset: [], arms: [], lost: [] };

  for (const field of LOCALIZED_ASSET_FIELDS) {
    const value = asset[field];

    if (!isPlainObject(value)) {
      continue;
    }

    if (config.keep.length > 1) {
      cleanup.arms.push(...armsToClear(value, field, clears, asset._id, skipped));
      continue;
    }

    // An empty string is written text, as it is for the alt text endpoint.
    const text = value[config.defaultLocale];

    if (typeof text === "string") {
      cleanup.set[field] = text;
      continue;
    }

    cleanup.unset.push(field);

    if (hasText(value)) {
      cleanup.lost.push(field);
    }
  }

  return Object.keys(cleanup.set).length + cleanup.unset.length + cleanup.arms.length > 0 ? cleanup : undefined;
}

/** Why Sanity would refuse a write to `id`, or undefined: a version in a release that is not active or unread. */
export function releaseLock(id: string, releases: readonly Release[] | undefined): string | undefined {
  const name = releaseOf(id);

  if (name === undefined) {
    return undefined;
  }

  const release = releases?.find((entry) => entry.name === name);

  if (release?.state === EDITABLE_RELEASE_STATE) {
    return undefined;
  }

  if (!release?.state) {
    return `it is a version in release "${name}", which could not be read.`;
  }

  const label = release.title ? `"${release.title}" (${name})` : `"${name}"`;

  return `it is a version in release ${label}, which is ${release.state}. Unschedule it first.`;
}

function releaseRefusals(ids: Iterable<string>, releases: readonly Release[] | undefined): Finding[] {
  const refusals: Finding[] = [];

  for (const id of unique(ids)) {
    const reason = releaseLock(id, releases);

    if (reason) {
      refusals.push({ id, reason });
    }
  }

  return refusals;
}

function releaseImpact(deleteIds: readonly string[], releases: readonly Release[] | undefined): ReleaseImpact[] {
  const deleting = new Map<string, number>();

  for (const name of deleteIds.map(releaseOf)) {
    if (name !== undefined) {
      deleting.set(name, (deleting.get(name) ?? 0) + 1);
    }
  }

  return [...deleting].map(([name, count]) => {
    const release = releases?.find((entry) => entry.name === name);

    return {
      name,
      title: release?.title,
      state: release?.state,
      deleting: count,
      emptied: typeof release?.documents === "number" && count >= release.documents,
    };
  });
}

/** Each doomed URI paired with its default-language sibling through its translation group. */
function redirectSuggestions(
  doomed: readonly GhostGroup[],
  metadata: readonly RawDocument[],
  groups: ReadonlyMap<string, Group>,
  doomedPublished: ReadonlySet<string>,
  defaultLocale: string
): RedirectSuggestion[] {
  const translationGroups = metadata.filter((document) => document._id === publishedIdOf(document._id)).map(metadataRows);
  const suggestions = new Map<string, string>();

  for (const group of doomed) {
    if (!group.uri || suggestions.has(group.uri)) {
      continue;
    }

    const rows = translationGroups.find((candidate) => candidate.some((row) => row.ref === group.publishedId));
    const sibling = rows?.find((row) => row.language === defaultLocale && row.ref !== undefined && !doomedPublished.has(row.ref));
    const to = sibling?.ref === undefined ? undefined : groups.get(sibling.ref)?.uri;

    if (to && to !== group.uri) {
      suggestions.set(group.uri, to);
    }
  }

  return [...suggestions].map(([from, to]) => ({ from, to }));
}

type MetadataRepair = { patches: MetadataPatch[]; deletes: string[]; refusals: Finding[]; skipped: Finding[] };

/** A link goes with its target, or when it is in a removed language and points at nothing that survives. */
function planMetadataRepair(
  metadata: readonly RawDocument[],
  removed: ReadonlySet<string>,
  doomedPublished: ReadonlySet<string>,
  surviving: ReadonlySet<string>
): MetadataRepair {
  const repair: MetadataRepair = { patches: [], deletes: [], refusals: [], skipped: [] };

  for (const document of metadata) {
    const rows = metadataRows(document);
    const leaving = rows.filter(
      ({ language, ref }) =>
        (ref !== undefined && doomedPublished.has(ref)) ||
        (language !== undefined && removed.has(language) && !(ref !== undefined && surviving.has(ref)))
    );

    if (leaving.length === 0) {
      continue;
    }

    // The plugin keeps a group only while it links two documents.
    if (rows.filter((row) => !leaving.includes(row) && row.ref !== undefined).length < 2) {
      repair.deletes.push(document._id);
      continue;
    }

    const unsetKeys: string[] = [];

    for (const row of leaving) {
      const key = JSON.stringify(row.key);

      if (typeof row.key === "string" && KEY.test(row.key)) {
        unsetKeys.push(row.key);
      } else if (row.strong && row.ref !== undefined && doomedPublished.has(row.ref)) {
        repair.refusals.push({
          id: document._id,
          reason: `its link ${key} strongly references ${row.ref}, and no patch path can name it.`,
        });
      } else {
        repair.skipped.push({ id: document._id, reason: `its link ${key} has a key no patch path can name.` });
      }
    }

    if (unsetKeys.length > 0) {
      repair.patches.push({ id: document._id, unsetKeys });
    }
  }

  return repair;
}

/** Surviving documents pointing at a doomed one, split into strong (blocks the commit) and weak (dangles). */
function classifyHolders(
  holders: Iterable<RawDocument>,
  skip: ReadonlySet<string>,
  doomedPublished: ReadonlySet<string>
): { strong: Map<string, ReferenceHolder[]>; weak: ReferenceHolder[] } {
  const strong = new Map<string, ReferenceHolder[]>();
  const weak: ReferenceHolder[] = [];

  for (const document of holders) {
    if (skip.has(document._id) || document._type === TRANSLATION_METADATA) {
      continue;
    }

    for (const [ref, strength] of collectReferences(document)) {
      const target = publishedIdOf(ref);

      if (!doomedPublished.has(target)) {
        continue;
      }

      if (strength === "strong") {
        strong.set(target, [...(strong.get(target) ?? []), holderOf(document)]);
      } else {
        weak.push(holderOf(document));
      }
    }
  }

  return { strong, weak };
}

/**
 * The whole plan from raw reads: every copy in `removed` goes, links with it, and survivors lose their text in
 * `removed` (in every language outside `keep` for a run that sweeps, see `clearsArm`).
 */
export function planLanguageRemoval(input: LanguageRemovalInput, config: LanguageRemovalConfig): LanguageRemovalPlan {
  assertLocaleConfig(config);

  for (const language of config.removed) {
    const blocker = removalBlocker(language, config);

    if (blocker) {
      throw new Error(blocker);
    }
  }

  const removed = new Set(config.removed);
  const clears = clearsArm(config);
  const documents = byId(input.documents);
  const groups = groupTranslated(documents.values(), config);
  const skipped: Finding[] = [];
  const doomedGroups: GhostGroup[] = [];
  const mixed: MixedGroup[] = [];

  for (const { publishedId, type, uri, copies, language, languages } of groups.values()) {
    if (language === undefined && languages.some((entry) => removed.has(entry))) {
      mixed.push({ publishedId, type, languages });
    }

    if (language !== undefined && removed.has(language)) {
      doomedGroups.push({ publishedId, type, language, uri, ids: copies.map(({ id }) => id) });
    }
  }

  const deleteIds = unique([...doomedGroups.flatMap(({ ids }) => ids), ...(input.alsoDeleting ?? [])]);
  const doomed = new Set(deleteIds);
  const doomedPublished = new Set(deleteIds.map(publishedIdOf));
  const surviving = new Set([...groups.keys()].filter((id) => !doomedPublished.has(id)));
  const metadata = [...documents.values()].filter(({ _type }) => _type === TRANSLATION_METADATA);
  const repair = planMetadataRepair(metadata, removed, doomedPublished, surviving);

  const holders = new Map(documents);

  for (const holder of input.holders ?? []) {
    holders.set(holder._id, holder);
  }

  const typeOf = new Map([...holders.values()].map(({ _id, _type }) => [publishedIdOf(_id), _type ?? ""]));
  const referrers = classifyHolders(holders.values(), new Set([...doomed, ...repair.deletes]), doomedPublished);
  const blocked = [...referrers.strong].map(([_id, blockedBy]) => ({
    _id,
    _type: groups.get(_id)?.type ?? typeOf.get(_id) ?? "",
    blockedBy: dedupeHolders(blockedBy),
  }));

  const fieldCleanups = [...documents.values()].flatMap((document) => {
    const arms = doomed.has(document._id)
      ? []
      : localizedFieldsOf(config, document._type).flatMap((field) =>
          armsToClear(valueAt(document, field), field, clears, document._id, skipped)
        );

    return arms.length > 0 ? [{ id: document._id, type: document._type ?? "", arms }] : [];
  });

  const assetCleanups = (input.assets ?? []).flatMap((asset) => planAssetCleanup(asset, config, skipped) ?? []);
  const written = [
    ...deleteIds,
    ...repair.deletes,
    ...repair.patches.map(({ id }) => id),
    ...fieldCleanups.map(({ id }) => id),
    ...assetCleanups.map(({ id }) => id),
    ...(input.alsoPatching ?? []),
  ];

  return {
    removed: [...config.removed],
    keep: [...config.keep],
    defaultLocale: config.defaultLocale,
    flatten: config.keep.length === 1,
    groups: doomedGroups,
    mixed,
    deleteIds,
    metadataPatches: repair.patches,
    metadataDeletes: repair.deletes,
    fieldCleanups,
    assetCleanups,
    blocked,
    dangling: dedupeHolders(referrers.weak),
    refusals: [...repair.refusals, ...releaseRefusals(written, input.releases)],
    skipped: [...repair.skipped, ...skipped],
    redirects: redirectSuggestions(doomedGroups, metadata, groups, doomedPublished, config.defaultLocale),
    releases: releaseImpact(deleteIds, input.releases),
  };
}

/** Nothing to write: no document, link, arm or asset text to touch. */
export function isEmptyPlan(plan: LanguageRemovalPlan): boolean {
  const writes = [plan.deleteIds, plan.metadataPatches, plan.metadataDeletes, plan.fieldCleanups, plan.assetCleanups];

  return writes.every((list) => list.length === 0);
}

/** Every reason the plan must not run, blockers first. Empty means it may. */
export function refusalReasons(plan: Pick<LanguageRemovalPlan, "blocked" | "refusals">): string[] {
  const holders = (blockedBy: ReferenceHolder[]) =>
    blockedBy.map((holder) => `${holder._type} ${holder.uri ?? holder._id}`).join(", ");

  return [
    ...plan.blocked.map(({ _id, _type, blockedBy }) => `${_type} ${_id} is strongly referenced by ${holders(blockedBy)}.`),
    ...plan.refusals.map(({ id, reason }) => `${id}: ${reason}`),
  ];
}

export function armPath({ field, key }: Arm): string {
  return `${field}['${key}']`;
}

export function translationLinkPath(key: string): string {
  return `translations[_key=="${key}"]`;
}

function describeWrites(plan: LanguageRemovalPlan): Set<string> {
  return new Set([
    ...[...plan.deleteIds, ...plan.metadataDeletes].map((id) => `delete ${id}`),
    ...plan.metadataPatches.flatMap(({ id, unsetKeys }) => unsetKeys.map((key) => `unset ${id} ${translationLinkPath(key)}`)),
    ...plan.fieldCleanups.flatMap(({ id, arms }) => arms.map((arm) => `unset ${id} ${armPath(arm)}`)),
    ...plan.assetCleanups.flatMap(({ id, set, unset, arms }) => [
      ...Object.keys(set).map((field) => `flatten ${id} ${field}`),
      ...[...unset, ...arms.map(armPath)].map((path) => `unset ${id} ${path}`),
    ]),
  ]);
}

/** Writes a plan re-made from fresh reads would add to the confirmed one. Any at all: abort, nobody saw them. */
export function planGrowth(confirmed: LanguageRemovalPlan, fresh: LanguageRemovalPlan): string[] {
  const seen = describeWrites(confirmed);

  return [...describeWrites(fresh)].filter((write) => !seen.has(write));
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
}

/** Discard `versionIds` first (nothing references a version), commit `transaction` whole, then rerunnable `patches`. */
export function languageRemovalMutations(plan: LanguageRemovalPlan, batchSize = 100): LanguageRemovalMutations {
  const deletes = unique([...plan.deleteIds, ...plan.metadataDeletes]);
  const transaction: Mutation[] = [
    ...plan.metadataPatches.map(({ id, unsetKeys }) => ({ patch: { id, unset: unsetKeys.map(translationLinkPath) } })),
    ...deletes.filter((id) => releaseOf(id) === undefined).map((id) => ({ delete: { id } })),
  ];
  const cleanups: Mutation[] = [
    ...plan.fieldCleanups.map(({ id, arms }) => ({ patch: { id, unset: arms.map(armPath) } })),
    ...plan.assetCleanups.map(({ id, set, unset, arms }) => {
      const unsets = [...unset, ...arms.map(armPath)];

      return { patch: { id, ...(Object.keys(set).length > 0 ? { set } : {}), ...(unsets.length > 0 ? { unset: unsets } : {}) } };
    }),
  ];

  const versionIds = deletes.filter((id) => releaseOf(id) !== undefined);
  const discards = versionIds.map(
    (versionId): VersionDiscard => ({ actionType: "sanity.action.document.version.discard", versionId })
  );

  return { versionIds, discards: chunk(discards, batchSize), transaction, patches: chunk(cleanups, batchSize) };
}

function dropArms(document: RawDocument, arms: readonly Arm[]): void {
  for (const { field, key } of arms) {
    const value = valueAt(document, field);

    if (isPlainObject(value)) {
      delete value[key];
    }
  }
}

/** The plan applied in memory: what the dataset holds once every write has landed. */
export function applyLanguageRemoval(
  documents: readonly RawDocument[],
  assets: readonly RawDocument[],
  plan: LanguageRemovalPlan
): { documents: RawDocument[]; assets: RawDocument[] } {
  const deleted = new Set([...plan.deleteIds, ...plan.metadataDeletes]);
  const links = new Map(plan.metadataPatches.map(({ id, unsetKeys }) => [id, new Set(unsetKeys)]));
  const arms = new Map(plan.fieldCleanups.map((cleanup) => [cleanup.id, cleanup.arms]));
  const assetCleanups = new Map(plan.assetCleanups.map((cleanup) => [cleanup.id, cleanup]));

  const nextDocuments = documents
    .filter((document) => !deleted.has(document._id))
    .map((document) => {
      const keys = links.get(document._id);
      const toDrop = arms.get(document._id);

      if (!keys && !toDrop) {
        return document;
      }

      const copy = structuredClone(document);

      if (keys && Array.isArray(copy.translations)) {
        copy.translations = copy.translations.filter(
          (row) => !(isPlainObject(row) && typeof row._key === "string" && keys.has(row._key))
        );
      }

      dropArms(copy, toDrop ?? []);

      return copy;
    });

  const nextAssets = assets.map((asset) => {
    const cleanup = assetCleanups.get(asset._id);

    if (!cleanup) {
      return asset;
    }

    const copy: RawDocument = { ...structuredClone(asset), ...cleanup.set };

    for (const field of cleanup.unset) {
      delete copy[field];
    }

    dropArms(copy, cleanup.arms);

    return copy;
  });

  return { documents: nextDocuments, assets: nextAssets };
}

function emptyCount(language: string, config: LocaleConfig): LanguageCount {
  return {
    language,
    configured: config.keep.includes(language),
    blocker: removalBlocker(language, config),
    documents: { published: 0, drafts: 0, versions: 0 },
    translationLinks: 0,
    sharedFields: 0,
    assets: 0,
  };
}

/** Counts per language across documents, links, localized fields and asset text, including what outlives the documents. */
export function languageCensus(
  input: { documents: readonly RawDocument[]; assets?: readonly RawDocument[] },
  config: LocaleConfig
): LanguageCensus {
  assertLocaleConfig(config);

  const documents = byId(input.documents);
  const counts = new Map<string, LanguageCount>();
  const seen = new Set<string>();
  const entry = (language: string): LanguageCount => {
    const count = counts.get(language) ?? emptyCount(language, config);

    counts.set(language, count);

    return count;
  };
  const firstTime = (...parts: unknown[]): boolean => {
    const key = JSON.stringify(parts);

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);

    return true;
  };

  for (const group of groupTranslated(documents.values(), config).values()) {
    for (const copy of group.copies) {
      entry(copy.language ?? group.language ?? config.defaultLocale).documents[bucketOf(copy.id)] += 1;
    }
  }

  for (const document of documents.values()) {
    const publishedId = publishedIdOf(document._id);

    for (const row of document._type === TRANSLATION_METADATA ? metadataRows(document) : []) {
      if (row.language !== undefined && firstTime("link", publishedId, row.language, row.ref ?? row.key)) {
        entry(row.language).translationLinks += 1;
      }
    }

    for (const field of localizedFieldsOf(config, document._type)) {
      const value = valueAt(document, field);

      for (const key of isPlainObject(value) ? Object.keys(value) : []) {
        if (!key.startsWith("_") && KEY.test(key) && firstTime("field", publishedId, field, key)) {
          entry(key).sharedFields += 1;
        }
      }
    }
  }

  let assetsToFlatten = 0;

  for (const asset of input.assets ?? []) {
    const objects = LOCALIZED_ASSET_FIELDS.map((field) => asset[field]).filter(isPlainObject);

    for (const key of unique(objects.flatMap((value) => Object.keys(value)))) {
      if (!key.startsWith("_") && KEY.test(key)) {
        entry(key).assets += 1;
      }
    }

    if (config.keep.length === 1 && objects.length > 0) {
      assetsToFlatten += 1;
    }
  }

  const rank = (language: string) => {
    const index = config.keep.indexOf(language);

    return index === -1 ? config.keep.length : index;
  };

  const languages = [...counts.values()].sort(
    (a, b) => rank(a.language) - rank(b.language) || a.language.localeCompare(b.language)
  );

  return { languages, assetsToFlatten };
}

function storedTotal({ documents, translationLinks, sharedFields, assets }: LanguageCount): number {
  return documents.published + documents.drafts + documents.versions + translationLinks + sharedFields + assets;
}

/** Unconfigured languages a removal can take out that still leave anything: documents, links, arms or asset text. */
export function strandedLanguages(census: LanguageCensus): LanguageCount[] {
  return census.languages.filter((entry) => !entry.configured && entry.blocker === undefined && storedTotal(entry) > 0);
}

/** Whether a purge has work, a cleanup-only one included: arms and asset text outlive their documents. */
export function hasLanguageLeftovers(census: LanguageCensus): boolean {
  const strayText = census.languages.some((entry) => !entry.configured && entry.sharedFields + entry.assets > 0);

  return strayText || census.assetsToFlatten > 0 || strandedLanguages(census).length > 0;
}

/** `it 9 documents (+2 drafts, 1 in a release), 9 translation links, 2 shared fields, 3 assets`. */
export function describeLanguageCount(entry: LanguageCount): string {
  const { published, drafts, versions } = entry.documents;
  const unpublished = [drafts > 0 ? `+${plural(drafts, "draft")}` : "", versions > 0 ? `${versions} in a release` : ""];
  const extra = unpublished.filter(Boolean).join(", ");
  const parts = [
    `${plural(published, "document")}${extra ? ` (${extra})` : ""}`,
    entry.translationLinks > 0 ? plural(entry.translationLinks, "translation link") : "",
    entry.sharedFields > 0 ? plural(entry.sharedFields, "shared field") : "",
    entry.assets > 0 ? plural(entry.assets, "asset") : "",
  ];

  return `${entry.language || '""'} ${parts.filter(Boolean).join(", ")}`;
}

function listed<T>(items: readonly T[], line: (item: T) => string): string[] {
  const lines = items.slice(0, LISTED).map((item) => `      - ${line(item)}`);

  return items.length > LISTED ? [...lines, `      … and ${items.length - LISTED} more`] : lines;
}

function removedLines(plan: LanguageRemovalPlan, name: (language: string) => string): string[] {
  return plan.removed.flatMap((language) => {
    const groups = plan.groups.filter((group) => group.language === language);
    const copies = groups.reduce((sum, group) => sum + group.ids.length, 0);

    if (groups.length === 0) {
      return [`   ${name(language)}: no documents left; only its links and text are cleaned.`];
    }

    const including =
      copies > groups.length ? ` (${plural(copies, "copy", "copies")}, drafts and release versions included)` : "";

    return [
      `   ${name(language)}: ${plural(groups.length, "document")}${including}, deleted in one transaction.`,
      ...listed(groups, (group) => `${group.type} ${group.uri ?? group.publishedId}`),
    ];
  });
}

function warningLines(plan: LanguageRemovalPlan): string[] {
  const lost = plan.assetCleanups.filter((cleanup) => cleanup.lost.length > 0);
  const reasons = refusalReasons(plan);
  const blocks: [boolean, string, string[]][] = [
    [
      reasons.length > 0,
      "⛔ Sanity would refuse these writes, so nothing is exported or deleted until they are fixed:",
      listed(reasons, (reason) => reason),
    ],
    [
      plan.mixed.length > 0,
      "⚠️  Left alone, their copies disagree on the language. Fix them in the Studio, then run this again:",
      listed(
        plan.mixed,
        ({ type, publishedId, languages }) => `${type} ${publishedId} (${languages.map((code) => code || '""').join(", ")})`
      ),
    ],
    [
      lost.length > 0,
      `⚠️  Text with no ${plan.defaultLocale} version is lost on ${plural(lost.length, "asset")}; the alt text backfill can write it again:`,
      listed(lost, (cleanup) => `${cleanup.id} ${cleanup.lost.join(", ")}`),
    ],
    [
      plan.dangling.length > 0,
      `⚠️  ${plural(plan.dangling.length, "document")} ${plan.dangling.length === 1 ? "holds" : "hold"} a weak reference that will dangle:`,
      listed(plan.dangling, (holder) => `${holder._type} ${holder.uri ?? holder._id}`),
    ],
    [
      plan.skipped.length > 0,
      "⚠️  Left as they are, no write can address them safely:",
      listed(plan.skipped, ({ id, reason }) => `${id}: ${reason}`),
    ],
    [
      plan.redirects.length > 0,
      "Suggested 301s for Settings > Redirects (nothing is written; publish them, then redeploy):",
      listed(plan.redirects, ({ from, to }) => `${from} → ${to}`),
    ],
  ];

  return blocks.flatMap(([shown, heading, items]) => (shown ? [`   ${heading}`, ...items, ""] : []));
}

/** The plan as the trim and the CLI both print it. `titles` names a language: `{ it: "Italian" }`. */
export function formatLanguageRemovalPlan(plan: LanguageRemovalPlan, titles: Readonly<Record<string, string>> = {}): string[] {
  const name = (language: string) => (titles[language] ? `${titles[language]} (${language})` : language);
  const lines = [`🌐 Language removal plan (keeping ${plan.keep.join(", ")})`, ""];

  if (isEmptyPlan(plan) && plan.blocked.length + plan.refusals.length + plan.mixed.length === 0) {
    return [...lines, "   • nothing to change.", ""];
  }

  lines.push(...removedLines(plan, name));

  if (plan.metadataPatches.length + plan.metadataDeletes.length > 0) {
    const deleted = plural(plan.metadataDeletes.length, "group");

    lines.push(`   Translation links: ${deleted} deleted, ${plan.metadataPatches.length} repaired, in the same transaction.`);
  }

  if (plan.fieldCleanups.length > 0) {
    const fields = unique(plan.fieldCleanups.flatMap(({ type, arms }) => arms.map(({ field }) => `${type}.${field}`)));
    const keys = unique(plan.fieldCleanups.flatMap(({ arms }) => arms.map(({ key }) => key)));

    lines.push(
      `   Shared fields: ${keys.join(", ")} text unset on ${plural(plan.fieldCleanups.length, "document")} (${fields.join(", ")}).`
    );
  }

  if (plan.assetCleanups.length > 0) {
    const keys = unique(plan.assetCleanups.flatMap(({ arms }) => arms.map(({ key }) => key)));
    const how = plan.flatten ? `flattened to their ${plan.defaultLocale} text` : `cleared of ${keys.join(", ")} text`;

    lines.push(`   Asset text: ${plural(plan.assetCleanups.length, "asset")} ${how}; the assets stay.`);
  }

  for (const release of plan.releases.filter(({ emptied }) => emptied)) {
    lines.push(`   Release "${release.title ?? release.name}" is left empty.`);
  }

  return [...lines, "", ...warningLines(plan)];
}

function literal(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function literalList(values: readonly string[], pattern: RegExp, what: string): string {
  for (const value of values) {
    if (!pattern.test(value)) {
      throw new Error(`Refusing to build a query for the unexpected ${what} ${JSON.stringify(value)}.`);
    }
  }

  return `[${values.map(literal).join(", ")}]`;
}

/** Every copy of every translated document, projected light: the language scan and the census. */
export function buildTranslatedDocumentsQuery(i18nTypes: readonly string[]): string {
  return `*[_type in ${literalList(i18nTypes, TYPE_NAME, "type name")}]{ _id, _type, language, "uri": uri.current }`;
}

/** Every translation group, whole: a link whose target is already gone is still found by its language. */
export function buildTranslationMetadataQuery(): string {
  return `*[_type == ${literal(TRANSLATION_METADATA)}]{ _id, _type, translations }`;
}

export function buildSharedDocumentsQuery(localizedFields: Readonly<Record<string, readonly string[]>>): string {
  const types = literalList(Object.keys(localizedFields), TYPE_NAME, "type name");
  const paths = unique(Object.values(localizedFields).flat());

  literalList(paths, FIELD_PATH, "field name");

  // A nested path is read with the object holding it, which is what its arms are cleared from.
  const fields = unique(paths.map((path) => path.split(".")[0] as string));

  return `*[_type in ${types}]{ ${["_id", "_type", ...fields].join(", ")} }`;
}

/** Only assets storing text as an object, so the media library is never read whole. */
export function buildLocalizedAssetsQuery(): string {
  const types = literalList(ASSET_TYPES, TYPE_NAME, "type name");
  const objects = LOCALIZED_ASSET_FIELDS.map((field) => `(defined(${field}) && !defined(string(${field})))`).join(" || ");

  return `*[_type in ${types} && (${objects})]{ ${["_id", "_type", ...LOCALIZED_ASSET_FIELDS].join(", ")} }`;
}

/** Whole documents referencing `publishedIds`, every copy and uncapped: a blocker past a cap would fail the commit. */
export function buildReferrersQuery(publishedIds: readonly string[]): string {
  return `*[references(${literalList(publishedIds, DOCUMENT_ID, "document id")}) && _type != ${literal(TRANSLATION_METADATA)}]`;
}

export function buildReleasesQuery(): string {
  return `releases::all()[]{ name, state, "title": metadata.title, "documents": count(*[sanity::partOfRelease(^.name)]) }`;
}

async function readList<T>(read: QueryReader, query: string): Promise<T[] | undefined> {
  const result = await read(query);

  return Array.isArray(result) ? (result as T[]) : undefined;
}

/** The census reads: translated documents, translation groups, shared documents, localized assets and releases. */
export async function readLanguageScan(
  read: QueryReader,
  config: Pick<LocaleConfig, "i18nTypes" | "localizedFields">
): Promise<{ documents: RawDocument[]; assets: RawDocument[]; releases: Release[] } | undefined> {
  const [translated, metadata, shared, assets, releases] = await Promise.all([
    readList<RawDocument>(read, buildTranslatedDocumentsQuery(config.i18nTypes)),
    readList<RawDocument>(read, buildTranslationMetadataQuery()),
    readList<RawDocument>(read, buildSharedDocumentsQuery(config.localizedFields)),
    readList<RawDocument>(read, buildLocalizedAssetsQuery()),
    readList<Release>(read, buildReleasesQuery()),
  ]);

  if (!translated || !metadata || !shared || !assets || !releases) {
    return undefined;
  }

  return { documents: [...translated, ...metadata, ...shared], assets, releases };
}

/** The scan, then whole documents referencing what it dooms. Read it again at write time and compare with `planGrowth`. */
export async function readLanguageRemovalInput(
  read: QueryReader,
  config: LanguageRemovalConfig,
  alsoDeleting: readonly string[] = []
): Promise<LanguageRemovalInput | undefined> {
  const scan = await readLanguageScan(read, config);

  if (!scan) {
    return undefined;
  }

  const targets = unique(planLanguageRemoval({ ...scan, alsoDeleting }, config).deleteIds.map(publishedIdOf));
  const holders = targets.length > 0 ? await readList<RawDocument>(read, buildReferrersQuery(targets)) : [];

  return holders ? { ...scan, holders, alsoDeleting } : undefined;
}

const LLMS_LINK = /\]\(([^)\s]+)/g;

function linksInto(line: string, prefixes: readonly string[]): boolean {
  return [...line.matchAll(LLMS_LINK)].some(([, href = ""]) => {
    let path: string;

    try {
      path = new URL(href, "https://seed.invalid").pathname;
    } catch {
      return false;
    }

    return prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
  });
}

/** Stored llms.txt without the entries of `removed` languages, and without a section they leave empty. */
export function narrowLlmsTxt(content: string, removed: readonly string[]): string {
  const prefixes = removed.map((language) => `/${language}`);
  const sections = content.split(/^(?=## )/m);

  return sections
    .map((section) => section.split("\n").filter((line) => !(/^\s*[-*] /.test(line) && linksInto(line, prefixes))))
    .filter((lines, index) => index === 0 || !/^## /.test(lines[0] ?? "") || lines.some((line) => /^\s*[-*] /.test(line)))
    .map((lines) => lines.join("\n"))
    .join("")
    .replace(/\n{3,}/g, "\n\n");
}

/** The bundled seed filtered to `config.keep` by the same plan; a strong reference into what goes throws. */
export function filterSeedToLocales(documents: readonly RawDocument[], assets: SeedAssets, config: LocaleConfig) {
  const assetList: RawDocument[] = Object.entries(assets).map(([_id, value]) => ({ ...value, _id }));
  const census = languageCensus({ documents, assets: assetList }, config);
  const removed = census.languages
    .filter((entry) => !entry.configured && entry.blocker === undefined)
    .map((entry) => entry.language);
  // A seed keeps nothing it does not configure, text in a language no removal can key on included.
  const plan = planLanguageRemoval({ documents, assets: assetList }, { ...config, removed, strayText: true });

  if (plan.blocked.length > 0) {
    throw new Error(
      `The seed cannot drop ${removed.join(", ")}: ${refusalReasons({ blocked: plan.blocked, refusals: [] }).join(" ")}`
    );
  }

  const applied = applyLanguageRemoval(documents, assetList, plan);
  // The stored llms.txt lists every language's pages, and an import would serve the dropped ones as 404s.
  const filtered = {
    ...applied,
    documents: applied.documents.map((document) => {
      const llms = document.llms as { content?: unknown } | undefined;

      return removed.length > 0 && typeof llms?.content === "string"
        ? { ...document, llms: { ...llms, content: narrowLlmsTxt(llms.content, removed) } }
        : document;
    }),
  };
  const filteredAssets = Object.fromEntries(
    filtered.assets.map(({ _id, ...value }) => {
      const stored = assets[_id];

      return [_id, stored && Object.hasOwn(stored, "_id") ? { ...value, _id: stored._id } : value];
    })
  );

  return { documents: filtered.documents, assets: filteredAssets, plan };
}
