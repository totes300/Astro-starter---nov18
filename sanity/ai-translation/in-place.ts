// A shared routed document (a person) translated in place: one schema-aware Translate call per document and language,
// aimed at its default-language arms, whose answer is copied into that language's empty arms. See docs/features/ai-translation.md

import { AI_TRANSLATION_STYLE_GUIDE_LIMIT, SHARED_ROUTED_DOCUMENT_TYPES, TRANSLATION_EXCLUDED_FIELDS } from "../constants";
import { isBlock, isPlainObject, isSpan } from "./fields";
import { fnv1a64 } from "./fingerprint";
import { AI_TRANSLATE_MAX_PATH_DEPTH, type TranslateRequest } from "./request";
import type { TranslationLanguage } from "./style-guide";

/** Translated as a whole document in place, not as names: its arms hold rich text, and it has a page of its own. */
export function isInPlaceDocumentType(type: string): boolean {
  return SHARED_ROUTED_DOCUMENT_TYPES.includes(type);
}

/** The value at a registry path (`seoMetadata.title`), through own keys only. */
export function valueAtPath(document: Record<string, unknown> | undefined, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>((value, key) => (isPlainObject(value) && Object.hasOwn(value, key) ? value[key] : undefined), document);
}

/** Text, or a portable text array with a block in it. */
export function isFilledArm(value: unknown): boolean {
  return typeof value === "string" ? value.trim() !== "" : Array.isArray(value) && value.length > 0;
}

/** The fields an AI run translates: agent Markdown is generated from the page in each language, never translated. */
export function translatedInPlaceFields(fields: readonly string[]): string[] {
  return fields.filter((field) => !TRANSLATION_EXCLUDED_FIELDS.includes(field.split(".")[0] as string));
}

function armsAt(document: Record<string, unknown> | undefined, field: string): Record<string, unknown> {
  const value = valueAtPath(document, field);

  return isPlainObject(value) ? value : {};
}

/** The fields whose default arm holds something and whose `language` arm is empty. */
export function missingArms(
  document: Record<string, unknown> | undefined,
  fields: readonly string[],
  language: string,
  defaultLocale: string
): string[] {
  return fields.filter((field) => {
    const arms = armsAt(document, field);

    return isFilledArm(arms[defaultLocale]) && !isFilledArm(arms[language]);
  });
}

/** The fields with something in their default arm: what a call translates from, and what its source key covers. */
export function sourceFields(document: Record<string, unknown> | undefined, fields: readonly string[], defaultLocale: string) {
  return fields.filter((field) => isFilledArm(armsAt(document, field)[defaultLocale]));
}

/** What the answer was made from: changed since, a saved or rejected answer no longer applies. */
export function inPlaceSourceKey(
  document: Record<string, unknown> | undefined,
  fields: readonly string[],
  defaultLocale: string
) {
  return fnv1a64(JSON.stringify(fields.map((field) => [field, armsAt(document, field)[defaultLocale] ?? null])));
}

/** One billed call: Translate in noWrite mode on the document itself, limited to the default arms of `fields`. */
export function buildInPlaceRequest(options: {
  schemaId: string;
  documentId: string;
  fields: readonly string[];
  from: TranslationLanguage;
  to: TranslationLanguage;
  styleGuide?: string;
  protectedPhrases?: readonly string[];
}): TranslateRequest {
  const { schemaId, documentId, fields, from, to, styleGuide = "", protectedPhrases = [] } = options;

  if (fields.length === 0 || from.id === to.id) {
    throw new Error("[ai-translation] buildInPlaceRequest: name at least one field and two different languages.");
  }

  if (styleGuide.length > AI_TRANSLATION_STYLE_GUIDE_LIMIT) {
    throw new Error("[ai-translation] buildInPlaceRequest: the style guide is over Sanity's limit; check buildStyleGuide first.");
  }

  return {
    schemaId,
    documentId,
    forcePublishedWrite: true,
    noWrite: true,
    temperature: 0,
    fromLanguage: { id: from.id, title: from.title },
    toLanguage: { id: to.id, title: to.title },
    ...(styleGuide ? { styleGuide } : {}),
    ...(protectedPhrases.length > 0 ? { protectedPhrases: [...protectedPhrases] } : {}),
    target: fields.map((field) => ({ path: [...field.split("."), from.id], maxPathDepth: AI_TRANSLATE_MAX_PATH_DEPTH })),
  };
}

/** The source blocks with only their span text taken from the answer: keys, marks, links and media stay as written. */
function keepStructure(source: unknown[], answer: unknown): unknown[] | undefined {
  if (!Array.isArray(answer)) {
    return undefined;
  }

  const answered = new Map(answer.filter(isPlainObject).map((item) => [item._key, item]));
  const blocks: unknown[] = [];

  for (const item of source) {
    if (!isBlock(item)) {
      blocks.push(structuredClone(item));
      continue;
    }

    const match = answered.get(item._key);

    if (!isBlock(match)) {
      return undefined;
    }

    const texts = new Map(match.children.filter(isSpan).map((span) => [span._key, span.text]));
    const children = item.children.map((child) => {
      const text = isSpan(child) ? texts.get(child._key) : undefined;

      return isSpan(child) && text !== undefined ? { ...child, text } : child;
    });

    // A span the answer dropped would lose its words: the whole field is refused rather than half translated.
    if (item.children.some((child) => isSpan(child) && child.text.trim() !== "" && !texts.has(child._key))) {
      return undefined;
    }

    blocks.push(structuredClone({ ...item, children }));
  }

  return blocks;
}

export type InPlaceAnswer = { arms: Record<string, unknown>; refused: string[] };

/** Each field's translation from the answer's default arm, checked against the source; a field that fails is refused. */
export function translatedArms(
  answer: unknown,
  source: Record<string, unknown>,
  fields: readonly string[],
  defaultLocale: string
): InPlaceAnswer {
  const result: InPlaceAnswer = { arms: {}, refused: [] };
  const translated = isPlainObject(answer) ? answer : {};

  for (const field of fields) {
    const before = armsAt(source, field)[defaultLocale];
    const after = armsAt(translated, field)[defaultLocale];

    if (typeof before === "string") {
      const text = typeof after === "string" ? after.trim() : "";

      if (text) {
        result.arms[field] = text;
      } else {
        result.refused.push(field);
      }

      continue;
    }

    const blocks = Array.isArray(before) ? keepStructure(before, after) : undefined;

    if (blocks && blocks.length > 0) {
      result.arms[field] = blocks;
    } else {
      result.refused.push(field);
    }
  }

  return result;
}
