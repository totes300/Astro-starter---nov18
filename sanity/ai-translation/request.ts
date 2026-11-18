// The one billed call per pair: Translate in noWrite mode, reading exactly the version given, opened only where copy hides.

import type { TranslateDocument } from "@sanity/client";
import { AI_TRANSLATION_STYLE_GUIDE_LIMIT } from "../constants";
import { CONDITIONAL_PATHS, isPlainObject, translationExcludes } from "./fields";
import type { TranslationLanguage } from "./style-guide";

/** Page builder copy sits down to depth 9 or 10 in the seed; Translate's default of 4 would skip nearly all of it. */
export const AI_TRANSLATE_MAX_PATH_DEPTH = 12;

export type TranslateRequest = TranslateDocument & { noWrite: true; async?: false };

export type ConditionalPath = (string | { _key: string })[];

/** Each rule as the paths `document` holds: `[]` becomes every keyed item, and a value it lacks opens nothing. */
export function conditionalPaths(document: Record<string, unknown>, rules: readonly (readonly string[])[]): ConditionalPath[] {
  const found = new Map<string, ConditionalPath>();

  function follow(node: unknown, rule: readonly string[], path: ConditionalPath) {
    if (node === undefined || node === null || path.length > AI_TRANSLATE_MAX_PATH_DEPTH) {
      return;
    }

    const [segment, ...rest] = rule;

    if (segment === undefined) {
      found.set(JSON.stringify(path), path);

      return;
    }

    if (segment !== "[]") {
      follow(isPlainObject(node) ? node[segment] : undefined, rest, [...path, segment]);

      return;
    }

    // Agent Actions address an array item by its key alone.
    for (const item of Array.isArray(node) ? node : []) {
      if (isPlainObject(item) && typeof item._key === "string") {
        follow(item, rest, [...path, { _key: item._key }]);
      }
    }
  }

  for (const rule of rules) {
    follow(document, rule, []);
  }

  return [...found.values()];
}

export type TranslateRequestOptions = {
  schemaId: string;
  /** The exact source version: a published id, or `drafts.<id>` for its unpublished changes. */
  documentId: string;
  type: string;
  /** That version's values: the conditional paths opened are the ones it holds. */
  document: Record<string, unknown>;
  from: TranslationLanguage;
  to: TranslationLanguage;
  /** Compiled by `buildStyleGuide`. */
  styleGuide?: string;
  /** Merged by `mergeProtectedPhrases`. */
  protectedPhrases?: readonly string[];
};

export function buildTranslateRequest(options: TranslateRequestOptions): TranslateRequest {
  const { schemaId, documentId, type, document, from, to, styleGuide = "", protectedPhrases = [] } = options;

  if (documentId.startsWith("versions.")) {
    throw new Error("[ai-translation] buildTranslateRequest: a release version cannot be translated yet.");
  }

  if (from.id === to.id) {
    throw new Error("[ai-translation] buildTranslateRequest: the source and target languages are the same.");
  }

  if (styleGuide.length > AI_TRANSLATION_STYLE_GUIDE_LIMIT) {
    throw new Error(
      "[ai-translation] buildTranslateRequest: the style guide is over Sanity's limit; check buildStyleGuide first."
    );
  }

  const paths = conditionalPaths(document, CONDITIONAL_PATHS[type] ?? []).map((path) => ({
    path,
    hidden: false,
    readOnly: false,
  }));

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
    target: { maxPathDepth: AI_TRANSLATE_MAX_PATH_DEPTH, exclude: translationExcludes(type) },
    ...(paths.length > 0 ? { conditionalPaths: { paths } } : {}),
  };
}
