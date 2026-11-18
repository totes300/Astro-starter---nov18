import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  censusConfig,
  I18N_CONFIG,
  loadI18nContext,
  readLocaleConfig,
  removalConfig,
  stillConfigured,
  switchedOff,
} from "./language";
import { loadLocaleToggle } from "./locale-toggle";

const root = join(import.meta.dirname, "..", "..");

const config = (entries: string, tail = 'export const DEFAULT_LOCALE = "en";\n') => `export const LOCALES = [
${entries}
] as const;

${tail}`;

/** A throwaway project holding only what the loader reads. */
function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "trim-language-"));

  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }

  return dir;
}

const CONSTANTS = `export const I18N_DOCUMENT_TYPES: readonly string[] = ["page", "article"];
export const LOCALIZED_FIELDS = { articleCategory: ["name"] } as const;
`;

test("readLocaleConfig reads the active entries, the commented candidates and the default", () => {
  const source = config(`  { id: "en", title: "English" },
  {
    id: "it",
    title: "Italiano",
  }, // reviewed
  // { id: "fr", title: "Français" },
  // a note about { id: "da" }
  // { id: "de", title:`);

  assert.deepEqual(readLocaleConfig(source), { defaultLocale: "en", active: ["en", "it"], commented: ["fr"] });
});

test("readLocaleConfig falls back to the first entry when DEFAULT_LOCALE is not a literal", () => {
  assert.equal(
    readLocaleConfig(config(`  { id: "fr" },\n  { id: "en" },`, "export const DEFAULT_LOCALE = pick();\n"))?.defaultLocale,
    "fr"
  );
});

test("readLocaleConfig answers nothing for a list it cannot read as entries", () => {
  assert.equal(readLocaleConfig('export const LOCALES = [...BASE, { id: "it" }];\n'), undefined);
  assert.equal(readLocaleConfig("export const LOCALES = build();\n"), undefined);
  assert.equal(readLocaleConfig("export const LOCALES = [{ id: someId }];\n"), undefined);
  assert.equal(readLocaleConfig("export const OTHER = [];\n"), undefined);
});

test("readLocaleConfig agrees with the locale toggle on every config it can read", async (t) => {
  const toggle = await loadLocaleToggle();

  if (!toggle) {
    t.skip("scripts/sanity-migrations/lib/locales.ts is not here");
    return;
  }

  const sources = [
    ...(existsSync(join(root, I18N_CONFIG)) ? [readFileSync(join(root, I18N_CONFIG), "utf8")] : []),
    config(`  { id: "en" },\n  // { id: "it", title: "Italiano" },\n  // { id: "fr" }, // later`),
    config(`  { id: "en" },\n  {\n    // { id: "sv" },\n    id: "nb",\n  },\n  //{ id: "es" }`),
    config(`  { id: "en" },\n  { id: "it" },\n  // { id: "it", title: "Italiano" },`),
  ];

  for (const source of sources) {
    const toggleView = toggle.listLocales(source);
    const view = readLocaleConfig(source);

    assert.deepEqual(
      view && { active: view.active, commented: view.commented },
      toggleView && {
        active: toggleView.active,
        commented: toggleView.commented,
      }
    );
  }
});

test("loadI18nContext reads this repository's languages and translated types, or none before i18n", async () => {
  const { context, problem } = await loadI18nContext(root);

  if (!existsSync(join(root, I18N_CONFIG))) {
    assert.deepEqual({ context, problem }, { context: undefined, problem: undefined });
    return;
  }

  assert.equal(problem, undefined);
  assert.ok(context);
  assert.ok(context.active.includes(context.defaultLocale));
  assert.ok(context.i18nTypes.includes("page"));
});

