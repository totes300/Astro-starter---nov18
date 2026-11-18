import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SANITY_PAGE_DOCUMENT_TYPE } from "../../../sanity/constants";
import { DEFAULT_LOCALE, IS_I18N_ENABLED, LOCALE_IDS } from "../../../sanity/i18n";
import { SECTION_TYPES, SECTIONS, type Section, type SectionTypes, sectionPath } from "../../../sanity/sections";
import type { LanguageCopy } from "./language";
import {
  findTargetCollisions,
  pathKey,
  planRedirectRetargets,
  planRedirects,
  planSegmentChanges,
  planSegmentMigration,
  type UriChange,
} from "./segments";

// A stored word no section names stands in for a renamed one; a trim that leaves no section skips the lot.
const [section] = SECTIONS as string[];
const types: SectionTypes | undefined = section ? (SECTION_TYPES as Record<string, SectionTypes>)[section] : undefined;
const OLD = "old-word";
const noSection = { skip: !section };
const secondary: string = LOCALE_IDS.find((locale) => locale !== DEFAULT_LOCALE) ?? DEFAULT_LOCALE;

const at = (_id: string, _type: string, uri: string, language?: string): LanguageCopy => ({
  _id,
  _type,
  _rev: `rev-${_id}`,
  uri,
  ...(language === undefined ? {} : { language }),
});

const move = (id: string, from: string, to: string): UriChange => ({ id, type: "item", from, to });

describe("pathKey", () => {
  it("compares paths the way the redirects match them", () => {
    assert.equal(pathKey("/Blog/Post/"), "/blog/post");
    assert.equal(pathKey("/blog/post?x=1#top"), "/blog/post");
    assert.equal(pathKey("/"), "/");
  });
});

describe("planSegmentChanges", noSection, () => {
  const item = types?.item ?? "";
  const word = (rest = "") => sectionPath(DEFAULT_LOCALE, section as Section, rest);

  it("moves the index, items and nested types from an old word to the current one, every copy", () => {
    const nested = types?.nested ?? [];
    const { changes, unplaced } = planSegmentChanges(
      [
        at("a", item, `/${OLD}/hello`),
        at("drafts.a", item, `/${OLD}/hello-draft`),
        at("versions.r1.a", item, `/${OLD}/hello-version`),
        at("b", item, word("/fine")),
        ...(types?.index ? [at("index", types.index, `/${OLD}`)] : []),
        ...nested.map((type) => at(`nested-${type}`, type, `/${OLD}/sub/person`)),
      ],
      DEFAULT_LOCALE
    );

    assert.deepEqual(unplaced, []);
    assert.deepEqual(
      changes.map(({ id, to }) => [id, to]),
      [
        ["a", word("/hello")],
        ["drafts.a", word("/hello-draft")],
        ["versions.r1.a", word("/hello-version")],
        ...(types?.index ? [["index", word()]] : []),
        ...nested.map((type) => [`nested-${type}`, word("/sub/person")]),
      ]
    );
  });

  it("leaves pages, unconfigured and empty languages alone, and reports slugless items", () => {
    const { changes, unplaced } = planSegmentChanges(
      [
        at("page", SANITY_PAGE_DOCUMENT_TYPE, `/${OLD}/hello`),
        at("ghost", item, `/zz/${OLD}/hello`, "zz"),
        at("empty", item, `/${OLD}/hello`, ""),
        at("stray", item, "/hello"),
      ],
      DEFAULT_LOCALE
    );

    assert.deepEqual(changes, []);
    assert.deepEqual(
      unplaced.map(({ _id }) => _id),
      ["stray"]
    );
  });

  it("moves a draft with no language in its document's language, prefix kept", { skip: !IS_I18N_ENABLED }, () => {
    const uri = `/${secondary}/${OLD}/hello`;
    const { changes } = planSegmentChanges([at("a", item, uri, secondary), at("drafts.a", item, uri)], DEFAULT_LOCALE);
    const expected = sectionPath(secondary, section as Section, "/hello");

    assert.deepEqual(
      changes.map(({ id, to }) => [id, to]),
      [
        ["a", expected],
        ["drafts.a", expected],
      ]
    );
  });
});

