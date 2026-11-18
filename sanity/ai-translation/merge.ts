// The guard between a paid Translate result and the dataset: only translated copy is taken, everything else is the source's.

import type { PathSegment } from "../translation-references";
import type { TranslationDocument } from "../translation-stub";
import {
  type Block,
  blockText,
  collectLeaves,
  DECORATORS,
  isBlock,
  isMachineString,
  isOpaque,
  isPlainObject,
  isProtectedKey,
  isSpan,
  isTranslatableText,
  isTranslatedMark,
  itemSegment,
  translationExcludes,
} from "./fields";

/** More strings than this coming back untranslated marks the result "partially translated". */
export const PARTIAL_TRANSLATION_THRESHOLD = 3;

export type MergeStats = {
  translated: number;
  keptInEnglish: number;
  /** Values the agent changed that the guard put back: keys, links, enums, URLs, dropped or invented items. */
  guarded: number;
  partial: boolean;
};

export type MergeResult = {
  document: TranslationDocument;
  stats: MergeStats;
  keptPaths: PathSegment[][];
  guardedPaths: PathSegment[][];
};

type Tally = { translated: number; keptPaths: PathSegment[][]; guardedPaths: PathSegment[][] };

function isEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function keep(tally: Tally, source: unknown, path: PathSegment[], key: string) {
  for (const leaf of collectLeaves(source, path, key)) {
    tally.keptPaths.push(leaf.path);
  }
}

/** The source's value, counted as guarded when the agent sent back something else. */
function restore<T>(tally: Tally, source: T, result: unknown, path: PathSegment[]): T {
  if (result !== undefined && !isEqual(source, result)) {
    tally.guardedPaths.push(path);
  }

  return structuredClone(source);
}

function keyedItem(items: unknown, key: string): unknown {
  return Array.isArray(items) ? items.find((item) => isPlainObject(item) && item._key === key) : undefined;
}

/** A block with its inline objects and translated annotations cut to their keys: what the block rule compares, their copy aside. */
function blockShell(value: unknown): unknown {
  if (!isBlock(value)) {
    return value;
  }

  const shell = (item: Record<string, unknown>) => ({ _key: item._key, _type: item._type });

  return {
    ...value,
    children: value.children.map((child) => (isSpan(child) ? child : shell(child))),
    ...(Array.isArray(value.markDefs)
      ? { markDefs: value.markDefs.map((markDef) => (isTranslatedMark(markDef) ? shell(markDef) : markDef)) }
      : {}),
  };
}

/** The source block with each inline object and translated annotation merged by `_key` like any object; every other mark stays as is. */
function mergeBlockObjects(tally: Tally, source: Block, result: unknown, path: PathSegment[]): Block {
  const answer = isBlock(result) ? result : undefined;
  const children = source.children.map((child, index) => {
    if (isSpan(child)) {
      return structuredClone(child);
    }

    if (typeof child._key !== "string") {
      keep(tally, child, [...path, "children", index], "children");

      return structuredClone(child);
    }

    const childPath = [...path, "children", { _key: child._key }];

    return mergeValue(tally, child, keyedItem(answer?.children, child._key), childPath, "children") as Record<string, unknown>;
  });
  const markDefs = source.markDefs?.map((markDef, index) => {
    if (!isTranslatedMark(markDef)) {
      return structuredClone(markDef);
    }

    if (typeof markDef._key !== "string") {
      keep(tally, markDef, [...path, "markDefs", index], "markDefs");

      return structuredClone(markDef);
    }

    const markPath = [...path, "markDefs", { _key: markDef._key }];

    return mergeValue(tally, markDef, keyedItem(answer?.markDefs, markDef._key), markPath, "markDefs") as { _key?: string };
  });

  return { ...structuredClone(source), children, ...(markDefs ? { markDefs } : {}) };
}

