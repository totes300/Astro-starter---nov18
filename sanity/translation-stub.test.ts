import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LOCALE, IS_I18N_ENABLED, LOCALE_IDS, withLocalePrefix } from "./i18n";
import { SECTION_TYPES, SECTIONS, type SectionTypes } from "./sections";
import {
  fixedPlace,
  metadataRow,
  newTranslationUriProblem,
  planTranslationRefresh,
  planTranslationStub,
  referenceOnlyChanges,
  refreshMutations,
  stubMutations,
  type TranslationDocument,
  translatedSlugUri,
  translationGroupId,
  uniqueUri,
} from "./translation-stub";

// `zz` is a language nobody configures, so these never depend on LOCALES; `secondary` is for URI moves only.
const NEW = "zz";
const secondary: string = LOCALE_IDS.find((locale) => locale !== DEFAULT_LOCALE) ?? DEFAULT_LOCALE;
const multiLocale = { skip: !IS_I18N_ENABLED };
// Read off the registry, so the fixed-path test outlives a trim that leaves no section.
const sectionIndex = (SECTIONS as string[])
  .map((section) => (SECTION_TYPES as Record<string, SectionTypes>)[section]?.index)
  .find(Boolean);

describe("metadataRow", () => {
  it("keys each link with 32 hex characters from Web Crypto", () => {
    const keys = new Set(Array.from({ length: 20 }, () => metadataRow(NEW, "target", "page")._key));

    assert.equal(keys.size, 20);

    for (const key of keys) {
      assert.match(key, /^[0-9a-f]{32}$/);
    }
  });
});

describe("translationGroupId", () => {
  it("is one UUID per source, the same for its draft, and different for another source", async () => {
    const id = await translationGroupId("about");

    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(await translationGroupId("drafts.about"), id);
    assert.equal(await translationGroupId("about"), id);
    assert.notEqual(await translationGroupId("contact"), id);
  });
});

describe("planTranslationStub", () => {
  const source: TranslationDocument = {
    _id: "drafts.about",
    _type: "page",
    _rev: "r1",
    language: DEFAULT_LOCALE,
    title: "About",
    aiTranslation: { sourceId: "x" },
    agentMarkdown: { content: "# About" },
  };

  it("creates the group it is given, under the published id of a draft source", async () => {
    const newMetadataId = await translationGroupId(source._id);
    const stub = planTranslationStub({
      source,
      locale: NEW,
      sourceLocale: DEFAULT_LOCALE,
      newMetadataId,
      excludedFields: ["agentMarkdown"],
      groups: [],
    });

    assert.equal(stub.sourceId, "about");
    assert.equal(stub.metadataId, newMetadataId);
    assert.equal(stub.metadata?._id, newMetadataId);
    assert.deepEqual(
      stub.metadata?.translations.map(({ language, value }) => [language, value._ref]),
      [
        [DEFAULT_LOCALE, "about"],
        [NEW, stub.document._id.replace("drafts.", "")],
      ]
    );
    assert.equal("aiTranslation" in stub.document, false, "a provenance record never carries over");
    assert.equal("_rev" in stub.document, false);
  });

  it("takes a URI the caller chose over the localized copy", () => {
    const stub = planTranslationStub({
      source: { ...source, uri: { _type: "slug", current: "/about" } },
      locale: NEW,
      sourceLocale: DEFAULT_LOCALE,
      uri: "/zz/chi-siamo",
      excludedFields: [],
      groups: [],
    });

    assert.equal(stub.uri, "/zz/chi-siamo");
    assert.equal(stub.patch["uri.current"], "/zz/chi-siamo");
  });
});

describe("stubMutations", () => {
  const source: TranslationDocument = { _id: "about", _type: "page", title: "About" };

  it("creates a new group with `create`, so a raced deterministic id conflicts instead of dropping a link", () => {
    const stub = planTranslationStub({ source, locale: NEW, sourceLocale: DEFAULT_LOCALE, excludedFields: [], groups: [] });
    const mutations = stubMutations(stub);

    assert.deepEqual(mutations, [{ create: stub.document }, { create: stub.metadata }]);
  });

  it("joins an existing group behind its revision, and moves the copy when it has something to move", () => {
    const stub = planTranslationStub({
      source: { ...source, cta: { _type: "reference", _ref: "about", _weak: true } },
      locale: NEW,
      sourceLocale: DEFAULT_LOCALE,
      metadataId: "group",
      excludedFields: [],
      groups: [],
    });
    const [create, move, link] = stubMutations(stub, { metadataRev: "rev-1" });

    assert.deepEqual(create, { create: stub.document });
    assert.deepEqual(move, { patch: { id: stub.document._id, set: { "cta._ref": stub.document._id.replace("drafts.", "") } } });
    assert.deepEqual(link, {
      patch: {
        id: "group",
        ifRevisionID: "rev-1",
        setIfMissing: { translations: [] },
        insert: { after: "translations[-1]", items: [stub.row] },
      },
    });
  });
});

