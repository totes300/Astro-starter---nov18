import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LOCALE, LOCALE_IDS } from "~/sanity/i18n";
import { formatList, hasUiStrings, UI_STRING_LOCALES, uiStrings } from "./strings";

type Leaf = { path: string; value: unknown };

type Template = (...args: number[]) => unknown;

function leaves(value: unknown, path = ""): Leaf[] {
  if (value === null || typeof value !== "object") {
    return [{ path, value }];
  }

  return Object.entries(value).flatMap(([key, child]) => leaves(child, path ? `${path}.${key}` : key));
}

/** Each key with its kind, and a template's argument count, so a translation cannot take fewer or more. */
function shape(dictionary: unknown): string[] {
  return leaves(dictionary)
    .map(({ path, value }) => (typeof value === "function" ? `${path}:function(${value.length})` : `${path}:${typeof value}`))
    .sort();
}

function templates(locale: string): Array<{ path: string; template: Template }> {
  return leaves(uiStrings(locale)).flatMap(({ path, value }) =>
    typeof value === "function" ? [{ path, template: value as Template }] : []
  );
}

const COUNTS = [0, 1, 2, 5, 1_000_000];

// Distinct per position, so a template that drops an argument, or repeats one for another, shows in its text.
const ARGUMENTS = [41, 42, 43];

// `npm run i18n:check` sets this when it switches on a commented-out language whose dictionary a trim deleted.
const UNTRANSLATED = (process.env.I18N_CHECK_UNTRANSLATED ?? "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

describe("uiStrings", () => {
  it("has a dictionary for every configured locale", () => {
    for (const locale of LOCALE_IDS) {
      if (!UNTRANSLATED.includes(locale)) {
        assert.equal(hasUiStrings(locale), true, `no UI strings for "${locale}"`);
      }
    }
  });

  it("exempts only configured, untranslated locales from the dictionary check", () => {
    const configured: readonly string[] = LOCALE_IDS;

    for (const locale of UNTRANSLATED) {
      assert.ok(configured.includes(locale), `I18N_CHECK_UNTRANSLATED names "${locale}", which LOCALES does not configure`);
      assert.notEqual(locale, DEFAULT_LOCALE, "the default locale always has a dictionary");
      assert.equal(hasUiStrings(locale), false, `I18N_CHECK_UNTRANSLATED names "${locale}", which has a dictionary`);
    }
  });

  it("gives every dictionary exactly the keys, kinds and arities of the default one", () => {
    const expected = shape(uiStrings(DEFAULT_LOCALE));

    for (const locale of UI_STRING_LOCALES) {
      assert.deepEqual(shape(uiStrings(locale)), expected, `"${locale}" differs from "${DEFAULT_LOCALE}"`);
    }
  });

  it("leaves no string empty", () => {
    for (const locale of UI_STRING_LOCALES) {
      for (const { path, value } of leaves(uiStrings(locale))) {
        if (typeof value === "string") {
          assert.notEqual(value.trim(), "", `${locale}.${path} is empty`);
        }
      }
    }
  });

  it("answers every template with text for any count", () => {
    for (const locale of UI_STRING_LOCALES) {
      for (const { path, template } of templates(locale)) {
        for (const count of COUNTS) {
          const text = template(...[count, ...ARGUMENTS].slice(0, template.length));

          assert.equal(typeof text, "string", `${locale}.${path}(${count}) is not a string`);
          assert.notEqual(String(text).trim(), "", `${locale}.${path}(${count}) is empty`);
        }
      }
    }
  });

  it("uses every argument a template takes", () => {
    for (const locale of UI_STRING_LOCALES) {
      for (const { path, template } of templates(locale)) {
        const args = ARGUMENTS.slice(0, template.length);
        const text = String(template(...args));

        for (const arg of args) {
          assert.ok(text.includes(String(arg)), `${locale}.${path} leaves out argument ${arg}: "${text}"`);
        }
      }
    }
  });

  it("falls back to the default dictionary for a locale without one", () => {
    for (const locale of ["zz", "", "constructor", "__proto__", "toString", undefined, null]) {
      assert.equal(hasUiStrings(locale), false, String(locale));
      assert.equal(uiStrings(locale), uiStrings(DEFAULT_LOCALE), String(locale));
    }
  });

  it("keeps the English copy's wording for counts", () => {
    const { list, article } = uiStrings("en");
    const names = formatList("en", ["Design", "Strategy"]);

    assert.equal(list.articleCount(0), "0 articles");
    assert.equal(list.articleCount(1), "1 article");
    assert.equal(list.articleCount(3), "3 articles");
    assert.equal(list.matching(list.articleCount(2), names), "2 articles matching Design and Strategy");
    assert.equal(article.minRead(4), "4 min read");
  });
});

describe("formatList", () => {
  it("keeps the serial comma the English copy has always used", () => {
    assert.equal(formatList("en", ["Design", "Strategy", "Content"]), "Design, Strategy, and Content");
  });

  it("joins in the default dictionary's language for a locale without one", () => {
    const items = ["Design", "Strategy", "Content"];

    assert.equal(formatList("zz", items), formatList(DEFAULT_LOCALE, items));
    assert.equal(formatList(undefined, items), formatList(DEFAULT_LOCALE, items));
  });

  it("joins every dictionary's language", () => {
    for (const locale of UI_STRING_LOCALES) {
      const joined = formatList(locale, ["A", "B", "C"]);

      assert.ok(joined.startsWith("A") && joined.endsWith("C") && joined.includes("B"), `${locale}: "${joined}"`);
    }
  });
});
