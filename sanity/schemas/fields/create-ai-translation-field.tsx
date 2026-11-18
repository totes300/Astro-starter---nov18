import { defineField } from "sanity";
import { AI_TRANSLATION_FIELD, I18N_DOCUMENT_TYPES } from "../../constants";

/** What "Translate with AI" translated and wrote, so a later plan can tell a hand edit from a stale source. */
export function createAiTranslationField() {
  return defineField({
    name: AI_TRANSLATION_FIELD,
    type: "object",
    title: "AI translation",
    readOnly: true,
    hidden: true,
    fields: [
      // A plain string, never a reference: the translation callback would re-point a reference to this language.
      defineField({ name: "sourceId", type: "string", title: "Source document" }),
      defineField({ name: "sourceLanguage", type: "string", title: "Source language" }),
      defineField({ name: "sourceRev", type: "string", title: "Source revision" }),
      defineField({ name: "sourceTextHash", type: "string", title: "Source text hash" }),
      defineField({ name: "sourceLayoutHash", type: "string", title: "Source layout hash" }),
      defineField({ name: "textHash", type: "string", title: "Text hash" }),
      defineField({ name: "layoutHash", type: "string", title: "Layout hash" }),
      defineField({ name: "translatedAt", type: "datetime", title: "Translated at" }),
      defineField({ name: "requestedBy", type: "string", title: "Requested by" }),
    ],
  });
}

type DocumentTypeLike = { name?: unknown; type?: unknown; fields?: { name: string }[] };

/** Appends the record to every type in `I18N_DOCUMENT_TYPES`; compose it inside `withTranslationExclusions` so copies drop it. */
export function withAiTranslationRecord<T>(type: T): T {
  const { name, type: kind, fields } = type as DocumentTypeLike;

  if (kind !== "document" || typeof name !== "string" || !Array.isArray(fields) || !I18N_DOCUMENT_TYPES.includes(name)) {
    return type;
  }

  if (fields.some((field) => field.name === AI_TRANSLATION_FIELD)) {
    return type;
  }

  return { ...type, fields: [...fields, createAiTranslationField()] };
}
