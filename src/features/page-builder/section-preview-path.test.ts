import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_LOCALE, IS_I18N_ENABLED, LOCALE_IDS } from "~/sanity/i18n";
import { isSectionPreviewPath, isSectionPreviewRequestPath } from "./section-preview-path";

const SECONDARY = LOCALE_IDS.find((id) => id !== DEFAULT_LOCALE) ?? DEFAULT_LOCALE;

describe("isSectionPreviewPath", () => {
  it("matches the specimen route and every section under it", () => {
    assert.equal(isSectionPreviewPath("/section-preview"), true);
    assert.equal(isSectionPreviewPath("/section-preview/cta-section"), true);
  });

  // The sitemap reads `uri.current`, which an editor may have typed without the leading slash.
  it("matches a CMS uri stored without its leading slash", () => {
    assert.equal(isSectionPreviewPath("section-preview/cta-section"), true);
  });

  it("leaves alone a path that only starts alike", () => {
    assert.equal(isSectionPreviewPath("/section-previews"), false);
    assert.equal(isSectionPreviewPath("/blog/section-preview"), false);
    assert.equal(isSectionPreviewPath("/"), false);
  });
});

describe("isSectionPreviewRequestPath", () => {
  it("follows every spelling of the route a request can send", () => {
    for (const pathname of [
      "/section-preview",
      "/section-preview/hero",
      "/section-preview/hero.html",
      "//section-preview/hero/",
      "/%73ection-preview/hero",
    ]) {
      assert.equal(isSectionPreviewRequestPath(pathname), true, pathname);
    }
  });

  it("leaves alone a path that only starts alike, and one it cannot read", () => {
    for (const pathname of ["/section-previews", "/blog/section-preview", "/about", "/a%2Fsection-preview"]) {
      assert.equal(isSectionPreviewRequestPath(pathname), false, pathname);
    }
  });

  it("follows the route under a language prefix", { skip: !IS_I18N_ENABLED }, () => {
    assert.equal(isSectionPreviewRequestPath(`/${SECONDARY}/section-preview`), true);
    assert.equal(isSectionPreviewRequestPath(`/${SECONDARY}/section-preview/hero`), true);
    assert.equal(isSectionPreviewRequestPath(`/${SECONDARY}/blog/section-preview`), false);
  });
});
