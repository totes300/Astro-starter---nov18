// A shared routed document (`SHARED_ROUTED_DOCUMENT_TYPES`): one stored default-language `uri`, served under every
// language's prefix with its fields translated in place. See docs/features/internationalization.md

import { SHARED_ROUTED_DOCUMENT_TYPES } from "~/sanity/constants";
import { DEFAULT_LOCALE, LOCALE_IDS, type Locale } from "~/sanity/i18n";
import { localizeDocumentPath } from "~/sanity/sections";

export function isSharedRoutedType(type: unknown): type is string {
  return typeof type === "string" && SHARED_ROUTED_DOCUMENT_TYPES.includes(type);
}

/** Each configured language's URL of a shared document, from its stored `uri`. */
export function sharedLocalePaths(type: string, storedUri: string): { language: Locale; uri: string }[] {
  return LOCALE_IDS.map((language) => ({ language, uri: localizeDocumentPath(type, language, storedUri) }));
}

/** A string translated in place, read raw: the language's arm, else the default's; a plain string as it is. */
export function localizedValue(value: unknown, language: string): string | undefined {
  if (typeof value === "string") {
    return value;
  }

  if (!value || typeof value !== "object") {
    return undefined;
  }

  const arms = value as Record<string, unknown>;
  const pick = (key: string) => (typeof arms[key] === "string" && arms[key].trim() !== "" ? arms[key] : undefined);

  return pick(language) ?? pick(DEFAULT_LOCALE);
}
