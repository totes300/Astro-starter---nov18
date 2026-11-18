import { defineField, type StringRule, type ValidationContext } from "sanity";
import { sanityConfig } from "../../config";
import { I18N_DOCUMENT_TYPES } from "../../constants";
import { DEFAULT_LOCALE, getLocaleTitle, IS_I18N_ENABLED, isLocale } from "../../i18n";
import {
  collectReferences,
  crossLanguageTargets,
  REFERENCED_DOCUMENTS_QUERY,
  type ReferencedDocument,
  referencedDocumentIds,
} from "../../translation-references";

/** The site serves only `LOCALES`, so a document in any other language (or an empty one) is published nowhere. */
export function unconfiguredLanguageIssue(value: unknown): true | string {
  // A document written before the field existed reads as the default locale.
  if (value === undefined || value === null || isLocale(value)) {
    return true;
  }

  if (value === "") {
    return "This document has no language, so it is not published anywhere. Ask a developer to run npm run sanity:migrate-backfill-language.";
  }

  const language = typeof value === "string" ? value : JSON.stringify(value);

  return `"${language}" is not a language of this site, so this document is not published anywhere. Ask a developer to add it back to LOCALES in sanity/i18n.ts, or to run npm run trim, which deletes it.`;
}

/** Flags what a translation still points at in another language, e.g. a link the translation callback had no variant for. */
export async function crossLanguageReferences(_: unknown, context: ValidationContext): Promise<true | string> {
  const language = typeof context.document?.language === "string" ? context.document.language : DEFAULT_LOCALE;
  const ids = referencedDocumentIds(collectReferences(context.document));

  if (!ids.length) {
    return true;
  }

  let documents: ReferencedDocument[];

  // A validator that throws becomes an error, which would block publishing over an advisory check.
  try {
    documents = await context
      .getClient({ apiVersion: sanityConfig.apiVersion })
      .fetch<ReferencedDocument[]>(REFERENCED_DOCUMENTS_QUERY, { ids, types: I18N_DOCUMENT_TYPES }, { perspective: "raw" });
  } catch (error) {
    console.error("Could not check this document's references for other languages:", error);

    return true;
  }

  const targets = crossLanguageTargets(documents, language);

  if (!targets.length) {
    return true;
  }

  const list = targets
    .map(
      ({ label, uri, language: target }) =>
        `“${label}” (${[uri, getLocaleTitle(target ?? DEFAULT_LOCALE)].filter(Boolean).join(", ")})`
    )
    .join("; ");

  return `This ${getLocaleTitle(language)} document points at another language: ${list}. Pick the ${getLocaleTitle(language)} version, or translate it first. Once that translation is published, Update links in Settings > Translations points this at it.`;
}

/** The document's locale, owned by the translation plugin: read-only and hidden, as a hand edit orphans the translation. */
export function createLanguageField({ group }: { group?: string } = {}) {
  return defineField({
    group,
    name: "language",
    type: "string",
    title: "Language",
    initialValue: DEFAULT_LOCALE,
    readOnly: true,
    hidden: true,
    // Hidden fields still validate, and the document's validation panel lists these under "Language".
    validation: (rule: StringRule) => [
      rule.custom(unconfiguredLanguageIssue).warning(),
      ...(IS_I18N_ENABLED ? [rule.custom(crossLanguageReferences).warning()] : []),
    ],
  });
}
