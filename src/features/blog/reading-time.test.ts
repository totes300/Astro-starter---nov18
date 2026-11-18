import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { UI_STRING_LOCALES, uiStrings } from "~/features/i18n/strings";
import { countWords, formatReadingTime, readingTimeMinutes } from "./reading-time";

function block(...texts: string[]) {
  return { _type: "block", children: texts.map((text) => ({ text })) };
}

describe("countWords", () => {
  it("returns 0 for empty input", () => {
    assert.equal(countWords(), 0);
    assert.equal(countWords(null), 0);
    assert.equal(countWords([]), 0);
  });

  it("counts words across spans and blocks", () => {
    assert.equal(countWords([block("one two three"), block("four", " five")]), 5);
  });

  it("ignores non-block nodes such as media", () => {
    assert.equal(countWords([block("one two"), { _type: "mediaBlock" }]), 2);
  });

  it("collapses irregular whitespace instead of counting empty strings", () => {
    assert.equal(countWords([block("  one   two  ")]), 2);
  });
});

describe("readingTimeMinutes", () => {
  it("returns 0 for an empty body", () => {
    assert.equal(readingTimeMinutes([]), 0);
  });

  it("rounds up to a whole minute", () => {
    assert.equal(readingTimeMinutes([block("word ".repeat(201).trim())]), 2);
  });

  it("never returns less than a minute for non-empty content", () => {
    assert.equal(readingTimeMinutes([block("just a few words")]), 1);
  });
});

describe("formatReadingTime", () => {
  it("is empty when there is nothing to read", () => {
    assert.equal(formatReadingTime([], "en"), "");
  });

  it("labels the minutes", () => {
    assert.equal(formatReadingTime([block("a short body")], "en"), "1 min read");
  });

  it("labels the minutes in the page's language", () => {
    const body = [block("word ".repeat(201).trim())];

    for (const locale of UI_STRING_LOCALES) {
      assert.equal(formatReadingTime(body, locale), uiStrings(locale).article.minRead(2), locale);
    }
  });

  it("labels an unknown language in the default one", () => {
    assert.equal(formatReadingTime([block("a short body")], "zz"), "1 min read");
  });
});
