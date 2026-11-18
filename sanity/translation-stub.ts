// A translation's draft, its refresh and its link, planned without a dataset: the language CLIs and the AI route share it.
// Shapes match the translation plugin's own "create translation"; Web Crypto only, so a server function loads it as is.

import type { Mutation } from "@sanity/client";
import { getPublishedId } from "@sanity/client/csm";
import { AI_TRANSLATION_FIELD, SINGLETON_IDS } from "./constants";
import { isHomeUri, splitLocalePrefix, withLocalePrefix } from "./i18n";
import { toPatchPath } from "./lib/patch-path";
import { reservedPathProblem, uriGateProblem } from "./schemas/fields/uri-gate";
import { localizeDocumentPath, SECTION_TYPES, type SectionTypes, sectionOfType, sectionPathIssue } from "./sections";
import { slugifyText, uriFormatIssue } from "./slug";
import { translationPatch } from "./translation-callback";
import { collectReferences, type PathSegment, type TranslationGroup } from "./translation-references";

export const TRANSLATION_METADATA = "translation.metadata";

/** Written by the Content Lake for one document; `_system` (a version's base, an unpublish mark) never carries over. */
export const SYSTEM_FIELDS: readonly string[] = ["_rev", "_createdAt", "_updatedAt", "_originalId", "_system"];

/** Widened, so this still typechecks once a trim leaves no section and `Section` is `never`. */
const typesOf = (section: string) => (SECTION_TYPES as Record<string, SectionTypes>)[section] as SectionTypes;

export type TranslationDocument = { _id: string; _type: string; [field: string]: unknown };

export type MetadataRow = {
  _key: string;
  _type: "internationalizedArrayReferenceValue";
  language: string;
  value: { _type: "reference"; _ref: string; _weak: true; _strengthenOnPublish: { type: string } };
};

export type TranslationMetadata = {
  _id: string;
  _type: typeof TRANSLATION_METADATA;
  schemaTypes: string[];
  translations: MetadataRow[];
};

export type TranslationStub = {
  sourceId: string;
  /** A draft copy of the source in the new language, without system or excluded fields. */
  document: TranslationDocument;
  /** `translationPatch`: the URI, share-image source and references moved into the language. */
  patch: Record<string, string>;
  uri?: string;
  metadataId: string;
  /** Set when the source had no translation group yet. */
  metadata?: TranslationMetadata;
  row: MetadataRow;
};

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function metadataRow(language: string, ref: string, type: string): MetadataRow {
  return {
    _key: randomHex(16),
    _type: "internationalizedArrayReferenceValue",
    language,
    value: { _type: "reference", _ref: ref, _weak: true, _strengthenOnPublish: { type } },
  };
}

/** One group id per source, so two first translations racing each other collide on `create` instead of making two groups. */
export async function translationGroupId(sourceId: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(getPublishedId(sourceId))));
  const bytes = digest.slice(0, 16);

  // RFC 9562 version 8 (custom) and variant bits, so the id still reads as a UUID everywhere one is expected.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function uriOf(document: Record<string, unknown>): string | undefined {
  const current = (document.uri as { current?: unknown } | undefined)?.current;

  return typeof current === "string" ? current : undefined;
}

/** A draft copy of `source` in `locale`: `row` joins `metadataId`, or a new group is created when the source has none. */
export function planTranslationStub(options: {
  source: TranslationDocument;
  locale: string;
  sourceLocale: string;
  /** The source's existing group, joined with an insert. */
  metadataId?: string;
  /** The id of the group to create when there is none: `translationGroupId`, or a random one. */
  newMetadataId?: string;
  /** A URI the caller chose (a translated slug), used instead of the localized copy of the source's. */
  uri?: string;
  excludedFields: readonly string[];
  groups: readonly TranslationGroup[];
}): TranslationStub {
  const { source, locale, sourceLocale, metadataId, newMetadataId, excludedFields, groups } = options;
  const sourceId = getPublishedId(source._id);
  const id = crypto.randomUUID();
  const document: TranslationDocument = { ...structuredClone(source), _id: `drafts.${id}`, language: locale };

  for (const field of [...SYSTEM_FIELDS, ...excludedFields, AI_TRANSLATION_FIELD]) {
    delete document[field];
  }

  const patch = translationPatch({ sourceId, translation: document, sourceLanguage: sourceLocale, language: locale, groups });

  if (options.uri !== undefined) {
    patch["uri.current"] = options.uri;
  }

  const uri = patch["uri.current"] ?? uriOf(document);
  const row = metadataRow(locale, id, source._type);

  if (metadataId) {
    return { sourceId, document, patch, uri, metadataId, row };
  }

  const groupId = newMetadataId ?? crypto.randomUUID();
  const metadata: TranslationMetadata = {
    _id: groupId,
    _type: TRANSLATION_METADATA,
    schemaTypes: [source._type],
    translations: [metadataRow(sourceLocale, sourceId, source._type), row],
  };

  return { sourceId, document, patch, uri, metadataId: groupId, metadata, row };
}

