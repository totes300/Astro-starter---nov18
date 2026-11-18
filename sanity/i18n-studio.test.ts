import "./schemas/test-env";
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { I18N_DOCUMENT_TYPES, TRANSLATION_EXCLUDED_FIELDS } from "./constants";
import { getStudioLocaleTitle, IS_I18N_ENABLED, LOCALES } from "./i18n";

let studio: typeof import("./i18n-studio");
let localizeTranslation: typeof import("./translation-callback").localizeTranslation;

before(async () => {
  studio = await import("./i18n-studio");
  ({ localizeTranslation } = await import("./translation-callback"));
});

const languages = LOCALES.map(({ id }) => ({ id, title: getStudioLocaleTitle(id) }));

describe("the Studio's translation wiring", () => {
  it("registers the translation plugin only with a second language", () => {
    assert.deepEqual(
      studio.translationPlugins.map(({ name }) => name),
      IS_I18N_ENABLED ? ["@sanity/document-internationalization"] : []
    );
  });

  it("configures every translated type and language, the callback, and metadata kept out of search", () => {
    const { supportedLanguages, schemaTypes, metadataOmnisearchVisibility, callback, weakReferences } =
      studio.TRANSLATION_PLUGIN_CONFIG;

    assert.deepEqual(supportedLanguages, languages);
    assert.deepEqual(schemaTypes, [...I18N_DOCUMENT_TYPES]);
    assert.equal(metadataOmnisearchVisibility, false);
    assert.equal(callback, localizeTranslation);
    assert.equal(weakReferences, undefined);
  });

  it("keeps alt text a plain string with one language", () => {
    assert.deepEqual(studio.mediaLocaleOptions, IS_I18N_ENABLED ? { locales: languages } : {});
  });

  it("starts a translation without agent Markdown on every translated type that has it", async () => {
    type Field = { name: string; options?: { documentInternationalization?: { exclude?: boolean } } };
    const { schemaTypes } = (await import("./schemas")) as { schemaTypes: { name: string; fields?: Field[] }[] };
    const excluded = schemaTypes
      .map(studio.withTranslationExclusions)
      .filter(({ name }) => I18N_DOCUMENT_TYPES.includes(name))
      .flatMap(({ name, fields = [] }) =>
        fields.filter((field) => TRANSLATION_EXCLUDED_FIELDS.includes(field.name)).map((field) => ({ name, field }))
      );

    assert.ok(excluded.length > 0, "no translated type carries an excluded field");

    for (const { name, field } of excluded) {
      assert.equal(field.options?.documentInternationalization?.exclude, true, `${name}.${field.name}`);
    }
  });
});
