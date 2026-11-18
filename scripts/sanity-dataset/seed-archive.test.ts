import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  describeSeedFilter,
  filterSeedArchive,
  isBundledSeed,
  readSeed,
  readTar,
  readTarGz,
  SEED_ARCHIVE,
  seedFilterWarnings,
  type TarEntry,
  writeTar,
  writeTarGz,
} from "./seed-archive";

// Fixture locales stand on their own: en is the default and fr is the language a filter leaves out.
const CONFIG = {
  defaultLocale: "en",
  keep: ["en"],
  i18nTypes: ["site", "page"],
  localizedFields: { articleCategory: ["name"] },
};

const ROOT = "production-export-2026-01-01t00-00-00-000z/";

const file = (name: string, data: string | Buffer, mtime = 1_700_000_000): TarEntry => ({
  name,
  kind: "file",
  data: Buffer.isBuffer(data) ? data : Buffer.from(data),
  mode: 0o644,
  mtime,
});

const folder = (name: string): TarEntry => ({ name, kind: "directory", data: Buffer.alloc(0), mode: 0o755, mtime: 0 });

const ref = (_ref: string, weak = false) => ({ _type: "reference", _ref, ...(weak ? { _weak: true } : {}) });

const row = (_key: string, language: string, target: string) => ({
  _key,
  _type: "internationalizedArrayReferenceValue",
  language,
  value: ref(target, true),
});

const DOCUMENTS = [
  { _id: "site", _type: "site", language: "en", homepage: ref("homepage") },
  { _id: "site-fr", _type: "site", language: "fr", homepage: ref("homepage-fr") },
  { _id: "homepage", _type: "page", language: "en", uri: { _type: "slug", current: "/" } },
  { _id: "homepage-fr", _type: "page", language: "fr", uri: { _type: "slug", current: "/fr" } },
  { _id: "category-a", _type: "articleCategory", name: { _type: "localizedString", en: "Modelling", fr: "Modélisation" } },
  { _id: "meta-site", _type: "translation.metadata", translations: [row("k1", "en", "site"), row("k2", "fr", "site-fr")] },
  {
    _id: "meta-home",
    _type: "translation.metadata",
    translations: [row("k3", "en", "homepage"), row("k4", "fr", "homepage-fr")],
  },
];

const ASSETS = {
  "image-1": { altText: { en: "A gradient", fr: "Un dégradé" }, size: 1 },
  "image-2": { altText: { fr: "Seulement" }, size: 2 },
  "image-3": { altText: "Plain", size: 3 },
};

const IMAGE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);

function seedArchive(documents: readonly object[] = DOCUMENTS, assets: object = ASSETS): Buffer {
  return writeTarGz([
    folder(ROOT),
    folder(`${ROOT}images/`),
    file(`${ROOT}data.ndjson`, documents.map((document) => `${JSON.stringify(document)}\n`).join("")),
    file(`${ROOT}assets.json`, JSON.stringify(assets)),
    file(`${ROOT}images/${"a".repeat(40)}-1920x1080.png`, IMAGE),
  ]);
}

function plain(entries: readonly TarEntry[]) {
  return entries.map(({ name, kind, data, mode, mtime }) => ({ name, kind, data: data.toString("base64"), mode, mtime }));
}

test("writeTar and readTar round trip files, folders, empty files and names past 100 bytes", () => {
  const entries = [
    folder(`${"d".repeat(60)}/${"e".repeat(60)}/`),
    file(`${"d".repeat(60)}/${"e".repeat(60)}/${"f".repeat(90)}.bin`, IMAGE),
    file("empty.txt", ""),
    file("exact-block.txt", "x".repeat(512)),
  ];
  const archive = writeTar(entries);

  assert.deepEqual(plain(readTar(archive)), plain(entries));
  assert.equal(archive.length % (512 * 20), 0, "padded to whole tar records");
  assert.equal(archive.subarray(257, 263).toString("latin1"), "ustar\0");
});

