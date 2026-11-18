import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PluginCallbackArgs } from "@sanity/document-internationalization";
import { copyRecord, translationStatus } from "./ai-translation/plan";
import { DEFAULT_LOCALE, IS_I18N_ENABLED, LOCALE_IDS, withLocalePrefix } from "./i18n";
import { SECTION_TYPES, SECTIONS, type SectionTypes, sectionPath } from "./sections";
import { localizeSourceUrl, localizeTranslation, translationPatch } from "./translation-callback";

// `string`, so the fixtures stay valid when only the default locale is configured.
const secondary: string = LOCALE_IDS.find((locale) => locale !== DEFAULT_LOCALE) ?? DEFAULT_LOCALE;
const multiLocale = { skip: !IS_I18N_ENABLED };

describe("localizeSourceUrl", () => {
  it("moves a source that named the copied page, keeping its origin and query", () => {
    assert.equal(localizeSourceUrl("https://www.example.com/about", "/about", "/xx/about"), "https://www.example.com/xx/about");
    assert.equal(localizeSourceUrl("https://example.com/about/?v=2", "/about", "/xx/about"), "https://example.com/xx/about?v=2");
    assert.equal(localizeSourceUrl("https://example.com", "/", "/xx"), "https://example.com/xx");
    assert.equal(localizeSourceUrl("https://example.com/xx", "/xx", "/"), "https://example.com/");
    assert.equal(
      localizeSourceUrl("https://example.com/%E6%97%A5%E6%9C%AC", "/日本", "/xx/日本"),
      "https://example.com/xx/%E6%97%A5%E6%9C%AC"
    );
  });

  it("leaves another page's URL, an unreadable one, or one already in place", () => {
    assert.equal(localizeSourceUrl("https://example.com/pricing", "/about", "/xx/about"), undefined);
    assert.equal(localizeSourceUrl("not a url", "/about", "/xx/about"), undefined);
    assert.equal(localizeSourceUrl("https://example.com/%E0%A4%A", "/about", "/xx/about"), undefined);
    assert.equal(localizeSourceUrl("https://example.com/about", "/about", "/about"), undefined);
  });
});

describe("translationPatch", () => {
  const copy = (fields: Record<string, unknown>) => ({ _id: "drafts.translation", _type: "page", ...fields });

  it("moves the URI and the share-image source of a page into the language", multiLocale, () => {
    const patch = translationPatch({
      sourceId: "about",
      translation: copy({
        language: secondary,
        uri: { _type: "slug", current: "/about" },
        seoMetadata: { sourceUrl: "https://example.com/about" },
      }),
      sourceLanguage: DEFAULT_LOCALE,
      language: secondary,
      groups: [],
    });

    assert.deepEqual(patch, {
      "uri.current": withLocalePrefix(secondary, "/about"),
      "seoMetadata.sourceUrl": `https://example.com${withLocalePrefix(secondary, "/about")}`,
    });
  });

  it("moves a section's documents under the language's word, nested ones included", multiLocale, () => {
    for (const section of SECTIONS) {
      const { item, nested = [] }: SectionTypes = SECTION_TYPES[section];

      for (const type of [item, ...nested]) {
        const patch = translationPatch({
          sourceId: "source",
          translation: { _id: "drafts.translation", _type: type, uri: { _type: "slug", current: `/${section}/sub/slug` } },
          sourceLanguage: DEFAULT_LOCALE,
          language: secondary,
          groups: [],
        });

        assert.equal(patch["uri.current"], sectionPath(secondary, section, "/sub/slug"), type);
      }
    }
  });

  it("moves back to the default locale from a translation", multiLocale, () => {
    const from = withLocalePrefix(secondary, "/about");
    const patch = translationPatch({
      sourceId: "about-translated",
      translation: copy({ uri: { _type: "slug", current: from }, seoMetadata: { sourceUrl: `https://example.com${from}` } }),
      sourceLanguage: secondary,
      language: DEFAULT_LOCALE,
      groups: [],
    });

    assert.deepEqual(patch, { "uri.current": "/about", "seoMetadata.sourceUrl": "https://example.com/about" });
  });

  it("moves a page-less document's homepage source to the language's homepage", multiLocale, () => {
    const patch = translationPatch({
      sourceId: "site",
      translation: { _id: "drafts.translation", _type: "site", seoMetadata: { sourceUrl: "https://example.com/" } },
      sourceLanguage: DEFAULT_LOCALE,
      language: secondary,
      groups: [],
    });

    assert.deepEqual(patch, { "seoMetadata.sourceUrl": `https://example.com${withLocalePrefix(secondary, "/")}` });
  });

  it("re-points references to the published variant in the language, and a weak self-link to the translation", () => {
    const patch = translationPatch({
      sourceId: "about",
      translation: copy({
        author: { _ref: "person-en", _type: "reference" },
        categories: [{ _key: "c1", _ref: "category", _type: "reference" }],
        link: { _ref: "about", _type: "reference", _weak: true },
        parent: { _ref: "about", _type: "reference" },
      }),
      sourceLanguage: DEFAULT_LOCALE,
      language: "xx",
      groups: [
        {
          variants: [
            { id: "person-en", language: DEFAULT_LOCALE },
            { id: "person-xx", language: "xx" },
          ],
        },
      ],
    });

    assert.deepEqual(patch, { "author._ref": "person-xx", "link._ref": "translation" });
  });
});

