import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fingerprint, fnv1a64, layoutHash, textHash } from "./fingerprint";
import { listTranslatedMark } from "./test-fixtures";

// biome-ignore lint/suspicious/noExplicitAny: fixtures are rewritten deep in place.
type Mutable = Record<string, any>;

function page(): Mutable {
  return {
    _id: "about",
    _type: "page",
    _rev: "r1",
    _updatedAt: "2026-10-19T00:00:00Z",
    language: "en",
    title: "About",
    uri: { _type: "slug", current: "/about" },
    seoMetadata: { title: "About us", sourceUrl: "https://example.com/about", noIndex: false },
    agentMarkdown: { content: "# About" },
    hero: { _type: "image", asset: { _type: "reference", _ref: "image-a-10x10-jpg" } },
    pageBuilder: {
      sectionsArray: [
        {
          _key: "s1",
          _type: "headlineSectionField",
          sectionSettings: { fullBleed: true },
          sectionContent: { headline: "One", link: { _type: "reference", _ref: "contact", _weak: true } },
        },
        {
          _key: "s2",
          _type: "textSectionField",
          sectionContent: {
            appRichText: [
              {
                _key: "b1",
                _type: "block",
                style: "normal",
                markDefs: [],
                children: [{ _key: "c1", _type: "span", text: "Two words", marks: [] }],
              },
            ],
          },
        },
      ],
    },
  };
}

describe("fnv1a64", () => {
  it("matches the published FNV-1a 64 vectors", () => {
    assert.equal(fnv1a64(""), "cbf29ce484222325");
    assert.equal(fnv1a64("a"), "af63dc4c8601ec8c");
    assert.equal(fnv1a64("foobar"), "85944171f73967e8");
  });
});

describe("fingerprint", () => {
  it("is blind to what each copy sets on its own: ids, language, URI, share image, references, records, system fields", () => {
    const copy = page();

    copy._id = "drafts.about-it";
    copy._rev = "r9";
    copy._updatedAt = "2027-01-01T00:00:00Z";
    copy.language = "it";
    copy.uri.current = "/it/about";
    copy.seoMetadata.sourceUrl = "https://example.com/it/about";
    copy.agentMarkdown = { content: "# Generated" };
    copy.aiTranslation = { textHash: "x" };
    copy.pageBuilder.sectionsArray[0].sectionContent.link = {
      _type: "reference",
      _ref: "contact-it",
      _strengthenOnPublish: { type: "page" },
    };

    assert.deepEqual(fingerprint(copy), fingerprint(page()));
  });

  it("is blind to the defaults the Studio fills in and to key order", () => {
    const filled = page();

    filled.seoMetadata = { noIndex: false, sourceUrl: "https://example.com/about", title: "About us", description: "" };
    filled.pageBuilder.sectionsArray[0].sectionSettings.disabled = false;
    delete filled.pageBuilder.sectionsArray[1].sectionContent.appRichText[0].markDefs;
    delete filled.pageBuilder.sectionsArray[1].sectionContent.appRichText[0].children[0].marks;

    assert.deepEqual(fingerprint(filled), fingerprint(page()));
  });

  it("puts a reworded string in the text hash only", () => {
    const reworded = page();

    reworded.pageBuilder.sectionsArray[0].sectionContent.headline = "Uno";

    assert.notEqual(textHash(reworded), textHash(page()));
    assert.equal(layoutHash(reworded), layoutHash(page()));
  });

  it("puts a moved section, a swapped image, a setting and a new mark in the layout hash only", () => {
    const moved = page();
    const swapped = page();
    const toggled = page();
    const marked = page();

    moved.pageBuilder.sectionsArray.reverse();
    swapped.hero.asset._ref = "image-b-10x10-jpg";
    toggled.pageBuilder.sectionsArray[0].sectionSettings.fullBleed = false;
    marked.pageBuilder.sectionsArray[1].sectionContent.appRichText[0].children = [
      { _key: "c1", _type: "span", text: "Two ", marks: [] },
      { _key: "c2", _type: "span", text: "words", marks: ["strong"] },
    ];

    for (const changed of [moved, swapped, toggled, marked]) {
      assert.equal(textHash(changed), textHash(page()));
      assert.notEqual(layoutHash(changed), layoutHash(page()));
    }
  });

  it("reads an inline object's copy as text, and a link or the object's own settings as layout", () => {
    const annotated = () => {
      const copy = page();
      const block = copy.pageBuilder.sectionsArray[1].sectionContent.appRichText[0];

      block.markDefs = [{ _key: "l1", _type: "linkField", type: "external", external: "https://example.com/docs" }];
      block.children = [
        { _key: "c1", _type: "span", text: "Two ", marks: [] },
        { _key: "c2", _type: "span", text: "words", marks: ["l1"] },
        { _key: "i1", _type: "inlineNoteField", note: "An aside", media: { type: "image" } },
      ];

      return copy;
    };
    const markDefs = (copy: Mutable) => copy.pageBuilder.sectionsArray[1].sectionContent.appRichText[0].markDefs;
    const inline = (copy: Mutable) => copy.pageBuilder.sectionsArray[1].sectionContent.appRichText[0].children[2];
    const reworded = annotated();
    const relinked = annotated();

    inline(reworded).note = "A longer aside";
    markDefs(relinked)[0].external = "https://example.com/guides";
    inline(relinked).media.type = "video";

    assert.notEqual(textHash(reworded), textHash(annotated()));
    assert.equal(layoutHash(reworded), layoutHash(annotated()));
    assert.equal(textHash(relinked), textHash(annotated()));
    assert.notEqual(layoutHash(relinked), layoutHash(annotated()));
  });

  it("tells text moved between two items from text that stayed put", () => {
    const swapped = page();

    swapped.pageBuilder.sectionsArray[0].sectionContent.headline = "Two words";
    swapped.pageBuilder.sectionsArray[1].sectionContent.appRichText[0].children[0].text = "One";

    assert.notEqual(textHash(swapped), textHash(page()));
  });
});

describe("fingerprint: an annotation `TRANSLATED_MARKS` lists", () => {
  listTranslatedMark("glossaryField");

  const glossed = () => {
    const copy = page();
    const block = copy.pageBuilder.sectionsArray[1].sectionContent.appRichText[0];

    block.markDefs = [{ _key: "g1", _type: "glossaryField", term: "Headless", type: "external" }];
    block.children[0].marks = ["g1"];

    return copy;
  };
  const glossary = (copy: Mutable) => copy.pageBuilder.sectionsArray[1].sectionContent.appRichText[0].markDefs[0];

  it("reads its copy as text and its settings as layout", () => {
    const reworded = glossed();
    const reset = glossed();

    glossary(reworded).term = "Decoupled";
    glossary(reset).type = "internal";

    assert.notEqual(textHash(reworded), textHash(glossed()));
    assert.equal(layoutHash(reworded), layoutHash(glossed()));
    assert.equal(textHash(reset), textHash(glossed()));
    assert.notEqual(layoutHash(reset), layoutHash(glossed()));
  });
});
