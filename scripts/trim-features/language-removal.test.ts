import assert from "node:assert/strict";
import { test } from "node:test";
import {
  dedupeHolders as trimDedupeHolders,
  publishedIdOf as trimPublishedIdOf,
  referenceStrength as trimReferenceStrength,
} from "./dataset";
import {
  applyLanguageRemoval,
  buildLocalizedAssetsQuery,
  buildReferrersQuery,
  buildSharedDocumentsQuery,
  buildTranslatedDocumentsQuery,
  dedupeHolders,
  describeLanguageCount,
  filterSeedToLocales,
  formatLanguageRemovalPlan,
  hasLanguageLeftovers,
  isEmptyPlan,
  type LanguageRemovalConfig,
  type LanguageRemovalPlan,
  languageCensus,
  languageRemovalMutations,
  narrowLlmsTxt,
  planGrowth,
  planLanguageRemoval,
  publishedIdOf,
  type RawDocument,
  readLanguageRemovalInput,
  readLanguageScan,
  referenceStrength,
  refusalReasons,
  releaseOf,
  removalBlocker,
  strandedLanguages,
} from "./language-removal";

// Fixture locales stand on their own: en is the default, fr goes, de is a language nobody configured.
const BASE = {
  defaultLocale: "en",
  i18nTypes: ["site", "page", "blog", "article", "legalPage", "person"],
  localizedFields: { articleCategory: ["name"] },
};

const DROP_FR: LanguageRemovalConfig = { ...BASE, keep: ["en"], removed: ["fr"] };

const doc = (_id: string, _type: string, language?: unknown, uri?: string, extra: Record<string, unknown> = {}): RawDocument => ({
  _id,
  _type,
  ...(language === undefined ? {} : { language }),
  ...(uri === undefined ? {} : { uri: { _type: "slug", current: uri } }),
  ...extra,
});

const ref = (_ref: string, weak = false) => ({ _type: "reference", _ref, ...(weak ? { _weak: true } : {}) });

const link = (_key: unknown, language: string, target: string | null, strong = false) => ({
  _key,
  _type: "internationalizedArrayReferenceValue",
  language,
  value: target === null ? { _type: "reference" } : { _type: "reference", _ref: target, ...(strong ? {} : { _weak: true }) },
});

const metadata = (_id: string, ...translations: unknown[]): RawDocument => ({ _id, _type: "translation.metadata", translations });

const asset = (_id: string, fields: Record<string, unknown>): RawDocument => ({ _id, _type: "sanity.imageAsset", ...fields });

const weakLinkTo = (target: string) => ({
  body: [{ _key: "b1", _type: "block", markDefs: [{ _key: "m1", _type: "link", internal: { link: ref(target, true) } }] }],
});

/** An en+fr dataset with drafts, a release version, a ghost language, links in every shape and localized assets. */
const DATASET: RawDocument[] = [
  doc("site", "site", "en"),
  doc("site-fr", "site", "fr", undefined, { legal: [{ _key: "l1", ...ref("legal-fr", true) }] }),
  doc("homepage", "page", "en", "/"),
  doc("homepage-fr", "page", "fr", "/fr"),
  doc("drafts.homepage-fr", "page", "fr", "/fr"),
  doc("versions.rlaunch.homepage-fr", "page", undefined, undefined, { _system: { delete: true } }),
  doc("about", "page", "en", "/about"),
  doc("about-fr", "page", "fr", "/fr/a-propos"),
  doc("legal-fr", "legalPage", "fr", "/fr/legal/conditions"),
  doc("article", "article", "en", "/blog/model", { author: ref("person"), categories: [{ _key: "c1", ...ref("category-a") }] }),
  doc("article-fr", "article", "fr", "/fr/blog/modele", {
    author: ref("person-fr"),
    categories: [{ _key: "c1", ...ref("category-a") }],
  }),
  doc("person", "person", "en", "/blog/authors/demo"),
  doc("person-fr", "person", "fr", "/fr/blog/authors/demo"),
  doc("person-de", "person", "de", "/de/blog/authors/demo"),
  doc("page-de", "page", "de", "/de/x"),
  doc("contact", "page", "en", "/contact"),
  doc("drafts.contact", "page", "fr", "/contact"),
  doc("legacy", "page", undefined, "/legacy"),
  doc("links", "page", "en", "/links", weakLinkTo("about-fr")),
  doc("drafts.links", "page", "en", "/links", weakLinkTo("about-fr")),
  doc("category-a", "articleCategory", undefined, undefined, {
    name: { en: "Modelling", fr: "Modélisation", de: "Modellierung" },
  }),
  doc("drafts.category-a", "articleCategory", undefined, undefined, {
    name: { _type: "localized", en: "Modelling", fr: "Modélisation" },
  }),
  doc("category-b", "articleCategory", undefined, undefined, { name: "Publishing" }),
  metadata("meta-home", link("k1", "en", "homepage"), link("k2", "fr", "homepage-fr")),
  metadata("meta-about", link("k1", "en", "about"), link("k2", "fr", "about-fr", true)),
  metadata("meta-article", link("k1", "en", "article"), link("k2", "fr", "article-fr")),
  metadata("meta-person", link("k1", "en", "person"), link("k2", "fr", "person-fr"), link("k3", "de", "person-de")),
  metadata("meta-gone", link("k1", "en", "legacy"), link("k2", "fr", "old-fr"), link("k3", "de", "page-de")),
];

