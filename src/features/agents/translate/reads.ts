import type { SanityClient } from "@sanity/client";
import { getPublishedId } from "@sanity/client/csm";
import {
  AiTranslationDocumentsQuery,
  AiTranslationGroupQuery,
  AiTranslationGroupsPageQuery,
  AiTranslationHoldersQuery,
  AiTranslationPlanPageQuery,
  AiTranslationSettingsQuery,
  AiTranslationTimeoutsQuery,
  AiTranslationVariantsQuery,
  AiTranslationVersionsQuery,
} from "~/features/agents/query";
import { isPlainObject } from "~/sanity/ai-translation/fields";
import {
  type PlanDocument,
  type PlanGroup,
  pairKey,
  sameDocumentIn,
  type TranslationStatus,
  translationStatus,
} from "~/sanity/ai-translation/plan";
import { readTranslationSettings, type TranslationSettings } from "~/sanity/ai-translation/style-guide";
import { I18N_DOCUMENT_TYPES } from "~/sanity/constants";
import { collectReferences, type TranslationGroup } from "~/sanity/translation-references";
import { fixedPlace, type TranslationDocument } from "~/sanity/translation-stub";
import { fetchSanity } from "../../../sanity/lib/fetch";
import { type Copies, isString, RAW } from "./shared";

/** The `[0...200]` slice both page queries end in. */
export const PLAN_PAGE_SIZE = 200;

const ID_CHUNK = 100;

type Row = { key?: string; language?: string; ref?: string };

type SettingsRead = {
  translations?: unknown;
  siteName?: string | null;
  personNames?: (string | null)[] | null;
} | null;

type ReadSettings = { settings: TranslationSettings; siteName?: string; personNames: string[] };

function chunks<T>(items: readonly T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));
}

export function rowsOf(group: PlanGroup | null | undefined): Row[] {
  return (Array.isArray(group?.translations) ? group.translations : []).filter(isPlainObject).map((row) => ({
    key: typeof row._key === "string" ? row._key : undefined,
    language: typeof row.language === "string" ? row.language : undefined,
    ref: isPlainObject(row.value) && typeof row.value._ref === "string" ? getPublishedId(row.value._ref) : undefined,
  }));
}

export async function readSettings(client: SanityClient): Promise<ReadSettings> {
  const read = await fetchSanity<SettingsRead>(client, AiTranslationSettingsQuery);

  return {
    settings: readTranslationSettings(read?.translations),
    siteName: isString(read?.siteName) ? read.siteName : undefined,
    personNames: (read?.personNames ?? []).filter(isString),
  };
}

/** Each id's published and draft copy, whole, under `raw`. */
export async function readDocuments(client: SanityClient, ids: readonly string[]): Promise<TranslationDocument[]> {
  const wanted = [...new Set(ids)].flatMap((id) => [id, `drafts.${id}`]);
  const pages = await Promise.all(
    chunks(wanted, ID_CHUNK).map((page) =>
      fetchSanity<TranslationDocument[] | null>(client, AiTranslationDocumentsQuery, { ids: page }, RAW)
    )
  );

  return pages.flatMap((page) => page ?? []);
}

