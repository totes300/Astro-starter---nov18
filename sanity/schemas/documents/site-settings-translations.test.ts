import "../test-env";
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { AI_TRANSLATION_DEFAULTS, AI_TRANSLATION_STYLE_GUIDE_LIMIT } from "../../constants";
import { DEFAULT_LOCALE, IS_I18N_ENABLED, LOCALE_IDS } from "../../i18n";

type Field = {
  name: string;
  type: string;
  group?: string;
  fieldset?: string;
  hidden?: unknown;
  initialValue?: unknown;
  options?: { list?: { title: string; value: string }[]; collapsible?: boolean; collapsed?: boolean };
  fieldsets?: { name: string; title: string; options?: { collapsible?: boolean; collapsed?: boolean } }[];
  fields?: Field[];
  of?: Field[];
};

let settings: typeof import("./site-settings");
let translations: Field;

before(async () => {
  settings = await import("./site-settings");

  const fields = settings.siteSettings.fields as unknown as Field[];
  const found = fields.find((field) => field.name === "translations");

  assert.ok(found, "siteSettings has no translations field");
  translations = found;
});

const child = (field: Field | undefined, name: string) => field?.fields?.find((candidate) => candidate.name === name);
const targets = LOCALE_IDS.filter((locale) => locale !== DEFAULT_LOCALE);

describe("Settings > Translations", () => {
  it("is a tab and an object of its own, both hidden without a second language", () => {
    const group = (settings.siteSettings.groups ?? []).find((candidate) => candidate.name === "translations");

    assert.equal(group?.hidden, !IS_I18N_ENABLED);
    assert.equal(translations.group, "translations");
    assert.equal(translations.type, "object");
    assert.equal(translations.hidden, !IS_I18N_ENABLED);
    assert.deepEqual(
      translations.fields?.map(({ name }) => name),
      ["styleGuide", "protectedPhrases", "glossary", "languageNotes", "defaults"]
    );
  });

  it("folds how the AI writes and the defaults, so the panel comes first", () => {
    assert.deepEqual(translations.fieldsets, [
      { name: "writing", title: "How the AI writes", options: { collapsible: true, collapsed: true } },
    ]);
    assert.deepEqual(
      translations.fields?.filter(({ fieldset }) => fieldset === "writing").map(({ name }) => name),
      ["styleGuide", "protectedPhrases", "glossary", "languageNotes"]
    );
    assert.deepEqual(child(translations, "defaults")?.options, { collapsed: true, collapsible: true });
  });

  it("words the options as the dialog and the panel do", () => {
    const defaults = child(translations, "defaults");
    const titles = (name: string) => child(defaults, name)?.options?.list?.map(({ title }) => title);

    assert.deepEqual(titles("policy"), [
      "Only pages not translated yet",
      "Also refresh AI translations whose English was updated",
    ]);
    assert.deepEqual(titles("slugs"), ["Translate the slug", "Keep the English slug"]);
    assert.deepEqual(titles("afterTranslate"), ["Save as draft", "Publish"]);
  });

  it("takes a note and a glossary rendering per language translated into, never an empty object", () => {
    const expected = IS_I18N_ENABLED ? targets : [DEFAULT_LOCALE];
    const renderings = child(translations.fields?.find(({ name }) => name === "glossary")?.of?.[0], "renderings");

    assert.deepEqual(
      child(translations, "languageNotes")?.fields?.map(({ name }) => name),
      expected
    );
    assert.deepEqual(
      renderings?.fields?.map(({ name }) => name),
      expected
    );
  });

  it("starts every default from the shared defaults, and offers only languages translated into", () => {
    const defaults = child(translations, "defaults");

    for (const name of ["policy", "slugs", "afterTranslate", "maxCreditsPerRun", "maxCreditsPerDay"] as const) {
      assert.equal(child(defaults, name)?.initialValue, AI_TRANSLATION_DEFAULTS[name], name);
    }

    assert.deepEqual(
      child(defaults, "policy")?.options?.list?.map(({ value }) => value),
      ["missing", "refresh"]
    );
    assert.deepEqual(
      child(defaults, "slugs")?.options?.list?.map(({ value }) => value),
      ["translate", "keep"]
    );
    assert.deepEqual(
      child(defaults, "afterTranslate")?.options?.list?.map(({ value }) => value),
      ["draft", "publish"]
    );
    assert.deepEqual(
      child(defaults, "languages")?.options?.list?.map(({ value }) => value),
      targets
    );
  });

  it("checks each language's compiled guide, notes and glossary included", { skip: !IS_I18N_ENABLED }, () => {
    const [target = DEFAULT_LOCALE] = targets;
    const half = "x".repeat(AI_TRANSLATION_STYLE_GUIDE_LIMIT / 2);

    assert.equal(settings.compiledStyleGuideIssue({ styleGuide: half, languageNotes: { [target]: "Use tu." } }), true);
    assert.match(
      String(settings.compiledStyleGuideIssue({ styleGuide: half, languageNotes: { [target]: half } })),
      /over Sanity's limit/
    );
    assert.equal(settings.compiledStyleGuideIssue(undefined), true);
  });

  it("counts the style guide against Sanity's cap", () => {
    assert.equal(settings.styleGuideLengthIssue(undefined), true);
    assert.equal(settings.styleGuideLengthIssue("x".repeat(AI_TRANSLATION_STYLE_GUIDE_LIMIT)), true);
    assert.match(String(settings.styleGuideLengthIssue("x".repeat(AI_TRANSLATION_STYLE_GUIDE_LIMIT + 1))), /2,001 characters/);
  });
});