const ASSETS: RawDocument[] = [
  asset("image-1", { altText: { en: "A gradient", fr: "Un dégradé" } }),
  asset("image-2", { altText: { fr: "Seulement" }, title: { _type: "localized" } }),
  asset("image-3", { altText: "Plain" }),
];

const RELEASES = [{ name: "rlaunch", state: "active", title: "Launch", documents: 1 }] as const;

const plan = (overrides: Partial<Parameters<typeof planLanguageRemoval>[0]> = {}, config = DROP_FR) =>
  planLanguageRemoval({ documents: DATASET, assets: ASSETS, releases: RELEASES, ...overrides }, config);

const sorted = <T>(values: readonly T[]) => [...values].sort();

/** What these tests use of groq-js, which a project cut before it was a dependency may not have. */
type Groq = {
  parse(query: string): unknown;
  evaluate(tree: unknown, options: { dataset: unknown[] }): Promise<{ get(): Promise<unknown> }>;
};

const GROQ = "groq-js";

async function loadGroq(): Promise<Groq | undefined> {
  try {
    return (await import(GROQ)) as Groq;
  } catch {
    return undefined;
  }
}

test("ids and reference strength read exactly as the type purge reads them", () => {
  const ids = ["page", "drafts.page", "versions.r1.page", "versions.r1.drafts.page", "drafts.versions.x", "a.b"];

  for (const id of ids) {
    assert.equal(publishedIdOf(id), trimPublishedIdOf(id), id);
  }

  assert.equal(releaseOf("versions.rlaunch.homepage-fr"), "rlaunch");
  assert.equal(releaseOf("drafts.homepage-fr"), undefined);
  assert.equal(releaseOf("homepage-fr"), undefined);

  const holders = [
    { author: ref("x") },
    { links: [ref("x", true)] },
    { a: ref("x", true), b: { deep: [ref("x")] } },
    { other: ref("y") },
    { _ref: "x", _weak: false },
    null,
  ];

  for (const holder of holders) {
    assert.equal(referenceStrength(holder, "x"), trimReferenceStrength(holder, "x"), JSON.stringify(holder));
  }

  const listed = [
    { _id: "drafts.a", _type: "page" },
    { _id: "a", _type: "page", uri: "/a" },
    { _id: "versions.r.b", _type: "page" },
  ];

  assert.deepEqual(dedupeHolders(listed), trimDedupeHolders(listed));
});

test("removalBlocker refuses the default, a configured language, a missing one and anything not a code", () => {
  const config = { defaultLocale: "en", keep: ["en", "de"] };

  assert.match(removalBlocker("en", config) ?? "", /default locale/);
  assert.match(removalBlocker("de", config) ?? "", /still configured/);
  assert.match(removalBlocker("", config) ?? "", /sanity:migrate-backfill-language/);
  assert.match(removalBlocker("EN", config) ?? "", /not a language code/);
  assert.match(removalBlocker('["fr"]', config) ?? "", /not a language code/);
  assert.equal(removalBlocker("fr", config), undefined);
  assert.equal(removalBlocker("pt-BR", config), undefined);
});

test("every copy of a document in the language goes, a release version without a language included", () => {
  const result = plan();

  assert.deepEqual(sorted(result.deleteIds), [
    "about-fr",
    "article-fr",
    "drafts.homepage-fr",
    "homepage-fr",
    "legal-fr",
    "person-fr",
    "site-fr",
    "versions.rlaunch.homepage-fr",
  ]);
  assert.deepEqual(result.groups.find((group) => group.publishedId === "homepage-fr")?.ids, [
    "homepage-fr",
    "drafts.homepage-fr",
    "versions.rlaunch.homepage-fr",
  ]);
  assert.equal(result.groups.find((group) => group.publishedId === "homepage-fr")?.uri, "/fr");
});

test("copies that disagree on the language are left for a person, and a published copy without one is the default", () => {
  const result = plan();

  assert.deepEqual(result.mixed, [{ publishedId: "contact", type: "page", languages: ["en", "fr"] }]);
  assert.ok(!result.deleteIds.includes("drafts.contact"));
  assert.ok(!result.deleteIds.includes("legacy"));

  const legacyDraft = planLanguageRemoval(
    { documents: [doc("old", "page", undefined, "/old"), doc("drafts.old", "page", "fr", "/old")] },
    DROP_FR
  );

  assert.deepEqual(legacyDraft.deleteIds, []);
  assert.deepEqual(legacyDraft.mixed[0]?.languages, ["en", "fr"]);

  const missing = planLanguageRemoval({ documents: [doc("x", "page", ""), doc("drafts.x", "page", "fr")] }, DROP_FR);

  assert.deepEqual(missing.deleteIds, []);
  assert.deepEqual(missing.mixed[0]?.languages, ["", "fr"]);
});

