// The bundled export in memory: read it, filter it to the configured languages, pack it again.
// Plain ustar and gzip, so a filtered import needs no `tar` binary and no extracted folder.

import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  filterSeedToLocales,
  isEmptyPlan,
  type LanguageRemovalPlan,
  type LocaleConfig,
  type RawDocument,
  type SeedAssets,
} from "../trim-features/language-removal";

/** The one archive `sanity:dataset-import` filters to the configured languages; backups restore verbatim. */
export const SEED_ARCHIVE = "seed/seed-dataset.tar.gz";

export type TarEntry = { name: string; kind: "file" | "directory"; data: Buffer; mode: number; mtime: number };

export type SeedContent = { root: string; documents: RawDocument[]; assets: SeedAssets };

/** `archive` is undefined when the plan changes nothing, so the original file is imported as it is. */
export type FilteredSeed = { plan: LanguageRemovalPlan; archive?: Buffer };

const BLOCK = 512;

/** tar pads an archive to whole records of 20 blocks; stricter readers expect that length. */
const RECORD = BLOCK * 20;

const DATA_FILE = "data.ndjson";

const ASSETS_FILE = "assets.json";

function text(block: Buffer, start: number, length: number): string {
  return (
    block
      .subarray(start, start + length)
      .toString("utf8")
      .split("\0")[0] ?? ""
  );
}

function octal(block: Buffer, start: number, length: number): number {
  const value = text(block, start, length).trim();

  return value ? Number.parseInt(value, 8) : 0;
}

/** The header's byte sum with its own checksum field read as spaces, as tar defines it. */
function checksum(header: Buffer): number {
  let sum = 0;

  for (const [index, byte] of header.entries()) {
    sum += index >= 148 && index < 156 ? 0x20 : byte;
  }

  return sum;
}

/** The `path` record of a pax extended header, which names the entry that follows it. */
function paxPath(data: Buffer): string | undefined {
  let offset = 0;
  let path: string | undefined;

  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const length = Number.parseInt(data.subarray(offset, space).toString("utf8"), 10);

    if (space === -1 || !Number.isInteger(length) || length <= 0) {
      break;
    }

    const record = data.subarray(space + 1, offset + length - 1).toString("utf8");
    const equals = record.indexOf("=");

    if (record.slice(0, equals) === "path") {
      path = record.slice(equals + 1);
    }

    offset += length;
  }

  return path;
}

/** Files and folders of an uncompressed tar, long names (ustar prefix, pax, GNU) resolved. Anything else throws. */
export function readTar(archive: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let longName: string | undefined;
  let offset = 0;

  while (offset + BLOCK <= archive.length) {
    const header = archive.subarray(offset, offset + BLOCK);

    if (header.every((byte) => byte === 0)) {
      break;
    }

    if (octal(header, 148, 8) !== checksum(header)) {
      throw new Error(`The archive has a corrupt header at byte ${offset}.`);
    }

    const size = octal(header, 124, 12);
    const type = text(header, 156, 1);
    const start = offset + BLOCK;

    if (start + size > archive.length) {
      throw new Error(`The archive ends inside ${text(header, 0, 100)}.`);
    }

    const data = archive.subarray(start, start + size);
    // Only POSIX ustar has a name prefix; GNU tar keeps other fields at that offset.
    const prefix = header.subarray(257, 263).toString("latin1") === "ustar\0" ? text(header, 345, 155) : "";
    const name = longName ?? (prefix ? `${prefix}/${text(header, 0, 100)}` : text(header, 0, 100));

    offset = start + Math.ceil(size / BLOCK) * BLOCK;

    if (type === "g") {
      continue;
    }

    if (type === "x" || type === "L") {
      longName = type === "x" ? (paxPath(data) ?? longName) : text(data, 0, data.length);
      continue;
    }

    longName = undefined;

    if (type !== "0" && type !== "" && type !== "5") {
      throw new Error(`${name} is neither a file nor a folder (tar type ${type}), which an export never holds.`);
    }

    entries.push({
      name,
      kind: type === "5" ? "directory" : "file",
      data,
      mode: octal(header, 100, 8),
      mtime: octal(header, 136, 12),
    });
  }

  return entries;
}

