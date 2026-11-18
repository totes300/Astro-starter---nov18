// Two content hashes per document: its translatable text, and everything else a translation carries over (its layout).
// Both run over a normalized projection, so the Studio filling in defaults or reordering keys never reads as an edit.

import { getPublishedId } from "@sanity/client/csm";
import { AI_TRANSLATION_FIELD, TRANSLATION_EXCLUDED_FIELDS } from "../constants";
import { collectReferences } from "../translation-references";
import { SYSTEM_FIELDS } from "../translation-stub";
import {
  type Block,
  blockText,
  isBlock,
  isOpaque,
  isPlainObject,
  isProtectedKey,
  isSpan,
  isTranslatableText,
  isTranslatedMark,
  translatableLeaves,
  translationExcludes,
} from "./fields";

export type Fingerprint = { textHash: string; layoutHash: string };

/** Set per copy (ids, language, URI, the record) or derived from the content: never part of a hash. */
const UNHASHED_FIELDS = new Set([
  ...SYSTEM_FIELDS,
  "_id",
  "language",
  "uri",
  AI_TRANSLATION_FIELD,
  ...TRANSLATION_EXCLUDED_FIELDS,
]);

/** Document references are re-pointed per language and the share-image source moves with the URI; an asset's `_ref` stays. */
const UNHASHED_KEYS = new Set(["_ref", "_weak", "_strengthenOnPublish", "sourceUrl"]);

const FNV_OFFSET = BigInt("0xcbf29ce484222325");
const FNV_PRIME = BigInt("0x100000001b3");
const MASK_64 = BigInt("0xffffffffffffffff");

/** FNV-1a, 64 bit, over the UTF-8 bytes: a change detector, not a security boundary. */
export function fnv1a64(text: string): string {
  let hash = FNV_OFFSET;

  for (const byte of new TextEncoder().encode(text)) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & MASK_64;
  }

  return hash.toString(16).padStart(16, "0");
}

function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null || value === "" || value === false) {
    return true;
  }

  if (Array.isArray(value)) {
    return value.length === 0;
  }

  return isPlainObject(value) && Object.keys(value).length === 0;
}

/** Sorted keys, NFC text, no empty values (`false` included); `keepText` off drops the copy a translation rewrites. */
function normalize(value: unknown, keepText: boolean, key: string): unknown {
  if (typeof value === "string") {
    return keepText || !isTranslatableText(value) ? value.normalize("NFC") : undefined;
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => (isBlock(item) ? normalizeBlock(item, keepText) : normalize(item, keepText, key)))
      .filter((item) => !isEmpty(item));
  }

  if (!isPlainObject(value)) {
    return value;
  }

  const keepAll = keepText || isOpaque(value);
  const entries = Object.keys(value)
    .filter((childKey) => !UNHASHED_KEYS.has(childKey) || (childKey === "_ref" && key === "asset"))
    .sort()
    .map((childKey): [string, unknown] => [childKey, normalize(value[childKey], keepAll || isProtectedKey(childKey), childKey)])
    .filter(([, child]) => !isEmpty(child));

  return Object.fromEntries(entries);
}

/** A block is one text leaf: its spans keep their keys and marks, and lose their text when the block is copy. */
function normalizeBlock(block: Block, keepText: boolean): unknown {
  const dropText = !keepText && isTranslatableText(blockText(block));
  const children = block.children.map((child) => {
    if (isSpan(child)) {
      return dropText ? { ...child, text: undefined } : child;
    }

    // An inline object's own copy is a leaf of its own, so the layout loses it as it loses span text.
    return normalize(child, keepText, "children");
  });
  const markDefs = block.markDefs?.map((markDef) =>
    isTranslatedMark(markDef) ? normalize(markDef, keepText, "markDefs") : markDef
  );

  return normalize({ ...block, children, ...(markDefs ? { markDefs } : {}) }, true, "");
}

/** The translatable text by path: moving a section changes the layout hash only, rewording one changes this. */
export function textHash(document: Record<string, unknown>): string {
  const texts = translatableLeaves(document)
    .map(({ path, text }): [string, string] => [JSON.stringify(path), text.normalize("NFC")])
    .sort(([a], [b]) => (a < b ? -1 : 1));

  return fnv1a64(JSON.stringify(texts));
}

/** Everything a translation keeps from its source except the text: structure, keys, marks, media, settings. */
export function layoutHash(document: Record<string, unknown>): string {
  const excluded = new Set(translationExcludes(String(document._type ?? "")));
  const projection = Object.fromEntries(
    Object.keys(document)
      .filter((key) => !UNHASHED_FIELDS.has(key))
      .sort()
      .map((key): [string, unknown] => [key, normalize(document[key], excluded.has(key) || isProtectedKey(key), key)])
      .filter(([, value]) => !isEmpty(value))
  );

  return fnv1a64(JSON.stringify(projection));
}

export function fingerprint(document: Record<string, unknown>): Fingerprint {
  return { textHash: textHash(document), layoutHash: layoutHash(document) };
}

/** Two published ids that are one page or person in different languages (one translation group), or the same id. */
export type SameDocument = (a: string, b: string) => boolean;

function referencesByPlace(document: Record<string, unknown>): Map<string, string> {
  return new Map(
    collectReferences(document)
      .filter(({ path }) => path[path.length - 1] !== "asset")
      .map(({ path, ref }) => [JSON.stringify(path), getPublishedId(ref)])
  );
}

/** The hashes leave document `_ref`s out, so this names each place both link from, `copy` elsewhere, variants aside. */
export function movedReferences(
  source: Record<string, unknown>,
  copy: Record<string, unknown>,
  sameDocument: SameDocument = (a, b) => a === b
): string[] {
  const from = referencesByPlace(source);
  const to = referencesByPlace(copy);

  // A link only one side has is a layout change: the copy's own shows in its layout hash, the English's is no edit.
  return [...to.keys()].filter((place) => {
    const before = from.get(place);
    const after = to.get(place);

    return before !== undefined && after !== undefined && !sameDocument(before, after);
  });
}
