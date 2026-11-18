import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodePathname, normalizePathname } from "./pathname";

describe("normalizePathname", () => {
  it("drops a trailing slash and keeps the root", () => {
    assert.equal(normalizePathname("/about/"), "/about");
    assert.equal(normalizePathname("/"), "/");
  });
});

describe("decodePathname", () => {
  it("turns the escaped request path back into the stored one", () => {
    assert.equal(decodePathname(new URL("https://example.com/it/caffè").pathname), "/it/caffè");
    assert.equal(decodePathname("/blog/authors/tom%C3%A1s-herrera"), "/blog/authors/tomás-herrera");
  });

  it("keeps reserved escapes, so an encoded slash never becomes a path separator", () => {
    assert.equal(decodePathname("/a%2Fb"), "/a%2Fb");
  });

  it("leaves a malformed escape as sent", () => {
    assert.equal(decodePathname("/100%"), "/100%");
  });
});
