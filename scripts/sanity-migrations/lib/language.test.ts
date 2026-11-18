import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluate, parse } from "groq-js";
import { copyRecord, readRecord, translationStatus } from "../../../sanity/ai-translation/plan";
import { DEFAULT_LOCALE, IS_I18N_ENABLED, LOCALE_IDS, withLocalePrefix } from "../../../sanity/i18n";
import type { RawDocument } from "../../trim-features/language-removal";
import {
  documentLanguage,
  findPrefixCollisions,
  type LanguageCopy,
  MISSING_LANGUAGE_QUERY,
  metadataRow,
  planLanguageBackfill,
  planSingletonTranslations,
  planTranslationStub,
  statedLanguages,
} from "./language";

// `zz` is a language nobody configures, so these never depend on LOCALES; `secondary` is for URI moves only.
const NEW = "zz";
const secondary: string = LOCALE_IDS.find((locale) => locale !== DEFAULT_LOCALE) ?? DEFAULT_LOCALE;
const multiLocale = { skip: !IS_I18N_ENABLED };

const copy = (_id: string, language?: unknown, uri?: string, _type = "page"): LanguageCopy => ({
  _id,
  _type,
  _rev: `rev-${_id}`,
  ...(language === undefined ? {} : { language }),
  ...(uri === undefined ? {} : { uri }),
});

async function run(query: string, dataset: unknown[], params: Record<string, unknown> = {}) {
  const value = await evaluate(parse(query, { params }), { dataset, params });

  return value.get();
}

describe("MISSING_LANGUAGE_QUERY", () => {
  it("finds every copy of a translated type with no language or an empty one, and nothing else", async () => {
    const dataset = [
      { _id: "a", _type: "page" },
      { _id: "drafts.a", _type: "page", language: "" },
      { _id: "versions.r1.a", _type: "page", language: null },
      { _id: "b", _type: "page", language: DEFAULT_LOCALE },
      { _id: "c", _type: "siteSettings" },
    ];

    const found = (await run(MISSING_LANGUAGE_QUERY, dataset, { types: ["page"] })) as LanguageCopy[];

    assert.deepEqual(
      found.map(({ _id }) => _id),
      ["a", "drafts.a", "versions.r1.a"]
    );
  });
});

describe("documentLanguage", () => {
  it("reads a copy's own language, keeps an empty one as missing, and inherits otherwise", () => {
    const copies = [copy("a", NEW), copy("drafts.a"), copy("versions.r1.a"), copy("b"), copy("drafts.b", "")] as const;
    const stated = statedLanguages(copies);

    assert.equal(documentLanguage(copies[0], stated, DEFAULT_LOCALE), NEW);
    assert.equal(documentLanguage(copies[1], stated, DEFAULT_LOCALE), NEW);
    assert.equal(documentLanguage(copies[2], stated, DEFAULT_LOCALE), NEW);
    assert.equal(documentLanguage(copies[3], stated, DEFAULT_LOCALE), DEFAULT_LOCALE);
    assert.equal(documentLanguage(copies[4], stated, DEFAULT_LOCALE), "");
  });

  it("never guesses when the copies disagree or state something that is not a code", () => {
    const disagree = [copy("a", NEW), copy("drafts.a", DEFAULT_LOCALE), copy("versions.r1.a")] as const;
    const notACode = [copy("b", [NEW]), copy("drafts.b")] as const;

    assert.equal(documentLanguage(disagree[2], statedLanguages(disagree), DEFAULT_LOCALE), undefined);
    assert.equal(documentLanguage(notACode[0], statedLanguages(notACode), DEFAULT_LOCALE), undefined);
    assert.equal(documentLanguage(notACode[1], statedLanguages(notACode), DEFAULT_LOCALE), undefined);
  });
});

describe("planLanguageBackfill", () => {
  it("sets the language the other copies state, else the default, an empty one included", () => {
    const copies = [
      copy("a", NEW, "/zz/a"),
      copy("drafts.a", undefined, "/zz/a"),
      copy("versions.r1.a"),
      copy("b", "", "/b"),
      copy("c", undefined, "/c"),
      copy("d", DEFAULT_LOCALE, "/d"),
    ];
    const missing = copies.filter(({ language }) => language === undefined || language === "");
    const { patches, skipped } = planLanguageBackfill(missing, copies, DEFAULT_LOCALE, [{ name: "r1", state: "active" }]);

    assert.deepEqual(skipped, []);
    assert.deepEqual(
      patches.map(({ id, language, inherited, rev }) => [id, language, inherited, rev]),
      [
        ["drafts.a", NEW, true, "rev-drafts.a"],
        ["versions.r1.a", NEW, true, "rev-versions.r1.a"],
        ["b", DEFAULT_LOCALE, false, "rev-b"],
        ["c", DEFAULT_LOCALE, false, "rev-c"],
      ]
    );
  });

  it("leaves a copy whose other copies disagree, and a version in a release that is not active", () => {
    const copies = [copy("a", NEW), copy("drafts.a", DEFAULT_LOCALE), copy("versions.r1.a"), copy("versions.r2.b")] as const;
    const missing = [copies[2], copies[3]];
    const { patches, skipped } = planLanguageBackfill(missing, copies, DEFAULT_LOCALE, [
      { name: "r1", state: "active" },
      { name: "r2", state: "scheduled", title: "Launch" },
    ]);

    assert.deepEqual(patches, []);
    assert.deepEqual(
      skipped.map(({ id }) => id),
      ["versions.r1.a", "versions.r2.b"]
    );
    assert.match(skipped[0]?.reason ?? "", /disagree/);
    assert.match(skipped[1]?.reason ?? "", /"Launch".*scheduled/);
  });

  it("never touches a copy that states a language, whatever the query returned", () => {
    const stated = copy("a", NEW);

    assert.deepEqual(planLanguageBackfill([stated], [stated], DEFAULT_LOCALE).patches, []);
  });
});

