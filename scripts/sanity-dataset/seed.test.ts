import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import { I18N_DOCUMENT_TYPES, LOCALIZED_FIELDS } from "../../sanity/constants";
import { listLocales } from "../sanity-migrations/lib/locales";
import {
  filterSeedToLocales,
  KEY,
  LOCALIZED_ASSET_FIELDS,
  type RawDocument,
  type SeedAssets,
  TRANSLATION_METADATA,
  valueAt,
} from "../trim-features/language-removal";
import { readSeed, readTar, readTarGz, writeTarGz } from "./seed-archive";

const SEED_PATH = new URL("../../seed/seed-dataset.tar.gz", import.meta.url);

const LOCALES_SOURCE = readFileSync(new URL("../../sanity/i18n.ts", import.meta.url), "utf8");

function loadSeed() {
  const entries = readTarGz(readFileSync(SEED_PATH));

  return { entries: new Map(entries.map((entry) => [entry.name, entry.data])), ...readSeed(entries) };
}

function collect(value: unknown, path: string, visit: (node: Record<string, unknown>, path: string) => void) {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      collect(item, `${path}[${index}]`, visit);
    }
  } else if (value && typeof value === "object") {
    const node = value as Record<string, unknown>;
    visit(node, path);
    for (const [key, child] of Object.entries(node)) {
      collect(child, path ? `${path}.${key}` : key, visit);
    }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function danglingStrongReferences(documents: readonly RawDocument[]): string[] {
  const ids = new Set(documents.map((doc) => doc._id));
  const dangling: string[] = [];

  for (const doc of documents) {
    collect(doc, "", (node, path) => {
      if (typeof node._ref === "string" && !node._weak && !ids.has(node._ref)) {
        dangling.push(`${doc._id} ${path} -> ${node._ref}`);
      }
    });
  }

  return dangling;
}

// The import fails outright on a strong reference to a document the export left out (a type missing from `--types`).
test("every strong reference in the seed points at a document the seed contains", () => {
  assert.deepEqual(danglingStrongReferences(loadSeed().documents), []);
});

test("every asset the seed documents use is bundled in the archive", () => {
  const { entries, root, documents } = loadSeed();
  const missing: string[] = [];

  for (const doc of documents) {
    collect(doc, "", (node, path) => {
      if (typeof node._sanityAsset !== "string") {
        return;
      }
      const file = node._sanityAsset.replace(/^\w+@file:\/\/\.\//, "");
      if (!entries.has(root + file)) {
        missing.push(`${doc._id} ${path} -> ${file}`);
      }
    });
  }

  assert.deepEqual(missing, []);
});

// A hand repack on macOS adds AppleDouble `._` files and xattr headers: metadata every clone would ship.
test("the archive carries no macOS metadata", () => {
  const archive = gunzipSync(readFileSync(SEED_PATH));
  const appleDouble = readTar(archive)
    .map(({ name }) => name)
    .filter((name) => name.split("/").at(-1)?.startsWith("._"));

  assert.deepEqual(appleDouble, []);
  assert.equal(archive.includes("xattr.com.apple."), false, "extended attributes in a pax header");
});

/** Every header's owner fields, pax records included: what `tar` copies from the account that packed the archive. */
function recordedOwners(archive: Buffer): string[] {
  const owners: string[] = [];
  let offset = 0;

  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);

    if (header.every((byte) => byte === 0)) {
      break;
    }

    const field = (start: number, length: number) =>
      (
        header
          .subarray(start, start + length)
          .toString("utf8")
          .split("\0")[0] ?? ""
      ).trim();
    const size = Number.parseInt(field(124, 12) || "0", 8);
    const ids = [field(108, 8), field(116, 8)].map((id) => Number.parseInt(id || "0", 8));
    const names = [field(265, 32), field(297, 32)].filter(Boolean);
    const data = archive.subarray(offset + 512, offset + 512 + size).toString("utf8");
    const paxOwner = ["x", "g"].includes(field(156, 1)) && /\b(uid|gid|uname|gname)=/.test(data);

    if (ids.some((id) => id !== 0) || names.length > 0 || paxOwner) {
      owners.push(`${field(0, 100)}: uid ${ids[0]}, gid ${ids[1]}${names.length > 0 ? `, ${names.join(":")}` : ""}`);
    }

    offset += 512 + Math.ceil(size / 512) * 512;
  }

  return owners;
}

