// What a translation may change, decided from a document's values alone so the server needs no Studio schema.
// fields.test.ts walks the real schema and fails when these lists stop covering it.

import { AI_TRANSLATION_FIELD, TRANSLATION_EXCLUDED_FIELDS } from "../constants";
import type { PathSegment } from "../translation-references";

/** Never translated wherever they sit: enums, slugs, URLs, link targets, tokens, dates, and containers holding only those. */
export const PROTECTED_KEYS: ReadonlySet<string> = new Set([
  "type",
  "theme",
  "aspectRatio",
  "uri",
  "slug",
  "sectionHash",
  "external",
  "sourceUrl",
  "videoUrl",
  "email",
  "phone",
  "paramsHref",
  "internal",
  "sectionTarget",
  "color",
  "publishedAt",
  "stateMachine",
  "language",
  "appMedia",
  "media",
]);

/** Annotations whose fields are copy (a tooltip's term, say), merged by `_key`; every other mark definition is the source's. */
export const TRANSLATED_MARKS: ReadonlySet<string> = new Set<string>();

/** Every decorator a rich text block in the schema allows; an agent span may carry only these and the block's own annotations. */
export const DECORATORS: ReadonlySet<string> = new Set(["strong", "em", "code", "sup"]);

const SEO_TEXT = [
  ["seoMetadata", "title"],
  ["seoMetadata", "description"],
] as const;

/** Conditionally hidden copy per type, `[]` for any array item: Agent Actions skip it unless a request opens its keyed path. */
export const CONDITIONAL_PATHS: Readonly<Record<string, readonly (readonly string[])[]>> = {
  site: SEO_TEXT,
  page: [["title"], ...SEO_TEXT],
  blog: SEO_TEXT,
  article: SEO_TEXT,
  legalPage: SEO_TEXT,
  person: SEO_TEXT,
  // PLOP: Add Conditional Paths
};

/** Kept as written on one type: a person's name is a name, not copy. */
export const TYPE_EXCLUDED_FIELDS: Readonly<Record<string, readonly string[]>> = {
  person: ["name"],
};

/** Top-level fields Translate never sees and the guard copies from the source: set by the write, or kept as written. */
export function translationExcludes(type: string): string[] {
  return [
    ...new Set(["language", "uri", AI_TRANSLATION_FIELD, ...TRANSLATION_EXCLUDED_FIELDS, ...(TYPE_EXCLUDED_FIELDS[type] ?? [])]),
  ];
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isProtectedKey(key: string): boolean {
  return key.startsWith("_") || PROTECTED_KEYS.has(key);
}

const OPAQUE_TYPES = new Set(["reference", "image", "file", "mux.video", "slug"]);

/** A reference, an asset or a slug: copied as it is, whatever it holds. */
export function isOpaque(value: Record<string, unknown>): boolean {
  return typeof value._ref === "string" || value.asset !== undefined || OPAQUE_TYPES.has(String(value._type));
}

export type Span = { _type: "span"; _key?: string; text: string; marks?: string[] };

export type Block = {
  _type: "block";
  _key?: string;
  children: Record<string, unknown>[];
  markDefs?: { _key?: string }[];
  [field: string]: unknown;
};

export function isBlock(value: unknown): value is Block {
  return isPlainObject(value) && value._type === "block" && Array.isArray(value.children);
}

export function isSpan(value: unknown): value is Span {
  return isPlainObject(value) && value._type === "span" && typeof value.text === "string";
}

export function blockText(block: Block): string {
  return block.children
    .filter(isSpan)
    .map(({ text }) => text)
    .join("");
}

const MACHINE_STRINGS = [
  /^(?:https?|mailto|tel|sms|ftp|data):\S+$/i,
  /^\/\/\S+$/,
  /^[/?#]\S*$/,
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  /^(?:image|file)-[0-9a-f]{12,}(?:-\d+x\d+)?-[a-z0-9]+$/i,
  /^\d{4}-\d{2}-\d{2}(?:T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/,
  /^[^\p{L}]*$/u,
];

/** A URL, a path, an email address, an asset id, a date, or text with no letters: never sent back translated. */
export function isMachineString(value: string): boolean {
  const trimmed = value.trim();

  return MACHINE_STRINGS.some((pattern) => pattern.test(trimmed));
}

export function isTranslatableText(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && !isMachineString(value);
}

export type TranslatableLeaf = { path: PathSegment[]; kind: "string" | "block"; text: string };

export function itemSegment(item: unknown, index: number): PathSegment {
  return isPlainObject(item) && typeof item._key === "string" ? { _key: item._key } : index;
}

/** An annotation listed in `TRANSLATED_MARKS`: its fields are copy, unlike a link's or a colour's. */
export function isTranslatedMark(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value) && TRANSLATED_MARKS.has(String(value._type));
}

export function collectLeaves(
  value: unknown,
  path: PathSegment[],
  key: string,
  leaves: TranslatableLeaf[] = []
): TranslatableLeaf[] {
  if (isProtectedKey(key)) {
    return leaves;
  }

  if (typeof value === "string") {
    if (isTranslatableText(value)) {
      leaves.push({ path, kind: "string", text: value });
    }

    return leaves;
  }

  // The spans are one leaf; an inline object or a translated annotation in the block holds leaves of its own.
  if (isBlock(value)) {
    const text = blockText(value);

    if (isTranslatableText(text)) {
      leaves.push({ path, kind: "block", text });
    }

    value.children.forEach((child, index) => {
      if (!isSpan(child)) {
        collectLeaves(child, [...path, "children", itemSegment(child, index)], "children", leaves);
      }
    });

    (value.markDefs ?? []).forEach((markDef, index) => {
      if (isTranslatedMark(markDef)) {
        collectLeaves(markDef, [...path, "markDefs", itemSegment(markDef, index)], "markDefs", leaves);
      }
    });

    return leaves;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      collectLeaves(item, [...path, itemSegment(item, index)], key, leaves);
    });

    return leaves;
  }

  if (isPlainObject(value) && !isOpaque(value)) {
    for (const [childKey, child] of Object.entries(value)) {
      collectLeaves(child, [...path, childKey], childKey, leaves);
    }
  }

  return leaves;
}