export function byPublishedId(documents: readonly TranslationDocument[]): Map<string, Copies> {
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

/** Every page of a `_id > $after` read, `PLAN_PAGE_SIZE` at a time. */
async function readAllPages<T extends { _id: string }>(read: (after: string) => Promise<T[] | null>): Promise<T[]> {
  const all: T[] = [];
  let after = "";

  for (;;) {
    const page = (await read(after)) ?? [];

    all.push(...page);

    if (page.length < PLAN_PAGE_SIZE) {
      return all;
    }

    after = page[page.length - 1]?._id ?? after;
  }
}

/** Whole documents of `types`, every published and draft copy. */
export function readDocumentsOfTypes(client: SanityClient, types: readonly string[]): Promise<TranslationDocument[]> {
  return readAllPages((after) =>
    fetchSanity<TranslationDocument[] | null>(client, AiTranslationPlanPageQuery, { types: [...types], after }, RAW)
  );
}

export function readAllGroups(client: SanityClient): Promise<PlanGroup[]> {
  return readAllPages((after) => fetchSanity<PlanGroup[] | null>(client, AiTranslationGroupsPageQuery, { after }, RAW));
}

/** Read published, as the translation callback does: only a published variant is a reference's new target. */
export async function readVariantGroups(client: SanityClient, refs: readonly string[]): Promise<TranslationGroup[]> {
  const ids = [...new Set(refs.map((ref) => getPublishedId(ref)))];
  const pages = await Promise.all(
    chunks(ids, ID_CHUNK).map((page) => fetchSanity<TranslationGroup[] | null>(client, AiTranslationVariantsQuery, { ids: page }))
  );

  return pages.flatMap((page) => page ?? []);
}

export type Holder = PlanDocument & { language?: string };

/** Documents a new translation of `source` into `language` would duplicate: its fixed URI's, or the singleton's copy. */
export async function readHoldersOf(client: SanityClient, source: TranslationDocument, language: string): Promise<Holder[]> {
  const place = fixedPlace(source, language);

  if (!place) {
    return [];
  }

  const sourceId = getPublishedId(source._id);
  const found = await fetchSanity<Holder[] | null>(
    client,
    AiTranslationHoldersQuery,
    {
      uri: "uri" in place ? place.uri : null,
      type: "singleton" in place ? place.singleton : null,
      language,
      exclude: [sourceId, `drafts.${sourceId}`],
    },
    RAW
  );

  return found ?? [];
}

export async function findHolder(
  client: SanityClient,
  source: TranslationDocument,
  language: string
): Promise<string | undefined> {
  const [holder] = await readHoldersOf(client, source, language);

  return holder ? getPublishedId(holder._id) : undefined;
}

/** Release versions of every translated type: a linked translation may exist only inside one. */
export async function readVersions(client: SanityClient): Promise<PlanDocument[]> {
  return (
    (await fetchSanity<PlanDocument[] | null>(client, AiTranslationVersionsQuery, { types: [...I18N_DOCUMENT_TYPES] }, RAW)) ?? []
  );
}

type TimeoutRead = { sourceId?: unknown; language?: unknown; sourceTextHash?: unknown };

/** The source text each pair's last call timed out on, by `pairKey`. */
export async function readTimeouts(client: SanityClient): Promise<Record<string, string>> {
  const markers = (await fetchSanity<TimeoutRead[] | null>(client, AiTranslationTimeoutsQuery)) ?? [];

  return Object.fromEntries(
    markers.flatMap(({ sourceId, language, sourceTextHash }) =>
      isString(sourceId) && isString(language) && isString(sourceTextHash) ? [[pairKey(sourceId, language), sourceTextHash]] : []
    )
  );
}

/** A translation group as published ids, for `sameDocumentIn`. */
function groupIds(group: PlanGroup | TranslationGroup | null | undefined): string[] {
  if (group && "variants" in group) {
    return (group.variants ?? []).flatMap(({ id }) => (id ? [getPublishedId(id)] : []));
  }

  return rowsOf(group as PlanGroup | null | undefined).flatMap(({ ref }) => (ref ? [ref] : []));
}

/** The groups of every document these copies link to, so a link a copy moved to a variant reads as no edit. */
export async function readReferenceGroups(
  client: SanityClient,
  documents: readonly (TranslationDocument | undefined)[]
): Promise<string[][]> {
  const refs = documents.flatMap((document) => (document ? collectReferences(document).map(({ ref }) => ref) : []));

  return refs.length > 0 ? (await readVariantGroups(client, refs)).map(groupIds) : [];
}

export type PairReads = ReadSettings & {
  source: Copies;
  group: PlanGroup | null;
  target?: Copies & { id: string };
  /** Rows for the language whose document is gone, replaced by a new translation's row. */
  staleKeys: string[];
  /** The linked translation exists only inside a release: never written over, and its row never replaced. */
  releaseOnly?: string;
  /** The pair's own group and its references' groups, as published ids. */
  groups: string[][];
};

export async function readPair(client: SanityClient, sourceId: string, language: string): Promise<PairReads> {
  const [settings, sources, group] = await Promise.all([
    readSettings(client),
    readDocuments(client, [sourceId]),
    fetchSanity<PlanGroup | null>(client, AiTranslationGroupQuery, { id: sourceId }, RAW),
  ]);
  const rows = rowsOf(group).filter((row) => row.language === language && row.ref !== sourceId);
  const refs = rows.flatMap(({ ref }) => (ref ? [ref] : []));
  const targets = byPublishedId(refs.length > 0 ? await readDocuments(client, refs) : []);
  const live = refs.find((ref) => targets.has(ref));
  const releases = new Set<string>(
    live || refs.length === 0 ? [] : (await readVersions(client)).map(({ _id }) => getPublishedId(_id))
  );
  const releaseOnly = refs.find((ref) => releases.has(ref));
  const source = byPublishedId(sources).get(sourceId) ?? {};
  const target = live ? { id: live, ...targets.get(live) } : undefined;
  const referenceGroups = await readReferenceGroups(client, [source.published, source.draft, target?.published, target?.draft]);

  return {
    ...settings,
    source,
    group: group ?? null,
    ...(target ? { target } : {}),
    staleKeys: live || releaseOnly ? [] : rows.flatMap(({ key }) => (key ? [key] : [])),
    ...(releaseOnly ? { releaseOnly } : {}),
    groups: [groupIds(group), ...referenceGroups],
  };
}

export function currentTarget(reads: PairReads): TranslationDocument | undefined {
  return reads.target ? (reads.target.draft ?? reads.target.published) : undefined;
}

/** The plan's status for the pair as read now, the server's re-check before it spends or writes. */
export function pairStatus(reads: PairReads, source: TranslationDocument): TranslationStatus {
  return translationStatus({ source, target: currentTarget(reads), sameDocument: sameDocumentIn(reads.groups) });
}