// A repack with the system `tar` writes the packing account's name and ids into every header, which every clone ships.
test("the archive records no local account", () => {
  assert.deepEqual(recordedOwners(gunzipSync(readFileSync(SEED_PATH))), []);
});

// `sanity:dataset-import` packs a filtered seed with the same writer, so it must hold every entry of the real one.
test("the archive packs back into the same entries", () => {
  const entries = readTarGz(readFileSync(SEED_PATH));

  assert.deepEqual(readTarGz(writeTarGz(entries)), entries);
});

// Each automatic description is billed, once per configured language, for every image a fresh clone uploads.
test("the seed ships automatic alt text switched off", () => {
  const settings = loadSeed().documents.find(({ _id }) => _id === "siteSettings");

  assert.ok(settings, "the seed holds siteSettings");
  assert.notEqual((settings.altText as { enabled?: unknown } | undefined)?.enabled, true);
});

/** Must match the `--types` list in docs/sanity/seed-dataset.md: anything else could carry a secret. */
const SEED_TYPE_ALLOWLIST = new Set([
  "page",
  "legalPage",
  "site",
  "siteSettings",
  "blog",
  "article",
  "articleCategory",
  "person",
  TRANSLATION_METADATA,
  "sanity.imageAsset",
  "sanity.fileAsset",
]);

const SINGLETON_TYPES = new Set(["site", "siteSettings", "blog"]);

/** Never content: preview and share secrets, plugin config secrets, visitor submissions. */
const SECRET_TYPE = /^(sanity\.previewUrl|sanity\.secrets|mux\.|secrets\.|contactFormSubmission$)/;

const SECRET_KEY = /(token|secret|password|apikey|api_key|privatekey|signingkey)/i;

type SeedRules = {
  defaultLocale: string;
  /** Every language the seed may carry. */
  locales: readonly string[];
  i18nTypes: readonly string[];
  localizedFields: Readonly<Record<string, readonly string[]>>;
};

const LOCALE_LIST = listLocales(LOCALES_SOURCE);

assert.ok(LOCALE_LIST?.defaultLocale, "sanity/i18n.ts has a literal LOCALES and DEFAULT_LOCALE");

const DEFAULT_LOCALE = LOCALE_LIST.defaultLocale;

// Commented candidates count: a project that switched a language off keeps its seed valid until it trims `bootstrap`.
const RULES: SeedRules = {
  defaultLocale: DEFAULT_LOCALE,
  locales: [...LOCALE_LIST.active, ...LOCALE_LIST.commented],
  i18nTypes: I18N_DOCUMENT_TYPES,
  localizedFields: LOCALIZED_FIELDS,
};