function uniqueKey(preferred: unknown, taken: Set<string>, index: number): string {
  if (typeof preferred === "string" && preferred !== "" && !taken.has(preferred)) {
    return preferred;
  }

  let key = `t${index}`;

  for (let suffix = 1; taken.has(key); suffix += 1) {
    key = `t${index}x${suffix}`;
  }

  return key;
}

/** The agent's children, or undefined unless they are spans with known marks plus the source's own inline objects. */
function acceptedChildren(source: Block, result: unknown): Record<string, unknown>[] | undefined {
  if (!isBlock(result)) {
    return undefined;
  }

  // An inline object with no key cannot be matched, so the agent could drop it unnoticed.
  if (source.children.some((child) => !isSpan(child) && typeof child._key !== "string")) {
    return undefined;
  }

  const annotations = new Set((source.markDefs ?? []).map(({ _key }) => _key).filter((key): key is string => Boolean(key)));
  const inline = new Map(
    source.children
      .filter((child) => !isSpan(child) && typeof child._key === "string")
      .map((child) => [child._key as string, child])
  );
  const linked = new Set(
    source.children.filter(isSpan).flatMap(({ marks }) => (marks ?? []).filter((mark) => annotations.has(mark)))
  );
  const taken = new Set(inline.keys());
  const placed = new Set<string>();
  const stillLinked = new Set<string>();
  const children: Record<string, unknown>[] = [];

  for (const [index, child] of result.children.entries()) {
    if (isSpan(child)) {
      const marks = child.marks ?? [];

      if (
        !Array.isArray(marks) ||
        !marks.every((mark) => typeof mark === "string" && (DECORATORS.has(mark) || annotations.has(mark)))
      ) {
        return undefined;
      }

      const key = uniqueKey(child._key, taken, index);

      taken.add(key);

      for (const mark of marks.filter((value) => annotations.has(value))) {
        stillLinked.add(mark);
      }

      children.push({ _type: "span", _key: key, text: child.text, marks: [...marks] });
      continue;
    }

    const original = isPlainObject(child) && typeof child._key === "string" ? inline.get(child._key) : undefined;

    if (!original || original._type !== child._type || placed.has(child._key as string)) {
      return undefined;
    }

    placed.add(child._key as string);
    children.push(structuredClone(original));
  }

  const complete = placed.size === inline.size && [...linked].every((key) => stillLinked.has(key));
  const text = children
    .filter(isSpan)
    .map((span) => span.text)
    .join("");

  return complete && text.trim() !== "" ? children : undefined;
}

/** Per block, not per span: a re-spanned sentence is taken whole when valid, or the whole source block stays. */
function mergeBlock(tally: Tally, source: Block, result: unknown, path: PathSegment[]): Block {
  const sourceText = blockText(source);
  const merged = mergeBlockObjects(tally, source, result, path);

  if (!isTranslatableText(sourceText)) {
    restore(tally, blockShell(source), blockShell(result), path);

    return merged;
  }

  const children = acceptedChildren(source, result);
  const translated = children ? blockText({ ...source, children }) : sourceText;

  if (!children || translated === sourceText) {
    tally.keptPaths.push(path);

    if (!isBlock(result)) {
      restore(tally, source, result, path);
    }

    return merged;
  }

  tally.translated += 1;

  const objects = new Map(merged.children.filter((child) => !isSpan(child)).map((child) => [child._key, child]));

  return { ...merged, children: children.map((child) => (isSpan(child) ? child : (objects.get(child._key) ?? child))) };
}

