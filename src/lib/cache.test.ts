import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { CacheOptions } from "astro";
import { DEFAULT_LOCALE, IS_I18N_ENABLED, LOCALE_IDS, withLocalePrefix } from "~/sanity/i18n";
import { CACHE_TTL, cacheResponse, docCacheTags, SITE_WIDE_CACHE_TAGS } from "./cache";

function recorder() {
  const calls: (CacheOptions | false)[] = [];

  return { calls, cache: { set: (input: CacheOptions | false) => calls.push(input) } };
}

test("cacheResponse caches a public render with the options it is given", () => {
  const { calls, cache } = recorder();

  cacheResponse({ cache, locals: {} }, { ...CACHE_TTL, tags: ["page"] });

  assert.deepEqual(calls, [{ ...CACHE_TTL, tags: ["page"] }]);
});

test("cacheResponse lets a route decline to cache a render", () => {
  const { calls, cache } = recorder();

  cacheResponse({ cache, locals: {} }, false);

  assert.deepEqual(calls, [false]);
});

test("cacheResponse never caches a draft session render, whatever the route asks", () => {
  const { calls, cache } = recorder();

  cacheResponse({ cache, locals: { draftSession: true } }, { ...CACHE_TTL, tags: ["page"] });

  assert.deepEqual(calls, [false]);
});

/** The tags the revalidate webhook busts for a published homepage, the same `docCacheTags` a route sets. */
function homepageTags(locale: string): string[] {
  return docCacheTags({ _id: `home-${locale}`, _type: "page", uri: withLocalePrefix(locale, "/") });
}

test("publishing another language's homepage refreshes every page, whose switcher may link it", {
  skip: !IS_I18N_ENABLED,
}, () => {
  for (const locale of LOCALE_IDS.filter((id) => id !== DEFAULT_LOCALE)) {
    assert.ok(
      homepageTags(locale).some((tag) => SITE_WIDE_CACHE_TAGS.includes(tag)),
      `${locale}'s homepage busts no site-wide tag`
    );
  }
});

test("an edit to the default language's homepage busts the pages, not every response", () => {
  assert.deepEqual(
    homepageTags(DEFAULT_LOCALE).filter((tag) => SITE_WIDE_CACHE_TAGS.includes(tag)),
    []
  );
});

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);

    if (statSync(path).isDirectory()) {
      return routeFiles(path);
    }

    return /\.(astro|ts)$/.test(name) && !name.endsWith(".test.ts") ? [path] : [];
  });
}

test("no page or endpoint sets its cache directly, so none can undo the draft session opt-out", () => {
  const pages = join(import.meta.dirname, "..", "pages");
  const files = routeFiles(pages);
  const direct = files.filter((file) => /\bcache\.set\(/.test(readFileSync(file, "utf8")));

  assert.ok(
    files.some((file) => file.endsWith(".ts")),
    "the scan reaches the endpoints"
  );
  assert.deepEqual(direct, []);
});