function writeOctal(block: Buffer, value: number, start: number, length: number): void {
  block.write(`${value.toString(8).padStart(length - 1, "0")}\0`, start, length, "latin1");
}

/** A ustar name: up to 100 bytes, or a folder prefix of up to 155 bytes and the rest. */
function splitName(name: string): { prefix: string; base: string } {
  if (Buffer.byteLength(name) <= 100) {
    return { prefix: "", base: name };
  }

  // A folder's own trailing slash is never the split point.
  for (let slash = name.lastIndexOf("/", name.length - 2); slash > 0; slash = name.lastIndexOf("/", slash - 1)) {
    const prefix = name.slice(0, slash);
    const base = name.slice(slash + 1);

    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(base) <= 100) {
      return { prefix, base };
    }
  }

  throw new Error(`${name} is too long for a tar header.`);
}

function headerFor(entry: TarEntry): Buffer {
  const header = Buffer.alloc(BLOCK);
  const { prefix, base } = splitName(entry.name);

  header.write(base, 0, 100, "utf8");
  writeOctal(header, entry.mode, 100, 8);
  writeOctal(header, 0, 108, 8);
  writeOctal(header, 0, 116, 8);
  writeOctal(header, entry.kind === "file" ? entry.data.length : 0, 124, 12);
  writeOctal(header, entry.mtime, 136, 12);
  header.write(entry.kind === "file" ? "0" : "5", 156, 1, "latin1");
  header.write("ustar\0", 257, 6, "latin1");
  header.write("00", 263, 2, "latin1");
  header.write(prefix, 345, 155, "utf8");
  header.write(`${checksum(header).toString(8).padStart(6, "0")}\0 `, 148, 8, "latin1");

  return header;
}

/** A POSIX ustar archive of `entries`, in their order. */
export function writeTar(entries: readonly TarEntry[]): Buffer {
  const parts = entries.flatMap((entry) => {
    if (entry.kind === "directory") {
      return [headerFor(entry)];
    }

    const padding = Math.ceil(entry.data.length / BLOCK) * BLOCK - entry.data.length;

    return [headerFor(entry), entry.data, Buffer.alloc(padding)];
  });
  const body = Buffer.concat([...parts, Buffer.alloc(BLOCK * 2)]);

  return Buffer.concat([body, Buffer.alloc(Math.ceil(body.length / RECORD) * RECORD - body.length)]);
}

export function readTarGz(archive: Buffer): TarEntry[] {
  return readTar(gunzipSync(archive));
}

export function writeTarGz(entries: readonly TarEntry[]): Buffer {
  return gzipSync(writeTar(entries));
}

function dataEntryOf(entries: readonly TarEntry[]): TarEntry {
  const found = entries.filter(({ name, kind }) => kind === "file" && (name === DATA_FILE || name.endsWith(`/${DATA_FILE}`)));
  const [entry] = found;

  if (!entry || found.length !== 1) {
    throw new Error(`An export holds one ${DATA_FILE}; this archive holds ${found.length}.`);
  }

  return entry;
}