/** The translation group each document belongs to, by the `translation.metadata` rows that link it. */
function translationGroups(documents: readonly RawDocument[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();

  for (const doc of documents.filter(({ _type }) => _type === TRANSLATION_METADATA)) {
    for (const row of Array.isArray(doc.translations) ? doc.translations : []) {
      const target = isPlainObject(row) && isPlainObject(row.value) ? row.value._ref : undefined;

      if (typeof target === "string") {
        groups.set(target, [...(groups.get(target) ?? []), doc._id]);
      }
    }
  }

  return groups;
}

function seedProblems(documents: readonly RawDocument[], rules: SeedRules): string[] {
  const problems: string[] = [];
  const groups = translationGroups(documents);

  for (const doc of documents) {
    if (SECRET_TYPE.test(doc._type ?? "") || SECRET_TYPE.test(doc._id)) {
      problems.push(`${doc._id}: secret-bearing ${doc._type}`);
    } else if (!SEED_TYPE_ALLOWLIST.has(doc._type ?? "")) {
      problems.push(`${doc._id}: type ${doc._type} is not in the seed allowlist`);
    }

    if (doc._id.includes(".")) {
      problems.push(`${doc._id}: dotted ids (drafts, release versions, hidden documents) never ship in the seed`);
    }

    collect(doc, "", (node, path) => {
      for (const [key, value] of Object.entries(node)) {
        if (SECRET_KEY.test(key) && typeof value === "string" && value) {
          problems.push(`${doc._id} ${path ? `${path}.` : ""}${key}: looks like a secret`);
        }
      }
    });
  }

  // One document per singleton, plus at most one translation per other language, linked to it.
  for (const type of SINGLETON_TYPES) {
    const copies = documents.filter(({ _type }) => _type === type);
    const main = copies.find(({ _id }) => _id === type);
    const mainGroup = groups.get(type)?.[0];
    const languages = new Set<unknown>();
    const extra = copies.filter((doc) => {
      const isTranslation =
        doc !== main &&
        typeof doc.language === "string" &&
        doc.language !== rules.defaultLocale &&
        !languages.has(doc.language) &&
        mainGroup !== undefined &&
        groups.get(doc._id)?.[0] === mainGroup;

      languages.add(doc.language);

      return doc !== main && !isTranslation;
    });

    if (copies.length > 0 && (!main || extra.length > 0)) {
      const found = copies.map(({ _id }) => _id).join(", ");

      problems.push(
        `${type}: singleton must be one document with _id "${type}" plus at most one linked translation per language, found ${found}`
      );
    }

    if (main?.language !== undefined && main.language !== rules.defaultLocale) {
      problems.push(`${type}: the singleton itself is the ${rules.defaultLocale} document, not ${JSON.stringify(main.language)}`);
    }
  }

  return problems;
}

/** Text, or portable text: a person's bio translates in place too. */
const isArmText = (value: unknown) =>
  (typeof value === "string" && value !== "") || (Array.isArray(value) && value.length > 0 && value.every(isPlainObject));

/** Text per language on a shared field or an asset: an object of configured arms, `_` keys being Sanity's own. */
function armProblems(value: Record<string, unknown>, at: string, rules: SeedRules): string[] {
  return Object.entries(value).flatMap(([key, text]) => {
    if (key.startsWith("_")) {
      return [];
    }

    if (!rules.locales.includes(key)) {
      return [`${at}.${key}: ${key} is not in LOCALES, active or commented`];
    }

    return typeof text === "string" || isArmText(text) ? [] : [`${at}.${key}: not text`];
  });
}

function languageProblems(documents: readonly RawDocument[], assets: SeedAssets, rules: SeedRules): string[] {
  const problems: string[] = [];
  const byId = new Map(documents.map((doc) => [doc._id, doc]));
  const groups = translationGroups(documents);

  for (const doc of documents) {
    const isTranslated = rules.i18nTypes.includes(doc._type ?? "");

    // An empty string is a missing language, as the backfill and the removal both read it.
    if (isTranslated && (typeof doc.language !== "string" || doc.language === "")) {
      problems.push(`${doc._id}: ${doc._type} has no language`);
    } else if (doc.language !== undefined && !rules.locales.includes(doc.language as string)) {
      problems.push(`${doc._id}: language ${JSON.stringify(doc.language)} is not in LOCALES, active or commented`);
    }

    for (const field of Object.hasOwn(rules.localizedFields, doc._type ?? "")
      ? (rules.localizedFields[doc._type ?? ""] ?? [])
      : []) {
      const value = valueAt(doc, field);

      if (value === undefined) {
        continue;
      }

      if (!isPlainObject(value)) {
        problems.push(`${doc._id} ${field}: one plain value, not an object of text per language`);
        continue;
      }

      problems.push(...armProblems(value, `${doc._id} ${field}`, rules));

      if (!isArmText(value[rules.defaultLocale])) {
        problems.push(`${doc._id} ${field}: no ${rules.defaultLocale} text`);
      }
    }

    if ((groups.get(doc._id)?.length ?? 0) > 1) {
      problems.push(`${doc._id}: linked by ${groups.get(doc._id)?.length} translation groups`);
    }
  }

  for (const doc of documents.filter(({ _type }) => _type === TRANSLATION_METADATA)) {
    const rows = Array.isArray(doc.translations) ? doc.translations : [];
    const languages = new Set<string>();

    if (rows.length < 2) {
      problems.push(`${doc._id}: a translation group links two or more documents, found ${rows.length}`);
    }

    for (const [index, row] of rows.entries()) {
      const entry = isPlainObject(row) ? row : {};
      const value = isPlainObject(entry.value) ? entry.value : {};
      const target = typeof value._ref === "string" ? byId.get(value._ref) : undefined;
      const at = `${doc._id} translations[${index}]`;

      if (typeof entry._key !== "string" || !KEY.test(entry._key)) {
        problems.push(`${at}: _key ${JSON.stringify(entry._key)} is not a key a patch path can name`);
      }

      if (typeof entry.language !== "string" || !rules.locales.includes(entry.language)) {
        problems.push(`${at}: language ${JSON.stringify(entry.language)} is not in LOCALES, active or commented`);
      } else if (languages.has(entry.language)) {
        problems.push(`${at}: a second ${entry.language} document in one group`);
      }

      languages.add(String(entry.language));

      if (!target) {
        problems.push(`${at} -> ${String(value._ref)}: not a document the seed contains`);
      } else if (target.language !== entry.language) {
        problems.push(`${at}: links ${target._id}, whose language is ${JSON.stringify(target.language)}`);
      } else if (Array.isArray(doc.schemaTypes) && !doc.schemaTypes.includes(target._type)) {
        problems.push(`${at}: links a ${target._type}, outside the group's schemaTypes`);
      }
    }
  }

  for (const [id, asset] of Object.entries(assets)) {
    for (const field of LOCALIZED_ASSET_FIELDS) {
      const value = asset[field];

      if (isPlainObject(value)) {
        problems.push(...armProblems(value, `${id} ${field}`, rules));
      }
    }
  }

  return problems;
}

/** Languages are checked once the seed carries any: an export taken before them holds none at all. */
function predatesLanguages(documents: readonly RawDocument[]): string | false {
  const hasLanguages = documents.some((doc) => doc.language !== undefined || doc._type === TRANSLATION_METADATA);

  return (
    !hasLanguages &&
    "the seed predates languages: refresh it from a dataset after `npm run sanity:migrate-backfill-language` and `npm run sanity:migrate-localize-fields`"
  );
}

/** The seed as an import into a dataset configured for the default language alone receives it. */
function defaultLanguageOnly() {
  const { documents, assets } = loadSeed();
  // A trim can take a type out of I18N_DOCUMENT_TYPES while the seed still holds its translations.
  const carryLanguage = documents.flatMap(({ _type, language }) => (_type && language !== undefined ? [_type] : []));
  const i18nTypes = [...new Set([...RULES.i18nTypes, ...carryLanguage])];
  const filtered = filterSeedToLocales(documents, assets, { ...RULES, keep: [DEFAULT_LOCALE], i18nTypes });

  return { ...filtered, rules: { ...RULES, locales: [DEFAULT_LOCALE], i18nTypes } };
}

test("the seed holds only allowlisted content types and no secret-bearing document", () => {
  assert.deepEqual(seedProblems(loadSeed().documents, RULES), []);
});

test("the seed's documents, translation groups, shared fields and asset text use the languages LOCALES lists", {
  todo: predatesLanguages(loadSeed().documents),
}, () => {
  const { documents, assets } = loadSeed();
  const english = defaultLanguageOnly();

  assert.deepEqual(languageProblems(documents, assets, RULES), []);
  assert.deepEqual(languageProblems(english.documents, english.assets, english.rules), []);
});

test("the seed filtered to the default language alone is still a valid seed", () => {
  const { documents, assets, plan, rules } = defaultLanguageOnly();
  const localizedAssetText = Object.entries(assets).flatMap(([id, asset]) =>
    LOCALIZED_ASSET_FIELDS.filter((field) => isPlainObject(asset[field])).map((field) => `${id} ${field}`)
  );

  assert.deepEqual(seedProblems(documents, rules), []);
  assert.deepEqual(danglingStrongReferences(documents), []);
  assert.deepEqual(plan.dangling, [], "a kept document links to one the filter leaves out");
  assert.deepEqual(
    plan.assetCleanups.flatMap(({ id, lost }) => lost.map((field) => `${id} ${field}`)),
    [],
    "asset text with no default-language version"
  );
  assert.deepEqual(localizedAssetText, [], "asset text still stored per language");
  assert.deepEqual(
    documents.filter(({ _type }) => _type === TRANSLATION_METADATA).map(({ _id }) => _id),
    [],
    "a translation group outlives its translations"
  );
});

// Fixture locales stand on their own: en is the default, fr a second language, de one nothing lists.
const FIXTURE_RULES: SeedRules = {
  defaultLocale: "en",
  locales: ["en", "fr"],
  i18nTypes: ["site", "page", "blog"],
  localizedFields: { articleCategory: ["name"] },
};

const weakRef = (_ref: string) => ({ _type: "reference", _ref, _weak: true });

const row = (_key: string, language: string, target: string) => ({ _key, language, value: weakRef(target) });

const group = (_id: string, ...rows: ReturnType<typeof row>[]): RawDocument => ({
  _id,
  _type: TRANSLATION_METADATA,
  schemaTypes: ["site", "page"],
  translations: rows,
});

test("seedProblems flags every secret-bearing or unexpected document a full export would add", () => {
  const bad: RawDocument[] = [
    { _id: "secret-1", _type: "sanity.previewUrlSecret", secret: "s3cr3t" },
    { _id: "share-1", _type: "sanity.previewUrlShareAccess" },
    { _id: "secrets.mux", _type: "sanity.secrets" },
    { _id: "secrets.namespace", _type: "pluginConfig" },
    { _id: "mux-config", _type: "mux.apiKey" },
    { _id: "submission-1", _type: "contactFormSubmission", email: "visitor@example.com" },
    { _id: "contactFormSubmission.abc", _type: "contactFormSubmission" },
    { _id: "drafts.about", _type: "page" },
    { _id: "versions.rABC.about", _type: "page" },
    { _id: "other", _type: "redirect" },
    { _id: "siteSettings", _type: "siteSettings" },
    { _id: "siteSettings-copy", _type: "siteSettings" },
    { _id: "about", _type: "page", embed: { apiKey: "sk-live-123" } },
  ];
  const problems = seedProblems(bad, FIXTURE_RULES).join("\n");

  for (const id of ["secret-1", "share-1", "secrets.mux", "secrets.namespace", "mux-config", "submission-1"]) {
    assert.match(problems, new RegExp(`^${id.replace(".", "\\.")}: secret-bearing`, "m"));
  }

  assert.match(problems, /^drafts\.about: dotted ids/m);
  assert.match(problems, /^versions\.rABC\.about: dotted ids/m);
  assert.match(problems, /^contactFormSubmission\.abc: secret-bearing/m);
  assert.match(problems, /^contactFormSubmission\.abc: dotted ids/m);
  assert.match(problems, /^other: type redirect is not in the seed allowlist/m);
  assert.match(problems, /^siteSettings: singleton must be one document .*found siteSettings, siteSettings-copy$/m);
  assert.match(problems, /^about embed\.apiKey: looks like a secret/m);
  assert.match(problems, /^secret-1 secret: looks like a secret/m);
});

test("seedProblems takes a singleton's linked translations, one per language, and nothing else", () => {
  const valid: RawDocument[] = [
    { _id: "site", _type: "site", language: "en" },
    { _id: "site-fr", _type: "site", language: "fr" },
    { _id: "blog", _type: "blog", language: "en" },
    { _id: "siteSettings", _type: "siteSettings" },
    group("meta-site", row("a", "en", "site"), row("b", "fr", "site-fr")),
  ];

  assert.deepEqual(seedProblems(valid, FIXTURE_RULES), []);

  const cases: [string, RawDocument[], RegExp][] = [
    [
      "an unlinked translation",
      [...valid.slice(0, 4), { _id: "blog-fr", _type: "blog", language: "fr" }],
      /^blog: singleton must be one document .*found blog, blog-fr$/m,
    ],
    [
      "a second translation in one language",
      [
        ...valid.slice(0, 4),
        { _id: "site-fr-2", _type: "site", language: "fr" },
        group("meta-site", row("a", "en", "site"), row("b", "fr", "site-fr"), row("c", "fr", "site-fr-2")),
      ],
      /^site: singleton must be one document .*found site, site-fr, site-fr-2$/m,
    ],
    [
      "a translation in the default language",
      [...valid.filter(({ _id }) => _id !== "site-fr"), { _id: "site-fr", _type: "site", language: "en" }],
      /^site: singleton must be one document/m,
    ],
    [
      "no document at the type's id",
      valid.map((doc) => (doc._id === "blog" ? { ...doc, _id: "blog-en" } : doc)),
      /^blog: singleton must be one document .*found blog-en$/m,
    ],
    [
      "the singleton in another language",
      valid.map((doc) => (doc._id === "blog" ? { ...doc, language: "fr" } : doc)),
      /^blog: the singleton itself is the en document, not "fr"$/m,
    ],
  ];

  for (const [label, documents, expected] of cases) {
    assert.match(seedProblems(documents, FIXTURE_RULES).join("\n"), expected, label);
  }
});

test("languageProblems accepts a seed whose languages, groups, fields and asset text all line up", () => {
  const documents: RawDocument[] = [
    { _id: "site", _type: "site", language: "en" },
    { _id: "site-fr", _type: "site", language: "fr" },
    { _id: "about", _type: "page", language: "en" },
    { _id: "about-fr", _type: "page", language: "fr" },
    { _id: "category-a", _type: "articleCategory", name: { _type: "localized", en: "Modelling", fr: "Modélisation" } },
    { _id: "settings", _type: "siteSettings" },
    group("meta-site", row("a", "en", "site"), row("b", "fr", "site-fr")),
    group("meta-about", row("c", "en", "about"), row("d", "fr", "about-fr")),
  ];
  const assets = { "image-1": { altText: { en: "A gradient", fr: "Un dégradé" } }, "image-2": { altText: "Plain" } };

  assert.deepEqual(languageProblems(documents, assets, FIXTURE_RULES), []);
});

test("languageProblems flags missing and unlisted languages, broken groups and stray text", () => {
  const documents: RawDocument[] = [
    { _id: "site", _type: "site" },
    { _id: "blank", _type: "page", language: "" },
    { _id: "about", _type: "page", language: "en" },
    { _id: "about-de", _type: "page", language: "de" },
    { _id: "about-fr", _type: "page", language: "fr" },
    { _id: "category-a", _type: "articleCategory", name: "Modelling" },
    { _id: "category-b", _type: "articleCategory", name: { fr: "Publication", de: "Veröffentlichung", en: 1 } },
    group("meta-about", row("c", "en", "about"), row("bad key", "fr", "about-fr"), row("e", "fr", "about-de")),
    group("meta-lonely", row("f", "en", "missing")),
    { ...group("meta-site", row("g", "en", "about"), row("h", "fr", "about-fr")), schemaTypes: ["site"] },
  ];
  const assets = { "image-1": { altText: { en: "A gradient", de: "Ein Verlauf" } } };
  const problems = languageProblems(documents, assets, FIXTURE_RULES).join("\n");

  for (const expected of [
    /^site: site has no language$/m,
    /^blank: page has no language$/m,
    /^about-de: language "de" is not in LOCALES/m,
    /^category-a name: one plain value/m,
    /^category-b name\.de: de is not in LOCALES/m,
    /^category-b name\.en: not text$/m,
    /^category-b name: no en text$/m,
    /^about: linked by 2 translation groups$/m,
    /^meta-about translations\[1\]: _key "bad key"/m,
    /^meta-about translations\[2\]: a second fr document in one group$/m,
    /^meta-about translations\[2\]: links about-de, whose language is "de"$/m,
    /^meta-lonely: a translation group links two or more documents, found 1$/m,
    /^meta-lonely translations\[0\] -> missing: not a document the seed contains$/m,
    /^meta-site translations\[0\]: links a page, outside the group's schemaTypes$/m,
    /^image-1 altText\.de: de is not in LOCALES/m,
  ]) {
    assert.match(problems, expected);
  }
});

test("the default-language filter of a fixture seed passes every rule", () => {
  const documents: RawDocument[] = [
    { _id: "site", _type: "site", language: "en", home: weakRef("about") },
    { _id: "site-fr", _type: "site", language: "fr", home: weakRef("about-fr") },
    { _id: "about", _type: "page", language: "en" },
    { _id: "about-fr", _type: "page", language: "fr" },
    { _id: "category-a", _type: "articleCategory", name: { en: "Modelling", fr: "Modélisation" } },
    group("meta-site", row("a", "en", "site"), row("b", "fr", "site-fr")),
    group("meta-about", row("c", "en", "about"), row("d", "fr", "about-fr")),
  ];
  const assets = { "image-1": { altText: { en: "A gradient", fr: "Un dégradé" } } };
  const filtered = filterSeedToLocales(documents, assets, { ...FIXTURE_RULES, keep: ["en"] });
  const rules = { ...FIXTURE_RULES, locales: ["en"] };

  assert.deepEqual(seedProblems(filtered.documents, rules), []);
  assert.deepEqual(languageProblems(filtered.documents, filtered.assets, rules), []);
  assert.deepEqual(filtered.plan.dangling, []);
  assert.deepEqual(filtered.assets, { "image-1": { altText: "A gradient" } });
  assert.match(languageProblems(documents, assets, rules).join("\n"), /^site-fr: language "fr" is not in LOCALES/m);
});

test("a seed with no language anywhere predates languages, and one with any does not", () => {
  assert.match(String(predatesLanguages([{ _id: "site", _type: "site" }])), /predates languages/);
  assert.equal(predatesLanguages([{ _id: "site", _type: "site", language: "en" }]), false);
  assert.equal(predatesLanguages([{ _id: "meta", _type: TRANSLATION_METADATA }]), false);
});
