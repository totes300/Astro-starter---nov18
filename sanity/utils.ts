import { getPublishedId, type Rule } from "sanity";
import { I18N_DOCUMENT_TYPES, SANITY_SINGLETON_HOMEPAGE_ID, SINGLETON_IDS, TRANSLATION_EXCLUDED_FIELDS } from "./constants";
import { homeUris } from "./i18n";
import { run } from "./lib/run";

type DocumentVariant = { _id?: unknown; uri?: unknown } | null | undefined;

/** By URI as well as id: only the default locale's homepage keeps the fixed id, a translation's is generated. */
export function isHomepageDocument(source: DocumentVariant): boolean {
  const raw = source?._id;

  // Its draft and release versions too, so a release cannot move the homepage either.
  if (typeof raw === "string" && getPublishedId(raw) === SANITY_SINGLETON_HOMEPAGE_ID) {
    return true;
  }

  const uri = (source?.uri as { current?: unknown } | undefined)?.current;

  // Exactly a served language's home: `/en` only redirects there, and with one language it is an ordinary page.
  return typeof uri === "string" && homeUris().includes(uri);
}

const singletonIds: readonly string[] = Object.values(SINGLETON_IDS);

/** The plugin's delete removes the document once no translation references it, so a singleton never gets it. */
export function offersDeleteTranslation(
  schemaType: string,
  documentId: string,
  /** Every variant read so far (version, draft, published): a homepage in any of them is one to keep. */
  variants: readonly DocumentVariant[] = []
): boolean {
  if (!I18N_DOCUMENT_TYPES.includes(schemaType) || singletonIds.includes(schemaType) || singletonIds.includes(documentId)) {
    return false;
  }

  return !variants.some(isHomepageDocument);
}

type FieldDefinitionLike = { name: string; options?: object };

/** Sets the translation plugin's `exclude` flag from `TRANSLATION_EXCLUDED_FIELDS`, the list the migrations read too. */
export function withTranslationExclusions<T>(type: T): T {
  const { name, fields } = type as { name?: unknown; fields?: FieldDefinitionLike[] };

  if (typeof name !== "string" || !Array.isArray(fields) || !I18N_DOCUMENT_TYPES.includes(name)) {
    return type;
  }

  return {
    ...type,
    fields: fields.map((field) => {
      if (!TRANSLATION_EXCLUDED_FIELDS.includes(field.name)) {
        return field;
      }

      return { ...field, options: { ...field.options, documentInternationalization: { exclude: true } } };
    }),
  };
}

/** Filter schema options by name via a caller `whitelist` or `blacklist` (mutually exclusive; throws if both). Unnamed items are always kept. */
export function selectByName<T, N extends string>(
  items: readonly T[],
  getName: (item: T) => N | null | undefined,
  { whitelist, blacklist, label }: { whitelist?: readonly N[]; blacklist?: readonly N[]; label: string }
): T[] {
  if (whitelist?.length && blacklist?.length) {
    throw new Error(`${label}: Cannot provide both whitelist and blacklist parameters.`);
  }

  return items.filter((item) => {
    const name = getName(item);

    if (!name) {
      return true;
    }

    if (whitelist?.length) {
      return whitelist.includes(name);
    }

    if (blacklist?.length) {
      return !blacklist.includes(name);
    }

    return true;
  });
}

// biome-ignore lint/suspicious/noExplicitAny: we don't know what the object is.
function dotPathToObjectValue<O extends Record<string, any>>(obj: O, path: string) {
  if (!path) {
    return obj;
  }

  return path.includes(".") ? path.split(".").reduce((acc, part) => (acc ? acc[part] : undefined), obj) : obj[path];
}

/** Rule that hides a field unless another field equals the given value(s); `false` also matches undefined. */
export const visibleIf = (fieldName: string) => (value?: boolean | string | string[]) => ({
  hidden: ({ parent }: { parent: Record<string, unknown> }) => {
    const resolvedValue = parent ? dotPathToObjectValue(parent, fieldName) : undefined;
    const allowedValues = Array.isArray(value) ? value : [value];
    // When checking for boolean false, treat undefined as matching (falsy)
    const toMatch = allowedValues.length === 1 && allowedValues[0] === false ? [undefined, false] : allowedValues;
    return !toMatch.includes(resolvedValue as boolean | string);
  },
});