test("an English page's language-less release version stays English", () => {
  const documents = [
    doc("page", "page", "en", "/page"),
    doc("versions.r1.page", "page", undefined, undefined, { _system: { delete: true } }),
  ];

  assert.ok(isEmptyPlan(planLanguageRemoval({ documents }, DROP_FR)));
});

test("a type without a language field is never read as a language", () => {
  const documents = [doc("snippet", "codeSnippet", "fr"), doc("submission", "contactFormSubmission", "fr")];

  assert.ok(isEmptyPlan(planLanguageRemoval({ documents }, DROP_FR)));
});

test("translation groups left with fewer than two links are deleted, the rest repaired, in the same plan", () => {
  const result = plan();

  assert.deepEqual(sorted(result.metadataDeletes), ["meta-about", "meta-article", "meta-home"]);
  assert.deepEqual(result.metadataPatches, [
    { id: "meta-person", unsetKeys: ["k2"] },
    { id: "meta-gone", unsetKeys: ["k2"] },
  ]);
});

test("a link without a target does not keep its group alive", () => {
  const documents = [
    doc("a", "page", "en"),
    doc("a-fr", "page", "fr"),
    metadata("meta", link("k1", "en", "a"), link("k2", "fr", "a-fr"), link("k3", "de", null)),
    metadata("meta-empty", link("k1", "en", "a"), link("k2", "fr", "a-fr"), link("k3", "de", "")),
  ];

  assert.deepEqual(planLanguageRemoval({ documents }, DROP_FR).metadataDeletes, ["meta", "meta-empty"]);
});

test("a link in the language stays while the document it points at survives", () => {
  const documents = [
    doc("a", "page", "en"),
    doc("drafts.a", "page", "fr"),
    doc("b", "page", "de"),
    metadata("meta", link("k1", "en", "x"), link("k2", "fr", "a"), link("k3", "de", "b")),
  ];
  const result = planLanguageRemoval({ documents }, DROP_FR);

  assert.deepEqual(result.metadataPatches, []);
  assert.deepEqual(result.metadataDeletes, []);
});

test("a link key no patch path can name is skipped when weak and refused when strong", () => {
  const group = (key: unknown, strong: boolean) => [
    doc("a", "page", "en"),
    doc("a-fr", "page", "fr"),
    doc("a-de", "page", "de"),
    metadata("meta", link("k1", "en", "a"), link(key, "fr", "a-fr", strong), link("k3", "de", "a-de")),
  ];
  const weak = planLanguageRemoval({ documents: group('bad"key', false) }, DROP_FR);
  const strong = planLanguageRemoval({ documents: group(7, true) }, DROP_FR);

  assert.deepEqual(weak.metadataPatches, []);
  assert.equal(weak.skipped[0]?.id, "meta");
  assert.deepEqual(weak.refusals, []);
  assert.equal(strong.refusals[0]?.id, "meta");
  assert.match(strong.refusals[0]?.reason ?? "", /strongly references a-fr/);
});

test("a strong reference from a surviving document blocks the plan, uncapped, while weak ones only dangle", () => {
  const bylines = Array.from({ length: 60 }, (_, index) =>
    doc(`byline-${index}`, "page", "en", `/byline-${index}`, { featured: ref("person-fr") })
  );
  const result = plan({
    holders: [...bylines, doc("drafts.byline-0", "page", "en", "/byline-0", { featured: ref("person-fr") })],
  });

  assert.equal(result.blocked.length, 1);
  assert.equal(result.blocked[0]?._id, "person-fr");
  assert.equal(result.blocked[0]?._type, "person");
  assert.equal(result.blocked[0]?.blockedBy.length, 60);
  assert.deepEqual(result.dangling, [{ _id: "links", _type: "page", uri: "/links" }]);
  assert.match(refusalReasons(result)[0] ?? "", /^person person-fr is strongly referenced by page \/byline-0/);
});

test("documents that go together never block each other", () => {
  const result = plan();

  assert.deepEqual(result.blocked, []);
  assert.ok(!result.dangling.some((holder) => holder._id === "site-fr"));
});

test("a removal unsets its own language's arms on every copy of a shared document, never flattened", () => {
  assert.deepEqual(plan().fieldCleanups, [
    { id: "category-a", type: "articleCategory", arms: [{ field: "name", key: "fr" }] },
    { id: "drafts.category-a", type: "articleCategory", arms: [{ field: "name", key: "fr" }] },
  ]);
});

