import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LOCALE } from "./i18n";
import {
  buildReferencePatch,
  collectReferences,
  crossLanguageTargets,
  referencedDocumentIds,
  variantTargets,
} from "./translation-references";

const other = "xx";

const translation = {
  _id: "drafts.new",
  _type: "page",
  language: other,
  uri: { _type: "slug", current: "/about" },
  seoMetadata: { image: { asset: { _ref: "image-abc-10x10-png", _type: "reference" } } },
  pageBuilder: {
    sectionsArray: [
      {
        _key: "cta",
        _type: "ctaSection",
        links: [{ _key: "l1", type: "internal", internal: { link: { _ref: "pricing", _type: "reference", _weak: true } } }],
      },
      {
        _key: "text",
        _type: "textSection",
        link: { type: "internal", internal: { link: { _ref: "source", _type: "reference", _weak: true } } },
      },
    ],
  },
  categories: [{ _ref: "category", _type: "reference" }],
};

describe("collectReferences", () => {
  it("finds every reference with the path of the object holding it", () => {
    assert.deepEqual(collectReferences(translation), [
      { path: ["seoMetadata", "image", "asset"], ref: "image-abc-10x10-png", weak: false },
      {
        path: ["pageBuilder", "sectionsArray", { _key: "cta" }, "links", { _key: "l1" }, "internal", "link"],
        ref: "pricing",
        weak: true,
      },
      {
        path: ["pageBuilder", "sectionsArray", { _key: "text" }, "link", "internal", "link"],
        ref: "source",
        weak: true,
      },
      { path: ["categories", 0], ref: "category", weak: false },
    ]);
  });

  it("finds nothing in a document without references", () => {
    assert.deepEqual(collectReferences({ _id: "a", title: "A", list: [1, "two", null] }), []);
  });
});

describe("buildReferencePatch", () => {
  const references = collectReferences(translation);

  it("sets the _ref of each re-pointed reference by its keyed path", () => {
    const targets = new Map([
      ["pricing", "pricing-xx"],
      ["category", "category"],
    ]);

    assert.deepEqual(
      buildReferencePatch(references, ({ ref }) => targets.get(ref)),
      { 'pageBuilder.sectionsArray[_key=="cta"].links[_key=="l1"].internal.link._ref': "pricing-xx" }
    );
  });

  it("passes the whole reference, so a caller can re-point only weak ones", () => {
    const patch = buildReferencePatch(references, ({ ref, weak }) => (weak && ref === "source" ? "new" : undefined));

    assert.deepEqual(patch, { 'pageBuilder.sectionsArray[_key=="text"].link.internal.link._ref': "new" });
  });

  it("is empty when nothing resolves", () => {
    assert.deepEqual(
      buildReferencePatch(references, () => undefined),
      {}
    );
  });
});

describe("variantTargets", () => {
  it("maps every variant of a group to the published one in the language", () => {
    const targets = variantTargets(
      [
        {
          variants: [
            { id: "pricing", language: DEFAULT_LOCALE },
            { id: "pricing-xx", language: other },
          ],
        },
      ],
      other
    );

    assert.equal(targets.get("pricing"), "pricing-xx");
    assert.equal(targets.has("pricing-xx"), false);
  });

  it("maps nothing for a group without a published variant in the language", () => {
    const targets = variantTargets(
      [
        {
          variants: [
            { id: "a", language: DEFAULT_LOCALE },
            { id: "b", language: null },
          ],
        },
        { variants: null },
      ],
      other
    );

    assert.equal(targets.size, 0);
  });
});

describe("referencedDocumentIds", () => {
  it("asks for the published and draft id of each target once", () => {
    const ids = referencedDocumentIds([
      { path: ["a"], ref: "one", weak: false },
      { path: ["b"], ref: "one", weak: true },
      { path: ["c"], ref: "drafts.two", weak: true },
    ]);

    assert.deepEqual(ids, ["one", "drafts.one", "two", "drafts.two"]);
  });
});

describe("crossLanguageTargets", () => {
  it("reports each target in another language once, preferring the draft", () => {
    const targets = crossLanguageTargets(
      [
        { _id: "about", language: DEFAULT_LOCALE, label: "About" },
        { _id: "drafts.about", language: DEFAULT_LOCALE, label: "About us" },
        { _id: "pricing", language: other, label: "Pricing" },
        { _id: "legacy", language: null, label: "Legacy" },
      ],
      other
    );

    assert.deepEqual(
      targets.map(({ label }) => label),
      ["About us", "Legacy"]
    );
  });

  it("reports nothing when every target shares the language", () => {
    assert.deepEqual(crossLanguageTargets([{ _id: "pricing", language: other }], other), []);
  });
});