describe("findPrefixCollisions", () => {
  it("returns nothing for the default locale, which owns no prefix", () => {
    assert.deepEqual(findPrefixCollisions([copy("a", undefined, "/about")], DEFAULT_LOCALE, DEFAULT_LOCALE), []);
  });

  it("finds copies under the new prefix in another language, a missing one read as the default", () => {
    const copies = [
      copy("home", undefined, `/${NEW}`),
      copy("nested", DEFAULT_LOCALE, `/${NEW}/about`),
      copy("empty", "", `/${NEW}/empty`),
      copy("lookalike", undefined, `/${NEW}-services`),
      copy("own", NEW, `/${NEW}/a-propos`),
      copy("drafts.own", undefined, `/${NEW}/a-propos`),
    ];

    assert.deepEqual(
      findPrefixCollisions(copies, NEW, DEFAULT_LOCALE).map(({ _id }) => _id),
      ["home", "nested", "empty"]
    );
  });
});

describe("planTranslationStub", () => {
  const source = {
    _id: "blog",
    _type: "blog",
    _rev: "r1",
    _createdAt: "2026-01-01T00:00:00Z",
    _updatedAt: "2026-01-01T00:00:00Z",
    _system: { base: { id: "blog", rev: "r0" } },
    language: DEFAULT_LOCALE,
    title: "Blog",
    uri: { _type: "slug", current: "/blog" },
    agentMarkdown: { content: "# Blog" },
  };

  it("copies the source as a draft in the new language, without system or excluded fields", () => {
    const { document } = planTranslationStub({
      source,
      locale: NEW,
      sourceLocale: DEFAULT_LOCALE,
      excludedFields: ["agentMarkdown"],
      groups: [],
    });

    assert.match(document._id, /^drafts\.[0-9a-f-]{36}$/);
    assert.equal(document.language, NEW);
    assert.equal(document.title, "Blog");

    for (const field of ["_rev", "_createdAt", "_updatedAt", "_system", "agentMarkdown"]) {
      assert.equal(field in document, false, field);
    }

    assert.equal(source.agentMarkdown.content, "# Blog", "the source itself is left whole");
  });

  it("links the stub and its source through a new group, with the plugin's weak, strengthen-on-publish links", () => {
    const { document, metadata, metadataId, row } = planTranslationStub({
      source,
      locale: NEW,
      sourceLocale: DEFAULT_LOCALE,
      excludedFields: [],
      groups: [],
    });

    assert.ok(metadata);
    assert.equal(metadata._id, metadataId);
    assert.equal(metadata._type, "translation.metadata");
    assert.deepEqual(metadata.schemaTypes, ["blog"]);
    assert.deepEqual(
      metadata.translations.map(({ language, value }) => [language, value._ref]),
      [
        [DEFAULT_LOCALE, "blog"],
        [NEW, document._id.replace("drafts.", "")],
      ]
    );
    assert.deepEqual(row.value, {
      _type: "reference",
      _ref: document._id.replace("drafts.", ""),
      _weak: true,
      _strengthenOnPublish: { type: "blog" },
    });
    assert.equal(row._type, "internationalizedArrayReferenceValue");
    assert.match(row._key, /^[0-9a-f]{32}$/);
  });

  it("joins an existing group instead of creating one", () => {
    const stub = planTranslationStub({
      source,
      locale: NEW,
      sourceLocale: DEFAULT_LOCALE,
      metadataId: "existing",
      excludedFields: [],
      groups: [],
    });

    assert.equal(stub.metadata, undefined);
    assert.equal(stub.metadataId, "existing");
  });

  it("moves its URI into the language and re-points references to published translations", multiLocale, () => {
    const page = {
      _id: "homepage",
      _type: "page",
      uri: { _type: "slug", current: "/" },
      cta: { _type: "reference", _ref: "about", _weak: true },
    };
    const { patch, uri } = planTranslationStub({
      source: page,
      locale: secondary,
      sourceLocale: DEFAULT_LOCALE,
      excludedFields: [],
      groups: [
        {
          variants: [
            { id: "about", language: DEFAULT_LOCALE },
            { id: "about-2", language: secondary },
          ],
        },
      ],
    });

    assert.equal(uri, withLocalePrefix(secondary, "/"));
    assert.equal(patch["uri.current"], uri);
    assert.equal(patch["cta._ref"], "about-2");
  });

  it("writes a translation link the way the plugin does", () => {
    const row = metadataRow(NEW, "target", "page");

    assert.deepEqual(Object.keys(row).sort(), ["_key", "_type", "language", "value"]);
  });
});