test("writeTar refuses a name no ustar header can hold", () => {
  assert.throws(() => writeTar([file("n".repeat(101), "")]), /too long for a tar header/);
  assert.throws(() => writeTar([file(`${"p".repeat(156)}/name`, "")]), /too long for a tar header/);
});

test("readTar takes a long name from a pax header, and from a GNU long-name entry", () => {
  const long = `${"x".repeat(150)}/${"y".repeat(150)}.txt`;
  const record = (key: string, value: string) => {
    const body = ` ${key}=${value}\n`;
    let length = body.length + 1;

    while (`${length}${body}`.length !== length) {
      length += 1;
    }

    return `${length}${body}`;
  };
  const pax = writeTar([
    { ...file("PaxHeader/short", record("mtime", "1") + record("path", long)), name: "PaxHeader/short" },
    file("short", "pax"),
  ]);
  const gnu = writeTar([file("././@LongLink", `${long}\0`), file("short", "gnu")]);

  // Retype the header entries: writeTar only writes files and folders, so the type byte is set by hand.
  for (const [archive, type] of [
    [pax, "x"],
    [gnu, "L"],
  ] as const) {
    archive.write(type, 156, 1, "latin1");
    archive.write("        ", 148, 8, "latin1");

    let sum = 0;

    for (const byte of archive.subarray(0, 512)) {
      sum += byte;
    }

    archive.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "latin1");
  }

  assert.deepEqual(
    readTar(pax).map(({ name, data }) => [name, data.toString()]),
    [[long, "pax"]]
  );
  assert.deepEqual(
    readTar(gnu).map(({ name, data }) => [name, data.toString()]),
    [[long, "gnu"]]
  );
});

test("readTar refuses a corrupt header, a truncated archive and an entry that is not a file or folder", () => {
  const archive = writeTar([file("a.txt", "x".repeat(2000))]);
  const corrupt = Buffer.from(archive);

  corrupt[0] = "b".charCodeAt(0);

  assert.throws(() => readTar(corrupt), /corrupt header at byte 0/);
  assert.throws(() => readTar(archive.subarray(0, 1024)), /ends inside a\.txt/);

  const link = Buffer.from(archive);

  link.write("2", 156, 1, "latin1");
  link.write("        ", 148, 8, "latin1");

  let sum = 0;

  for (const byte of link.subarray(0, 512)) {
    sum += byte;
  }

  link.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "latin1");

  assert.throws(() => readTar(link), /neither a file nor a folder \(tar type 2\)/);
});

test("readSeed finds the export under its root folder, with or without assets.json", () => {
  const seed = readSeed(readTarGz(seedArchive()));

  assert.equal(seed.root, ROOT);
  assert.deepEqual(
    seed.documents.map(({ _id }) => _id),
    DOCUMENTS.map(({ _id }) => _id)
  );
  assert.deepEqual(seed.assets, ASSETS);

  const bare = readSeed([file("data.ndjson", '{"_id":"a","_type":"page"}\n\n')]);

  assert.equal(bare.root, "");
  assert.deepEqual(bare.assets, {});
  assert.throws(() => readSeed([file("a/data.ndjson", ""), file("b/data.ndjson", "")]), /holds 2/);
  assert.throws(() => readSeed([file("._data.ndjson", "")]), /holds 0/);
});

test("filterSeedArchive leaves out what the configured languages do not keep, and nothing else", () => {
  const original = readTarGz(seedArchive());
  const { plan, archive } = filterSeedArchive(seedArchive(), CONFIG);

  assert.ok(archive, "a filtered archive");

  const entries = readTarGz(archive);
  const seed = readSeed(entries);

  assert.deepEqual(
    seed.documents.map(({ _id }) => _id),
    ["site", "homepage", "category-a"]
  );
  assert.deepEqual(seed.documents.find(({ _id }) => _id === "category-a")?.name, { _type: "localizedString", en: "Modelling" });
  assert.deepEqual(seed.assets, {
    "image-1": { altText: "A gradient", size: 1 },
    "image-2": { size: 2 },
    "image-3": { altText: "Plain", size: 3 },
  });
  assert.deepEqual(
    entries.map(({ name, kind, mode, mtime }) => ({ name, kind, mode, mtime })),
    original.map(({ name, kind, mode, mtime }) => ({ name, kind, mode, mtime }))
  );
  assert.deepEqual(entries.at(-1)?.data, IMAGE);
  assert.deepEqual(plan.removed, ["fr"]);
  assert.deepEqual(plan.metadataDeletes.sort(), ["meta-home", "meta-site"]);
});

