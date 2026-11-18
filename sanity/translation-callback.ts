// The translation plugin's callback: a translation starts as a copy of its source, so this moves it into its language.
// Type-only plugin import: the plugin's runtime loads Studio CSS, which `node --test` cannot import.

import { getPublishedId } from "@sanity/client/csm";
import type { PluginCallbackArgs } from "@sanity/document-internationalization";
import { AI_TRANSLATION_FIELD } from "./constants";
import { withLocalePrefix } from "./i18n";
import { localizeDocumentPath } from "./sections";
import {
  buildReferencePatch,
  collectReferences,
  TRANSLATION_VARIANTS_QUERY,
  type TranslationGroup,
  variantTargets,
} from "./translation-references";

type TranslationCopy = { _id: string; _type: string; [field: string]: unknown };

function pathOf(url: URL): string | undefined {
  try {
    const path = decodeURIComponent(url.pathname);

    return path === "/" ? path : path.replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}

/** A share-image source that named the copied page moves to the translation's page; any other URL is left alone. */
export function localizeSourceUrl(sourceUrl: string, fromPath: string, toPath: string): string | undefined {
  let url: URL;

  try {
    url = new URL(sourceUrl);
  } catch {
    return undefined;
  }

  if (fromPath === toPath || pathOf(url) !== fromPath) {
    return undefined;
  }

  url.pathname = toPath;

  return url.toString();
}

type TranslationPatchOptions = {
  /** The published id of the document the translation was copied from. */
  sourceId: string;
  translation: TranslationCopy;
  sourceLanguage: string;
  language: string;
  /** `TRANSLATION_VARIANTS_QUERY` read for the translation's references, on the published perspective. */
  groups: readonly TranslationGroup[];
};

/** Every `set` a fresh translation needs: its URI, its share-image source and its references, in `language`. */
export function translationPatch({ sourceId, translation, sourceLanguage, language, groups }: TranslationPatchOptions) {
  const patch: Record<string, string> = {};
  const current = (translation.uri as { current?: unknown } | undefined)?.current;
  const copiedUri = typeof current === "string" ? current : undefined;
  const uri = copiedUri === undefined ? undefined : localizeDocumentPath(translation._type, language, copiedUri);

  if (uri !== undefined && uri !== copiedUri) {
    patch["uri.current"] = uri;
  }

  const sourceUrl = (translation.seoMetadata as { sourceUrl?: unknown } | undefined)?.sourceUrl;

  // A document without a page (the Site) moves a source that named its language's homepage.
  if (typeof sourceUrl === "string") {
    const fromPath = copiedUri ?? withLocalePrefix(sourceLanguage, "/");
    const toPath = uri ?? withLocalePrefix(language, "/");
    const localizedSourceUrl = localizeSourceUrl(sourceUrl, fromPath, toPath);

    if (localizedSourceUrl) {
      patch["seoMetadata.sourceUrl"] = localizedSourceUrl;
    }
  }

  const targets = variantTargets(groups, language);
  const translationId = getPublishedId(translation._id);

  // A self-link has no published variant yet: it is this translation. Weak only, as its target is still a draft.
  Object.assign(
    patch,
    buildReferencePatch(collectReferences(translation), ({ ref, weak }) => {
      if (ref === sourceId) {
        if (weak) {
          return translationId;
        }
        return undefined;
      }
      return targets.get(ref);
    })
  );

  return patch;
}

/** The translation already exists when this runs, so a failure is logged rather than thrown into a second error toast. */
export async function localizeTranslation({
  sourceDocument,
  newDocument,
  sourceLanguageId,
  destinationLanguageId,
  client,
}: PluginCallbackArgs): Promise<void> {
  try {
    // On use: the AI plan reads translation-stub, which imports this module.
    const { copyRecord } = await import("./ai-translation/plan");
    const ids = [...new Set(collectReferences(newDocument).map(({ ref }) => ref))];
    const groups = ids.length
      ? await client.fetch<TranslationGroup[]>(TRANSLATION_VARIANTS_QUERY, { ids }, { perspective: "published" })
      : [];
    const sourceId = getPublishedId(sourceDocument._id);
    const patch: Record<string, unknown> = translationPatch({
      sourceId,
      translation: newDocument,
      sourceLanguage: sourceLanguageId,
      language: destinationLanguageId,
      groups,
    });

    // Stamped as made, so Translate with AI tells this untouched copy from a translation written over it, exactly.
    if (destinationLanguageId !== sourceLanguageId) {
      patch[AI_TRANSLATION_FIELD] = copyRecord(newDocument, { sourceId, sourceLanguage: sourceLanguageId });
    }

    if (Object.keys(patch).length) {
      await client.patch(newDocument._id).set(patch).commit();
    }
  } catch (error) {
    console.error(`Could not move the ${destinationLanguageId} translation ${newDocument._id} to its language:`, error);
  }
}
