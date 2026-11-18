import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TranslationDocument } from "../translation-stub";
import { mergeTranslation } from "./merge";
import { listTranslatedMark } from "./test-fixtures";

// biome-ignore lint/suspicious/noExplicitAny: fixtures are rewritten deep in place.
type Mutable = Record<string, any>;

function source(): TranslationDocument {
  return {
    _id: "about",
    _type: "page",
    _rev: "r1",
    language: "en",
    title: "About",
    uri: { _type: "slug", current: "/about" },
    showHeader: true,
    seoMetadata: {
      title: "About us",
      description: "Who we are.",
      sourceUrl: "https://example.com/about",
      screenshotWaitSeconds: 2,
    },
    agentMarkdown: { content: "# About" },
    pageBuilder: {
      sectionsArray: [
        {
          _key: "s1",
          _type: "textSectionField",
          sectionSettings: { sectionTitle: "Intro", sectionHash: { _type: "slug", current: "intro" }, fullBleed: true },
          sectionContent: {
            _type: "textSection",
            headline: "Model content, not pages",
            appRichText: [
              {
                _key: "b1",
                _type: "block",
                style: "h2",
                markDefs: [{ _key: "l1", _type: "linkField", type: "external", external: "https://sanity.io" }],
                children: [
                  { _key: "c1", _type: "span", text: "Read ", marks: [] },
                  { _key: "c2", _type: "span", text: "the docs", marks: ["l1", "strong"] },
                  { _key: "c3", _type: "span", text: " today.", marks: [] },
                ],
              },
              {
                _key: "b2",
                _type: "block",
                style: "normal",
                listItem: "bullet",
                level: 1,
                markDefs: [],
                children: [
                  { _key: "d1", _type: "span", text: "Look: ", marks: [] },
                  { _key: "i1", _type: "inlineMediaField", media: { type: "image", image: { asset: { _ref: "image-1" } } } },
                  { _key: "d2", _type: "span", text: " an inline picture.", marks: [] },
                ],
              },
              {
                _key: "m1",
                _type: "mediaBlock",
                caption: "A caption",
                appMedia: { type: "rive", riveOptions: { stateMachine: "Idle" } },
              },
            ],
            appLink: {
              type: "internal",
              internal: { link: { _type: "reference", _ref: "contact", _weak: true }, sectionTarget: "form" },
              email: "hello@example.com",
              customText: "Get in touch",
            },
          },
        },
        {
          _key: "s2",
          _type: "headlineSectionField",
          sectionContent: { _type: "headlineSection", headline: "Second" },
        },
      ],
    },
  };
}

/** What a well-behaved agent returns: the same structure with Italian text. */
function translated(): Mutable {
  const result: Mutable = structuredClone(source());
  const [first, second] = result.pageBuilder.sectionsArray;

  result._id = "drafts.about";
  result._rev = "agent-rev";
  result.title = "Chi siamo";
  result.seoMetadata.title = "Chi siamo";
  result.seoMetadata.description = "Chi siamo.";
  first.sectionSettings.sectionTitle = "Introduzione";
  first.sectionContent.headline = "Modella i contenuti, non le pagine";
  first.sectionContent.appRichText[0].children = [
    { _key: "c1", _type: "span", text: "Leggi ", marks: [] },
    { _key: "c2", _type: "span", text: "la documentazione", marks: ["l1", "strong"] },
    { _key: "c3", _type: "span", text: " oggi.", marks: [] },
  ];
  first.sectionContent.appRichText[1].children[0].text = "Guarda: ";
  first.sectionContent.appRichText[1].children[2].text = " una foto.";
  first.sectionContent.appRichText[2].caption = "Una didascalia";
  first.sectionContent.appLink.customText = "Scrivici";
  second.sectionContent.headline = "Seconda";

  return result;
}

const sections = (document: Mutable) => document.pageBuilder.sectionsArray;
const blocks = (document: Mutable) => sections(document)[0].sectionContent.appRichText;