test("filterSeedArchive hands back no archive when the seed already matches the configuration", () => {
  const result = filterSeedArchive(seedArchive(), { ...CONFIG, keep: ["en", "fr"] });

  assert.equal(result.archive, undefined);
  assert.deepEqual(result.plan.removed, []);

  const english = DOCUMENTS.filter((document) => !("language" in document) || document.language === "en").filter(
    ({ _type }) => _type !== "translation.metadata"
  );
  const englishOnly = filterSeedArchive(
    seedArchive(
      english.map((document) => (document._id === "category-a" ? { ...document, name: { en: "Modelling" } } : document)),
      { "image-3": { altText: "Plain" } }
    ),
    CONFIG
  );

  assert.equal(englishOnly.archive, undefined);
});

test("filterSeedArchive refuses a seed whose kept documents strongly reference one it leaves out", () => {
  const documents = [...DOCUMENTS, { _id: "about", _type: "page", language: "en", featured: ref("homepage-fr") }];

  assert.throws(
    () => filterSeedArchive(seedArchive(documents), CONFIG),
    /cannot drop fr: page homepage-fr is strongly referenced/
  );
});

test("describeSeedFilter and seedFilterWarnings say what a filtered import keeps and loses", () => {
  const documents = [...DOCUMENTS, { _id: "contact", _type: "page", language: "en", link: ref("homepage-fr", true) }];
  const { plan } = filterSeedArchive(seedArchive(documents), CONFIG);

  assert.equal(
    describeSeedFilter(plan),
    "en (leaves out 2 documents in fr and 2 translation groups; keeps only en on 1 shared document, 2 assets)"
  );
  assert.deepEqual(seedFilterWarnings(plan), [
    "image-2: altText has no en text, so it is left out.",
    "page contact links to a document that is left out.",
  ]);

  const unchanged = filterSeedArchive(seedArchive(), { ...CONFIG, keep: ["en", "fr"] }).plan;

  assert.equal(describeSeedFilter(unchanged), "en, fr, as configured (the seed holds nothing else)");
  assert.deepEqual(seedFilterWarnings(unchanged), []);
});

test("isBundledSeed matches the seed by real path, never another archive", () => {
  const root = mkdtempSync(join(tmpdir(), "seed-archive-"));

  try {
    mkdirSync(join(root, "seed"));
    mkdirSync(join(root, "backups"));
    writeFileSync(join(root, SEED_ARCHIVE), seedArchive());
    writeFileSync(join(root, "backups", "copy.tar.gz"), seedArchive());
    symlinkSync(join(root, SEED_ARCHIVE), join(root, "linked.tar.gz"));

    assert.equal(isBundledSeed(SEED_ARCHIVE, root), true);
    assert.equal(isBundledSeed(`./seed/../${SEED_ARCHIVE}`, root), true);
    assert.equal(isBundledSeed(join(root, SEED_ARCHIVE), root), true);
    assert.equal(isBundledSeed("linked.tar.gz", root), true);
    assert.equal(isBundledSeed("backups/copy.tar.gz", root), false);
    assert.equal(isBundledSeed("missing.tar.gz", root), false);

    rmSync(join(root, "seed"), { recursive: true });

    assert.equal(isBundledSeed(SEED_ARCHIVE, root), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readTarGz and writeTarGz are gzip around the same tar", () => {
  const entries = [file("a.txt", "hello")];

  assert.deepEqual(plain(readTarGz(writeTarGz(entries))), plain(entries));
  assert.deepEqual(gunzipSync(writeTarGz(entries)), writeTar(entries));
  assert.deepEqual(plain(readTarGz(gzipSync(writeTar(entries)))), plain(entries));
});
