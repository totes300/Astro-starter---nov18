// Pure helpers for the desk structure, kept out of `structure.tsx` so they can be tested without a
// StructureBuilder: divider hygiene (`grouped`) and the language filters and groups.

import { getPublishedId } from "sanity";
import { DEFAULT_LOCALE, LOCALE_IDS } from "./i18n";

/** A divider is the one structure item that is a plain object rather than a builder. */
export function isDivider(item: unknown): boolean {
  return typeof item === "object" && item !== null && "type" in item && (item as { type?: unknown }).type === "divider";
}

/**
 * Drops the gaps a removed group leaves: no divider first, last, or twice in a row.
 *
 * A divider only means anything with a group either side of it. Removing a feature takes its items
 * out of the list and would otherwise leave the rule that framed them, reading as an empty section.
 * Applied here because the edit that causes it is usually `npm run trim` rather than a person.
 */
export function grouped<Item>(items: Item[]): Item[] {
  const kept: Item[] = [];

  for (const item of items) {
    const previous = kept.at(-1);

    if (isDivider(item) && (previous === undefined || isDivider(previous))) {
      continue;
    }

    kept.push(item);
  }

  while (kept.length > 0 && isDivider(kept.at(-1))) {
    kept.pop();
  }

  return kept;
}

export type TranslationEntry = { id?: string | null; language?: string | null };

/** Each language's document: the metadata's own, else one found at the language's URI (by its published id). */
export function translationIdsByLanguage(
  entries: readonly TranslationEntry[],
  atUri: readonly TranslationEntry[] = []
): Map<string, string> {
  const ids = new Map<string, string>();

  for (const { id, language } of entries) {
    if (id && language) {
      ids.set(language, id);
    }
  }

  for (const { id, language } of atUri) {
    if (id && language && !ids.has(language)) {
      ids.set(language, getPublishedId(id));
    }
  }

  return ids;
}

/** A literal list, not `$locales`: Presentation's filter params only take strings. A missing language reads as the default. */
export const CONFIGURED_LANGUAGE_FILTER = `coalesce(language, "${DEFAULT_LOCALE}") in ${JSON.stringify(LOCALE_IDS)}`;

/** Translated documents the site serves nowhere, an empty language included. Binds `$types`. */
export const UNSERVED_LANGUAGE_FILTER = `_type in $types && !(${CONFIGURED_LANGUAGE_FILTER})`;

export type UnservedLanguage = {
  /** The stored value; `null` holds every value that is not a string, which a GROQ filter cannot single out. */
  language: string | null;
  label: string;
  /** Documents, each counted once whatever drafts or release versions it has. */
  count: number;
  /** Every id read, drafts and versions included, so the `null` group can list by id. */
  ids: string[];
};

function unservedLanguageLabel(language: string | null, count: number): string {
  if (language === "") {
    return `Missing language, run the backfill (${count})`;
  }

  if (language === null) {
    return `Not a language code (${count})`;
  }

  return `${language} (${count})`;
}

function unservedLanguageRank(language: string | null): number {
  if (language === null) {
    return 2;
  }

  return language === "" ? 1 : 0;
}

/** The list behind one group: by exact language, which tells `""` from a missing field, or by id for what GROQ cannot match. */
export function unservedLanguageList({ language, ids }: UnservedLanguage, types: readonly string[]) {
  if (language === null) {
    return { filter: "_id in $ids", params: { ids } };
  }

  return { filter: "_type in $types && language == $language", params: { types: [...types], language } };
}

/** Groups what `UNSERVED_LANGUAGE_FILTER` matched by its exact stored language: languages first, then the two broken values. */
export function unservedLanguages(documents: readonly { _id: string; language?: unknown }[]): UnservedLanguage[] {
  const groups = new Map<string | null, { ids: string[]; documents: Set<string> }>();

  for (const { _id, language } of documents) {
    const key = typeof language === "string" ? language : null;
    const group = groups.get(key) ?? { ids: [], documents: new Set<string>() };

    group.ids.push(_id);
    group.documents.add(getPublishedId(_id));
    groups.set(key, group);
  }

  return [...groups]
    .map(([language, { ids, documents: ofLanguage }]) => ({
      language,
      label: unservedLanguageLabel(language, ofLanguage.size),
      count: ofLanguage.size,
      ids,
    }))
    .sort(
      (a, b) =>
        unservedLanguageRank(a.language) - unservedLanguageRank(b.language) || (a.language ?? "").localeCompare(b.language ?? "")
    );
}