function mergeArray(tally: Tally, source: unknown[], result: unknown, path: PathSegment[], key: string): unknown[] {
  if (!Array.isArray(result)) {
    keep(tally, source, path, key);

    return restore(tally, source, result, path);
  }

  const keyed = source.every((item) => isPlainObject(item) && typeof item._key === "string");

  if (!keyed) {
    if (result.length !== source.length) {
      keep(tally, source, path, key);

      return restore(tally, source, result, path);
    }

    return source.map((item, index) => mergeValue(tally, item, result[index], [...path, index], key));
  }

  const byKey = new Map<string, unknown>();

  result.forEach((item, index) => {
    const itemKey = isPlainObject(item) && typeof item._key === "string" ? item._key : undefined;

    if (itemKey === undefined || byKey.has(itemKey) || !source.some((own) => (own as { _key: string })._key === itemKey)) {
      tally.guardedPaths.push([...path, itemSegment(item, index)]);
    } else {
      byKey.set(itemKey, item);
    }
  });

  return source.map((item) => {
    const itemPath = [...path, { _key: (item as { _key: string })._key }];
    const match = byKey.get((item as { _key: string })._key);

    if (match === undefined) {
      keep(tally, item, itemPath, key);

      return structuredClone(item);
    }

    return mergeValue(tally, item, match, itemPath, key);
  });
}

function mergeObject(tally: Tally, source: Record<string, unknown>, result: unknown, path: PathSegment[], key: string) {
  if (isOpaque(source)) {
    return restore(tally, source, result, path);
  }

  if (!isPlainObject(result) || result._type !== source._type) {
    keep(tally, source, path, key);

    return restore(tally, source, result, path);
  }

  const merged: Record<string, unknown> = {};

  for (const [childKey, child] of Object.entries(source)) {
    merged[childKey] = mergeValue(tally, child, result[childKey], [...path, childKey], childKey);
  }

  for (const childKey of Object.keys(result)) {
    if (!(childKey in source) && !childKey.startsWith("_")) {
      tally.guardedPaths.push([...path, childKey]);
    }
  }

  return merged;
}

function mergeValue(tally: Tally, source: unknown, result: unknown, path: PathSegment[], key: string): unknown {
  if (isProtectedKey(key)) {
    return restore(tally, source, result, path);
  }

  if (Array.isArray(source)) {
    return mergeArray(tally, source, result, path, key);
  }

  // Every block, keyed or not, so its style, list and marks are never taken from the agent span by span.
  if (isBlock(source)) {
    return mergeBlock(tally, source, result, path);
  }

  if (isPlainObject(source)) {
    return mergeObject(tally, source, result, path, key);
  }

  if (!isTranslatableText(source)) {
    return restore(tally, source, result, path);
  }

  if (typeof result !== "string" || result.trim() === "" || result === source || isMachineString(result)) {
    tally.keptPaths.push(path);

    return typeof result === "string" ? source : restore(tally, source, result, path);
  }

  tally.translated += 1;

  return result;
}

/** Walks the SOURCE: the agent's text is taken only at translatable leaves, and its structure never is. */
export function mergeTranslation(source: TranslationDocument, result: unknown): MergeResult {
  const tally: Tally = { translated: 0, keptPaths: [], guardedPaths: [] };
  const excluded = new Set(translationExcludes(source._type));
  const translated = isPlainObject(result) ? result : {};
  const document = {} as TranslationDocument;

  for (const [key, value] of Object.entries(source)) {
    if (key.startsWith("_")) {
      document[key] = structuredClone(value);
    } else if (excluded.has(key)) {
      document[key] = restore(tally, value, translated[key], [key]);
    } else {
      document[key] = mergeValue(tally, value, translated[key], [key], key);
    }
  }

  for (const key of Object.keys(translated)) {
    if (!(key in source) && !key.startsWith("_") && !excluded.has(key)) {
      tally.guardedPaths.push([key]);
    }
  }

  return {
    document,
    stats: {
      translated: tally.translated,
      keptInEnglish: tally.keptPaths.length,
      guarded: tally.guardedPaths.length,
      partial: tally.keptPaths.length > PARTIAL_TRANSLATION_THRESHOLD,
    },
    keptPaths: tally.keptPaths,
    guardedPaths: tally.guardedPaths,
  };
}
