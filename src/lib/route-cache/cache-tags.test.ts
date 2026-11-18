import assert from "node:assert/strict";
import { test } from "node:test";
import { cacheTagHeader, encodeCacheTag } from "./cache-tags";

test("tags already in printable ASCII pass through unchanged", () => {
  for (const tag of ["page", "doc:homepage", "/fr/blog/post", "astro-path:/about", "route-cache:all"]) {
    assert.equal(encodeCacheTag(tag), tag);
  }
});

test("a space, a comma, a percent sign or a non-ASCII character is percent-encoded, so one URI stays one tag", () => {
  assert.equal(encodeCacheTag("/über uns"), "/%C3%BCber%20uns");
  assert.equal(encodeCacheTag("/a,b"), "/a%2Cb");
  assert.equal(encodeCacheTag("/100%"), "/100%25");
  assert.equal(encodeCacheTag("/emoji-😀"), "/emoji-%F0%9F%98%80");
});

test("an empty or overlong tag is left out rather than silently dropped by Cloudflare", () => {
  assert.equal(encodeCacheTag(""), null);
  assert.equal(encodeCacheTag(`/${"a".repeat(1024)}`), null);
  assert.equal(cacheTagHeader(["page", "", "page"]), "page");
});

test("tags that would not fit one header make the response unstorable instead of half-tagged", () => {
  const tags = Array.from({ length: 20 }, (_, index) => `/${String(index).padStart(1000, "x")}`);

  assert.equal(cacheTagHeader(tags), null);
});
