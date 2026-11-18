// The references a translated document carries, found and re-pointed. Pure: the callback and validation share it.
import { DEFAULT_LOCALE } from "./i18n";
import { toPatchPath } from "./lib/patch-path";

export type PathSegment = string | number | { _key: string };

export type ReferenceAt = { path: PathSegment[]; ref: string; weak: boolean };

/** Every `_ref` in a document, with the path of the reference object that holds it. */
export function collectReferences(value: unknown, path: PathSegment[] = []): ReferenceAt[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => {
      const key = (item as { _key?: unknown } | null)?._key;

      return collectReferences(item, [...path, typeof key === "string" ? { _key: key } : index]);
    });
  }

  if (!value || typeof value !== "object") {
    return [];
  }

  const { _ref, _weak } = value as { _ref?: unknown; _weak?: unknown };

  if (typeof _ref === "string") {
    return [{ path, ref: _ref, weak: _weak === true }];
  }

  return Object.entries(value).flatMap(([key, child]) => collectReferences(child, [...path, key]));
}

/** One `set` for every reference `resolve` re-points, keyed by the patch path of its `_ref`. */
export function buildReferencePatch(
  references: readonly ReferenceAt[],
  resolve: (reference: ReferenceAt) => string | undefined
): Record<string, string> {
  const patch: Record<string, string> = {};

  for (const reference of references) {
    const target = resolve(reference);

    if (target && target !== reference.ref) {
      patch[toPatchPath([...reference.path, "_ref"])] = target;
    }
  }

  return patch;
}

// Read on the published perspective, so a variant counts once published; its language comes off the document.
export const TRANSLATION_VARIANTS_QUERY = `
  *[_type == "translation.metadata" && references($ids)]{
    "variants": translations[]{ "id": value._ref, "language": value->language }
  }
`;

export type TranslationGroup = { variants?: { id?: string | null; language?: string | null }[] | null };

/** Maps every document in a group to the group's variant in `language`, when that variant is published. */
export function variantTargets(groups: readonly TranslationGroup[], language: string): Map<string, string> {
  const targets = new Map<string, string>();

  for (const { variants } of groups) {
    const target = variants?.find((variant) => variant.language === language)?.id;

    if (!target) {
      continue;
    }

    for (const { id } of variants ?? []) {
      if (id && id !== target) {
        targets.set(id, target);
      }
    }
  }

  return targets;
}

// Read on the raw perspective with draft ids too, so a target that exists only as a draft still reports its language.
export const REFERENCED_DOCUMENTS_QUERY = `
  *[_id in $ids && _type in $types]{ _id, language, "label": coalesce(title, name, uri.current, _type), "uri": uri.current }
`;

export type ReferencedDocument = { _id: string; language?: string | null; label?: string | null; uri?: string | null };

/** The ids to ask `REFERENCED_DOCUMENTS_QUERY` for: every target, published and draft. */
export function referencedDocumentIds(references: readonly ReferenceAt[]): string[] {
  const ids = new Set(references.map(({ ref }) => ref.replace(/^drafts\./, "")));

  return [...ids].flatMap((id) => [id, `drafts.${id}`]);
}

/** The referenced documents written in another language, once each, preferring the draft's newer label. */
export function crossLanguageTargets(documents: readonly ReferencedDocument[], language: string): ReferencedDocument[] {
  const byId = new Map<string, ReferencedDocument>();

  for (const document of documents) {
    const id = document._id.replace(/^drafts\./, "");

    if (!byId.has(id) || document._id.startsWith("drafts.")) {
      byId.set(id, document);
    }
  }

  return [...byId.values()].filter((document) => (document.language ?? DEFAULT_LOCALE) !== language);
}
