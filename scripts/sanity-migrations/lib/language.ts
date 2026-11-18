// Pure planners behind the language CLIs, so what they would write is tested without a dataset.
// Stub and translation link shapes are the translation plugin's own "create translation".

import { copyRecord } from "../../../sanity/ai-translation/plan";
import { AI_TRANSLATION_FIELD } from "../../../sanity/constants";
import type { TranslationGroup } from "../../../sanity/translation-references";
import { planTranslationStub, type TranslationStub } from "../../../sanity/translation-stub";
import { publishedIdOf, type RawDocument } from "../../trim-features/language-removal";
import { type Release, releaseLock } from "./releases";

export {
  type MetadataRow,
  metadataRow,
  planTranslationStub,
  stubMutations,
  type TranslationMetadata,
  type TranslationStub,
} from "../../../sanity/translation-stub";

/** Translated documents with no language or `""` (which the ghost guard hides); the plugin translates neither. */
export const MISSING_LANGUAGE_QUERY = `*[_type in $types && (!defined(language) || language == "")]{ _id, _type, _rev, language, "uri": uri.current }`;

export type LanguageCopy = { _id: string; _type: string; _rev?: string; language?: unknown; uri?: string | null };

export type Skipped = { id: string; type: string; reason: string };

export type BackfillPatch = { id: string; type: string; rev?: string; uri?: string; language: string; inherited: boolean };

export type LanguageBackfill = { patches: BackfillPatch[]; skipped: Skipped[] };

export type SingletonTranslations = { stubs: TranslationStub[]; translated: string[]; skipped: Skipped[] };

