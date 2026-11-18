import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LOCALE, LOCALES } from "~/sanity/i18n";
import { formatDate } from "./format-date";

const DAY_MONTH_YEAR = { day: "numeric", month: "short", year: "numeric" } as const;

describe("formatDate", () => {
  it("prints day, short month and year in British English for the English copy", () => {
    assert.equal(formatDate("2026-07-21", "en"), "21 Jul 2026");
  });

  it("formats each configured locale with its own region", () => {
    for (const { id, region } of LOCALES as readonly { id: string; region?: string }[]) {
      const expected = new Date(2026, 6, 21).toLocaleDateString(region ? `${id}-${region}` : id, DAY_MONTH_YEAR);

      assert.equal(formatDate("2026-07-21", id), expected, id);
    }
  });

  it("formats an unknown locale as the default one", () => {
    assert.equal(formatDate("2026-07-21", "zz"), formatDate("2026-07-21", DEFAULT_LOCALE));
  });

  it("returns the raw value when it will not parse", () => {
    assert.equal(formatDate("not a date", DEFAULT_LOCALE), "not a date");
  });
});