/** Every string, text and rich text block a translation of `document` changes, in document order; a block counts once. */
export function translatableLeaves(document: Record<string, unknown>): TranslatableLeaf[] {
  const excluded = new Set(translationExcludes(String(document._type ?? "")));
  const leaves: TranslatableLeaf[] = [];

  for (const [key, value] of Object.entries(document)) {
    if (!excluded.has(key)) {
      collectLeaves(value, [key], key, leaves);
    }
  }

  return leaves;
}

export function countWords(leaves: readonly TranslatableLeaf[]): number {
  return leaves.reduce((total, { text }) => total + (text.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu)?.length ?? 0), 0);
}

type SchemaDefinition = {
  name?: string;
  type?: string;
  fields?: SchemaDefinition[];
  of?: SchemaDefinition[];
  options?: { list?: unknown };
  hidden?: unknown;
  readOnly?: unknown;
  marks?: { decorators?: { value?: string }[]; annotations?: SchemaDefinition[] };
};

export type SchemaField = { documentType: string; path: string; name: string; covered: boolean };

export type SchemaFieldRules = {
  enums: SchemaField[];
  slugs: SchemaField[];
  /** String-valued fields that are not copy: URLs, dates, and named string types (a colour token). */
  machine: SchemaField[];
  /** Copy inside a protected container that is not itself a protected key: the guard would never let it be translated. */
  hiddenCopy: string[];
  /** Every copy field and rich text block the guard lets through, so a test can measure how deep Translate must reach. */
  copy: { documentType: string; path: string[] }[];
  decorators: string[];
  /** Per type, every conditional field or ancestor on the way to unprotected copy; `[]` marks an array. */
  conditionalPaths: Record<string, string[][]>;
};

const BUILT_IN_TYPES = new Set([
  "string",
  "text",
  "number",
  "boolean",
  "object",
  "array",
  "block",
  "span",
  "reference",
  "crossDatasetReference",
  "image",
  "file",
  "slug",
  "url",
  "date",
  "datetime",
  "email",
  "geopoint",
  "document",
]);

const MACHINE_TYPES = new Set(["url", "date", "datetime", "email"]);

const OPAQUE_SCHEMA_TYPES = new Set(["reference", "crossDatasetReference", "image", "file", "slug"]);

/** Sanity's decorators for a block that names none. */
const DEFAULT_DECORATORS = ["strong", "em", "code", "underline", "strike-through"];

type Walk = {
  documentType: string;
  path: string[];
  /** Inside a protected key, a reference or an asset: restored whole. */
  guarded: boolean;
  /** Inside a top-level excluded field: never sent, never reported. */
  excluded: boolean;
  conditional: string[][];
  seen: ReadonlySet<string>;
};