/** The export's documents and its asset metadata (`assets.json`, keyed by asset id), under its one root folder. */
export function readSeed(entries: readonly TarEntry[]): SeedContent {
  const data = dataEntryOf(entries);
  const root = data.name.slice(0, -DATA_FILE.length);
  const assets = entries.find(({ name, kind }) => kind === "file" && name === `${root}${ASSETS_FILE}`);
  const documents = data.data
    .toString("utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as RawDocument);

  return { root, documents, assets: assets ? (JSON.parse(assets.data.toString("utf8")) as SeedAssets) : {} };
}

/** The archive reduced to `config.keep` by the language-removal plan. Throws as `filterSeedToLocales` does. */
export function filterSeedArchive(archive: Buffer, config: LocaleConfig): FilteredSeed {
  const entries = readTarGz(archive);
  const seed = readSeed(entries);
  const filtered = filterSeedToLocales(seed.documents, seed.assets, config);

  if (isEmptyPlan(filtered.plan)) {
    return { plan: filtered.plan };
  }

  const replaced = new Map([
    [`${seed.root}${DATA_FILE}`, Buffer.from(filtered.documents.map((document) => `${JSON.stringify(document)}\n`).join(""))],
    [`${seed.root}${ASSETS_FILE}`, Buffer.from(JSON.stringify(filtered.assets))],
  ]);
  const next = entries.map((entry) => {
    const data = entry.kind === "file" ? replaced.get(entry.name) : undefined;

    return data ? { ...entry, data } : entry;
  });

  return { plan: filtered.plan, archive: writeTarGz(next) };
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** One summary line: what the filter keeps and what it leaves out. */
export function describeSeedFilter(plan: LanguageRemovalPlan): string {
  const kept = plan.keep.join(", ");

  if (isEmptyPlan(plan)) {
    return `${kept}, as configured (the seed holds nothing else)`;
  }

  const languages = [...new Set(plan.groups.map(({ language }) => language))];
  const left = [
    plan.groups.length > 0 ? `${plural(plan.groups.length, "document")} in ${languages.join(", ")}` : "",
    plan.metadataDeletes.length > 0 ? plural(plan.metadataDeletes.length, "translation group") : "",
  ].filter(Boolean);
  const trimmed = [
    plan.metadataPatches.length > 0 ? plural(plan.metadataPatches.length, "translation group") : "",
    plan.fieldCleanups.length > 0 ? plural(plan.fieldCleanups.length, "shared document") : "",
    plan.assetCleanups.length > 0 ? plural(plan.assetCleanups.length, "asset") : "",
  ].filter(Boolean);
  const parts = [
    left.length > 0 ? `leaves out ${left.join(" and ")}` : "",
    trimmed.length > 0 ? `keeps only ${kept} on ${trimmed.join(", ")}` : "",
  ].filter(Boolean);

  return `${kept} (${parts.join("; ")})`;
}

/** What a filtered import loses that a person may want to know about before it runs. */
export function seedFilterWarnings(plan: LanguageRemovalPlan): string[] {
  const lost = plan.assetCleanups.filter((cleanup) => cleanup.lost.length > 0);

  return [
    ...lost.map(({ id, lost: fields }) => `${id}: ${fields.join(", ")} has no ${plan.defaultLocale} text, so it is left out.`),
    ...plan.dangling.map((holder) => `${holder._type} ${holder.uri ?? holder._id} links to a document that is left out.`),
    ...plan.skipped.map(({ id, reason }) => `${id}: ${reason}`),
  ];
}

/** Whether `file` is the bundled seed, by real path, so a symlink or another spelling of it counts too. */
export function isBundledSeed(file: string, cwd: string = process.cwd()): boolean {
  const seed = resolve(cwd, SEED_ARCHIVE);
  const target = resolve(cwd, file);

  return existsSync(seed) && existsSync(target) && realpathSync(seed) === realpathSync(target);
}

/** Writes a filtered seed to a temporary folder that goes on any exit, a failed import or Ctrl-C included. */
export function stageSeedArchive(archive: Buffer): string {
  const folder = mkdtempSync(join(tmpdir(), "seed-import-"));
  const remove = () => rmSync(folder, { recursive: true, force: true });

  process.once("exit", remove);
  process.once("SIGINT", () => process.exit(130));
  writeFileSync(join(folder, basename(SEED_ARCHIVE)), archive);

  return join(folder, basename(SEED_ARCHIVE));
}