export function isMissingLanguage(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

/** Every language a document's copies state, under its published id; a non-string is kept so it reads as a disagreement. */
export function statedLanguages(copies: readonly LanguageCopy[]): Map<string, unknown[]> {
  const stated = new Map<string, unknown[]>();

  for (const copy of copies) {
    if (isMissingLanguage(copy.language)) {
      continue;
    }

    const id = publishedIdOf(copy._id);
    const values = stated.get(id) ?? [];

    if (!values.some((value) => JSON.stringify(value) === JSON.stringify(copy.language))) {
      stated.set(id, [...values, copy.language]);
    }
  }

  return stated;
}

/** Its own, else what its other copies agree on (an unpublish version has none), else the default; never a guess. */
export function documentLanguage(
  copy: LanguageCopy,
  stated: ReadonlyMap<string, readonly unknown[]>,
  defaultLocale: string
): string | undefined {
  if (copy.language === "") {
    return "";
  }

  if (!isMissingLanguage(copy.language)) {
    return typeof copy.language === "string" ? copy.language : undefined;
  }

  const languages = stated.get(publishedIdOf(copy._id)) ?? [];

  if (languages.length === 0) {
    return defaultLocale;
  }

  return languages.length === 1 && typeof languages[0] === "string" ? languages[0] : undefined;
}

/** What the backfill sets: the language the document's other copies state, else the default. Never a guess. */
export function planLanguageBackfill(
  missing: readonly LanguageCopy[],
  copies: readonly LanguageCopy[],
  defaultLocale: string,
  releases: readonly Release[] = []
): LanguageBackfill {
  const stated = statedLanguages(copies);
  const backfill: LanguageBackfill = { patches: [], skipped: [] };

  for (const copy of missing) {
    if (!isMissingLanguage(copy.language)) {
      continue;
    }

    const languages = stated.get(publishedIdOf(copy._id)) ?? [];
    const language = documentLanguage({ ...copy, language: undefined }, stated, defaultLocale);
    const lock = releaseLock(copy._id, releases);

    if (language === undefined) {
      const listed = languages.map((value) => JSON.stringify(value)).join(", ");

      backfill.skipped.push({ id: copy._id, type: copy._type, reason: `its other copies disagree (${listed}).` });
    } else if (lock) {
      backfill.skipped.push({ id: copy._id, type: copy._type, reason: lock });
    } else {
      backfill.patches.push({
        id: copy._id,
        type: copy._type,
        rev: copy._rev,
        uri: copy.uri ?? undefined,
        language,
        inherited: languages.length > 0,
      });
    }
  }

  return backfill;
}

/** Documents already under the new language's prefix in another language: once it is configured they would route as it. */
export function findPrefixCollisions(copies: readonly LanguageCopy[], locale: string, defaultLocale: string): LanguageCopy[] {
  if (locale === defaultLocale) {
    return [];
  }

  const prefix = `/${locale}`;
  const stated = statedLanguages(copies);

  return copies.filter((copy) => {
    const underPrefix = copy.uri === prefix || copy.uri?.startsWith(`${prefix}/`) === true;

    return underPrefix && documentLanguage(copy, stated, defaultLocale) !== locale;
  });
}

type Link = { language?: string; ref?: string };

function linksOf(metadata: RawDocument): Link[] {
  const rows = Array.isArray(metadata.translations) ? metadata.translations : [];

  return rows.map((row) => {
    const entry = (row ?? {}) as { language?: unknown; value?: { _ref?: unknown } };

    return {
      language: typeof entry.language === "string" ? entry.language : undefined,
      ref: typeof entry.value?._ref === "string" ? entry.value._ref : undefined,
    };
  });
}

/** A linked draft translation of each per-language singleton, unless it has one or an unlinked document holds its place. */
export function planSingletonTranslations(options: {
  /** Published and draft copies of the singleton ids; the published copy is the source when both exist. */
  singletons: readonly RawDocument[];
  i18nTypes: readonly string[];
  metadata: readonly RawDocument[];
  /** Every copy of the translated types, for the languages links do not state and the places already taken. */
  copies: readonly LanguageCopy[];
  locale: string;
  defaultLocale: string;
  excludedFields: readonly string[];
  groups: readonly TranslationGroup[];
}): SingletonTranslations {
  const { singletons, i18nTypes, metadata, copies, locale, defaultLocale, excludedFields, groups } = options;
  const sources = new Map<string, RawDocument & { _type: string }>();

  for (const singleton of singletons) {
    const id = publishedIdOf(singleton._id);
    const isVersion = singleton._id !== id && !singleton._id.startsWith("drafts.");

    if (!singleton._type || !i18nTypes.includes(singleton._type) || isVersion) {
      continue;
    }

    if (!sources.has(id) || singleton._id === id) {
      sources.set(id, { ...singleton, _type: singleton._type });
    }
  }

  const stated = statedLanguages(copies);
  const translationGroups = metadata
    .filter(({ _id }) => publishedIdOf(_id) === _id)
    .map((document) => ({ id: document._id, links: linksOf(document) }));
  const plan: SingletonTranslations = { stubs: [], translated: [], skipped: [] };

  for (const [id, source] of sources) {
    const group = translationGroups.find(({ links }) => links.some(({ ref }) => ref === id));
    // A link the plugin wrote states its language; an older one is read off the document it points at.
    const linked = (group?.links ?? []).map(
      ({ language, ref }) => language ?? (ref ? documentLanguage({ _id: ref, _type: "" }, stated, defaultLocale) : undefined)
    );

    if (linked.includes(locale)) {
      plan.translated.push(id);
      continue;
    }

    const sourceLocale = typeof source.language === "string" && source.language !== "" ? source.language : defaultLocale;
    const stub = planTranslationStub({ source, locale, sourceLocale, metadataId: group?.id, excludedFields, groups });
    const holder = copies.find((copy) => {
      if (publishedIdOf(copy._id) === id) {
        return false;
      }

      return stub.uri !== undefined
        ? copy.uri === stub.uri
        : copy._type === source._type && documentLanguage(copy, stated, defaultLocale) === locale;
    });

    if (holder) {
      const place = stub.uri ? `already sits at ${stub.uri}` : `is already a ${source._type} in ${locale}`;

      plan.skipped.push({
        id,
        type: source._type,
        reason: `${holder._id} ${place} but is not linked to ${id}: link it as the translation from Translate with AI in the Studio, or delete it and run this again.`,
      });
      continue;
    }

    // Stamped as made, so Translate with AI tells this untouched copy from one an editor translated, exactly.
    stub.document[AI_TRANSLATION_FIELD] = copyRecord(stub.document, { sourceId: id, sourceLanguage: sourceLocale });
    plan.stubs.push(stub);
  }

  return plan;
}
