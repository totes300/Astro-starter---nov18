import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluate, parse } from "groq-js";
import { DEFAULT_LOCALE, IS_I18N_ENABLED, LOCALE_IDS } from "~/sanity/i18n";
import { AlternatesFragment, ConfiguredLocaleFilter, configuredReference, localeParams, localized } from "./fragment";

// Fixtures derive from `sanity/i18n.ts`; `zz` stands in for a language the site does not serve.
// Params are bound at parse time: unbound there, groq-js reads `[$language]` as a filter, not a key.

// Typed wide: with one locale a fixture's two language keys are the same literal, which does not type-check.
const secondary: string = LOCALE_IDS.find((id) => id !== DEFAULT_LOCALE) ?? DEFAULT_LOCALE;

// Any four of the marks stega encodes with, which is the shortest run `stegaClean` strips.
const STEGA = "​‌‍﻿";

async function query(groq: string, dataset: Record<string, unknown>[], params: Record<string, unknown> = localeParams()) {
  return (await evaluate(parse(groq, { params }), { dataset, params })).get();
}

describe("localeParams", () => {
  it("binds the default language and every configured locale", () => {
    assert.deepEqual(localeParams(), { language: DEFAULT_LOCALE, locales: LOCALE_IDS });
  });

  it("keeps the caller's params and language", () => {
    assert.deepEqual(localeParams({ uri: "/about", language: secondary }), {
      uri: "/about",
      language: secondary,
      locales: LOCALE_IDS,
    });
  });

  it("never lets a caller widen the configured locales", () => {
    assert.deepEqual(localeParams({ locales: ["zz"] }).locales, LOCALE_IDS);
  });

  it("cleans a stega-encoded language, which preview strings carry", () => {
    assert.equal(localeParams({ language: `${secondary}${STEGA}` }).language, secondary);
  });

  it("refuses a language the site does not serve", () => {
    assert.throws(() => localeParams({ language: "zz" }), /configured locale/);
    assert.throws(() => localeParams({ language: "" }), /configured locale/);
  });
});

describe("ConfiguredLocaleFilter", () => {
  it("keeps documents in a configured language or none, and hides the rest", async () => {
    const dataset = [
      { _id: "legacy" },
      { _id: "null", language: null },
      { _id: "default", language: DEFAULT_LOCALE },
      { _id: "secondary", language: secondary },
      { _id: "ghost", language: "zz" },
      { _id: "empty", language: "" },
    ];

    assert.deepEqual(await query(`*[${ConfiguredLocaleFilter}]._id`, dataset), ["legacy", "null", "default", "secondary"]);
  });
});

describe("configuredReference", () => {
  it("drops a reference to a document in a language the site does not serve", async () => {
    const dataset = [
      { _id: "live", _type: "person", name: "Live" },
      { _id: "ghost", _type: "person", language: "zz", name: "Ghost" },
      { _id: "a", _type: "article", author: { _ref: "live" } },
      { _id: "b", _type: "article", author: { _ref: "ghost" } },
    ];
    const groq = `*[_type == "article"]{ _id, "author": select(${configuredReference("author")} => author->name) }`;

    assert.deepEqual(await query(groq, dataset), [
      { _id: "a", author: "Live" },
      { _id: "b", author: null },
    ]);
  });
});

describe("localized", () => {
  const groq = `*[]{ _id, "name": ${localized("name")} }`;
  const dataset = [
    { _id: "default-only", name: { [DEFAULT_LOCALE]: "Design" } },
    { _id: "legacy", name: "Legacy" },
    { _id: "ghost-only", name: { zz: "Ghost" } },
    { _id: "missing" },
  ];
  const fallbacks = [
    { _id: "default-only", name: "Design" },
    { _id: "legacy", name: "Legacy" },
    { _id: "ghost-only", name: null },
    { _id: "missing", name: null },
  ];

  it("falls back to the default, then to a plain string stored before the field was translated", async () => {
    assert.deepEqual(await query(groq, dataset), fallbacks);
  });

  it("reads the requested language first", { skip: !IS_I18N_ENABLED }, async () => {
    const translated = { _id: "translated", name: { [DEFAULT_LOCALE]: "Design", [secondary]: "Progetto" } };

    assert.deepEqual(await query(groq, [translated, ...dataset], localeParams({ language: secondary })), [
      { _id: "translated", name: "Progetto" },
      ...fallbacks,
    ]);
    assert.deepEqual(await query(groq, [translated]), [{ _id: "translated", name: "Design" }]);
  });
});

describe("AlternatesFragment", () => {
  const alternatesOf = (dataset: Record<string, unknown>[]) =>
    query(`*[_id == "default"][0]{${AlternatesFragment}}.alternates`, dataset);

  function group(...ids: string[]) {
    return { _id: "group", _type: "translation.metadata", translations: ids.map((id) => ({ value: { _ref: id } })) };
  }

  const page = { _id: "default", _type: "page", language: DEFAULT_LOCALE, uri: { current: "/about" } };
  const self = { language: DEFAULT_LOCALE, uri: "/about", noIndex: false };

  it("never names a password protected translation", { skip: !IS_I18N_ENABLED }, async () => {
    const translation = { _id: "secondary", _type: "page", language: secondary, uri: { current: `/${secondary}/chi-siamo` } };
    const alternates = await alternatesOf([page, { ...translation, passwordProtected: true }, group("default", "secondary")]);

    assert.deepEqual(alternates, [self]);
  });

  it("leaves a noindex translation to hreflang and the switcher", { skip: !IS_I18N_ENABLED }, async () => {
    const translation = { _id: "secondary", _type: "page", language: secondary, uri: { current: `/${secondary}/chi-siamo` } };
    const alternates = await alternatesOf([
      page,
      { ...translation, seoMetadata: { noIndex: true } },
      group("default", "secondary"),
    ]);

    assert.deepEqual(alternates, [self, { language: secondary, uri: `/${secondary}/chi-siamo`, noIndex: true }]);
  });

  it("never names a translation in a language the site does not serve", async () => {
    const ghost = { _id: "ghost", _type: "page", language: "zz", uri: { current: "/zz/about" } };

    assert.deepEqual(await alternatesOf([page, ghost, group("default", "ghost")]), [self]);
  });

  it("never names a translation with no URI, rather than sending its language to the homepage", async () => {
    const unrouted = { _id: "secondary", _type: "page", language: secondary, uri: {} };

    assert.deepEqual(await alternatesOf([page, unrouted, group("default", "secondary")]), [self]);
  });
});
