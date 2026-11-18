import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import ts from "typescript";
import { commentedEntry, disableLocales, enableCommentedLocales, listLocales, otherLocaleMode } from "./locales";

const config = (entries: string, tail = "") => `/** The site's locales. */
export const LOCALES = [
${entries}
] as const;

export const DEFAULT_LOCALE = "en";
${tail}`;

const BILINGUAL = config(`  { id: "en", title: "English", region: "GB" },
  { id: "it", title: "Italiano", region: "IT" },`);

const SINGLE = config(`  { id: "en", title: "English", region: "GB" },
  // { id: "it", title: "Italiano", region: "IT" },`);

const REAL_CONFIG = readFileSync(new URL("../../../sanity/i18n.ts", import.meta.url), "utf8");

function syntaxErrors(source: string): string[] {
  const { diagnostics = [] } = ts.transpileModule(source, { reportDiagnostics: true });

  return diagnostics.map(({ messageText }) => ts.flattenDiagnosticMessageText(messageText, "\n"));
}

describe("listLocales", () => {
  it("reads the active entries, the commented candidates and the default", () => {
    assert.deepEqual(listLocales(BILINGUAL), { active: ["en", "it"], commented: [], defaultLocale: "en" });
    assert.deepEqual(listLocales(SINGLE), { active: ["en"], commented: ["it"], defaultLocale: "en" });
  });

  it("only counts candidates inside LOCALES, whole and valid", () => {
    const source = config(
      `  {
    id: "en",
    // { id: "sv", title: "Svenska" },
    title: "English",
  },
  // { id: "fr", title: "Français", region: "FR" },
  //{ id: "es", title: "Español" }
  // { id: "de", title: "Deutsch"
  // { id: "nl", title: }
  // a note about { id: "da" }`,
      `// { id: "pt", title: "Português" },\n`
    );

    assert.deepEqual(listLocales(source)?.commented, ["fr", "es"]);
    assert.deepEqual(enableCommentedLocales(source).enabled, ["fr", "es"]);
  });

  it("answers undefined for a LOCALES no script can read", () => {
    for (const entries of ["  ...BASE,", '  { id: LANGUAGE, title: "x" },', '  { title: "no id" },', "  ENGLISH,"]) {
      assert.equal(listLocales(config(`  { id: "en", title: "English" },\n${entries}`)), undefined, entries);
    }

    assert.equal(listLocales("export const LOCALES = BASE.map((id) => ({ id }));"), undefined);
    assert.equal(listLocales("export const SOMETHING_ELSE = [];"), undefined);
  });
});

