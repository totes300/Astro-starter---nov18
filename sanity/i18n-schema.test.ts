import "./schemas/test-env";
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { I18N_DOCUMENT_TYPES, LOCALIZED_FIELDS } from "./constants";
import { DEFAULT_LOCALE } from "./i18n";

// Read from the definitions rather than `sanity-schema.json`, so it holds in either locale mode and right after a trim.
type FieldDefinition = { name: string; type?: string; fields?: FieldDefinition[] };
type TypeDefinition = { name: string; type: string; fields?: FieldDefinition[] };

let documents = new Map<string, FieldDefinition[]>();

before(async () => {
  const { schemaTypes } = (await import("./schemas")) as { schemaTypes: TypeDefinition[] };

  documents = new Map(schemaTypes.filter(({ type }) => type === "document").map(({ name, fields }) => [name, fields ?? []]));
});

const fieldOf = (type: string, name: string) => documents.get(type)?.find((field) => field.name === name);

/** A registry path: one dot nests the field in an object (`seoMetadata.title`). */
const fieldAt = (type: string, path: string) => {
  const [first, ...rest] = path.split(".");

  return rest.reduce<FieldDefinition | undefined>(
    (field, name) => field?.fields?.find((child) => child.name === name),
    first ? fieldOf(type, first) : undefined
  );
};

describe("translated document types", () => {
  it("are exactly the registered types carrying a language field", () => {
    const withLanguage = [...documents.keys()].filter((type) => fieldOf(type, "language"));

    assert.deepEqual(withLanguage.sort(), [...I18N_DOCUMENT_TYPES].sort());
  });
});

describe("fields translated in place", () => {
  for (const [type, fields] of Object.entries<readonly string[]>(LOCALIZED_FIELDS)) {
    it(`${type} carries ${fields.join(", ")} with a default locale arm`, () => {
      assert.ok(documents.has(type), `no registered "${type}" document type`);
      assert.ok(!fieldOf(type, "language"), `"${type}" is translated in place, so it takes no language field`);

      for (const name of fields) {
        const field = fieldAt(type, name);

        assert.equal(field?.type, "object", `"${type}.${name}" is missing or not an object`);
        assert.ok(
          field?.fields?.some((arm) => arm.name === DEFAULT_LOCALE),
          `"${type}.${name}" has no "${DEFAULT_LOCALE}" arm`
        );
      }
    });
  }
});