describe("mergeTranslation", () => {
  it("takes every translated leaf and keeps the source's structure, ids and settings", () => {
    const { document, stats } = mergeTranslation(source(), translated());
    const merged = document as Mutable;

    assert.equal(merged._id, "about");
    assert.equal(merged._rev, "r1");
    assert.equal(merged.title, "Chi siamo");
    assert.equal(merged.seoMetadata.description, "Chi siamo.");
    assert.equal(merged.seoMetadata.sourceUrl, "https://example.com/about");
    assert.equal(sections(merged)[1].sectionContent.headline, "Seconda");
    assert.equal(blocks(merged)[0].children[1].text, "la documentazione");
    assert.equal(blocks(merged)[2].caption, "Una didascalia");
    assert.equal(sections(merged)[0].sectionSettings.sectionTitle, "Introduzione");
    assert.deepEqual(sections(merged)[0].sectionSettings.sectionHash, { _type: "slug", current: "intro" });
    assert.deepEqual(stats, { translated: 10, keptInEnglish: 0, guarded: 0, partial: false });
  });

  it("restores everything a hostile result changes, and counts it", () => {
    const hostile = translated();
    const [first] = sections(hostile);

    hostile.uri.current = "/chi-siamo";
    hostile.language = "it";
    hostile.showHeader = false;
    hostile.seoMetadata.sourceUrl = "https://evil.example/";
    hostile.seoMetadata.screenshotWaitSeconds = 9;
    first.sectionSettings.sectionHash.current = "introduzione";
    first.sectionContent.appLink.type = "external";
    first.sectionContent.appLink.internal.sectionTarget = "modulo";
    first.sectionContent.appLink.internal.link._ref = "elsewhere";
    first.sectionContent.appLink.email = "ciao@example.com";
    first.sectionContent.appRichText[0].style = "h1";
    first.sectionContent.appRichText[0].markDefs[0].external = "https://evil.example/";
    first.sectionContent.appRichText[1].listItem = "number";
    first.sectionContent.appRichText[2].appMedia.riveOptions.stateMachine = "Inattivo";
    first.sectionContent.appRichText[2].appMedia.type = "lottie";
    sections(hostile)[1]._type = "ctaSectionField";

    const { document, stats, guardedPaths } = mergeTranslation(source(), hostile);
    const merged = document as Mutable;
    const original = source() as Mutable;

    assert.deepEqual(merged.uri, original.uri);
    assert.equal(merged.language, "en");
    assert.equal(merged.showHeader, true);
    assert.equal(merged.seoMetadata.sourceUrl, original.seoMetadata.sourceUrl);
    assert.equal(merged.seoMetadata.screenshotWaitSeconds, 2);
    assert.deepEqual(sections(merged)[0].sectionSettings, {
      ...sections(original)[0].sectionSettings,
      sectionTitle: "Introduzione",
    });
    assert.deepEqual(
      { ...sections(merged)[0].sectionContent.appLink, customText: undefined },
      { ...sections(original)[0].sectionContent.appLink, customText: undefined }
    );
    assert.equal(sections(merged)[0].sectionContent.appLink.customText, "Scrivici");
    assert.equal(blocks(merged)[0].style, "h2");
    assert.deepEqual(blocks(merged)[0].markDefs, blocks(original)[0].markDefs);
    assert.equal(blocks(merged)[1].listItem, "bullet");
    assert.deepEqual(blocks(merged)[2].appMedia, blocks(original)[2].appMedia);
    assert.deepEqual(sections(merged)[1], sections(original)[1], "a type change keeps the source item");
    assert.equal(stats.translated, 9);
    assert.equal(stats.keptInEnglish, 1);
    assert.ok(stats.guarded >= 11, `guarded ${stats.guarded}`);
    assert.ok(guardedPaths.some((path) => path.join(".") === "uri"));
  });

  it("keeps a missing item from the source and drops an item the agent invented", () => {
    const result = translated();

    sections(result).splice(1, 1);
    sections(result).push({ _key: "s9", _type: "headlineSectionField", sectionContent: { headline: "Nuova" } });

    const { document, stats, keptPaths, guardedPaths } = mergeTranslation(source(), result);

    assert.deepEqual(
      sections(document as Mutable).map(({ _key }: { _key: string }) => _key),
      ["s1", "s2"]
    );
    assert.equal(sections(document as Mutable)[1].sectionContent.headline, "Second");
    assert.deepEqual(keptPaths, [["pageBuilder", "sectionsArray", { _key: "s2" }, "sectionContent", "headline"]]);
    assert.deepEqual(guardedPaths, [["pageBuilder", "sectionsArray", { _key: "s9" }]]);
    assert.equal(stats.keptInEnglish, 1);
  });

  it("takes a re-spanned block whole when every span and mark is valid, restoring the block's own settings", () => {
    const result = translated();

    blocks(result)[0] = {
      ...blocks(result)[0],
      style: "h1",
      children: [
        { _key: "new1", _type: "span", text: "Leggi la ", marks: [] },
        { _key: "new2", _type: "span", text: "documentazione", marks: ["l1"] },
        { _key: "new2", _type: "span", text: " oggi", marks: ["em"], extra: "dropped" },
        { _type: "span", text: ".", marks: [] },
      ],
    };

    const { document, stats } = mergeTranslation(source(), result);
    const block = blocks(document as Mutable)[0];

    assert.equal(block.style, "h2");
    assert.deepEqual(block.children.map(({ text }: { text: string }) => text).join(""), "Leggi la documentazione oggi.");
    assert.equal(new Set(block.children.map(({ _key }: { _key: string }) => _key)).size, 4, "keys stay unique");
    assert.equal("extra" in block.children[2], false);
    assert.equal(stats.keptInEnglish, 0);
  });

  it("keeps the whole source block when a span carries an invented mark, drops a link, or loses an inline object", () => {
    const invented = translated();
    blocks(invented)[0].children[1].marks = ["l9"];

    const dropped = translated();
    blocks(dropped)[0].children[1].marks = ["strong"];

    const lostInline = translated();
    blocks(lostInline)[1].children.splice(1, 1);

    const notSpans = translated();
    blocks(notSpans)[0].children.push({ _key: "x", _type: "inlineMediaField", media: {} });

    for (const result of [invented, dropped, lostInline, notSpans]) {
      const { document, keptPaths } = mergeTranslation(source(), result);
      const original = source() as Mutable;
      const changed = blocks(result).findIndex((block: Mutable, index: number) => {
        return JSON.stringify(block.children) !== JSON.stringify(blocks(translated())[index].children);
      });

      assert.deepEqual(blocks(document as Mutable)[changed], blocks(original)[changed]);
      assert.deepEqual(keptPaths.at(-1)?.at(-1), { _key: blocks(original)[changed]._key });
    }
  });

  it("guards a block written without keys as a whole block too, never span by span", () => {
    const unkeyed: TranslationDocument = {
      _id: "post",
      _type: "article",
      body: [
        {
          _type: "block",
          style: "normal",
          listItem: "bullet",
          markDefs: [],
          children: [
            { _type: "span", text: "Read ", marks: ["strong"] },
            { _type: "span", text: "the docs", marks: [] },
          ],
        },
        {
          _type: "block",
          style: "normal",
          markDefs: [],
          children: [
            { _type: "span", text: "Look: ", marks: [] },
            { _type: "inlineMediaField", media: { type: "image" } },
          ],
        },
      ],
    };
    const result = {
      ...unkeyed,
      body: [
        {
          _type: "block",
          style: "normale",
          listItem: "punto",
          markDefs: [],
          children: [
            { _type: "span", text: "Leggi ", marks: ["forte"] },
            { _type: "span", text: "the docs", marks: [] },
          ],
        },
        { _type: "block", style: "normal", markDefs: [], children: [{ _type: "span", text: "Guarda: ", marks: [] }] },
      ],
    };
    const { document, keptPaths } = mergeTranslation(unkeyed, result);
    const [first, second] = (document as Mutable).body;

    assert.equal(first.style, "normal");
    assert.equal(first.listItem, "bullet");
    assert.deepEqual(first.children, (unkeyed as Mutable).body[0].children, "an invented mark keeps the English block whole");
    assert.deepEqual(second, (unkeyed as Mutable).body[1], "an inline object without a key is never dropped");
    assert.deepEqual(keptPaths, [
      ["body", 0],
      ["body", 1],
    ]);
  });

  it("restores an inline object from the source inside an accepted block", () => {
    const result = translated();

    blocks(result)[1].children[1].media = { type: "image", image: { asset: { _ref: "image-evil" } } };

    const { document } = mergeTranslation(source(), result);
    const block = blocks(document as Mutable)[1];

    assert.equal(block.children[0].text, "Guarda: ");
    assert.equal(block.children[1].media.image.asset._ref, "image-1");
  });

  it("restores a URL, path, email or asset id even where a field holds copy", () => {
    const links: TranslationDocument = {
      _id: "site",
      _type: "site",
      footer: {
        note: "https://example.com/terms",
        path: "/legal/terms",
        contact: "hello@example.com",
        badge: "image-0123456789abcdef-10x10-png",
      },
    };
    const result = {
      ...links,
      footer: {
        note: "https://example.it/termini",
        path: "/legale/termini",
        contact: "ciao@example.com",
        badge: "image-fedcba9876543210-10x10-png",
      },
    };
    const { document, stats } = mergeTranslation(links, result);

    assert.deepEqual(document.footer, links.footer);
    assert.deepEqual(stats, { translated: 0, keptInEnglish: 0, guarded: 4, partial: false });
  });

  it("rejects a type change on a string and keeps the person's name", () => {
    const person: TranslationDocument = { _id: "p", _type: "person", name: "Ada Lovelace", role: "Engineer" };
    const { document, stats } = mergeTranslation(person, { ...person, name: "Ada Amorevole", role: { text: "Ingegnere" } });

    assert.equal(document.name, "Ada Lovelace");
    assert.equal(document.role, "Engineer");
    assert.deepEqual(stats, { translated: 0, keptInEnglish: 1, guarded: 2, partial: false });
  });

  it("flags a partial translation once more than three strings come back unchanged", () => {
    const { stats } = mergeTranslation(source(), {});

    assert.equal(stats.translated, 0);
    assert.equal(stats.keptInEnglish, 10);
    assert.equal(stats.partial, true);
  });
});

