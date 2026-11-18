import "../schemas/test-env";
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { I18N_DOCUMENT_TYPES } from "../constants";
import {
  CONDITIONAL_PATHS,
  countWords,
  DECORATORS,
  isMachineString,
  isProtectedKey,
  type SchemaFieldRules,
  schemaFieldRules,
  translatableLeaves,
  translationExcludes,
} from "./fields";
import { AI_TRANSLATE_MAX_PATH_DEPTH } from "./request";
import { listTranslatedMark } from "./test-fixtures";

// Read from the definitions rather than `sanity-schema.json`, which records no `hidden` or `readOnly`.
let rules: SchemaFieldRules;

before(async () => {
  const { schemaTypes } = (await import("../schemas")) as { schemaTypes: unknown[] };

  rules = schemaFieldRules(schemaTypes, I18N_DOCUMENT_TYPES);
});

const uncovered = (fields: SchemaFieldRules["enums"]) =>
  fields.filter(({ covered }) => !covered).map(({ documentType, path }) => `${documentType}.${path}`);

describe("the Studio schema against the guard's lists", () => {
  it("protects every field with an options.list by name: a new enum is never sent back translated", () => {
    assert.ok(rules.enums.length > 0, "the walk found no enum at all");
    assert.deepEqual(uncovered(rules.enums), []);
  });

  it("protects every slug field by name", () => {
    assert.ok(rules.slugs.some(({ name }) => name === "sectionHash"));
    assert.deepEqual(uncovered(rules.slugs), []);
  });

  it("protects every URL, date and named string type (a colour token) by name", () => {
    assert.deepEqual(uncovered(rules.machine), []);
  });

  it("hides no copy inside a protected container, where the guard would never let it be translated", () => {
    assert.deepEqual(rules.hiddenCopy, []);
  });

  it("allows exactly the decorators the rich text blocks define", () => {
    assert.deepEqual(rules.decorators, [...DECORATORS].sort());
  });

  it("opens exactly the conditionally hidden copy of each translated type", () => {
    const sectionContent = "pageBuilder.sectionsArray.[].sectionContent.";
    const sectionField = (path: string) => path.slice(sectionContent.length).split(".")[0];

    for (const type of I18N_DOCUMENT_TYPES) {
      const found = (rules.conditionalPaths[type] ?? []).map((path) => path.join("."));
      const foundSectionFields = new Set(found.filter((path) => path.startsWith(sectionContent)).map(sectionField));
      // A trimmed section takes its fields with it and leaves its rules opening nothing; a field still in the schema stays exact.
      const listed = (CONDITIONAL_PATHS[type] ?? [])
        .map((path) => path.join("."))
        .filter((path) => !path.startsWith(sectionContent) || foundSectionFields.has(sectionField(path)) || found.includes(path));

      assert.deepEqual(found.sort(), listed.sort(), type);
    }
  });

  it("reaches the deepest copy within Translate's path depth, a block's span text counted to the span", () => {
    const deepest = Math.max(...rules.copy.map(({ path }) => path.length));

    assert.ok(rules.copy.length > 0, "the walk found no copy");
    assert.ok(deepest <= AI_TRANSLATE_MAX_PATH_DEPTH, `copy at depth ${deepest}`);
  });
});