/** The stub, its move into the language and its link, in one transaction; `create` so a raced group id conflicts. */
export function stubMutations(
  { document, patch, metadata, metadataId, row }: TranslationStub,
  options: { metadataRev?: string } = {}
): Mutation[] {
  const mutations: Mutation[] = [{ create: document }];

  if (Object.keys(patch).length > 0) {
    mutations.push({ patch: { id: document._id, set: patch } });
  }

  if (metadata) {
    mutations.push({ create: metadata });
  } else {
    mutations.push({
      patch: {
        id: metadataId,
        ...(options.metadataRev ? { ifRevisionID: options.metadataRev } : {}),
        setIfMissing: { translations: [] },
        insert: { after: "translations[-1]", items: [row] },
      },
    });
  }

  return mutations;
}

/** A home or a section index: the path every language keeps, never slugged or suffixed. */
export function isFixedUri(type: string, uri: string): boolean {
  const section = sectionOfType(type);

  return isHomeUri(uri) || Boolean(section && typesOf(section).index === type);
}

/** Where a new translation must go, no suffix allowed: a fixed URI, or a URI-less singleton's one copy. */
export function fixedPlace(source: TranslationDocument, locale: string): { uri: string } | { singleton: string } | undefined {
  const uri = uriOf(source);

  if (uri === undefined) {
    return (Object.values(SINGLETON_IDS) as string[]).includes(getPublishedId(source._id))
      ? { singleton: source._type }
      : undefined;
  }

  const localized = localizeDocumentPath(source._type, locale, uri);

  return isFixedUri(source._type, localized) ? { uri: localized } : undefined;
}

/** Why a new translation may not take `uri`, by the Studio URI field's rules a translated slug can break. */
export function newTranslationUriProblem(options: {
  uri: string;
  type: string;
  locale: string;
  /** Where the host serves the Studio (`sanityConfig.reservedStudioPaths`). */
  studioPaths: readonly string[];
}): string | null {
  const { uri, type, locale, studioPaths } = options;

  return (
    uriFormatIssue(uri) ??
    uriGateProblem(uri) ??
    uriGateProblem(splitLocalePrefix(uri).pathname) ??
    reservedPathProblem(uri, studioPaths) ??
    sectionPathIssue(type, locale, uri) ??
    null
  );
}

/** The new URI's last segment from the translated title; fixed paths (a home, a section index) are kept. */
export function translatedSlugUri(options: { type: string; uri: string | undefined; title: unknown }): string | undefined {
  const { type, uri, title } = options;

  if (!uri || typeof title !== "string" || isFixedUri(type, uri)) {
    return uri;
  }

  const slug = slugifyText(title);
  const { locale, localeInPath, pathname } = splitLocalePrefix(uri);
  const segments = pathname.split("/").filter(Boolean);

  if (!slug || segments.length === 0 || !localeInPath) {
    return uri;
  }

  segments[segments.length - 1] = slug;

  return withLocalePrefix(locale, `/${segments.join("/")}`);
}