test("loadI18nContext finds nothing in a project from before i18n, and says so for nothing else", async () => {
  const dir = project({ "sanity/constants.ts": CONSTANTS });

  try {
    assert.deepEqual(await loadI18nContext(dir), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadI18nContext reads a project's own config", async () => {
  const dir = project({ [I18N_CONFIG]: config(`  { id: "en" },\n  { id: "it" },`), "sanity/constants.ts": CONSTANTS });

  try {
    const { context } = await loadI18nContext(dir);

    assert.deepEqual(context, {
      defaultLocale: "en",
      active: ["en", "it"],
      commented: [],
      i18nTypes: ["page", "article"],
      localizedFields: { articleCategory: ["name"] },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadI18nContext reports what it cannot read instead of guessing or crashing", async () => {
  const cases: [Record<string, string>, RegExp][] = [
    [{ [I18N_CONFIG]: "export const LOCALES = build();\n", "sanity/constants.ts": CONSTANTS }, /not a literal array/],
    [
      { [I18N_CONFIG]: config(`  { id: "en" },\n  { id: "Italiano" },`), "sanity/constants.ts": CONSTANTS },
      /not a language code/,
    ],
    [{ [I18N_CONFIG]: config(`  { id: "en" },`), "sanity/constants.ts": "export const OTHER = 1;\n" }, /I18N_DOCUMENT_TYPES/],
    [
      { [I18N_CONFIG]: config(`  { id: "en" },`), "sanity/constants.ts": 'export const I18N_DOCUMENT_TYPES = ["page x"];\n' },
      /I18N_DOCUMENT_TYPES/,
    ],
    [
      {
        [I18N_CONFIG]: config(`  { id: "en" },`),
        "sanity/constants.ts":
          'export const I18N_DOCUMENT_TYPES = ["page"];\nexport const LOCALIZED_FIELDS = { page: "title" };\n',
      },
      /LOCALIZED_FIELDS/,
    ],
    [
      {
        [I18N_CONFIG]: config(`  { id: "en" },`),
        "sanity/constants.ts": 'import "./missing-runtime-module";\nexport const I18N_DOCUMENT_TYPES = [];\n',
      },
      /could not be loaded/,
    ],
  ];

  for (const [files, problem] of cases) {
    const dir = project(files);

    try {
      const loaded = await loadI18nContext(dir);

      assert.equal(loaded.context, undefined);
      assert.match(loaded.problem ?? "", problem);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("a removal keeps what stays configured, and the census keeps everything configured now", () => {
  const context = {
    defaultLocale: "en",
    active: ["en", "fr", "it"],
    commented: ["de"],
    i18nTypes: ["page"],
    localizedFields: {},
  };

  assert.deepEqual(censusConfig(context).keep, ["en", "fr", "it"]);
  assert.deepEqual(removalConfig(context, ["it"]), {
    defaultLocale: "en",
    keep: ["en", "fr"],
    removed: ["it"],
    i18nTypes: ["page"],
    localizedFields: {},
  });
  assert.deepEqual(removalConfig(context, []).keep, ["en", "fr", "it"]);
});

test("a language whose LOCALES comment-out was left to a person is not switched off, so its content stays", () => {
  const commentOut = (value: string) => ({
    file: I18N_CONFIG,
    edit: { kind: "commentOutObjectInArray" as const, anchor: "LOCALES", property: "id", value },
    matches: 0,
    reason: "it shares a line with other code, so it cannot become a line of its own.",
  });
  const elsewhere = { file: "i18n/strings.ts", edit: { kind: "dropImport" as const, id: "italian" }, matches: 0 };

  assert.deepEqual(switchedOff(["it", "fr"], [commentOut("it"), elsewhere]), ["fr"]);
  assert.deepEqual(switchedOff(["it"], [elsewhere]), ["it"]);
  assert.deepEqual(switchedOff([], [commentOut("it")]), []);
});

test("a purge refuses a language the tree still configures, and one it cannot read", () => {
  const bilingual = config(`  { id: "en", title: "English" },
  { id: "it", title: "Italiano" },`);
  const english = config(`  { id: "en", title: "English" },
  // { id: "it", title: "Italiano" },`);

  assert.deepEqual(stillConfigured(bilingual, ["it"]), ["it"]);
  assert.deepEqual(stillConfigured(english, ["it"]), []);
  assert.deepEqual(stillConfigured(english, []), []);
  assert.deepEqual(stillConfigured("export const LOCALES = pick();\n", ["it"]), ["it"]);
  assert.deepEqual(stillConfigured(undefined, ["it"]), ["it"]);
  assert.deepEqual(stillConfigured(undefined, []), []);
});
