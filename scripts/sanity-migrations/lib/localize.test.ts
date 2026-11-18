import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluate, parse } from "groq-js";
import type { RawDocument } from "../../trim-features/language-removal";
import {
  buildLocalizableAssetsQuery,
  buildLocalizableDocumentsQuery,
  localizeStrings,
  planAssetLocalization,
  planFieldLocalization,
} from "./localize";

// Fixture locales stand on their own: `en` is the default here whatever LOCALES holds.
const FIELDS = { articleCategory: ["name"], person: ["role", "title"] };

async function run(query: string, dataset: unknown[], params: Record<string, unknown> = {}) {
  const value = await evaluate(parse(query, { params }), { dataset, params });

  return value.get();
}

describe("localizeStrings", () => {
  it("turns each plain string into its default arm, an empty one included, and leaves objects and other values", () => {
    const patch = localizeStrings(
      { _id: "a", _rev: "r1", name: "News", role: "", title: { en: "Done" }, count: 3 },
      ["name", "role", "title", "count"],
      "en"
    );

    assert.deepEqual(patch, { id: "a", rev: "r1", fields: ["name", "role"], set: { name: { en: "News" }, role: { en: "" } } });
  });

  it("has nothing to do once a document is localized", () => {
    assert.equal(localizeStrings({ _id: "a", name: { en: "News", fr: "Actualités" } }, ["name"], "en"), undefined);
  });
});

describe("planFieldLocalization", () => {
  it("converts only the fields listed for each type, on every copy", () => {
    const documents: RawDocument[] = [
      { _id: "category", _type: "articleCategory", name: "News", title: "not listed" },
      { _id: "drafts.category", _type: "articleCategory", name: "News draft" },
      { _id: "versions.r1.person", _type: "person", role: "Editor" },
      { _id: "page", _type: "page", name: "not listed" },
      { _id: "odd", _type: "constructor", name: "prototype key" },
    ];

    assert.deepEqual(
      planFieldLocalization(documents, FIELDS, "en").map(({ id, set }) => [id, set]),
      [
        ["category", { name: { en: "News" } }],
        ["drafts.category", { name: { en: "News draft" } }],
        ["versions.r1.person", { role: { en: "Editor" } }],
      ]
    );
  });
});

describe("planAssetLocalization", () => {
  it("converts the text the media library localizes", () => {
    const assets: RawDocument[] = [
      { _id: "image-a", altText: "A cat", title: { en: "Cat" }, description: "On a mat", creditLine: "Jo" },
      { _id: "image-b", altText: { en: "Done" } },
    ];

    assert.deepEqual(planAssetLocalization(assets, "en"), [
      {
        id: "image-a",
        rev: undefined,
        fields: ["altText", "description", "creditLine"],
        set: { altText: { en: "A cat" }, description: { en: "On a mat" }, creditLine: { en: "Jo" } },
      },
    ]);
  });
});

describe("the queries", () => {
  it("read only documents with a plain-string field, every copy", async () => {
    const dataset = [
      { _id: "category", _type: "articleCategory", _rev: "r1", name: "News", slug: { current: "news" } },
      { _id: "drafts.category", _type: "articleCategory", _rev: "r2", name: { en: "News" } },
      { _id: "person", _type: "person", role: "Editor" },
      { _id: "page", _type: "page", name: "not listed" },
    ];
    const found = (await run(buildLocalizableDocumentsQuery(FIELDS), dataset, { types: Object.keys(FIELDS) })) as RawDocument[];

    assert.deepEqual(found, [
      { _id: "category", _rev: "r1", _type: "articleCategory", name: "News", role: null, title: null },
      { _id: "person", _rev: null, _type: "person", name: null, role: "Editor", title: null },
    ]);
  });

  it("read only assets with plain-string text", async () => {
    const dataset = [
      { _id: "image-a", _type: "sanity.imageAsset", altText: "A cat" },
      { _id: "file-b", _type: "sanity.fileAsset", title: "Report" },
      { _id: "image-c", _type: "sanity.imageAsset", altText: { en: "Done" } },
      { _id: "image-d", _type: "sanity.imageAsset" },
      { _id: "page", _type: "page", altText: "not an asset" },
    ];
    const found = (await run(buildLocalizableAssetsQuery(), dataset)) as RawDocument[];

    assert.deepEqual(
      found.map(({ _id }) => _id),
      ["image-a", "file-b"]
    );
  });

  it("refuse a field name that is not an identifier, and read nothing when no field is listed", async () => {
    assert.throws(() => buildLocalizableDocumentsQuery({ person: ["role) || true || (x"] }), /unexpected field name/);
    assert.deepEqual(await run(buildLocalizableDocumentsQuery({}), []), []);
  });
});