describe("schemaFieldRules", () => {
  const schema = [
    {
      name: "doc",
      type: "document",
      fields: [
        { name: "variant", type: "string", options: { list: ["a", "b"] } },
        { name: "handle", type: "slug" },
        { name: "theme", type: "string", options: { list: ["dark"] } },
        { name: "internal", type: "object", fields: [{ name: "note", type: "string" }] },
        { name: "teaser", type: "string", hidden: () => true },
        { name: "tags", type: "array", of: [{ type: "string", options: { list: ["news", "guide"] } }] },
        { name: "type", type: "array", of: [{ type: "string", options: { list: ["covered"] } }] },
        {
          name: "items",
          type: "array",
          of: [{ type: "object", fields: [{ name: "label", type: "string", hidden: () => true }] }],
        },
        {
          name: "body",
          type: "array",
          of: [
            {
              type: "block",
              marks: {
                decorators: [{ value: "strong" }],
                annotations: [
                  { name: "linkField", type: "object", fields: [{ name: "label", type: "string" }] },
                  { name: "glossaryField", type: "object", fields: [{ name: "term", type: "string" }] },
                ],
              },
              of: [{ name: "inlineNoteField", type: "object", fields: [{ name: "note", type: "string", hidden: () => true }] }],
            },
          ],
        },
      ],
    },
  ];

  it("reports a new enum or slug name the guard does not know, and copy hidden in a protected container", () => {
    const found = schemaFieldRules(schema, ["doc"]);

    assert.deepEqual(uncovered(found.enums), ["doc.variant", "doc.tags.[]"]);
    assert.deepEqual(uncovered(found.slugs), ["doc.handle"]);
    // An annotation holding copy is reported until `TRANSLATED_MARKS` lists it.
    assert.deepEqual(found.hiddenCopy, ["doc.internal.note", "doc.body.[].markDefs.[].label", "doc.body.[].markDefs.[].term"]);
    assert.deepEqual(
      found.conditionalPaths.doc?.map((path) => path.join(".")),
      ["body.[].children.[].note", "items.[].label", "teaser"]
    );
  });

  it("walks a block's annotations and inline objects as keyed array items, and measures its spans to their text", () => {
    const copy = schemaFieldRules(schema, ["doc"]).copy.map(({ path }) => path.join("."));

    assert.ok(copy.includes("body.[].children.[].text"));
    assert.ok(copy.includes("body.[].children.[].note"));
    assert.ok(!copy.includes("body.[].markDefs.[].label"));
    assert.ok(!copy.includes("body.[].markDefs.[].term"));
  });

  describe("once `TRANSLATED_MARKS` lists an annotation", () => {
    listTranslatedMark("glossaryField");

    it("reads its fields as copy, and stops reporting them as hidden", () => {
      const found = schemaFieldRules(schema, ["doc"]);

      assert.ok(found.copy.some(({ path }) => path.join(".") === "body.[].markDefs.[].term"));
      assert.deepEqual(found.hiddenCopy, ["doc.internal.note", "doc.body.[].markDefs.[].label"]);
    });
  });
});

describe("isProtectedKey", () => {
  it("leaves `markDefs` open, so an annotation `TRANSLATED_MARKS` lists is never restored whole", () => {
    assert.equal(isProtectedKey("markDefs"), false);
    assert.equal(isProtectedKey("sectionHash"), true);
    assert.equal(isProtectedKey("_key"), true);
  });
});

describe("translationExcludes", () => {
  it("leaves the language, the URI, the record and derived fields out, and a person's name", () => {
    for (const field of ["language", "uri", "aiTranslation", "agentMarkdown"]) {
      assert.ok(translationExcludes("page").includes(field), field);
    }

    assert.ok(translationExcludes("person").includes("name"));
    assert.ok(!translationExcludes("page").includes("name"));
  });
});

describe("isMachineString", () => {
  it("knows URLs, paths, emails, asset ids, dates and text without letters", () => {
    for (const value of [
      "https://example.com/about",
      "mailto:hello@example.com",
      "tel:+390000",
      "/about",
      "?modal=contact",
      "#pricing",
      "hello@example.com",
      "image-0123456789abcdef0123456789abcdef01234567-1200x800-jpg",
      "2026-10-19",
      "2026-10-19T21:20:50Z",
      "+39 02 1234 5678",
      "42",
      "  ",
    ]) {
      assert.equal(isMachineString(value), true, value);
    }
  });

  it("leaves copy alone, a colon or a slash inside a sentence included", () => {
    for (const value of [
      "Note: read this",
      "Contact us",
      "Before / after",
      "Q&A",
      "Email us at hello@example.com today",
      "2 minutes",
    ]) {
      assert.equal(isMachineString(value), false, value);
    }
  });
});

