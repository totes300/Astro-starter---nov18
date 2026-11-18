// The Studio wiring for translated documents, spread by the host's `sanity.config.ts`; inert with one locale.
// Full reference: docs/features/internationalization.md

import { documentInternationalization, type PluginConfig } from "@sanity/document-internationalization";
import type { MediaToolOptions } from "sanity-plugin-media";
import { sanityConfig } from "./config";
import { I18N_DOCUMENT_TYPES } from "./constants";
import { getStudioLocaleTitle, IS_I18N_ENABLED, LOCALES } from "./i18n";
import { localizeTranslation } from "./translation-callback";

export { withAiTranslationRecord } from "./schemas/fields/create-ai-translation-field";
export { withTranslationExclusions } from "./utils";

const languages = LOCALES.map(({ id }) => ({ id, title: getStudioLocaleTitle(id) }));

/** The translation plugin's options, its metadata kept out of search; registered only with a second language. */
export const TRANSLATION_PLUGIN_CONFIG: PluginConfig = {
  supportedLanguages: languages,
  schemaTypes: [...I18N_DOCUMENT_TYPES],
  apiVersion: sanityConfig.apiVersion,
  metadataOmnisearchVisibility: false,
  callback: localizeTranslation,
};

/** Spread into `plugins`: writes `language`, links translations through `translation.metadata`, adds the language menu. */
export const translationPlugins = IS_I18N_ENABLED ? [documentInternationalization(TRANSLATION_PLUGIN_CONFIG)] : [];

/** Spread into `media({ ... })`: alt text is read out wherever the image appears, so it follows the page's language. */
export const mediaLocaleOptions: Pick<MediaToolOptions, "locales"> = IS_I18N_ENABLED ? { locales: languages } : {};
