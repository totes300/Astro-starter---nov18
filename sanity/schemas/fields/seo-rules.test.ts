import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { effectiveText, hasAltText, hasSocialProfile, lengthIssue, SEO_DESCRIPTION_LENGTH, SEO_TITLE_LENGTH } from "./seo-rules";

describe("effectiveText", () => {
  it("prefers the field's own text and falls back when it is empty or blank", () => {
    assert.equal(effectiveText(" Own title ", "Page title"), "Own title");
    assert.equal(effectiveText("", "Page title"), "Page title");
    assert.equal(effectiveText("   ", "Page title"), "Page title");
    assert.equal(effectiveText(undefined, undefined), "");
    assert.equal(effectiveText(42, ["not text"]), "");
  });
});

describe("lengthIssue", () => {
  it("passes text inside the band and empty text", () => {
    assert.equal(lengthIssue("A title that fits", SEO_TITLE_LENGTH, "This title"), null);
    assert.equal(lengthIssue("", SEO_TITLE_LENGTH, "This title"), null);
  });

  it("names the length and the band when the text is too short or too long", () => {
    assert.equal(
      lengthIssue("HSBC", SEO_TITLE_LENGTH, "This title"),
      "This title is 4 characters. Search results read best between 10 and 70."
    );
    assert.equal(
      lengthIssue("x".repeat(161), SEO_DESCRIPTION_LENGTH, "This description"),
      "This description is 161 characters. Search engines cut it after about 160."
    );
  });
});

describe("hasAltText", () => {
  it("reads a plain string", () => {
    assert.equal(hasAltText("A product dashboard", "en", "en"), true);
    assert.equal(hasAltText("  ", "en", "en"), false);
  });

  it("reads the document's language, then the default one, like the renderer", () => {
    assert.equal(hasAltText({ en: "A dashboard", fr: "Un tableau de bord" }, "fr", "en"), true);
    assert.equal(hasAltText({ en: "A dashboard" }, "fr", "en"), true);
    assert.equal(hasAltText({ fr: "" }, "fr", "en"), false);
  });

  it("treats a missing or empty value as no alt text", () => {
    for (const value of [undefined, null, {}, 3]) {
      assert.equal(hasAltText(value, "en", "en"), false, JSON.stringify(value));
    }
  });
});

describe("hasSocialProfile", () => {
  it("counts a contact whose link leaves the site", () => {
    assert.equal(
      hasSocialProfile([
        { appLink: { type: "internal" } },
        { appLink: { type: "external", external: "https://www.linkedin.com/company/example" } },
      ]),
      true
    );
  });

  it("ignores internal links, empty external ones and a missing list", () => {
    assert.equal(hasSocialProfile([{ appLink: { type: "internal" } }, { appLink: { type: "external", external: "" } }]), false);
    assert.equal(hasSocialProfile(undefined), false);
    assert.equal(hasSocialProfile([null]), false);
  });
});