/** `-2`, `-3`... until the URI is free; `taken` holds every URI other documents already sit at. */
export function uniqueUri(uri: string, taken: ReadonlySet<string>): string {
  if (!taken.has(uri)) {
    return uri;
  }

  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${uri}-${suffix}`;

    if (!taken.has(candidate)) {
      return candidate;
    }
  }
}

export type TranslationRefresh = {
  targetId: string;
  draftId: string;
  /** The draft as it reads once written: hash it for the provenance record. */
  document: TranslationDocument;
  /** Set when the target has no draft: its published copy becomes the draft first. */
  create?: TranslationDocument;
  /** With `create`: the published revision the draft was made from, so publishing it refuses a copy changed since. */
  publishedRev?: string;
  /** The draft's revision when it already exists, so an editor's change since the read conflicts. */
  ifRevisionId?: string;
  set: Record<string, unknown>;
  unset: string[];
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }

  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => isEqual(item, b[index]));
  }

  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a).filter((key) => a[key] !== undefined);

    return (
      keys.length === Object.keys(b).filter((key) => b[key] !== undefined).length && keys.every((key) => isEqual(a[key], b[key]))
    );
  }

  return false;
}

function keysOf(items: readonly unknown[]): string[] | undefined {
  const keys = items.map((item) => (isPlainObject(item) && typeof item._key === "string" ? item._key : undefined));

  return keys.every((key): key is string => key !== undefined) && new Set(keys).size === keys.length ? keys : undefined;
}

/** Leaf-level `set`s and `unset`s from `current` to `next`; an array whose keys moved is set whole. */
function diffInto(current: unknown, next: unknown, path: PathSegment[], out: Pick<TranslationRefresh, "set" | "unset">) {
  if (isEqual(current, next)) {
    return;
  }

  if (isPlainObject(current) && isPlainObject(next) && current._type === next._type) {
    for (const key of new Set([...Object.keys(current), ...Object.keys(next)])) {
      if (next[key] === undefined) {
        if (current[key] !== undefined) {
          out.unset.push(toPatchPath([...path, key]));
        }
      } else if (current[key] === undefined) {
        out.set[toPatchPath([...path, key])] = next[key];
      } else {
        diffInto(current[key], next[key], [...path, key], out);
      }
    }

    return;
  }

  if (Array.isArray(current) && Array.isArray(next)) {
    const currentKeys = keysOf(current);
    const nextKeys = keysOf(next);

    if (currentKeys && nextKeys && currentKeys.join("\u0000") === nextKeys.join("\u0000")) {
      next.forEach((item, index) => {
        diffInto(current[index], item, [...path, { _key: nextKeys[index] as string }], out);
      });

      return;
    }
  }

  out.set[toPatchPath(path)] = next;
}

function childOf(node: unknown, segment: PathSegment): unknown {
  if (Array.isArray(node)) {
    if (typeof segment === "number") {
      return node[segment];
    }

    return typeof segment === "object" ? node.find((item) => isPlainObject(item) && item._key === segment._key) : undefined;
  }

  return isPlainObject(node) && typeof segment === "string" ? node[segment] : undefined;
}

/** Sets one field in place; a path through a missing parent writes nothing. */
export function setAt(document: Record<string, unknown>, path: readonly PathSegment[], value: unknown) {
  const parent = path.slice(0, -1).reduce<unknown>(childOf, document);
  const last = path[path.length - 1];

  if (isPlainObject(parent) && typeof last === "string") {
    parent[last] = value;
  }
}

/** Each language's own, never taken from the source on a refresh: its URI, Password protect and the record. */
const TARGET_OWNED_FIELDS = ["uri", "passwordProtected", AI_TRANSLATION_FIELD];

/** `seoMetadata` keys each language keeps: noIndex, and the share image's source page, which follows the URI. */
const TARGET_OWNED_SEO_FIELDS = ["noIndex", "sourceUrl"];

/** A refresh from the source: the target keeps its id, language, URI and own fields; only changed leaves are written. */
export function planTranslationRefresh(options: {
  /** The guarded translation of the source (`mergeTranslation`), still under the source's id. */
  translated: TranslationDocument;
  target: { draft?: TranslationDocument | null; published?: TranslationDocument | null };
  locale: string;
  sourceLocale: string;
  excludedFields: readonly string[];
  groups: readonly TranslationGroup[];
}): TranslationRefresh {
  const { translated, target, locale, sourceLocale, excludedFields, groups } = options;
  const base = target.draft ?? target.published;

  if (!base) {
    throw new Error("[translation-stub] planTranslationRefresh: the target has neither a draft nor a published copy.");
  }

  const targetId = getPublishedId(base._id);
  const draftId = `drafts.${targetId}`;
  const document: TranslationDocument = { ...structuredClone(translated), _id: draftId, _type: base._type, language: locale };

  for (const field of SYSTEM_FIELDS) {
    delete document[field];
  }

  for (const field of new Set([...TARGET_OWNED_FIELDS, ...excludedFields])) {
    if (base[field] === undefined) {
      delete document[field];
    } else {
      document[field] = structuredClone(base[field]);
    }
  }

  const baseSeo = isPlainObject(base.seoMetadata) ? base.seoMetadata : {};

  for (const key of TARGET_OWNED_SEO_FIELDS) {
    if (isPlainObject(document.seoMetadata)) {
      if (baseSeo[key] === undefined) {
        delete document.seoMetadata[key];
      } else {
        document.seoMetadata[key] = structuredClone(baseSeo[key]);
      }
    } else if (baseSeo[key] !== undefined) {
      document.seoMetadata = { ...(typeof baseSeo._type === "string" ? { _type: baseSeo._type } : {}), [key]: baseSeo[key] };
    }
  }

  // Only the reference part: the URI and the share-image source are the target's own.
  const patch = translationPatch({
    sourceId: getPublishedId(translated._id),
    translation: document,
    sourceLanguage: sourceLocale,
    language: locale,
    groups,
  });

  for (const reference of collectReferences(document)) {
    const path = [...reference.path, "_ref"];
    const repointed = patch[toPatchPath(path)];

    if (repointed !== undefined) {
      setAt(document, path, repointed);
    }
  }

  const changes: Pick<TranslationRefresh, "set" | "unset"> = { set: {}, unset: [] };
  const current = { ...base };

  for (const field of [...SYSTEM_FIELDS, "_id"]) {
    delete current[field];
  }

  diffInto(current, { ...document, _id: undefined }, [], changes);

  if (target.draft) {
    return { targetId, draftId, document, ifRevisionId: stringOrUndefined(target.draft._rev), ...changes };
  }

  const create: TranslationDocument = { ...structuredClone(base), _id: draftId };

  for (const field of SYSTEM_FIELDS) {
    delete create[field];
  }

  const publishedRev = stringOrUndefined(base._rev);

  return { targetId, draftId, document, create, ...(publishedRev ? { publishedRev } : {}), ...changes };
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Nothing when nothing differs; otherwise the draft (created from the published copy if need be) and one guarded patch. */
export function refreshMutations({ draftId, create, ifRevisionId, set, unset }: TranslationRefresh): Mutation[] {
  if (Object.keys(set).length === 0 && unset.length === 0) {
    return [];
  }

  const patch = {
    id: draftId,
    ...(ifRevisionId ? { ifRevisionID: ifRevisionId } : {}),
    ...(Object.keys(set).length > 0 ? { set } : {}),
    ...(unset.length > 0 ? { unset } : {}),
  };

  return create ? [{ create }, { patch }] : [{ patch }];
}

/** The `_ref`s moved from `published` to `draft` when nothing else differs (`ignored` aside); else undefined. */
export function referenceOnlyChanges(
  published: TranslationDocument,
  draft: TranslationDocument,
  ignored: readonly (readonly string[])[] = []
): Record<string, { from: string; to: string }> | undefined {
  const [before, after] = [published, draft].map((document) => {
    const copy: Record<string, unknown> = structuredClone(document);

    for (const field of [...SYSTEM_FIELDS, "_id"]) {
      delete copy[field];
    }

    for (const path of ignored) {
      const parent = path.slice(0, -1).reduce<unknown>((node, key) => (isPlainObject(node) ? node[key] : undefined), copy);

      if (isPlainObject(parent)) {
        delete parent[path[path.length - 1] as string];
      }
    }

    return copy;
  }) as [Record<string, unknown>, Record<string, unknown>];
  const from = new Map(collectReferences(before).map(({ path, ref }) => [toPatchPath([...path, "_ref"]), { path, ref }]));
  const changes: Record<string, { from: string; to: string }> = {};

  for (const { path, ref } of collectReferences(after)) {
    const key = toPatchPath([...path, "_ref"]);
    const was = from.get(key);

    if (!was) {
      return undefined;
    }

    if (was.ref !== ref) {
      changes[key] = { from: was.ref, to: ref };
      setAt(after, [...path, "_ref"], was.ref);
    }
  }

  return isEqual(before, after) ? changes : undefined;
}