test("text in a language the run does not remove stays, unless the run sweeps every language outside those kept", () => {
  const swept = plan({}, { ...DROP_FR, strayText: true });

  assert.deepEqual(swept.fieldCleanups[0]?.arms, [
    { field: "name", key: "fr" },
    { field: "name", key: "de" },
  ]);
  assert.deepEqual(plan().fieldCleanups[0]?.arms, [{ field: "name", key: "fr" }]);

  const assets = [asset("image", { altText: { en: "A", fr: "B", de: "C", it: "D" } })];
  const kept = { ...DROP_FR, keep: ["en", "de"] };

  assert.deepEqual(planLanguageRemoval({ documents: [], assets }, kept).assetCleanups[0]?.arms, [
    { field: "altText", key: "fr" },
  ]);
  assert.deepEqual(planLanguageRemoval({ documents: [], assets }, { ...kept, strayText: true }).assetCleanups[0]?.arms, [
    { field: "altText", key: "fr" },
    { field: "altText", key: "it" },
  ]);
});

test("an arm key no patch path can name is skipped and reported by a run that sweeps it", () => {
  const documents = [doc("c", "articleCategory", undefined, undefined, { name: { en: "C", "fr fr": "x" } })];
  const result = planLanguageRemoval({ documents }, { ...DROP_FR, strayText: true });

  assert.deepEqual(result.fieldCleanups, []);
  assert.match(result.skipped[0]?.reason ?? "", /"fr fr"/);
  assert.deepEqual(planLanguageRemoval({ documents }, DROP_FR).skipped, [], "not a language the run removes");
});

test("a stored type named like an object built-in is not read as a localized type", () => {
  const documents = [doc("odd", "toString"), doc("odder", "constructor", "fr")];

  assert.ok(isEmptyPlan(planLanguageRemoval({ documents }, DROP_FR)));
  assert.equal(languageCensus({ documents }, { ...BASE, keep: ["en"] }).languages.length, 0);
});

test("with one locale left, asset text flattens to its default and text with none is reported lost", () => {
  const { assetCleanups, flatten } = plan();

  assert.equal(flatten, true);
  assert.deepEqual(assetCleanups, [
    { id: "image-1", set: { altText: "A gradient" }, unset: [], arms: [], lost: [] },
    { id: "image-2", set: {}, unset: ["altText", "title"], arms: [], lost: ["altText"] },
  ]);
});

test("an empty default text is written text: it flattens, and nothing is reported lost", () => {
  const assets = [asset("image", { altText: { en: "", fr: "Un dégradé" } })];

  assert.deepEqual(planLanguageRemoval({ documents: [], assets }, DROP_FR).assetCleanups, [
    { id: "image", set: { altText: "" }, unset: [], arms: [], lost: [] },
  ]);
});

test("with several locales left, asset text only loses the arms outside them", () => {
  const assets = [asset("image", { altText: { en: "A", fr: "B", de: "C", _type: "x" } }), asset("plain", { altText: "Plain" })];
  const result = planLanguageRemoval({ documents: [], assets }, { ...DROP_FR, keep: ["en", "de"] });

  assert.equal(result.flatten, false);
  assert.deepEqual(result.assetCleanups, [
    { id: "image", set: {}, unset: [], arms: [{ field: "altText", key: "fr" }], lost: [] },
  ]);
});

test("a version in a release that is not active is refused, as is one whose release cannot be read", () => {
  const scheduled = plan({ releases: [{ name: "rlaunch", state: "scheduled", title: "Launch" }] });
  const unread = plan({ releases: [] });

  assert.deepEqual(
    scheduled.refusals.map(({ id }) => id),
    ["versions.rlaunch.homepage-fr"]
  );
  assert.match(scheduled.refusals[0]?.reason ?? "", /"Launch" \(rlaunch\), which is scheduled/);
  assert.match(unread.refusals[0]?.reason ?? "", /could not be read/);
  assert.deepEqual(plan().refusals, []);
});

test("a patch to a shared document's version in a scheduled release is refused too", () => {
  const documents = [doc("versions.rq.category-a", "articleCategory", undefined, undefined, { name: { en: "A", fr: "B" } })];
  const result = planLanguageRemoval({ documents, releases: [{ name: "rq", state: "scheduling" }] }, DROP_FR);

  assert.equal(result.refusals[0]?.id, "versions.rq.category-a");
});

test("a section strip or a field unset on a version in a scheduled release is refused before anything is written", () => {
  const releases = [...RELEASES, { name: "rq", state: "scheduled", title: "Quarter" }];
  const result = plan({ releases, alsoPatching: ["homepage", "versions.rq.about", "versions.rlaunch.contact"] });

  assert.deepEqual(
    result.refusals.map(({ id }) => id),
    ["versions.rq.about"]
  );
  assert.match(refusalReasons(result).join("\n"), /"Quarter" \(rq\), which is scheduled\. Unschedule it first/);
});

test("a release the plan empties is flagged", () => {
  assert.deepEqual(plan().releases, [{ name: "rlaunch", title: "Launch", state: "active", deleting: 1, emptied: true }]);
  assert.equal(plan({ releases: [{ ...RELEASES[0], documents: 4 }] }).releases[0]?.emptied, false);
});