describe("planTranslationRefresh", () => {
  const translated: TranslationDocument = {
    _id: "about",
    _type: "page",
    _rev: "source-rev",
    language: DEFAULT_LOCALE,
    title: "Chi siamo",
    uri: { _type: "slug", current: "/about" },
    seoMetadata: { title: "Chi siamo", sourceUrl: "https://example.com/about", noIndex: false },
    agentMarkdown: { content: "# About" },
    pageBuilder: {
      sectionsArray: [
        { _key: "a", _type: "headlineSectionField", sectionContent: { headline: "Ciao" } },
        {
          _key: "b",
          _type: "ctaSectionField",
          sectionContent: { headline: "Scrivici", link: { _type: "reference", _ref: "contact" } },
        },
      ],
    },
    self: { _type: "reference", _ref: "about", _weak: true },
  };

  const published: TranslationDocument = {
    _id: "about-it",
    _type: "page",
    _rev: "published-rev",
    _createdAt: "2026-01-01T00:00:00Z",
    language: NEW,
    title: "About",
    uri: { _type: "slug", current: "/zz/chi-siamo" },
    seoMetadata: { title: "About", sourceUrl: "https://example.com/zz/chi-siamo", noIndex: false },
    agentMarkdown: { content: "# Chi siamo (generated)" },
    aiTranslation: { textHash: "old" },
    obsolete: "dropped from the source since",
    pageBuilder: {
      sectionsArray: [
        { _key: "a", _type: "headlineSectionField", sectionContent: { headline: "Hello" } },
        {
          _key: "b",
          _type: "ctaSectionField",
          sectionContent: { headline: "Write to us", link: { _type: "reference", _ref: "contact-it" } },
        },
      ],
    },
    self: { _type: "reference", _ref: "about-it", _weak: true },
  };

  const groups = [
    {
      variants: [
        { id: "contact", language: DEFAULT_LOCALE },
        { id: "contact-it", language: NEW },
      ],
    },
  ];

  it("sets only the leaves that differ, keeping the target's id, language, URI, share image, own fields and record", () => {
    const refresh = planTranslationRefresh({
      translated,
      target: { published },
      locale: NEW,
      sourceLocale: DEFAULT_LOCALE,
      excludedFields: ["agentMarkdown", "aiTranslation"],
      groups,
    });

    assert.equal(refresh.targetId, "about-it");
    assert.equal(refresh.draftId, "drafts.about-it");
    assert.deepEqual(refresh.set, {
      title: "Chi siamo",
      "seoMetadata.title": "Chi siamo",
      'pageBuilder.sectionsArray[_key=="a"].sectionContent.headline': "Ciao",
      'pageBuilder.sectionsArray[_key=="b"].sectionContent.headline': "Scrivici",
    });
    assert.deepEqual(refresh.unset, ["obsolete"]);
    assert.equal((refresh.document.uri as { current: string }).current, "/zz/chi-siamo");
    assert.deepEqual(refresh.document.agentMarkdown, published.agentMarkdown);
    assert.deepEqual(refresh.document.aiTranslation, published.aiTranslation);
    assert.equal(refresh.document.language, NEW);
  });

  it("re-points references again: a published variant, and the source itself to this translation", () => {
    const refresh = planTranslationRefresh({
      translated,
      target: { published: { ...published, pageBuilder: undefined, self: undefined } },
      locale: NEW,
      sourceLocale: DEFAULT_LOCALE,
      excludedFields: [],
      groups,
    });
    const sections = (refresh.document.pageBuilder as { sectionsArray: { sectionContent: { link?: { _ref: string } } }[] })
      .sectionsArray;

    assert.equal(sections[1]?.sectionContent.link?._ref, "contact-it");
    assert.deepEqual(refresh.document.self, { _type: "reference", _ref: "about-it", _weak: true });
  });

  it("creates the draft from the published copy when there is none, and patches an existing draft behind its revision", () => {
    const fromPublished = planTranslationRefresh({
      translated,
      target: { published },
      locale: NEW,
      sourceLocale: DEFAULT_LOCALE,
      excludedFields: [],
      groups,
    });

    assert.equal(fromPublished.ifRevisionId, undefined);
    assert.equal(fromPublished.publishedRev, "published-rev", "its publish refuses a published copy changed since");
    assert.equal(fromPublished.create?._id, "drafts.about-it");
    assert.equal(fromPublished.create && "_rev" in fromPublished.create, false);
    assert.equal(fromPublished.create && "_createdAt" in fromPublished.create, false);

    const [create, patch] = refreshMutations(fromPublished);

    assert.deepEqual(create, { create: fromPublished.create });
    assert.deepEqual(patch, { patch: { id: "drafts.about-it", set: fromPublished.set, unset: fromPublished.unset } });

    const draft = { ...published, _id: "drafts.about-it", _rev: "draft-rev" };
    const onDraft = planTranslationRefresh({
      translated,
      target: { draft, published },
      locale: NEW,
      sourceLocale: DEFAULT_LOCALE,
      excludedFields: [],
      groups,
    });

    assert.equal(onDraft.create, undefined);
    assert.equal(onDraft.publishedRev, undefined);
    assert.equal(onDraft.ifRevisionId, "draft-rev");
    assert.deepEqual(refreshMutations(onDraft), [
      { patch: { id: "drafts.about-it", ifRevisionID: "draft-rev", set: onDraft.set, unset: onDraft.unset } },
    ]);
  });

  it("writes nothing when nothing differs, and sets a reordered array whole", () => {
    const same = planTranslationRefresh({
      translated: { ...published, _id: "about", language: DEFAULT_LOCALE },
      target: { draft: { ...published, _id: "drafts.about-it" } },
      locale: NEW,
      sourceLocale: DEFAULT_LOCALE,
      excludedFields: ["agentMarkdown"],
      groups: [],
    });

    assert.deepEqual(refreshMutations(same), []);

    const sections = (published.pageBuilder as { sectionsArray: unknown[] }).sectionsArray;
    const reordered = planTranslationRefresh({
      translated: { ...published, _id: "about", pageBuilder: { sectionsArray: [...sections].reverse() } },
      target: { draft: { ...published, _id: "drafts.about-it" } },
      locale: NEW,
      sourceLocale: DEFAULT_LOCALE,
      excludedFields: ["agentMarkdown"],
      groups: [],
    });

    assert.deepEqual(Object.keys(reordered.set), ["pageBuilder.sectionsArray"]);
  });

  it("keeps the target's own Password protect and noIndex, set or unset, whatever the source says", () => {
    const protectedTarget = {
      ...published,
      passwordProtected: true,
      seoMetadata: { ...(published.seoMetadata as object), noIndex: true },
    };
    const fromOpenSource = planTranslationRefresh({
      translated: { ...translated, passwordProtected: false },
      target: { published: protectedTarget },
      locale: NEW,
      sourceLocale: DEFAULT_LOCALE,
      excludedFields: [],
      groups,
    });

    assert.equal(fromOpenSource.document.passwordProtected, true);
    assert.equal((fromOpenSource.document.seoMetadata as { noIndex?: boolean }).noIndex, true);
    assert.ok(!("passwordProtected" in fromOpenSource.set) && !fromOpenSource.unset.includes("passwordProtected"));
    assert.ok(!Object.keys(fromOpenSource.set).some((path) => path.includes("noIndex")));

    const openTarget = { ...published, seoMetadata: { title: "About", sourceUrl: "https://example.com/zz/chi-siamo" } };
    const fromProtectedSource = planTranslationRefresh({
      translated: {
        ...translated,
        passwordProtected: true,
        seoMetadata: { ...(translated.seoMetadata as object), noIndex: true },
      },
      target: { published: openTarget },
      locale: NEW,
      sourceLocale: DEFAULT_LOCALE,
      excludedFields: [],
      groups,
    });

    assert.equal(fromProtectedSource.document.passwordProtected, undefined);
    assert.equal((fromProtectedSource.document.seoMetadata as { noIndex?: boolean }).noIndex, undefined);
  });

  it("refuses a target with no copy at all", () => {
    assert.throws(() =>
      planTranslationRefresh({
        translated,
        target: {},
        locale: NEW,
        sourceLocale: DEFAULT_LOCALE,
        excludedFields: [],
        groups: [],
      })
    );
  });
});