describe("mergeTranslation: inline objects and annotations", () => {
  function article(): TranslationDocument {
    return {
      _id: "launch",
      _type: "article",
      content: [
        {
          _key: "b1",
          _type: "block",
          style: "normal",
          markDefs: [{ _key: "l1", _type: "linkField", type: "external", external: "https://example.com/docs" }],
          children: [
            { _key: "c1", _type: "span", text: "Model your ", marks: [] },
            { _key: "c2", _type: "span", text: "content", marks: ["l1"] },
          ],
        },
        {
          _key: "b2",
          _type: "block",
          style: "normal",
          markDefs: [],
          children: [
            { _key: "c3", _type: "span", text: "", marks: [] },
            { _key: "i1", _type: "inlineNoteField", note: "A short aside" },
          ],
        },
      ],
    };
  }

  function answer(): Mutable {
    const result: Mutable = structuredClone(article());

    result.content[0].children = [
      { _key: "c1", _type: "span", text: "Modella il tuo ", marks: [] },
      { _key: "c2", _type: "span", text: "contenuto", marks: ["l1"] },
    ];
    result.content[1].children[1].note = "Una breve nota";

    return result;
  }

  it("translates an inline object's copy as a leaf of its own, beside the block's text", () => {
    const { document, stats } = mergeTranslation(article(), answer());
    const [first, second] = (document as Mutable).content;

    assert.equal(first.children[0].text, "Modella il tuo ");
    assert.deepEqual(second.children[1], { _key: "i1", _type: "inlineNoteField", note: "Una breve nota" });
    assert.deepEqual(stats, { translated: 2, keptInEnglish: 0, guarded: 0, partial: false });
  });

  it("keeps a link annotation and an inline object's type as the source has them", () => {
    const hostile = answer();

    hostile.content[0].markDefs[0].external = "https://evil.example/";
    hostile.content[1].children[1]._type = "linkField";

    const { document } = mergeTranslation(article(), hostile);
    const [first, second] = (document as Mutable).content;
    const original = article() as Mutable;

    assert.deepEqual(first.markDefs, original.content[0].markDefs);
    assert.equal(second.children[1]._type, "inlineNoteField");
  });

  it("still takes a translated inline object when another block is kept in English", () => {
    const result = answer();

    result.content[0].children[1].marks = ["strong"];

    const { document, keptPaths } = mergeTranslation(article(), result);
    const [first, second] = (document as Mutable).content;

    assert.equal(first.children[0].text, "Model your ");
    assert.equal(second.children[1].note, "Una breve nota");
    assert.deepEqual(keptPaths, [["content", { _key: "b1" }]]);
  });

  it("keeps an inline object in English when the answer leaves it out, and counts it", () => {
    const result = answer();

    result.content[1] = { ...result.content[1], children: [result.content[1].children[0]] };

    const { document, keptPaths, stats } = mergeTranslation(article(), result);

    assert.equal((document as Mutable).content[1].children[1].note, "A short aside");
    assert.deepEqual(
      keptPaths.map((path) => JSON.stringify(path)),
      [JSON.stringify(["content", { _key: "b2" }, "children", { _key: "i1" }, "note"])]
    );
    assert.equal(stats.translated, 1);
  });
});