test("a type purge in the same run is planned as one union", () => {
  const blog = ["article", "article-fr", "person", "person-fr", "person-de", "category-a", "drafts.category-a", "category-b"];
  const result = plan({ alsoDeleting: blog });

  assert.ok(result.metadataDeletes.includes("meta-article"));
  assert.ok(result.metadataDeletes.includes("meta-person"));
  assert.deepEqual(result.fieldCleanups, []);
  assert.equal(result.deleteIds.filter((id) => id === "article-fr").length, 1);

  const held = plan({
    alsoDeleting: ["category-a"],
    holders: [doc("featured", "page", "en", "/featured", { pick: ref("category-a") })],
  });

  assert.deepEqual(
    held.blocked.map(({ _id, _type }) => [_id, _type]),
    [["category-a", "articleCategory"]]
  );
});

test("each URI that goes is paired with its default-language sibling as a suggested 301", () => {
  assert.deepEqual(plan().redirects, [
    { from: "/fr", to: "/" },
    { from: "/fr/a-propos", to: "/about" },
    { from: "/fr/blog/modele", to: "/blog/model" },
    { from: "/fr/blog/authors/demo", to: "/blog/authors/demo" },
  ]);

  const documents = [
    doc("a", "page", "en", "/a"),
    doc("a-de", "page", "de", "/de/a"),
    doc("a-fr", "page", "fr", "/fr/a"),
    metadata("meta", link("k1", "de", "a-de"), link("k2", "fr", "a-fr"), link("k3", "en", "a")),
  ];

  assert.deepEqual(planLanguageRemoval({ documents }, DROP_FR).redirects, [{ from: "/fr/a", to: "/a" }]);
});

test("the census counts every language in documents, links, shared fields and assets", () => {
  const census = languageCensus({ documents: DATASET, assets: ASSETS }, { ...BASE, keep: ["en", "fr"] });
  const byLanguage = Object.fromEntries(census.languages.map((entry) => [entry.language, entry]));

  assert.deepEqual(
    census.languages.map(({ language }) => language),
    ["en", "fr", "de"]
  );
  assert.deepEqual(byLanguage.en?.documents, { published: 8, drafts: 1, versions: 0 });
  assert.deepEqual(byLanguage.fr?.documents, { published: 6, drafts: 2, versions: 1 });
  assert.deepEqual(byLanguage.de?.documents, { published: 2, drafts: 0, versions: 0 });
  assert.deepEqual([byLanguage.fr?.translationLinks, byLanguage.fr?.sharedFields, byLanguage.fr?.assets], [5, 1, 2]);
  assert.equal(census.assetsToFlatten, 0);
  assert.deepEqual(
    strandedLanguages(census).map(({ language }) => language),
    ["de"]
  );
  assert.equal(
    describeLanguageCount(byLanguage.fr ?? census.languages[0]),
    "fr 6 documents (+2 drafts, 1 in a release), 5 translation links, 1 shared field, 2 assets"
  );
});

test("the census counts a link or an arm once, however many copies of its document hold it", () => {
  const documents = [
    metadata("meta", link("k1", "en", "a"), link("k2", "fr", "a-fr")),
    metadata("drafts.meta", link("k1", "en", "a"), link("k2", "fr", "a-fr")),
    doc("category", "articleCategory", undefined, undefined, { name: { en: "A", fr: "B" } }),
    doc("drafts.category", "articleCategory", undefined, undefined, { name: { en: "A", fr: "B" } }),
  ];
  const fr = languageCensus({ documents }, { ...BASE, keep: ["en"] }).languages.find(({ language }) => language === "fr");

  assert.deepEqual([fr?.translationLinks, fr?.sharedFields], [1, 1]);
});

test("a group takes the URI its published copy serves, whatever order the copies come in", () => {
  const documents = [doc("drafts.page-fr", "page", "fr", "/fr/new"), doc("page-fr", "page", "fr", "/fr/old")];

  assert.equal(planLanguageRemoval({ documents }, DROP_FR).groups[0]?.uri, "/fr/old");
});

test("an arm under a key that is no language still counts as something to clean", () => {
  const documents = [doc("category", "articleCategory", undefined, undefined, { name: { en: "A", EN: "B" } })];
  const census = languageCensus({ documents }, { ...BASE, keep: ["en"] });

  assert.deepEqual(strandedLanguages(census), []);
  assert.ok(hasLanguageLeftovers(census));
  assert.deepEqual(planLanguageRemoval({ documents }, { ...DROP_FR, removed: [] }).fieldCleanups[0]?.arms, [
    { field: "name", key: "EN" },
  ]);
});

test("the census reports missing and invalid languages without making them removable", () => {
  const documents = [doc("a", "page", ""), doc("b", "page", ["fr"]), doc("c", "page", "EN")];
  const census = languageCensus({ documents }, { ...BASE, keep: ["en"] });

  assert.deepEqual(
    census.languages.map(({ language, blocker }) => [language, blocker !== undefined]),
    [
      ["", true],
      ['["fr"]', true],
      ["EN", true],
    ]
  );
  assert.deepEqual(strandedLanguages(census), []);
  const [empty] = census.languages;
  assert.ok(empty);
  assert.equal(describeLanguageCount(empty), '"" 1 document');
});

