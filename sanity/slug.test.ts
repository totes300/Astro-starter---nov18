import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { foldDiacritics, slugifyText, suggestUri, uriFormatIssue } from "./slug";

describe("foldDiacritics", () => {
  it("strips Latin marks and spells out the letters that do not decompose", () => {
    assert.equal(foldDiacritics("La qualità è già così"), "La qualita e gia cosi");
    assert.equal(foldDiacritics("Ærø Œuvre Straße Łódź Þór Đakovo"), "AEro OEuvre Strasse Lodz THor Dakovo");
    assert.equal(foldDiacritics("æ ø œ đ ł þ ß ẞ"), "ae o oe d l th ss SS");
  });

  it("folds decomposed input the same as composed", () => {
    assert.equal(foldDiacritics("qualità".normalize("NFD")), "qualita");
  });

  it("leaves other scripts untouched", () => {
    for (const text of ["Καλημέρα κόσμε", "Привет, йога", "日本語のページ", "がぎぐ"]) {
      assert.equal(foldDiacritics(text), text.normalize("NFC"));
    }
  });
});

describe("slugifyText", () => {
  it("kebab-cases to ASCII for Latin text", () => {
    assert.equal(slugifyText("La qualità"), "la-qualita");
    assert.equal(slugifyText("Æsir Straße"), "aesir-strasse");
    assert.equal(slugifyText("What's New? 2024"), "what-s-new-2024");
  });

  it("keeps other scripts", () => {
    assert.equal(slugifyText("Καλημέρα Κόσμε"), "καλημέρα-κόσμε");
    assert.equal(slugifyText("Привет мир"), "привет-мир");
  });
});

describe("uriFormatIssue", () => {
  it("accepts every URI shape the site stores", () => {
    for (const uri of [
      "/",
      "/xx",
      "/about",
      "/legal/terms-of-service",
      "/blog/model-content-not-pages",
      "/blog/authors/tomás-herrera",
      "/xx/blog/model-content-not-pages",
      "/καλημέρα",
      "/日本語",
    ]) {
      assert.equal(uriFormatIssue(uri), undefined, uri);
    }
  });

  it("rejects what a request path would never match, with a corrected suggestion", () => {
    assert.equal(uriFormatIssue("about"), 'A URI must start with "/". Use "/about".');
    assert.equal(uriFormatIssue("/xx//about"), 'A URI cannot contain "//". Use "/xx/about".');
    assert.equal(uriFormatIssue("/about/"), 'A URI cannot end with "/". Use "/about".');
    assert.equal(uriFormatIssue("/La-Qualità"), 'A URI cannot contain capital letters. Use "/la-qualita".');
    assert.equal(
      uriFormatIssue("/about us?x=1"),
      'A URI may only contain lowercase letters, digits, "-" and "/" (found " ", "?", "="). Use "/about-us-x-1".'
    );
    assert.match(uriFormatIssue("/a_b") ?? "", /found "_"/);
    assert.match(uriFormatIssue("/50%") ?? "", /found "%"/);
  });

  it("always suggests a URI that passes", () => {
    for (const uri of ["About Us", "/Chi Siamo/", "//x//y//", "/Straße#top", "/"]) {
      assert.equal(uriFormatIssue(suggestUri(uri)), undefined, uri);
    }
  });
});