type Call = { method: string; args: unknown[] };

function stubClient(calls: Call[], groups: unknown) {
  return {
    fetch: async (...args: unknown[]) => {
      calls.push({ method: "fetch", args });

      if (groups instanceof Error) {
        throw groups;
      }

      return groups;
    },
    patch: (id: string) => ({
      set: (patch: Record<string, unknown>) => ({
        commit: async () => {
          calls.push({ method: "commit", args: [id, patch] });
        },
      }),
    }),
  };
}

function callbackArgs(newDocument: Record<string, unknown>, client: unknown, language: string): PluginCallbackArgs {
  return {
    sourceDocument: { _id: "about", _type: "page" },
    newDocument: { _id: "drafts.translation", _type: "page", ...newDocument },
    sourceLanguageId: DEFAULT_LOCALE,
    destinationLanguageId: language,
    metaDocumentId: "meta",
    client,
  } as unknown as PluginCallbackArgs;
}

describe("localizeTranslation", () => {
  it("reads the variants once, on the published perspective, and patches the new draft once", multiLocale, async () => {
    const calls: Call[] = [];
    const client = stubClient(calls, [
      {
        variants: [
          { id: "person-en", language: DEFAULT_LOCALE },
          { id: "person-other", language: secondary },
        ],
      },
    ]);

    await localizeTranslation(
      callbackArgs(
        { uri: { _type: "slug", current: "/about" }, author: { _ref: "person-en", _type: "reference" } },
        client,
        secondary
      )
    );

    const newDocument = {
      _id: "drafts.translation",
      _type: "page",
      uri: { _type: "slug", current: "/about" },
      author: { _ref: "person-en", _type: "reference" },
    };

    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0]?.args.slice(1), [{ ids: ["person-en"] }, { perspective: "published" }]);
    assert.deepEqual(calls[1]?.args, [
      "drafts.translation",
      {
        "uri.current": withLocalePrefix(secondary, "/about"),
        "author._ref": "person-other",
        aiTranslation: copyRecord(newDocument, { sourceId: "about", sourceLanguage: DEFAULT_LOCALE }),
      },
    ]);
  });

  it("stamps the copy as made, so a later English edit leaves it a copy and a hand edit never does", multiLocale, async () => {
    const calls: Call[] = [];
    const english = {
      _id: "about",
      _type: "page",
      language: DEFAULT_LOCALE,
      title: "About",
      intro: "Who we are and what we do.",
    };

    await localizeTranslation({
      ...callbackArgs(
        { title: "About", intro: "Who we are and what we do.", language: secondary },
        stubClient(calls, []),
        secondary
      ),
      sourceDocument: english,
    } as unknown as PluginCallbackArgs);

    const [, patch] = (calls.at(-1)?.args ?? []) as [string, Record<string, unknown>];
    const copy = { ...english, _id: "drafts.translation", language: secondary, ...patch };
    const edited = { ...english, intro: "Who we are, and what we do these days." };

    assert.equal(translationStatus({ source: edited, target: copy }), "copyOfEnglish");
    assert.equal(translationStatus({ source: edited, target: { ...copy, title: "Chi siamo" } }), "translatedByHand");
  });

  it("reads and writes nothing for a copy with nothing to move", async () => {
    const calls: Call[] = [];

    await localizeTranslation(callbackArgs({ title: "About" }, stubClient(calls, []), DEFAULT_LOCALE));

    assert.deepEqual(calls, []);
  });

  it("logs a failed read and never throws", async (t) => {
    const calls: Call[] = [];
    const logged = t.mock.method(console, "error", () => {});

    await localizeTranslation(
      callbackArgs({ author: { _ref: "person-en", _type: "reference" } }, stubClient(calls, new Error("offline")), secondary)
    );

    assert.equal(logged.mock.callCount(), 1);
    assert.deepEqual(
      calls.map(({ method }) => method),
      ["fetch"]
    );
  });
});
