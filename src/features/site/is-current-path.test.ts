import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_LOCALE, IS_I18N_ENABLED, LOCALE_IDS, withLocalePrefix } from "~/sanity/i18n";
import { isCurrentPath, isWithinPath } from "./is-current-path";

const secondary = LOCALE_IDS.find((id) => id !== DEFAULT_LOCALE) ?? DEFAULT_LOCALE;

// Any four of the marks stega encodes with, which is the shortest run `stegaClean` strips.
const STEGA = "​‌‍﻿";

test("a link to the page is current whatever its trailing slash, query or hash", () => {
  assert.equal(isCurrentPath("/about", "/about"), true);
  assert.equal(isCurrentPath("/about", "/about/"), true);
  assert.equal(isCurrentPath("/about", "/about?ref=nav#team"), true);
  assert.equal(isCurrentPath("/", "/"), true);
});

test("a link elsewhere, or with no href, is not current", () => {
  assert.equal(isCurrentPath("/about", "/blog"), false);
  assert.equal(isCurrentPath("/about", "/about/team"), false);
  assert.equal(isCurrentPath("/about", null), false);
  assert.equal(isCurrentPath("/about", ""), false);
});

test("an error page rendered without middleware has no path, and nothing is current", () => {
  assert.equal(isCurrentPath(undefined, "/"), false);
});

test("a preview href's stega marks do not break the match", () => {
  assert.equal(isCurrentPath("/about", `/about${STEGA}`), true);
});

test("the prefixed path is what matches, never its unprefixed twin", { skip: !IS_I18N_ENABLED }, () => {
  const path = withLocalePrefix(secondary, "/about");

  assert.equal(isCurrentPath(path, path), true);
  assert.equal(isCurrentPath(path, "/about"), false);
});

test("a section link stays current on the pages under it, and a home link only on home", () => {
  assert.equal(isWithinPath("/blog/model-content", "/blog"), true);
  assert.equal(isWithinPath("/blog", "/blog/"), true);
  assert.equal(isWithinPath("/blogroll", "/blog"), false);
  assert.equal(isWithinPath("/about", "/"), false);
  assert.equal(isWithinPath("/", "/"), true);
  assert.equal(isWithinPath("/blog/x", "https://example.com/blog"), false);
  assert.equal(isWithinPath(undefined, "/blog"), false);
});

test("a localized home link does not claim the pages of its language", { skip: !IS_I18N_ENABLED }, () => {
  const home = withLocalePrefix(secondary, "/");

  assert.equal(isWithinPath(withLocalePrefix(secondary, "/blog"), home), false);
  assert.equal(isWithinPath(home, home), true);
});