describe("enableCommentedLocales", () => {
  it("uncomments the entries inside LOCALES only, keeping indent", () => {
    const source = config(
      `  { id: "en", title: "English", region: "GB" },
  // { id: "fr", title: "Français", region: "FR" },
  //{ id: "es", title: "Español" }`,
      `// { id: "de", title: "Deutsch" },\n`
    );
    const { source: enabled, enabled: ids } = enableCommentedLocales(source);

    assert.deepEqual(ids, ["fr", "es"]);
    assert.match(enabled, /^ {2}\{ id: "fr", title: "Français", region: "FR" \},$/m);
    assert.match(enabled, /^ {2}\{ id: "es", title: "Español" \},$/m);
    assert.match(enabled, /^\/\/ \{ id: "de"/m);
    assert.deepEqual(listLocales(enabled)?.active, ["en", "fr", "es"]);
  });

  it("keeps a hand-written trailing comment after the entry", () => {
    const source = config(`  { id: "en", title: "English" },\n  // { id: "fr", title: "Français" }, // later`);

    assert.match(enableCommentedLocales(source).source, /^ {2}\{ id: "fr", title: "Français" \}, \/\/ later$/m);
  });

  it("gives the entry before a candidate its missing comma, so the array still parses", () => {
    const source = config(`  { id: "en", title: "English" } // the default
  // { id: "fr", title: "Français" },
  // { id: "es", title: "Español" },`);
    const enabled = enableCommentedLocales(source).source;

    assert.equal(
      enabled,
      config(`  { id: "en", title: "English" }, // the default
  { id: "fr", title: "Français" },
  { id: "es", title: "Español" },`)
    );
    assert.deepEqual(syntaxErrors(enabled), []);

    const commaAfterComment = config(`  { id: "en" } /* the default */ ,\n  // { id: "fr" },`);

    assert.equal(enableCommentedLocales(commaAfterComment).source, config(`  { id: "en" } /* the default */ ,\n  { id: "fr" },`));
  });

  it("enables only the ids asked for, and never a second copy of an active one", () => {
    const source = config(`  { id: "en", title: "English" },
  // { id: "en", title: "English (old)" },
  // { id: "fr", title: "Français" },
  // { id: "es", title: "Español" },
  // { id: "es", title: "Español (old)" },`);

    assert.deepEqual(enableCommentedLocales(source, ["es"]).enabled, ["es"]);
    assert.deepEqual(enableCommentedLocales(source).enabled, ["fr", "es"]);
    assert.doesNotMatch(enableCommentedLocales(source).source, /^ {2}\{ id: "es", title: "Español \(old\)" \},$/m);
  });

  it("leaves a source with no readable LOCALES alone", () => {
    const source = 'export const LOCALES = [...BASE];\n// { id: "fr" },\n';

    assert.deepEqual(enableCommentedLocales(source), { source, enabled: [] });
  });
});

describe("disableLocales", () => {
  it("comments out every active entry outside keep, one line each", () => {
    const { source, disabled, refused } = disableLocales(BILINGUAL, ["en"]);

    assert.equal(source, SINGLE);
    assert.deepEqual(disabled, ["it"]);
    assert.deepEqual(refused, []);
  });

  it("folds a multi-line entry into one line with id first", () => {
    const source = config(`  { id: "en", title: "English" },
  {
    title: "Italiano",
    id: "it",
    region: "IT",
  },
  { id: "fr", title: "Français" },`);

    assert.equal(
      disableLocales(source, ["en", "fr"]).source,
      config(`  { id: "en", title: "English" },
  // { id: "it", title: "Italiano", region: "IT" },
  { id: "fr", title: "Français" },`)
    );
  });

  it("normalizes the id to a double-quoted first property", () => {
    const source = config(`  { id: "en", title: "English" },\n  { title: 'Italiano', 'id': 'it' },`);

    assert.match(disableLocales(source, ["en"]).source, /^ {2}\/\/ \{ id: "it", title: 'Italiano' \},$/m);
  });

  it("moves a trailing comment onto its own line above the entry", () => {
    const source = config(`  { id: "en", title: "English" },\n  { id: "it", title: "Italiano" }, // the demo's second language`);

    assert.equal(
      disableLocales(source, ["en"]).source,
      config(`  { id: "en", title: "English" },\n  // the demo's second language\n  // { id: "it", title: "Italiano" },`)
    );
  });

  it("adds the comma a last entry left out", () => {
    const source = config(`  { id: "en", title: "English" },\n  { id: "it", title: "Italiano" }`);

    assert.match(disableLocales(source, ["en"]).source, /^ {2}\/\/ \{ id: "it", title: "Italiano" \},$/m);
  });

  it("refuses an entry it cannot fold into one commented line", () => {
    const cases = [
      `  { id: "en", title: "English" }, { id: "it", title: "Italiano" },`,
      `  { id: "en", title: "English" },\n  { id: "it", /* note */ title: "Italiano" },`,
      `  { id: "en", title: "English" },\n  {\n    id: "it", // note\n    title: "Italiano",\n  },`,
      `  { id: "en", title: "English" },\n  { id: "it", title: \`Italiano\` },`,
      `  { id: "en", title: "English" },\n  { id: "it", title: "Italiano" }\n  , { id: "fr", title: "Français" },`,
      `  { id: "en", title: "English" },\n  { id: "it", title: "Italiano" }, /* note */`,
    ];

    for (const entries of cases) {
      const source = config(entries);
      const result = disableLocales(source, ["en", "fr"]);

      assert.equal(result.source, source, entries);
      assert.deepEqual(result.disabled, [], entries);
      assert.equal(result.refused[0]?.id, "it", entries);
    }
  });

  it("never switches off the default locale", () => {
    const result = disableLocales(BILINGUAL, ["it"]);

    assert.deepEqual(result.disabled, []);
    assert.deepEqual(
      result.refused.map(({ id }) => id),
      ["en"]
    );
    assert.equal(result.source, BILINGUAL);
  });

  it("treats the first entry as the default when DEFAULT_LOCALE is not a literal", () => {
    const source = BILINGUAL.replace('DEFAULT_LOCALE = "en"', "DEFAULT_LOCALE = LOCALES[0].id");

    assert.deepEqual(
      disableLocales(source, []).refused.map(({ id }) => id),
      ["en"]
    );
  });

  it("reports a LOCALES it cannot read instead of calling it done", () => {
    const source = "export const LOCALES = [...BASE, EXTRA] as const;\n";
    const result = disableLocales(source, ["en"]);

    assert.equal(result.source, source);
    assert.match(result.refused[0]?.reason ?? "", /not a literal array/);
  });

  it("has nothing to do for an entry already commented out", () => {
    assert.deepEqual(disableLocales(SINGLE, ["en"]), { source: SINGLE, disabled: [], refused: [] });
  });
});

describe("round trip", () => {
  const shapes = [
    BILINGUAL,
    config(`  { id: "en", title: "English", region: "GB" },
  { id: "it", title: "Italiano", region: "IT" },
  { id: "fr", title: "Français" },`),
    config(`  { id: "en", title: "English" },\n  {\n    title: "Italiano",\n    id: "it",\n  },`),
    config(`  { id: "en", title: "English" },\n  { id: "it", title: "Italiano" }, // the demo's second language`),
  ];

  it("enabling what was disabled restores every active entry", () => {
    for (const source of shapes) {
      const before = listLocales(source);
      const disabled = disableLocales(source, ["en"]);
      const enabled = enableCommentedLocales(disabled.source);

      assert.deepEqual(disabled.refused, []);
      assert.deepEqual(enabled.enabled, disabled.disabled);
      assert.deepEqual(listLocales(enabled.source)?.active, before?.active);
      assert.deepEqual(listLocales(disableLocales(enabled.source, ["en"]).source), listLocales(disabled.source));
    }
  });

  it("is byte-exact for entries already in the canonical one-line shape", () => {
    assert.equal(enableCommentedLocales(disableLocales(BILINGUAL, ["en"]).source).source, BILINGUAL);
    assert.equal(disableLocales(enableCommentedLocales(SINGLE).source, ["en"]).source, SINGLE);
  });

  it("writes the same line as commentedEntry", () => {
    assert.equal(
      commentedEntry({ id: "it", properties: ['title: "Italiano"', 'region:\n    "IT"'] }),
      '// { id: "it", title: "Italiano", region: "IT" },'
    );
  });
});

describe("otherLocaleMode", () => {
  it("folds several locales to the default and enables the candidates of one", () => {
    assert.deepEqual(otherLocaleMode(BILINGUAL), { source: SINGLE, enabled: [], disabled: ["it"], refused: [] });
    assert.deepEqual(otherLocaleMode(SINGLE), { source: BILINGUAL, enabled: ["it"], disabled: [], refused: [] });
  });

  it("toggles the real config to the mode it does not run, and back", () => {
    const real = listLocales(REAL_CONFIG);

    assert.ok(real, "sanity/i18n.ts keeps LOCALES a literal array of { id } entries");

    const other = otherLocaleMode(REAL_CONFIG);
    const changed = real.active.length > 1 ? other.disabled : other.enabled;

    assert.deepEqual(other.refused, []);
    assert.ok(
      changed.length > 0,
      "a single-locale config keeps a commented candidate, so npm run i18n:check can run the other mode"
    );
    assert.notEqual(listLocales(other.source)?.active.length === 1, real.active.length === 1);
    assert.equal(otherLocaleMode(other.source).source, REAL_CONFIG);
  });
});