describe("mergeTranslation: an annotation `TRANSLATED_MARKS` lists", () => {
  listTranslatedMark("glossaryField");

  function glossary(): TranslationDocument {
    return {
      _id: "launch",
      _type: "article",
      content: [
        {
          _key: "b1",
          _type: "block",
          style: "normal",
          markDefs: [
            { _key: "l1", _type: "linkField", type: "external", external: "https://example.com/docs" },
            { _key: "g1", _type: "glossaryField", term: "Headless", type: "external" },
          ],
          children: [
            { _key: "c1", _type: "span", text: "Model your ", marks: ["g1"] },
            { _key: "c2", _type: "span", text: "content", marks: ["l1"] },
          ],
        },
      ],
    };
  }

  function glossaryAnswer(): Mutable {
    const result: Mutable = structuredClone(glossary());

    result.content[0].children = [
      { _key: "c1", _type: "span", text: "Modella il tuo ", marks: ["g1"] },
      { _key: "c2", _type: "span", text: "contenuto", marks: ["l1"] },
    ];
    result.content[0].markDefs[1].term = "Senza testa";

    return result;
  }

  it("takes its translated copy by `_key`, beside the block's text", () => {
    const { document, stats } = mergeTranslation(glossary(), glossaryAnswer());
    const [block] = (document as Mutable).content;

    assert.equal(block.children[0].text, "Modella il tuo ");
    assert.deepEqual(block.markDefs[1], { _key: "g1", _type: "glossaryField", term: "Senza testa", type: "external" });
    assert.deepEqual(stats, { translated: 2, keptInEnglish: 0, guarded: 0, partial: false });
  });

  it("restores its protected keys, a link's values and a changed `_type` from the source", () => {
    const relinked = glossaryAnswer();
    const retyped = glossaryAnswer();

    relinked.content[0].markDefs[0].external = "https://evil.example/";
    relinked.content[0].markDefs[1].type = "internal";
    retyped.content[0].markDefs[1]._type = "linkField";

    const [relinkedBlock] = (mergeTranslation(glossary(), relinked).document as Mutable).content;
    const [retypedBlock] = (mergeTranslation(glossary(), retyped).document as Mutable).content;
    const [original] = (glossary() as Mutable).content;

    assert.deepEqual(relinkedBlock.markDefs, [original.markDefs[0], { ...original.markDefs[1], term: "Senza testa" }]);
    assert.deepEqual(retypedBlock.markDefs, original.markDefs);
  });
});