describe("planSingletonTranslations", () => {
  const base = { i18nTypes: ["site", "page", "blog"], defaultLocale: DEFAULT_LOCALE, excludedFields: [], groups: [] };
  const singletons: RawDocument[] = [
    { _id: "site", _type: "site", title: "published" },
    { _id: "drafts.site", _type: "site", title: "draft" },
    { _id: "drafts.blog", _type: "blog", title: "draft only", uri: { current: "/blog" } },
    { _id: "versions.r1.homepage", _type: "page", uri: { current: "/" } },
    { _id: "siteSettings", _type: "siteSettings" },
  ];

  it("copies each translated singleton once, the published copy when there is one", () => {
    const plan = planSingletonTranslations({ ...base, singletons, metadata: [], copies: [], locale: NEW });

    assert.deepEqual(
      plan.stubs.map(({ sourceId, document }) => [sourceId, document.title]),
      [
        ["site", "published"],
        ["blog", "draft only"],
      ]
    );
  });

  it("stamps each copy as made, so a run reads it as a copy once the English changes, and a hand edit never", () => {
    const [site] = planSingletonTranslations({ ...base, singletons, metadata: [], copies: [], locale: NEW }).stubs;
    const made = site?.document as RawDocument & { _type: string };
    const source = { _id: "site", _type: "site", language: DEFAULT_LOCALE, title: "published, then edited" };
    const stamp = copyRecord({ ...made, aiTranslation: undefined }, { sourceId: "site", sourceLanguage: DEFAULT_LOCALE });

    assert.deepEqual(readRecord(made), stamp);
    assert.equal(translationStatus({ source, target: made }), "copyOfEnglish");
    assert.equal(translationStatus({ source, target: { ...made, title: "pubblicato" } }), "translatedByHand");
  });

  it("skips one already translated, whether its link names the language or only its document does", () => {
    const metadata: RawDocument[] = [
      {
        _id: "m1",
        _type: "translation.metadata",
        translations: [
          { language: DEFAULT_LOCALE, value: { _ref: "site" } },
          { language: NEW, value: { _ref: "site-zz" } },
        ],
      },
      { _id: "m2", _type: "translation.metadata", translations: [{ value: { _ref: "blog" } }, { value: { _ref: "blog-zz" } }] },
    ];
    const copies = [copy("drafts.blog-zz", NEW, "/zz/blog", "blog")];
    const plan = planSingletonTranslations({ ...base, singletons, metadata, copies, locale: NEW });

    assert.deepEqual(plan.translated, ["site", "blog"]);
    assert.deepEqual(plan.stubs, []);
  });

  it("joins the source's group, and leaves one whose place a document in the language already holds", () => {
    const metadata: RawDocument[] = [
      { _id: "m1", _type: "translation.metadata", translations: [{ language: DEFAULT_LOCALE, value: { _ref: "site" } }] },
      { _id: "drafts.m9", _type: "translation.metadata", translations: [{ language: DEFAULT_LOCALE, value: { _ref: "blog" } }] },
    ];
    const copies = [copy("unlinked-site", NEW, undefined, "site")];
    const plan = planSingletonTranslations({ ...base, singletons, metadata, copies, locale: NEW });

    assert.deepEqual(
      plan.skipped.map(({ id }) => id),
      ["site"]
    );
    assert.match(plan.skipped[0]?.reason ?? "", /unlinked-site .* not linked to site/);
    assert.deepEqual(
      plan.stubs.map(({ sourceId, metadataId, metadata: created }) => [sourceId, metadataId === "m1", created === undefined]),
      [["blog", false, false]]
    );
  });

  it("never counts the source's own copies as holding the stub's place", () => {
    const page: RawDocument[] = [{ _id: "homepage", _type: "page", uri: { current: "/" } }];
    const copies = [copy("homepage", undefined, "/"), copy("drafts.homepage", undefined, "/")];
    const plan = planSingletonTranslations({ ...base, singletons: page, metadata: [], copies, locale: NEW });

    assert.deepEqual(plan.skipped, []);
    assert.deepEqual(
      plan.stubs.map(({ sourceId }) => sourceId),
      ["homepage"]
    );
  });

  it("leaves a routed singleton whose translated URI another document already holds", multiLocale, () => {
    const page: RawDocument[] = [{ _id: "homepage", _type: "page", uri: { current: "/" } }];
    const copies = [copy("homepage", undefined, "/"), copy("hand-made", undefined, withLocalePrefix(secondary, "/"))];
    const plan = planSingletonTranslations({ ...base, singletons: page, metadata: [], copies, locale: secondary });

    assert.deepEqual(plan.stubs, []);
    assert.match(plan.skipped[0]?.reason ?? "", new RegExp(`hand-made already sits at ${withLocalePrefix(secondary, "/")}`));
  });
});