describe("translatedSlugUri", () => {
  it("replaces the last segment with the translated title, keeping the prefix and the section word", multiLocale, () => {
    assert.equal(
      translatedSlugUri({ type: "page", uri: withLocalePrefix(secondary, "/company/about"), title: "Chi siamo" }),
      withLocalePrefix(secondary, "/company/chi-siamo")
    );
    assert.equal(
      translatedSlugUri({
        type: "article",
        uri: withLocalePrefix(secondary, "/blog/model-content"),
        title: "Modellare i contenuti",
      }),
      withLocalePrefix(secondary, "/blog/modellare-i-contenuti")
    );
  });

  it("keeps fixed paths: a home, a section index, or a title that slugs to nothing", multiLocale, () => {
    const home = withLocalePrefix(secondary, "/");
    const blog = withLocalePrefix(secondary, "/blog");

    assert.equal(translatedSlugUri({ type: "page", uri: home, title: "Benvenuti" }), home);

    if (sectionIndex) {
      assert.equal(translatedSlugUri({ type: sectionIndex, uri: blog, title: "Il blog" }), blog);
    }

    assert.equal(
      translatedSlugUri({ type: "page", uri: withLocalePrefix(secondary, "/about"), title: "!!!" }),
      withLocalePrefix(secondary, "/about")
    );
  });
});

