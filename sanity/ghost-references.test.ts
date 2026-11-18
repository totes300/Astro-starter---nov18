import "./schemas/test-env";
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { I18N_DOCUMENT_TYPES } from "./constants";
import { GUARDED_REFERENCES, type GuardedReference } from "./ghost-references";

// A reference into a translated type can reach a ghost: a document in a language the site no longer serves.
// Every such field needs a read the app guards; the app's ghost guard test watches each path in GUARDED_REFERENCES.

type Reference = { owner: string; path: string; to: readonly string[] };

/** Registered by the translation plugin over `I18N_DOCUMENT_TYPES` (`i18n-studio.ts`), so `schemaTypes` never lists it. */
const PLUGIN_REFERENCES: Reference[] = [{ owner: "translation.metadata", path: "translations[].value", to: I18N_DOCUMENT_TYPES }];

type Definition = Record<string, unknown>;

const isDefinition = (value: unknown): value is Definition => typeof value === "object" && value !== null;

function targetsOf(to: unknown): string[] {
  return (Array.isArray(to) ? to : [to]).flatMap((target) =>
    isDefinition(target) && typeof target.type === "string" ? [target.type] : []
  );
}

/** Every reference field under `definition`, by its path of field names; array members add `[]` to their array's name. */
function referencesIn(definition: unknown, owner: string, path: string[]): Reference[] {
  if (Array.isArray(definition)) {
    return definition.flatMap((child) => referencesIn(child, owner, path));
  }

  if (!isDefinition(definition)) {
    return [];
  }

  const own = definition.type === "reference" ? [{ owner, path: path.join("."), to: targetsOf(definition.to) }] : [];
  const nested = Object.entries(definition).flatMap(([key, value]) =>
    (Array.isArray(value) ? value : [value]).flatMap((child) => {
      if (key === "of" && path.length > 0) {
        return referencesIn(child, owner, [...path.slice(0, -1), `${path.at(-1)}[]`]);
      }

      const isField = isDefinition(child) && typeof child.name === "string" && typeof child.type === "string";

      return referencesIn(child, owner, isField ? [...path, String(child.name)] : path);
    })
  );

  return [...own, ...nested];
}

const covers = (entry: GuardedReference, reference: Reference) =>
  entry.owner === "*"
    ? reference.path === entry.path || reference.path.endsWith(`.${entry.path}`)
    : entry.owner === reference.owner && entry.path === reference.path;

let owners = new Set<string>();
let references: Reference[] = [];

before(async () => {
  const { schemaTypes } = (await import("./schemas")) as { schemaTypes: Definition[] };

  owners = new Set([...schemaTypes.map(({ name }) => String(name)), ...PLUGIN_REFERENCES.map(({ owner }) => owner)]);
  references = [...schemaTypes.flatMap((type) => referencesIn(type, String(type.name), [])), ...PLUGIN_REFERENCES];
});

describe("references into translated types", () => {
  it("are found where the schema declares them", () => {
    assert.ok(
      references.some(({ path }) => path.endsWith("internal.link")),
      "the link factory's reference"
    );
    assert.ok(references.every(({ path, to }) => path !== "" && to.length > 0));
  });

  it("each read through a guarded path", () => {
    const unguarded = references
      .filter(({ to }) => to.some((type) => I18N_DOCUMENT_TYPES.includes(type)))
      .filter((reference) => !GUARDED_REFERENCES.some((entry) => covers(entry, reference)))
      .map(({ owner, path, to }) => `${owner}.${path} -> ${to.join(", ")}`);

    assert.deepEqual(
      unguarded,
      [],
      "guard each read with configuredReference(), then list it in GUARDED_REFERENCES (ghost-references.ts)"
    );
  });

  it("list only fields that still exist, skipping a type a trim removed", () => {
    for (const entry of GUARDED_REFERENCES.filter(({ owner }) => owner === "*" || owners.has(owner))) {
      assert.ok(
        references.some((reference) => covers(entry, reference)),
        `${entry.owner}.${entry.path} is gone: drop it from GUARDED_REFERENCES, with the read "${entry.guardedBy}"`
      );
    }
  });
});