/** Rule that requires a field when another field equals the given value(s); `false` also matches undefined. */
export const requiredIf = (fieldName: string) => (value?: boolean | string | string[]) => {
  const allowedValues = Array.isArray(value) ? value : [value];
  const toMatch = allowedValues.length === 1 && allowedValues[0] === false ? [undefined, false] : allowedValues;

  return {
    validation: (R: unknown) => {
      return (R as Rule).custom((currentValue, { parent }) => {
        const resolvedValue = parent ? dotPathToObjectValue(parent, fieldName) : undefined;
        const conditionMatches = toMatch.includes(resolvedValue as boolean | string);
        return conditionMatches && currentValue === undefined ? "Required" : true;
      });
    },
  };
};

type ValidationBuilder<T> = (rule: T) => any;

export function isEmptyObjectValue(value: unknown) {
  return typeof value === "object" && value != null && !Array.isArray(value) && Object.values(value).every((v) => v == null);
}

export type HiddenPredicate = (props: { parent: { [key: string]: unknown } }) => boolean;

/** Mirror the field's own `hidden` rule: nested initial values leave residue that would otherwise block saving. */
export function requireTypeWhenObjectHasValue(message: string, hidden?: HiddenPredicate): ValidationBuilder<unknown> {
  return (R) =>
    (R as Rule).custom((value, context) => {
      if (!value || isEmptyObjectValue(value)) {
        return true;
      }

      if (hidden?.({ parent: (context.parent ?? {}) as { [key: string]: unknown } })) {
        return true;
      }

      return (value as { type?: string }).type ? true : message;
    });
}

export function composeValidation<T>(baseValidation: ValidationBuilder<T>, externalValidation?: ValidationBuilder<T>) {
  return (rule: T) => {
    const baseResult = baseValidation(rule);

    if (!externalValidation) {
      return baseResult;
    }

    const externalResult = externalValidation(rule);
    return Array.isArray(externalResult) ? [...externalResult, baseResult] : [externalResult, baseResult];
  };
}

type RefLike = { _ref?: string };

/** Block duplicate refs in an array-of-references field, in the dropdown (`.filter`) and on save (`.validation`). `arrayKey` names the array when the filter receives the parent object. */
export function uniqueReferenceArray(options?: { arrayKey?: string; message?: string; required?: boolean }) {
  const arrayKey = options?.arrayKey;
  const message = options?.message ?? "Each item can only be added once.";
  const required = options?.required !== false;

  const getRefs = (items: RefLike[] | undefined): string[] =>
    (items ?? []).map((item) => item?._ref).filter((ref): ref is string => Boolean(ref));

  const duplicateCheck = (value: unknown) => {
    const items = Array.isArray(value) ? (value as RefLike[]) : [];

    if (!items.length) {
      return true;
    }

    const refs = getRefs(items);
    const hasDuplicates = refs.some((id, index) => refs.indexOf(id) !== index);
    return hasDuplicates ? message : true;
  };

  return {
    filter: ({ parent }: { parent?: unknown }) => {
      const items = run(() => {
        if (Array.isArray(parent)) {
          return parent as RefLike[];
        }
        if (arrayKey != null) {
          return (parent as Record<string, RefLike[] | undefined>)?.[arrayKey];
        }
        return undefined;
      });

      const selected = getRefs(Array.isArray(items) ? items : undefined);

      if (!selected.length) {
        // Match-all GROQ filter: equivalent to "no filtering", but keeps the
        // return type a valid reference filter (Sanity rejects a boolean here).
        return { filter: "true" };
      }

      return { filter: "!(_id in $selected)", params: { selected } };
    },
    validation: (R: unknown) => {
      const rule = (R as Rule).custom(duplicateCheck);
      return required ? (R as Rule).required().custom(duplicateCheck) : rule;
    },
  };
}

/** Extract a plain-text excerpt (up to `maxLength` chars) from a Portable Text array; empty string when blank. */
// biome-ignore lint/suspicious/noExplicitAny: the portable text block is too generic to type out.
export function createExcerptFromPortableText(value: any[], maxLength = 100) {
  const text = value.map(({ _type, children }) => {
    if (_type !== "block" || !children) {
      return "";
    }

    return children.map(({ text }: { text: string }) => text).join("");
  });

  if (!text?.length) {
    return "";
  }

  const joined = text.join(" ");
  return joined.length <= maxLength ? joined : `${joined.slice(0, maxLength)} …`;
}