describe("findTargetCollisions", () => {
  it("stops a move onto another document's URL or an existing redirect, not onto its own draft's", () => {
    const changes = [move("a", "/old/one", "/new/one"), move("b", "/old/two", "/new/two"), move("c", "/old/three", "/new/three")];
    const holders = [at("drafts.a", "item", "/new/one"), at("page", "page", "/New/Two/")];
    const collisions = findTargetCollisions(changes, holders, [{ from: "/new/three", to: "/elsewhere" }]);

    assert.deepEqual(
      collisions.map(({ id }) => id),
      ["b", "c"]
    );
  });

  it("stops two moves landing on one URL", () => {
    const collisions = findTargetCollisions([move("a", "/old/x", "/new/x"), move("b", "/older/x", "/new/x")], [], []);

    assert.deepEqual(
      collisions.map(({ id }) => id),
      ["b"]
    );
  });
});

describe("planRedirects", () => {
  it("redirects each public URL once, never a draft's, an already redirected one or one that answers again", () => {
    const redirects = planRedirects(
      [
        move("a", "/old/one", "/new/one"),
        move("drafts.a", "/old/one", "/new/one"),
        move("versions.r1.c", "/old/four", "/new/four"),
        move("b", "/old/two", "/new/two"),
        move("d", "/old/three", "/new/three"),
      ],
      [{ _key: "k", from: "/OLD/two/", to: "/elsewhere" }],
      new Set(["/old/three"])
    );

    assert.deepEqual(
      redirects.map(({ from, to, statusCode, _type }) => [from, to, statusCode, _type]),
      [["/old/one", "/new/one", 301, "redirect"]]
    );
    assert.match(redirects[0]?._key ?? "", /^[0-9a-f]{24}$/);
  });
});

describe("planRedirectRetargets", () => {
  it("re-aims a redirect at the new URL, keeping its anchor, instead of chaining", () => {
    const { retarget, manual } = planRedirectRetargets(
      [move("a", "/old/one", "/new/one"), move("drafts.b", "/old/two", "/new/two")],
      [
        { _key: "k1", from: "/legacy", to: "/old/one#top" },
        { _key: "k2", from: "/draft-only", to: "/old/two" },
        { _key: "k3", ref: "redirect-doc", from: "/linked", to: "/old/one" },
      ]
    );

    assert.deepEqual(retarget, [{ key: "k1", to: "/new/one#top" }]);
    assert.deepEqual(
      manual.map(({ from }) => from),
      ["/linked"]
    );
  });
});

describe("planSegmentMigration", noSection, () => {
  const item = types?.item ?? "";
  const target = sectionPath(DEFAULT_LOCALE, section as Section, "/hello");

  it("gives every copy of the settings the redirects it lacks, and leaves a locked version alone", () => {
    const plan = planSegmentMigration({
      documents: [at("a", item, `/${OLD}/hello`), at("versions.r2.b", item, `/${OLD}/locked`)],
      holders: [],
      settings: [
        { _id: "siteSettings", _rev: "r", redirects: [{ _key: "k1", from: "/legacy", to: `/${OLD}/hello` }] },
        { _id: "drafts.siteSettings", redirects: [{ _key: "x", from: `/${OLD}/hello`, to: target }] },
        { _id: "versions.r2.siteSettings", redirects: [] },
        { _id: "other", redirects: [] },
      ],
      settingsId: "siteSettings",
      defaultLocale: DEFAULT_LOCALE,
      releases: [{ name: "r2", state: "scheduled" }],
    });

    assert.deepEqual(
      plan.changes.map(({ id }) => id),
      ["a"]
    );
    assert.deepEqual(
      plan.locked.map(({ id }) => id),
      ["versions.r2.b", "versions.r2.siteSettings"]
    );
    assert.deepEqual(
      plan.settings.map(({ id, rev, add, retarget }) => [id, rev, add.map(({ from }) => from), retarget]),
      [["siteSettings", "r", [`/${OLD}/hello`], [{ key: "k1", to: target }]]]
    );
    assert.deepEqual(
      plan.redirects.map(({ from, to }) => [from, to]),
      [[`/${OLD}/hello`, target]]
    );
    assert.deepEqual(plan.collisions, []);
  });
});
