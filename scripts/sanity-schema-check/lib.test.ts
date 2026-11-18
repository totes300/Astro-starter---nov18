import assert from "node:assert/strict";
import { test } from "node:test";
import { compareSchemas, parseDeployedSchema } from "./lib";

// `page` is translated, `redirect` is not; extract entries and deployed types are in their own shapes.
const extractDocument = (name: string, fields: string[]) => ({
  type: "document",
  name,
  attributes: Object.fromEntries([
    ["_id", { value: { type: "string" } }],
    ...fields.map((field) => [field, { value: { type: "string" } }]),
  ]),
});

const deployedDocument = (name: string, fields: string[]) => ({
  name,
  type: "document",
  fields: fields.map((field) => ({ name: field, type: "string" })),
});

const LOCAL = [
  extractDocument("page", ["title"]),
  extractDocument("redirect", ["from", "to"]),
  { type: "document", name: "sanity.imageAsset", attributes: { url: { value: { type: "string" } } } },
  { type: "type", name: "slug", value: { type: "object" } },
];

const DEPLOYED = [deployedDocument("page", ["title"]), deployedDocument("redirect", ["from", "to"])];

test("a deployed schema that matches has no drift, and Sanity's own asset documents are never asked for", () => {
  const result = compareSchemas({ deployed: DEPLOYED, local: LOCAL });

  assert.deepEqual(result.drift, []);
  assert.equal(result.pausesTranslation, false);
  assert.deepEqual(result.documentTypes, ["page", "redirect"]);
});

test("a type Translate with AI does not check still counts as drift, without pausing it", () => {
  const result = compareSchemas({
    deployed: [deployedDocument("page", ["title"]), deployedDocument("redirect", ["from"])],
    local: LOCAL,
  });

  assert.deepEqual(result.drift, ["redirect.to: missing from the deployed schema"]);
  assert.equal(result.pausesTranslation, false);
});

test("a translated type that differs pauses Translate with AI", () => {
  const result = compareSchemas({
    deployed: [deployedDocument("page", ["title", "legacy"]), deployedDocument("redirect", ["from", "to"])],
    local: LOCAL,
  });

  assert.deepEqual(result.drift, ["page.legacy: in the deployed schema, removed here"]);
  assert.equal(result.pausesTranslation, true);
});

test("a new document type and one removed here are both drift", () => {
  const result = compareSchemas({
    deployed: [deployedDocument("page", ["title"]), deployedDocument("blog", ["title"])],
    local: LOCAL,
  });

  assert.deepEqual(result.drift, ["blog: in the deployed schema, removed here", "redirect: not in the deployed schema"]);
});

test("parseDeployedSchema reads the stored JSON string, and nothing that is not a list of types", () => {
  assert.deepEqual(parseDeployedSchema(JSON.stringify(DEPLOYED)), DEPLOYED);
  assert.deepEqual(parseDeployedSchema(DEPLOYED), DEPLOYED);
  assert.equal(parseDeployedSchema("{not json"), undefined);
  assert.equal(parseDeployedSchema('{"name":"page"}'), undefined);
  assert.equal(parseDeployedSchema(null), undefined);
});