describe("translatableLeaves", () => {
  const page = {
    _id: "about",
    _type: "page",
    _rev: "r1",
    language: "en",
    title: "About",
    uri: { _type: "slug", current: "/about" },
    agentMarkdown: { content: "# About" },
    seoMetadata: { title: "About us", description: "Who we are.", sourceUrl: "https://example.com/about", noIndex: false },
    pageBuilder: {
      sectionsArray: [
        {
          _key: "s1",
          _type: "textSectionField",
          sectionSettings: { sectionTitle: "Intro", sectionHash: { _type: "slug", current: "intro" }, fullBleed: true },
          sectionContent: {
            headline: "Model content, not pages",
            appRichText: [
              {
                _key: "b1",
                _type: "block",
                style: "normal",
                markDefs: [{ _key: "l1", _type: "linkField", type: "external", external: "https://sanity.io" }],
                children: [
                  { _key: "c1", _type: "span", text: "Read ", marks: [] },
                  { _key: "c2", _type: "span", text: "the docs", marks: ["l1"] },
                ],
              },
              {
                _key: "m1",
                _type: "mediaBlock",
                caption: "A caption",
                appMedia: { type: "rive", riveOptions: { stateMachine: "Idle" }, image: { asset: { _ref: "image-1" } } },
              },
            ],
            appLink: {
              type: "internal",
              internal: { link: { _type: "reference", _ref: "contact" }, sectionTarget: "form" },
              email: "hello@example.com",
              customText: "Get in touch",
            },
          },
        },
      ],
    },
  };

  it("finds every string, text and block of copy, a section's title included, a block counted once, and nothing else", () => {
    const leaves = translatableLeaves(page);

    assert.deepEqual(
      leaves.map(({ kind, text }) => `${kind}:${text}`),
      [
        "string:About",
        "string:About us",
        "string:Who we are.",
        "string:Intro",
        "string:Model content, not pages",
        "block:Read the docs",
        "string:A caption",
        "string:Get in touch",
      ]
    );
    assert.deepEqual(leaves[5]?.path, [
      "pageBuilder",
      "sectionsArray",
      { _key: "s1" },
      "sectionContent",
      "appRichText",
      { _key: "b1" },
    ]);
  });

  it("leaves a person's name to the person", () => {
    const leaves = translatableLeaves({ _id: "p", _type: "person", name: "Ada Lovelace", role: "Engineer" });

    assert.deepEqual(
      leaves.map(({ text }) => text),
      ["Engineer"]
    );
  });

  it("finds an inline object's copy, never a link's values or an annotation `TRANSLATED_MARKS` does not list", () => {
    const leaves = translatableLeaves({
      _id: "launch",
      _type: "article",
      content: [
        {
          _key: "b1",
          _type: "block",
          markDefs: [
            { _key: "l1", _type: "linkField", type: "external", external: "https://example.com/docs" },
            { _key: "g1", _type: "glossaryField", term: "Headless" },
          ],
          children: [
            { _key: "c1", _type: "span", text: "Model your content", marks: ["g1", "l1"] },
            { _key: "i1", _type: "inlineNoteField", note: "A short aside" },
          ],
        },
      ],
    });

    assert.deepEqual(
      leaves.map(({ path, kind, text }) => [
        path.map((segment) => (typeof segment === "object" ? segment._key : segment)).join("."),
        kind,
        text,
      ]),
      [
        ["content.b1", "block", "Model your content"],
        ["content.b1.children.i1.note", "string", "A short aside"],
      ]
    );
  });

  describe("once `TRANSLATED_MARKS` lists an annotation", () => {
    listTranslatedMark("glossaryField");

    it("finds its copy as a leaf of its own under its key, and still never a link's values", () => {
      const leaves = translatableLeaves({
        _id: "launch",
        _type: "article",
        content: [
          {
            _key: "b1",
            _type: "block",
            markDefs: [
              { _key: "l1", _type: "linkField", type: "external", external: "https://example.com/docs" },
              { _key: "g1", _type: "glossaryField", term: "Headless", type: "external" },
            ],
            children: [{ _key: "c1", _type: "span", text: "Model your content", marks: ["g1", "l1"] }],
          },
        ],
      });

      assert.deepEqual(
        leaves.map(({ path, text }) => [JSON.stringify(path), text]),
        [
          [JSON.stringify(["content", { _key: "b1" }]), "Model your content"],
          [JSON.stringify(["content", { _key: "b1" }, "markDefs", { _key: "g1" }, "term"]), "Headless"],
        ]
      );
    });
  });

  it("counts words across leaves", () => {
    assert.equal(countWords(translatableLeaves(page)), 19);
  });
});