describe("uniqueUri", () => {
  it("adds -2, -3 until the URI is free", () => {
    assert.equal(uniqueUri("/it/chi-siamo", new Set()), "/it/chi-siamo");
    assert.equal(uniqueUri("/it/chi-siamo", new Set(["/it/chi-siamo", "/it/chi-siamo-2"])), "/it/chi-siamo-3");
  });
});

describe("fixedPlace", () => {
  it(
    "is the fixed URI in the language, or the singleton's one copy, and nothing for a page that takes a suffix",
    multiLocale,
    () => {
      const page = (id: string, uri?: string): TranslationDocument => ({
        _id: id,
        _type: "page",
        language: DEFAULT_LOCALE,
        ...(uri ? { uri: { current: uri } } : {}),
      });

      assert.deepEqual(fixedPlace(page("homepage", "/"), secondary), { uri: withLocalePrefix(secondary, "/") });
      assert.equal(fixedPlace(page("about", "/about"), secondary), undefined);
      assert.deepEqual(fixedPlace({ _id: "site", _type: "site" }, secondary), { singleton: "site" });
      assert.equal(fixedPlace(page("no-uri"), secondary), undefined, "a page without a URI is not a singleton");
    }
  );
});

describe("newTranslationUriProblem", () => {
  const check = (uri: string, type = "page") =>
    newTranslationUriProblem({ uri, type, locale: secondary, studioPaths: ["/studio"] });

  it("refuses the paths the URI field refuses: the Studio's, gated shapes and a section's word", multiLocale, () => {
    assert.equal(check(withLocalePrefix(secondary, "/chi-siamo")), null);
    assert.match(check(withLocalePrefix(secondary, "/studio")) ?? "", /Sanity Studio/);
    assert.match(check(withLocalePrefix(secondary, "/404")) ?? "", /not-found/);
    assert.match(check(withLocalePrefix(secondary, "/api/x")) ?? "", /\/api/);
    assert.ok(check(withLocalePrefix(secondary, "/Chi-Siamo")), "capital letters");
  });
});

describe("referenceOnlyChanges", () => {
  const published: TranslationDocument = {
    _id: "about-it",
    _type: "page",
    _rev: "r1",
    title: "Chi siamo",
    cta: { _type: "reference", _ref: "contact" },
    agentMarkdown: { content: "# Chi siamo", enabled: true },
  };

  it("lists the moved references when nothing else differs, ignoring the paths asked", () => {
    const draft = {
      ...published,
      _id: "drafts.about-it",
      _rev: "r2",
      cta: { _type: "reference", _ref: "contact-it" },
      agentMarkdown: { content: "# Chi siamo, relinked", enabled: true },
    };

    assert.deepEqual(referenceOnlyChanges(published, draft, [["agentMarkdown", "content"]]), {
      "cta._ref": { from: "contact", to: "contact-it" },
    });
    assert.equal(referenceOnlyChanges(published, draft), undefined, "the Markdown differs unless ignored");
    assert.equal(referenceOnlyChanges(published, { ...draft, title: "Edited" }, [["agentMarkdown", "content"]]), undefined);
    assert.equal(
      referenceOnlyChanges(published, { ...draft, agentMarkdown: { content: "x", enabled: false } }, [
        ["agentMarkdown", "content"],
      ]),
      undefined
    );
  });
});
