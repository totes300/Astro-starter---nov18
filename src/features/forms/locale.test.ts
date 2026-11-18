import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_LOCALE, LOCALE_IDS } from "~/sanity/i18n";
import { formLocale, LOCALE_FIELD_NAME } from "./locale";

const posted = (value?: string) => {
  const formData = new FormData();

  if (value !== undefined) {
    formData.set(LOCALE_FIELD_NAME, value);
  }

  return formData;
};

test("formLocale keeps a configured locale the page posted", () => {
  for (const locale of LOCALE_IDS) {
    assert.equal(formLocale(posted(locale)), locale);
  }
});

test("formLocale reads a missing, unknown or differently spelled locale as the default", () => {
  for (const value of [undefined, "", "zz", "EN", "en-GB", " en"]) {
    assert.equal(formLocale(posted(value)), DEFAULT_LOCALE, String(value));
  }
});