test("a language with no document left is still stranded while its links, arms or asset text remain", () => {
  const leftovers = [
    doc("a", "page", "en"),
    doc("category", "articleCategory", undefined, undefined, { name: { en: "A", fr: "B" } }),
    metadata("meta", link("k1", "en", "a"), link("k2", "fr", "gone")),
  ];
  const assets = [asset("image", { altText: { en: "A" } })];
  const census = languageCensus({ documents: leftovers, assets }, { ...BASE, keep: ["en"] });

  assert.deepEqual(
    strandedLanguages(census).map(({ language }) => language),
    ["fr"]
  );
  assert.equal(census.assetsToFlatten, 1);
  assert.ok(hasLanguageLeftovers(census));

  const cleanup = planLanguageRemoval({ documents: leftovers, assets }, DROP_FR);

  assert.deepEqual(cleanup.deleteIds, []);
  assert.deepEqual(cleanup.metadataDeletes, ["meta"]);
  assert.deepEqual(cleanup.fieldCleanups[0]?.arms, [{ field: "name", key: "fr" }]);
  assert.deepEqual(cleanup.assetCleanups[0]?.set, { altText: "A" });

  const applied = applyLanguageRemoval(leftovers, assets, cleanup);

  assert.ok(!hasLanguageLeftovers(languageCensus(applied, { ...BASE, keep: ["en"] })));
});

test("a cleanup-only run removes no document but clears arms outside the kept locales", () => {
  const result = plan({}, { ...DROP_FR, keep: ["en", "fr"], removed: [] });

  assert.deepEqual(result.deleteIds, []);
  assert.deepEqual(result.metadataDeletes, []);
  assert.deepEqual(result.fieldCleanups[0]?.arms, [{ field: "name", key: "de" }]);
  assert.deepEqual(result.assetCleanups, []);
});

test("applying the plan leaves nothing for the same plan to do", () => {
  const first = plan();
  const applied = applyLanguageRemoval(DATASET, ASSETS, first);
  const again = planLanguageRemoval({ ...applied, releases: RELEASES }, DROP_FR);

  assert.ok(!isEmptyPlan(first));
  assert.ok(isEmptyPlan(again), JSON.stringify(again));

  const left = languageCensus(applied, { ...BASE, keep: ["en"] }).languages.find(({ language }) => language === "fr");

  assert.deepEqual(
    left && [left.documents, left.translationLinks, left.sharedFields, left.assets],
    [{ published: 0, drafts: 1, versions: 0 }, 0, 0, 0],
    "only the draft whose copies disagree is left, for a person"
  );
  assert.deepEqual(applied.documents.find(({ _id }) => _id === "meta-person")?.translations, [
    link("k1", "en", "person"),
    link("k3", "de", "person-de"),
  ]);
  assert.deepEqual(applied.documents.find(({ _id }) => _id === "drafts.category-a")?.name, {
    _type: "localized",
    en: "Modelling",
  });
  assert.deepEqual(
    applied.documents.find(({ _id }) => _id === "category-a")?.name,
    { en: "Modelling", de: "Modellierung" },
    "text in a language nobody removed stays"
  );
  assert.deepEqual(applied.assets, [asset("image-1", { altText: "A gradient" }), asset("image-2", {}), ASSETS[2]]);
  assert.deepEqual(DATASET.find(({ _id }) => _id === "category-a")?.name, {
    en: "Modelling",
    fr: "Modélisation",
    de: "Modellierung",
  });
});

test("a plan re-made at write time that grew is caught, one that shrank is not", () => {
  const confirmed = plan();
  const grown = plan({ documents: [...DATASET, doc("new-fr", "page", "fr", "/fr/new")] });
  const shrunk = plan({ documents: DATASET.filter(({ _id }) => _id !== "about-fr") });

  assert.deepEqual(planGrowth(confirmed, grown), ["delete new-fr"]);
  assert.deepEqual(planGrowth(confirmed, shrunk), []);
  assert.deepEqual(planGrowth(confirmed, confirmed), []);
});

test("the writes discard versions first, then commit links and deletes in one transaction, then patch in batches", () => {
  const { versionIds, discards, transaction, patches } = languageRemovalMutations(plan(), 1);

  assert.deepEqual(versionIds, ["versions.rlaunch.homepage-fr"]);
  assert.deepEqual(discards, [
    [{ actionType: "sanity.action.document.version.discard", versionId: "versions.rlaunch.homepage-fr" }],
  ]);
  assert.deepEqual(transaction.slice(0, 2), [
    { patch: { id: "meta-person", unset: ['translations[_key=="k2"]'] } },
    { patch: { id: "meta-gone", unset: ['translations[_key=="k2"]'] } },
  ]);
  assert.ok(transaction.some((mutation) => "delete" in mutation && mutation.delete.id === "meta-home"));
  assert.ok(!transaction.some((mutation) => "delete" in mutation && mutation.delete.id.startsWith("versions.")));
  assert.deepEqual(patches, [
    [{ patch: { id: "category-a", unset: ["name['fr']"] } }],
    [{ patch: { id: "drafts.category-a", unset: ["name['fr']"] } }],
    [{ patch: { id: "image-1", set: { altText: "A gradient" } } }],
    [{ patch: { id: "image-2", unset: ["altText", "title"] } }],
  ]);
  assert.equal(languageRemovalMutations(plan()).patches.length, 1);
});

