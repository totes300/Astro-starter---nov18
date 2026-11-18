import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AI_TRANSLATION_DEFAULTS, AI_TRANSLATION_STYLE_GUIDE_LIMIT } from "../constants";
import { buildStyleGuide, mergeProtectedPhrases, readTranslationSettings, styleGuideIssues } from "./style-guide";
import { TEST_LOCALES } from "./test-fixtures";

const [, italian, german] = TEST_LOCALES as [unknown, { id: string; title: string }, { id: string; title: string }];

const settings = readTranslationSettings({
  styleGuide: "  Friendly and precise.  ",
  protectedPhrases: ["Sanity", " Figma ", "", null, "Sanity"],
  glossary: [
    { _key: "g1", term: "content model", renderings: { it: "modello di contenuto", de: "Inhaltsmodell" } },
    { _key: "g2", term: "draft", renderings: { it: "bozza" } },
    { _key: "g3", term: "  ", renderings: { it: "nulla" } },
  ],
  languageNotes: { it: "Use the informal tu.", de: "" },
});

describe("readTranslationSettings", () => {
  it("trims and drops empty values, and fills every unset default", () => {
    assert.equal(settings.styleGuide, "Friendly and precise.");
    assert.deepEqual(settings.protectedPhrases, ["Sanity", "Figma"]);
    assert.equal(settings.glossary.length, 2);
    assert.deepEqual(settings.languageNotes, { it: "Use the informal tu." });
    assert.deepEqual(settings.defaults, { languages: [], ...AI_TRANSLATION_DEFAULTS });
  });

  it("keeps a valid default and ignores one that is not", () => {
    const read = readTranslationSettings({
      defaults: { languages: ["it", "it"], policy: "refresh", slugs: "sometimes", maxCreditsPerRun: 7, maxCreditsPerDay: -1 },
    });

    assert.deepEqual(read.defaults.languages, ["it"]);
    assert.equal(read.defaults.policy, "refresh");
    assert.equal(read.defaults.slugs, AI_TRANSLATION_DEFAULTS.slugs);
    assert.equal(read.defaults.maxCreditsPerRun, 7);
    assert.equal(read.defaults.maxCreditsPerDay, AI_TRANSLATION_DEFAULTS.maxCreditsPerDay);
  });
});

describe("buildStyleGuide", () => {
  it("joins the global guide, the language's notes and glossary, then the run's instructions, per language", () => {
    const it = buildStyleGuide(settings, italian, "Keep headings short.");
    const de = buildStyleGuide(settings, german);

    assert.ok(it.ok && de.ok);
    assert.equal(
      it.styleGuide,
      [
        "Friendly and precise.",
        "Use the informal tu.",
        'Translate "content model" as "modello di contenuto".\nTranslate "draft" as "bozza".',
        "Keep headings short.",
      ].join("\n\n")
    );
    assert.equal(de.styleGuide, 'Friendly and precise.\n\nTranslate "content model" as "Inhaltsmodell".');
    assert.equal(it.remaining, AI_TRANSLATION_STYLE_GUIDE_LIMIT - it.length);
  });

  it("accepts exactly the cap and names every part when one character over", () => {
    const exact = readTranslationSettings({ styleGuide: "x".repeat(AI_TRANSLATION_STYLE_GUIDE_LIMIT) });
    const atCap = buildStyleGuide(exact, italian);

    assert.ok(atCap.ok);
    assert.equal(atCap.remaining, 0);

    const over = buildStyleGuide(
      readTranslationSettings({ styleGuide: "x".repeat(1992), languageNotes: { it: "Use tu." } }),
      italian
    );

    assert.equal(over.ok, false);
    assert.ok(!over.ok);
    assert.equal(over.over, 1);
    assert.equal(
      over.message,
      "The style guide for Italiano is 2,001 characters, 1 over Sanity's limit of 2,000 (style guide 1,992, Italiano notes 7). Shorten one of them."
    );
  });

  it("reports only the languages whose compiled guide is over", () => {
    const long = readTranslationSettings({ styleGuide: "x".repeat(1995), languageNotes: { it: "Use the informal tu." } });

    assert.deepEqual(
      styleGuideIssues(long, [italian, german]).map((message) => message.split(" is ")[0]),
      ["The style guide for Italiano"]
    );
  });
});

describe("mergeProtectedPhrases", () => {
  it("merges the settings, the Site's name and every person, trimmed, without replacing any", () => {
    assert.deepEqual(
      mergeProtectedPhrases(settings.protectedPhrases, ["Acme"], ["Ada Lovelace", "Sanity", " Portable Text ", ""]),
      ["Sanity", "Figma", "Acme", "Ada Lovelace", "Portable Text"]
    );
  });
});
