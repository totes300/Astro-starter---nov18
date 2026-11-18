import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_LOCALE, LOCALE_IDS } from "~/sanity/i18n";
import { fallbackLang } from "./content-lang";

const secondary: string = LOCALE_IDS.find((id) => id !== DEFAULT_LOCALE) ?? "zz";

test("fallbackLang marks copy read in another language than the page", () => {
  assert.equal(fallbackLang(DEFAULT_LOCALE, secondary), DEFAULT_LOCALE);
});

test("fallbackLang leaves copy in the page's own language unmarked", () => {
  assert.equal(fallbackLang(DEFAULT_LOCALE, DEFAULT_LOCALE), undefined);
  assert.equal(fallbackLang(secondary, secondary), undefined);
});

test("fallbackLang marks nothing when either language is unknown", () => {
  assert.equal(fallbackLang(undefined, secondary), undefined);
  assert.equal(fallbackLang(null, secondary), undefined);
  assert.equal(fallbackLang("", secondary), undefined);
  assert.equal(fallbackLang(DEFAULT_LOCALE, undefined), undefined);
});