test("the config is checked before anything is planned", () => {
  const input = { documents: DATASET };

  assert.throws(() => planLanguageRemoval(input, { ...DROP_FR, keep: ["fr"], removed: [] }), /default locale "en"/);
  assert.throws(() => planLanguageRemoval(input, { ...DROP_FR, removed: ["en"] }), /default locale/);
  assert.throws(() => planLanguageRemoval(input, { ...DROP_FR, keep: ["en", "fr"] }), /still configured/);
  assert.throws(() => planLanguageRemoval(input, { ...DROP_FR, removed: [""] }), /missing/);
  assert.throws(() => planLanguageRemoval(input, { ...DROP_FR, i18nTypes: ["page'] || true"] }), /type name/);
  assert.throws(
    () => planLanguageRemoval(input, { ...DROP_FR, localizedFields: { articleCategory: ["name, secret"] } }),
    /field name/
  );
});

test("the plan prints what goes, what stays and what stops it", () => {
  const text = formatLanguageRemovalPlan(
    plan({ holders: [doc("byline", "page", "en", "/byline", { featured: ref("person-fr") })] }),
    {
      fr: "French",
    }
  ).join("\n");

  assert.match(text, /keeping en/);
  assert.match(
    text,
    /French \(fr\): 6 documents \(8 copies, drafts and release versions included\), deleted in one transaction\./
  );
  assert.match(text, /page \/fr\/a-propos/);
  assert.match(text, /Translation links: 3 groups deleted, 2 repaired/);
  assert.match(text, /Shared fields: fr text unset on 2 documents \(articleCategory\.name\)/);
  assert.match(text, /2 assets flattened to their en text/);
  assert.match(text, /Text with no en version is lost on 1 asset/);
  assert.match(text, /⛔ Sanity would refuse these writes/);
  assert.match(text, /person person-fr is strongly referenced by page \/byline/);
  assert.match(text, /copies disagree on the language/);
  assert.match(text, /1 document holds a weak reference that will dangle/);
  assert.match(text, /\/fr\/a-propos → \/about/);
  assert.match(text, /Release "Launch" is left empty/);
  assert.match(formatLanguageRemovalPlan(planLanguageRemoval({ documents: [] }, DROP_FR)).join("\n"), /nothing to change/);
});

test("the query builders refuse a name or id they did not expect", () => {
  assert.throws(() => buildTranslatedDocumentsQuery(["page", "x]|*[true"]), /type name/);
  assert.throws(() => buildSharedDocumentsQuery({ articleCategory: ["name}, secret{"] }), /field name/);
  assert.throws(() => buildReferrersQuery(["page", "a' || true || '"]), /document id/);
  assert.equal(buildSharedDocumentsQuery({}), "*[_type in []]{ _id, _type }");
  assert.match(buildLocalizedAssetsQuery(), /\(defined\(altText\) && !defined\(string\(altText\)\)\)/);
});

test("every query reads the raw dataset the plan needs, and the two-round read plans like the whole dataset", async (t) => {
  const groq = await loadGroq();

  if (!groq) {
    t.skip("groq-js is not installed");
    return;
  }

  const releases = [
    { _id: "_.releases.rlaunch", _type: "system.release", name: "rlaunch", state: "active", metadata: { title: "Launch" } },
  ];
  const holders = [
    doc("byline", "page", "en", "/byline", { featured: ref("person-fr") }),
    doc("versions.rlaunch.byline", "page", "en"),
  ];
  const dataset = [...DATASET, ...holders, ...ASSETS, ...releases, doc("snippet", "codeSnippet", "fr")];
  const read = async (query: string) => (await groq.evaluate(groq.parse(query), { dataset })).get();

  const scan = await readLanguageScan(read, DROP_FR);

  assert.ok(scan);
  assert.deepEqual(
    scan.assets.map(({ _id }) => _id),
    ["image-1", "image-2"]
  );
  assert.deepEqual(scan.releases, [{ name: "rlaunch", state: "active", title: "Launch", documents: 2 }]);
  assert.ok(!scan.documents.some(({ _id }) => _id === "snippet"));

  const referrers = (await read(buildReferrersQuery(["person-fr", "about-fr"]))) as RawDocument[];

  assert.deepEqual(sorted(referrers.map(({ _id }) => _id)), ["article-fr", "byline", "drafts.links", "links"]);

  const input = await readLanguageRemovalInput(read, DROP_FR);

  assert.ok(input);

  const normalize = (value: LanguageRemovalPlan) =>
    JSON.parse(
      JSON.stringify(value, (_, entry) =>
        Array.isArray(entry) ? [...entry].sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)) : entry
      )
    );
  const whole = planLanguageRemoval(
    {
      documents: dataset.filter(({ _type }) => !String(_type).startsWith("sanity.")),
      assets: ASSETS,
      releases: scan.releases,
    },
    DROP_FR
  );

  assert.deepEqual(normalize(planLanguageRemoval(input, DROP_FR)), normalize(whole));
  assert.equal(whole.blocked[0]?.blockedBy[0]?._id, "byline");
});

