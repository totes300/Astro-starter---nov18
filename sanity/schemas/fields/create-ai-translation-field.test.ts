import "../test-env";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import { AI_TRANSLATION_FIELD, I18N_DOCUMENT_TYPES, TRANSLATION_EXCLUDED_FIELDS } from "../../constants";

type Field = { name: string; type?: string; hidden?: unknown; readOnly?: unknown; options?: Record<string, unknown> };
type SchemaType = { name: string; type: string; fields?: Field[] };

let factory: typeof import("./create-ai-translation-field");
let studio: typeof import("../../i18n-studio");
let schemaTypes: SchemaType[];

before(async () => {
  factory = await import("./create-ai-translation-field");
  studio = await import("../../i18n-studio");
  ({ schemaTypes } = (await import("..")) as unknown as { schemaTypes: SchemaType[] });
});

const ROOT = join(import.meta.dirname, "..", "..", "..");

describe("the AI translation record", () => {
  it("is a hidden, read-only object carrying the source and both hashes on each side", () => {
    const field = factory.createAiTranslationField() as unknown as Field & { fields: Field[] };

    assert.equal(field.name, AI_TRANSLATION_FIELD);
    assert.equal(field.type, "object");
    assert.equal(field.hidden, true);
    assert.equal(field.readOnly, true);
    assert.deepEqual(
      field.fields.map(({ name, type }) => [name, type]),
      [
        ["sourceId", "string"],
        ["sourceLanguage", "string"],
        ["sourceRev", "string"],
        ["sourceTextHash", "string"],
        ["sourceLayoutHash", "string"],
        ["textHash", "string"],
        ["layoutHash", "string"],
        ["translatedAt", "datetime"],
        ["requestedBy", "string"],
      ]
    );
  });

  it("lands on every translated type, and on nothing else", () => {
    const wrapped = schemaTypes.map(studio.withAiTranslationRecord);

    for (const type of wrapped) {
      const hasRecord = (type.fields ?? []).some((field) => field.name === AI_TRANSLATION_FIELD);

      assert.equal(hasRecord, I18N_DOCUMENT_TYPES.includes(type.name) && type.type === "document", type.name);
    }

    assert.equal(
      wrapped.filter(({ fields = [] }) => fields.some((field) => field.name === AI_TRANSLATION_FIELD)).length,
      I18N_DOCUMENT_TYPES.length
    );
  });

  it("is added once, however often the wrapper runs", () => {
    const [translated] = schemaTypes.filter(({ name }) => I18N_DOCUMENT_TYPES.includes(name));
    assert.ok(translated);
    const twice = studio.withAiTranslationRecord(studio.withAiTranslationRecord(translated));

    assert.equal((twice.fields ?? []).filter((field) => field.name === AI_TRANSLATION_FIELD).length, 1);
  });

  it("is dropped from a plugin-made translation, like every excluded field", () => {
    assert.ok(TRANSLATION_EXCLUDED_FIELDS.includes(AI_TRANSLATION_FIELD));

    for (const type of schemaTypes.filter(({ name }) => I18N_DOCUMENT_TYPES.includes(name))) {
      const record = studio
        .withTranslationExclusions(studio.withAiTranslationRecord(type))
        .fields?.find((field) => field.name === AI_TRANSLATION_FIELD);

      assert.deepEqual(record?.options?.documentInternationalization, { exclude: true }, type.name);
    }
  });

  it("is composed into the Studio's schema, inside the exclusions", () => {
    const config = readFileSync(join(ROOT, "sanity.config.ts"), "utf8");

    assert.match(config, /withTranslationExclusions\(withAiTranslationRecord\(type\)\)/);
  });
});