/** Reads the Studio schema definitions: what `PROTECTED_KEYS`, `DECORATORS` and `CONDITIONAL_PATHS` must cover. */
export function schemaFieldRules(schemaTypes: readonly unknown[], documentTypes: readonly string[]): SchemaFieldRules {
  const definitions = schemaTypes as SchemaDefinition[];
  const named = new Map(definitions.filter(({ name }) => name).map((definition) => [definition.name as string, definition]));
  const rules: SchemaFieldRules = {
    enums: [],
    slugs: [],
    machine: [],
    hiddenCopy: [],
    copy: [],
    decorators: [],
    conditionalPaths: {},
  };
  const decorators = new Set<string>();
  const conditional = new Map<string, Map<string, string[]>>();

  function resolve(definition: SchemaDefinition, seen: ReadonlySet<string>) {
    const type = definition.type ?? "";
    const base = !BUILT_IN_TYPES.has(type) && !seen.has(type) ? named.get(type) : undefined;
    const alias = base !== undefined && (base.type === "string" || base.type === "text");

    return {
      kind: base?.type ?? type,
      alias,
      unknown: !BUILT_IN_TYPES.has(type) && base === undefined,
      list: definition.options?.list ?? base?.options?.list,
      conditional: [definition, base].some((item) => typeof item?.hidden === "function" || typeof item?.readOnly === "function"),
      fields: definition.fields ?? base?.fields,
      of: definition.of ?? base?.of,
      seen: base ? new Set([...seen, type]) : seen,
    };
  }

  function report(list: SchemaField[], walk: Walk, name: string) {
    if (!walk.excluded) {
      list.push({
        documentType: walk.documentType,
        path: [...walk.path, name].join("."),
        name,
        covered: walk.guarded || isProtectedKey(name),
      });
    }
  }

  function addCopy(walk: Walk, path: string[], conditionalPath: string[][]) {
    const paths = conditional.get(walk.documentType) ?? new Map<string, string[]>();

    rules.copy.push({ documentType: walk.documentType, path });

    for (const ancestor of conditionalPath) {
      paths.set(ancestor.join("."), ancestor);
    }

    conditional.set(walk.documentType, paths);
  }

  function visitBlock(block: SchemaDefinition, walk: Walk) {
    for (const decorator of block.marks?.decorators?.map(({ value }) => value) ?? DEFAULT_DECORATORS) {
      if (decorator) {
        decorators.add(decorator);
      }
    }

    if (!walk.guarded && !walk.excluded) {
      addCopy(walk, [...walk.path, "children", "[]", "text"], walk.conditional);
    }

    // Mark definitions and inline objects are array items, so their paths carry `[]` like any other.
    for (const annotation of block.marks?.annotations ?? []) {
      const guarded = walk.guarded || !TRANSLATED_MARKS.has(annotation.name ?? "");

      visitMembers([annotation], { ...walk, guarded, path: [...walk.path, "markDefs", "[]"] });
    }

    visitMembers(block.of ?? [], { ...walk, path: [...walk.path, "children", "[]"] });
  }

  function visitMembers(members: readonly SchemaDefinition[], walk: Walk) {
    for (const member of members) {
      if (member.type === "block") {
        visitBlock(member, walk);
        continue;
      }

      const resolved = resolve(member, walk.seen);
      const guarded = walk.guarded || resolved.unknown || OPAQUE_SCHEMA_TYPES.has(resolved.kind);

      // A list of enum strings: the guard reads its items under the array's own name.
      if (resolved.list !== undefined && !walk.excluded) {
        const name = walk.path.at(-2) ?? "";

        rules.enums.push({ documentType: walk.documentType, path: walk.path.join("."), name, covered: walk.guarded });
      }

      visitFields(resolved.fields ?? [], { ...walk, guarded, seen: resolved.seen });
    }
  }

  function visitFields(fields: readonly SchemaDefinition[], walk: Walk) {
    for (const field of fields) {
      const name = field.name ?? "";
      const resolved = resolve(field, walk.seen);
      const path = [...walk.path, name];
      const conditionalPath = resolved.conditional ? [...walk.conditional, path] : walk.conditional;

      if (resolved.list !== undefined) {
        report(rules.enums, walk, name);
      }

      if (resolved.kind === "slug") {
        report(rules.slugs, walk, name);
      }

      if (MACHINE_TYPES.has(resolved.kind) || (resolved.alias && resolved.list === undefined)) {
        report(rules.machine, walk, name);
      }

      const isCopy = (resolved.kind === "string" || resolved.kind === "text") && resolved.list === undefined && !resolved.alias;
      const guarded = walk.guarded || isProtectedKey(name);

      if (isCopy && !walk.excluded && walk.guarded && !isProtectedKey(name)) {
        rules.hiddenCopy.push(`${walk.documentType}.${path.join(".")}`);
      }

      if (isCopy && !walk.excluded && !guarded) {
        addCopy(walk, path, conditionalPath);
      }

      const next: Walk = {
        ...walk,
        path,
        guarded: guarded || resolved.unknown || OPAQUE_SCHEMA_TYPES.has(resolved.kind),
        conditional: conditionalPath,
        seen: resolved.seen,
      };

      visitFields(resolved.fields ?? [], next);
      visitMembers(resolved.of ?? [], { ...next, path: [...path, "[]"] });
    }
  }

  for (const documentType of documentTypes) {
    const document = named.get(documentType);

    if (!document) {
      continue;
    }

    const excluded = new Set(translationExcludes(documentType));

    conditional.set(documentType, new Map());

    for (const field of document.fields ?? []) {
      const walk: Walk = {
        documentType,
        path: [],
        guarded: false,
        excluded: excluded.has(field.name ?? ""),
        conditional: [],
        seen: new Set([documentType]),
      };

      visitFields([field], walk);
    }
  }

  rules.decorators = [...decorators].sort();
  rules.conditionalPaths = Object.fromEntries(
    [...conditional].map(([documentType, paths]) => [
      documentType,
      [...paths.values()].sort((a, b) => a.join(".").localeCompare(b.join("."))),
    ])
  );

  return rules;
}