test("a failed read stops the plan instead of planning on half a dataset", async () => {
  const read = (query: string) => (query.startsWith("releases::") ? undefined : []);

  assert.equal(await readLanguageScan(read, DROP_FR), undefined);
  assert.equal(await readLanguageRemovalInput(read, DROP_FR), undefined);
});

test("the seed is filtered through the same plan, and an English-only seed passes through untouched", () => {
  const seed = DATASET.filter(({ _id }) => _id === publishedIdOf(_id));
  const assets = { "image-1": { altText: { en: "A gradient", fr: "Un dégradé" }, size: 1 }, "image-3": { altText: "Plain" } };
  const filtered = filterSeedToLocales(seed, assets, { ...BASE, keep: ["en"] });

  assert.ok(!filtered.documents.some(({ language }) => language === "fr" || language === "de"));
  assert.ok(!filtered.documents.some(({ _id }) => _id === "meta-home"));
  assert.deepEqual(filtered.documents.find(({ _id }) => _id === "category-a")?.name, { en: "Modelling" });
  assert.deepEqual(filtered.assets, { "image-1": { altText: "A gradient", size: 1 }, "image-3": { altText: "Plain" } });
  assert.equal(
    filtered.documents.find(({ _id }) => _id === "about"),
    seed.find(({ _id }) => _id === "about")
  );

  const english = seed.filter(({ language }) => language === "en");
  const untouched = filterSeedToLocales(english, { "image-3": { altText: "Plain" } }, { ...BASE, keep: ["en"] });

  assert.deepEqual(untouched.documents, english);
  assert.deepEqual(untouched.assets, { "image-3": { altText: "Plain" } });
  assert.ok(isEmptyPlan(untouched.plan));

  // The seed keeps only configured text, even under a key no removal can name as a language.
  const oddKey = [doc("c", "articleCategory", undefined, undefined, { name: { en: "C", EN: "c" } })];
  const odd = filterSeedToLocales(oddKey, {}, { ...BASE, keep: ["en"] });

  assert.deepEqual(odd.documents[0]?.name, { en: "C" });
});

test("narrowLlmsTxt drops a removed language's entries and the sections they leave empty", () => {
  const llms = [
    "# Site",
    "",
    "> A summary.",
    "",
    "## Pages",
    "",
    "- [Home](/): The homepage.",
    "- [Français](/fr): A link into the removed language, inside a kept section.",
    "",
    "## Pages (Français)",
    "",
    "- [Accueil](/fr): L'accueil.",
    "- [À propos](https://example.com/fr/a-propos): Absolute links count too.",
    "",
    "## Developer resources",
    "",
    "- [Sitemap](/sitemap.xml): Every page.",
    "- [French press](/french-press): A path that only starts with the same letters stays.",
  ].join("\n");

  assert.equal(
    narrowLlmsTxt(llms, ["fr"]),
    [
      "# Site",
      "",
      "> A summary.",
      "",
      "## Pages",
      "",
      "- [Home](/): The homepage.",
      "",
      "## Developer resources",
      "",
      "- [Sitemap](/sitemap.xml): Every page.",
      "- [French press](/french-press): A path that only starts with the same letters stays.",
    ].join("\n")
  );
  assert.equal(narrowLlmsTxt(llms, []), llms);

  const settings = { _id: "siteSettings", _type: "siteSettings", llms: { enabled: true, content: llms } };
  const seed = [...DATASET.filter(({ _id }) => _id === publishedIdOf(_id)), settings];
  const filtered = filterSeedToLocales(seed, {}, { ...BASE, keep: ["en"] });
  const kept = filtered.documents.find(({ _id }) => _id === "siteSettings");
  const content = String((kept?.llms as { content?: unknown } | undefined)?.content);

  assert.ok(!content.includes("](/fr)"));
  assert.ok(!content.includes("Pages (Français)"));
  assert.ok(content.includes("](/french-press)"));
});

test("a seed whose kept documents strongly reference a dropped one is refused", () => {
  const seed = [
    doc("page", "page", "en", "/", { featured: ref("person-fr") }),
    doc("person-fr", "person", "fr", "/fr/blog/authors/a"),
  ];

  assert.throws(
    () => filterSeedToLocales(seed, {}, { ...BASE, keep: ["en"] }),
    /cannot drop fr: person person-fr is strongly referenced by page \//
  );
});
