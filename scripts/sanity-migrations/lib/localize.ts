// Planners behind the string-to-object migrations: text written before a field was translated becomes its default arm.

import { ASSET_TYPES, LOCALIZED_ASSET_FIELDS, type RawDocument, valueAt } from "../../trim-features/language-removal";

export type LocalizePatch = { id: string; rev?: string; fields: string[]; set: Record<string, Record<string, unknown>> };

/** A field, or one nested a level down in an object (`seoMetadata.title`). */
const FIELD_PATH = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;

function checkedFields(fields: readonly string[]): string[] {
  for (const field of fields) {
    if (!FIELD_PATH.test(field)) {
      throw new Error(`Refusing to build a query for the unexpected field name ${JSON.stringify(field)}.`);
    }
  }

  return [...new Set(fields)];
}

/** `{ field: { <default>: value } }` for each plain string or portable text array; an empty string too. Objects stay. */
export function localizeStrings(
  document: RawDocument,
  fields: readonly string[],
  defaultLocale: string
): LocalizePatch | undefined {
  const set: Record<string, Record<string, unknown>> = {};
  // A copy of a type that was one document per language holds its own language's text, not the default's.
  const language = typeof document.language === "string" && document.language !== "" ? document.language : defaultLocale;

  for (const field of fields) {
    const value = valueAt(document, field);

    if (typeof value === "string" || Array.isArray(value)) {
      set[field] = { [language]: value };
    }
  }

  const changed = Object.keys(set);
  const rev = typeof document._rev === "string" ? document._rev : undefined;

  return changed.length > 0 ? { id: document._id, rev, fields: changed, set } : undefined;
}

/** `LOCALIZED_FIELDS` written as plain strings, on every copy of the shared types. */
export function planFieldLocalization(
  documents: readonly RawDocument[],
  localizedFields: Readonly<Record<string, readonly string[]>>,
  defaultLocale: string
): LocalizePatch[] {
  return documents.flatMap((document) => {
    // Own keys only: a stored `_type` such as `constructor` must not reach the object prototype.
    const fields =
      document._type && Object.hasOwn(localizedFields, document._type) ? (localizedFields[document._type] ?? []) : [];

    return localizeStrings(document, fields, defaultLocale) ?? [];
  });
}

export function planAssetLocalization(assets: readonly RawDocument[], defaultLocale: string): LocalizePatch[] {
  return assets.flatMap((asset) => localizeStrings(asset, LOCALIZED_ASSET_FIELDS, defaultLocale) ?? []);
}

function anyString(fields: readonly string[]): string {
  return fields.map((field) => `defined(string(${field}))`).join(" || ");
}

/** A plain string, or a portable text array (its first block defined), not yet wrapped in arms. */
function anyPlain(fields: readonly string[]): string {
  return fields.map((field) => `defined(string(${field})) || defined(${field}[0])`).join(" || ");
}

/** Shared documents with at least one plain localized field; `$types` is the `LOCALIZED_FIELDS` keys. */
export function buildLocalizableDocumentsQuery(localizedFields: Readonly<Record<string, readonly string[]>>): string {
  const fields = checkedFields(Object.values(localizedFields).flat());

  if (fields.length === 0) {
    return "[]";
  }

  // A nested path is read with the object holding it, and patched at its full path.
  const read = [...new Set(fields.map((field) => field.split(".")[0] as string))];

  return `*[_type in $types && (${anyPlain(fields)})]{ ${["_id", "_rev", "_type", ...read].join(", ")} }`;
}

/** Assets with plain-string text, so the media library is never read whole. */
export function buildLocalizableAssetsQuery(): string {
  const fields = checkedFields(LOCALIZED_ASSET_FIELDS);
  const types = ASSET_TYPES.map((type) => `"${type}"`).join(", ");

  return `*[_type in [${types}] && (${anyString(fields)})]{ ${["_id", "_rev", "_type", ...fields].join(", ")} }`;
}
