import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import type { SanityClient } from "@sanity/client";
import {
  buildDeleteIdsQuery,
  buildFieldUsageQuery,
  buildPatchTargetsQuery,
  buildRawQueryArgs,
  buildRedirectsIntoQuery,
  buildSectionAnchorQuery,
  buildSectionKeyQuery,
  buildTypeCountsQuery,
  buildUsageQuery,
  dedupeHolders,
  executePurge,
  formatPurgePlan,
  formatUsageReport,
  isStranded,
  type LanguageScope,
  languageWorkAfter,
  PlanChangedError,
  planPurge,
  planScope,
  publishedIdOf,
  purgeRefusals,
  referenceStrength,
  scopeConfig,
  strandedLanguagesOf,
  type Usage,
} from "./dataset";
import type { I18nContext } from "./language";
import { languageCensus, planLanguageRemoval, type RawDocument } from "./language-removal";

const EMPTY: Usage = {
  dataset: "development",
  documents: [],
  sections: [],
  fields: [],
  weakReferenceHolders: [],
  sectionAnchorHolders: [],
  staleMarkdownHolders: [],
  blocked: [],
};

test("buildUsageQuery counts published, drafts and release versions in separate buckets", () => {
  const query = buildUsageQuery(["article"], []);

  assert.match(
    query,
    /'article': \{ "published": count\(\*\[_type == 'article' && !\(_id in path\("drafts\.\*\*"\)\) && !\(_id in path\("versions\.\*\*"\)\)\]\)/
  );
  assert.match(query, /"drafts": count\(\*\[_type == 'article' && _id in path\("drafts\.\*\*"\)\]\)/);
  assert.match(query, /"versions": count\(\*\[_type == 'article' && _id in path\("versions\.\*\*"\)\]\)/);
});

test("buildUsageQuery projects the pages a section still appears on, with a per-page count", () => {
  const query = buildUsageQuery([], ["mediaSectionField"]);

  assert.match(query, /'mediaSectionField': \*\[count\(pageBuilder\.sectionsArray\[_type == 'mediaSectionField'\]\) > 0\]/);
  assert.match(query, /"uri": uri\.current/);
});

test("buildUsageQuery stays valid GROQ when either list is empty", () => {
  // An unquoted key is a GROQ syntax error, and the purge plan reads a blog, which has no sections.
  assert.equal(buildUsageQuery([], []), `{ "documents": {  }, "sections": {  } }`);
  assert.doesNotMatch(buildUsageQuery(["article"], []), /[{,]\s*[A-Za-z_]\w*\s*:/);
  assert.doesNotMatch(buildUsageQuery([], ["mediaSectionField"]), /[{,]\s*[A-Za-z_]\w*\s*:/);
});

test("every query builder refuses a type name it did not expect", () => {
  const injection = `page'] || *[_type == 'site`;

  assert.throws(() => buildUsageQuery([injection], []), /Refusing to build a query/);
  assert.throws(() => buildSectionKeyQuery([injection]), /Refusing to build a query/);
  assert.throws(() => buildDeleteIdsQuery([injection]), /Refusing to build a query/);
});

test("referenceStrength finds a reference anywhere in a document, and tells weak from strong", () => {
  const site = { _id: "site", footer: [{ internal: { link: { _ref: "blog", _type: "reference", _weak: true } } }] };
  const page = { _id: "p1", sections: [{ author: { _ref: "person-1", _type: "reference" } }] };

  assert.equal(referenceStrength(site, "blog"), "weak");
  assert.equal(referenceStrength(page, "person-1"), "strong");
  assert.equal(referenceStrength(page, "blog"), undefined);
  assert.equal(
    referenceStrength({ a: { _ref: "x", _weak: true }, b: { _ref: "x" } }, "x"),
    "strong",
    "one strong reference is enough to block"
  );
});

test("buildSectionAnchorQuery answers an empty list rather than a query when nothing is anchored", () => {
  assert.equal(buildSectionAnchorQuery([]), "[]");
});

test("buildSectionAnchorQuery matches the section keys that are about to disappear", () => {
  const query = buildSectionAnchorQuery(["abc123", "def456"]);

  assert.match(query, /sectionContent\.appLink\.internal\.sectionTarget in \['abc123', 'def456'\]/);
});

test("buildTypeCountsQuery counts release versions apart from published documents", () => {
  const query = buildTypeCountsQuery(["person"]);

  assert.match(
    query,
    /"published": count\(\*\[_type == 'person' && !\(_id in path\("drafts\.\*\*"\)\) && !\(_id in path\("versions\.\*\*"\)\)\]\)/
  );
  assert.match(query, /"versions": count\(\*\[_type == 'person' && _id in path\("versions\.\*\*"\)\]\)/);
});

test("buildRawQueryArgs reads through sanity exec on the login token, with the query as one argument", () => {
  const query = `*[_type == 'article']{ "uri": uri.current }`;
  const args = buildRawQueryArgs(query, "development");

  assert.deepEqual(args, [
    "exec",
    "scripts/trim-features/raw-query.ts",
    "--with-user-token",
    "--",
    query,
    "development",
    "2025-02-19",
  ]);
  assert.ok(existsSync(args[1] ?? ""), `${args[1]} is missing`);
});

test("publishedIdOf strips the draft and release prefixes, and leaves a dotted published id alone", () => {
  assert.equal(publishedIdOf("drafts.article-1"), "article-1");
  assert.equal(publishedIdOf("versions.rSpring.article-1"), "article-1");
  assert.equal(publishedIdOf("versions.rSpring.sanity-preview-url-secret.abc"), "sanity-preview-url-secret.abc");
  assert.equal(publishedIdOf("article-1"), "article-1");
});

test("dedupeHolders lists a document once, under its published id and the published uri", () => {
  assert.deepEqual(
    dedupeHolders([
      { _id: "drafts.p1", _type: "page", uri: "/about-us" },
      { _id: "p1", _type: "page", uri: "/about" },
      { _id: "versions.rSpring.p1", _type: "page", uri: "/about-spring" },
      { _id: "drafts.p2", _type: "page", uri: "/new" },
    ]),
    [
      { _id: "p1", _type: "page", uri: "/about" },
      { _id: "p2", _type: "page", uri: "/new" },
    ]
  );
});

test("buildTypeCountsQuery skips a type name it cannot safely interpolate", () => {
  const query = buildTypeCountsQuery(["article", "not a type'; --"]);

  assert.match(query, /'article':/);
  assert.ok(!query.includes("not a type"));
});

test("buildTypeCountsQuery stays valid GROQ when nothing is countable", () => {
  assert.equal(buildTypeCountsQuery([]), "{}");
  assert.equal(buildTypeCountsQuery(["!!!"]), "{}");
});

test("formatUsageReport marks a type with content as in use and an empty one as unused", () => {
  const lines = formatUsageReport({
    ...EMPTY,
    documents: [
      { type: "article", published: 12, drafts: 2, versions: 0 },
      { type: "contactFormSubmission", published: 0, drafts: 0, versions: 0 },
    ],
  });

  assert.equal(lines[0], "📊 Dataset usage (development)");
  assert.match(lines.join("\n"), /article\s+12 documents \(\+2 drafts\)\s+⚠️ {2}in use/);
  assert.match(lines.join("\n"), /contactFormSubmission\s+0 documents\s+✅ unused/);
});

test("formatUsageReport shows release versions beside drafts, and a type held only in a release is in use", () => {
  const lines = formatUsageReport({
    ...EMPTY,
    documents: [
      { type: "article", published: 12, drafts: 2, versions: 1 },
      { type: "person", published: 0, drafts: 0, versions: 3 },
    ],
  }).join("\n");

  assert.match(lines, /article\s+12 documents \(\+2 drafts, \+1 release version\)\s+⚠️ {2}in use/);
  assert.match(lines, /person\s+0 documents \(\+3 release versions\)\s+⚠️ {2}in use/);
});

test("formatUsageReport totals a section across the pages that use it", () => {
  const lines = formatUsageReport({
    ...EMPTY,
    sections: [
      {
        type: "mediaSectionField",
        pages: [
          { _id: "a", uri: "/", count: 2 },
          { _id: "b", uri: "/about", count: 6 },
        ],
      },
    ],
  });

  assert.match(lines.join("\n"), /mediaSectionField\s+8 instances across 2 pages\s+⚠️ {2}in use/);
});

test("formatUsageReport says so plainly when a feature stores nothing", () => {
  assert.match(formatUsageReport(EMPTY).join("\n"), /none of these features stores content/);
});

test("formatPurgePlan reports documents nothing can delete, and what is holding them", () => {
  const plan = formatPurgePlan(
    {
      ...EMPTY,
      blocked: [{ _id: "a1", _type: "article", blockedBy: [{ _id: "p1", _type: "page", uri: "/about" }] }],
    },
    ["article"]
  ).join("\n");

  assert.match(plan, /1 document is held by a strong reference/);
  assert.match(plan, /article a1 ← page \/about/);
  assert.match(plan, /refuse the whole purge and delete nothing/);
});

test("formatPurgePlan states the types and the total including drafts", () => {
  const plan = formatPurgePlan(
    {
      ...EMPTY,
      documents: [
        { type: "person", published: 1, drafts: 0, versions: 0 },
        { type: "article", published: 12, drafts: 2, versions: 0 },
      ],
    },
    ["person", "article"]
  ).join("\n");

  assert.match(plan, /Types: person, article/);
  assert.match(plan, /15 documents including drafts, deleted in one transaction/);
});

test("formatPurgePlan counts release versions into the total it deletes, and says so", () => {
  const plan = formatPurgePlan({ ...EMPTY, documents: [{ type: "article", published: 12, drafts: 2, versions: 2 }] }, [
    "article",
  ]).join("\n");

  assert.match(plan, /16 documents including drafts and release versions, deleted in one transaction/);
});

test("formatPurgePlan lists every dangling weak reference rather than summarising them", () => {
  const plan = formatPurgePlan(
    {
      ...EMPTY,
      weakReferenceHolders: [
        { _id: "site", _type: "site" },
        { _id: "p1", _type: "page", uri: "/about" },
      ],
    },
    ["article"]
  ).join("\n");

  assert.match(plan, /2 documents hold a weak reference that will dangle/);
  assert.match(plan, /- site site/);
  assert.match(plan, /- page \/about/);
});

test("formatPurgePlan warns about orphaned section anchors and stale generated Markdown", () => {
  const plan = formatPurgePlan(
    {
      ...EMPTY,
      sectionAnchorHolders: [{ _id: "p1", _type: "page", uri: "/pricing" }],
      staleMarkdownHolders: [{ _id: "p2", _type: "page", uri: "/" }],
    },
    ["article"]
  ).join("\n");

  assert.match(plan, /1 link anchors to a section that is being removed:/);
  assert.match(plan, /falls back to the bare page URL/);
  assert.match(plan, /1 document carries generated Markdown that will describe deleted content/);
  assert.match(plan, /Regenerate from the Agents tab/);
});

test("formatPurgePlan says there is nothing to delete when no document type is involved", () => {
  assert.match(formatPurgePlan(EMPTY, []).join("\n"), /nothing to delete/);
});

test("isStranded is true only when a feature still has documents to delete", () => {
  const usage: Usage = {
    ...EMPTY,
    documents: [
      { type: "article", published: 3, drafts: 0, versions: 0 },
      { type: "contactFormSubmission", published: 0, drafts: 0, versions: 0 },
    ],
  };

  assert.equal(isStranded({ documentTypes: ["article"] }, usage), true);
  assert.equal(isStranded({ documentTypes: ["contactFormSubmission"] }, usage), false);
  assert.equal(isStranded({ documentTypes: ["notInThisReport"] }, usage), false);
  assert.equal(isStranded({}, usage), false);
});

test("isStranded counts drafts, so a never-published article still blocks a clean bill of health", () => {
  const usage: Usage = { ...EMPTY, documents: [{ type: "article", published: 0, drafts: 2, versions: 0 }] };

  assert.equal(isStranded({ documentTypes: ["article"] }, usage), true);
});

test("isStranded counts release versions, so content waiting in a release is not reported gone", () => {
  const usage: Usage = { ...EMPTY, documents: [{ type: "article", published: 0, drafts: 0, versions: 1 }] };

  assert.equal(isStranded({ documentTypes: ["article"] }, usage), true);
});

test("isStranded counts section instances, which live on pages rather than as documents", () => {
  const used: Usage = { ...EMPTY, sections: [{ type: "mediaSectionField", pages: [{ _id: "a", count: 2 }] }] };
  const unused: Usage = { ...EMPTY, sections: [{ type: "mediaSectionField", pages: [] }] };

  assert.equal(isStranded({ sectionTypes: ["mediaSectionField"] }, used), true);
  assert.equal(isStranded({ sectionTypes: ["mediaSectionField"] }, unused), false);
});

test("formatPurgePlan states what a section purge strips, and keeps the pages", () => {
  const plan = formatPurgePlan(
    {
      ...EMPTY,
      sections: [
        {
          type: "ctaSectionField",
          pages: [
            { _id: "home", uri: "/", count: 1 },
            { _id: "about", uri: "/about", count: 1 },
          ],
        },
      ],
    },
    []
  ).join("\n");

  assert.match(plan, /ctaSectionField: 2 section uses stripped from 2 pages; the pages stay/);
  assert.doesNotMatch(plan, /documents including drafts/);
});

test("buildFieldUsageQuery counts the documents still storing each field, keyed by type and field", () => {
  const query = buildFieldUsageQuery([{ documentType: "siteSettings", name: "contactFormNotificationEmails" }]);

  assert.equal(
    query,
    "{ 'siteSettings.contactFormNotificationEmails': count(*[_type == 'siteSettings' && defined(contactFormNotificationEmails)]) }"
  );
});

test("buildFieldUsageQuery refuses a field name that is not a plain identifier", () => {
  assert.throws(() => buildFieldUsageQuery([{ documentType: "site", name: "a) || true || (" }]), /unexpected field name/);
});

test("a field still set on a kept document is purge work, and the documents stay", () => {
  const usage: Usage = { ...EMPTY, fields: [{ documentType: "site", name: "announcement", documents: 1 }] };
  const plan = formatPurgePlan(usage, []).join("\n");

  assert.match(plan, /site\.announcement: unset on 1 document; the documents stay/);
  assert.doesNotMatch(plan, /nothing to delete/);
  assert.match(formatUsageReport(usage).join("\n"), /site\.announcement\s+1 document\s+⚠️ {2}set/);
  assert.equal(isStranded({ fields: [{ documentType: "site", name: "announcement" }] }, usage), true);
});

test("a field no document stores is nothing to purge", () => {
  const usage: Usage = { ...EMPTY, fields: [{ documentType: "site", name: "announcement", documents: 0 }] };

  assert.match(formatPurgePlan(usage, []).join("\n"), /nothing to delete/);
  assert.equal(isStranded({ fields: [{ documentType: "site", name: "announcement" }] }, usage), false);
});

// Locales of their own: en is the default, fr is the language a run switches off.
const CONTEXT: I18nContext = {
  defaultLocale: "en",
  active: ["en", "fr"],
  commented: [],
  i18nTypes: ["page", "article", "person"],
  localizedFields: { articleCategory: ["name"] },
};

const DROP_FR: LanguageScope = { context: CONTEXT, removed: ["fr"], cleanText: true };

const strongRef = (_ref: string) => ({ _type: "reference", _ref });

const link = (_key: string, language: string, _ref: string) => ({
  _key,
  _type: "internationalizedArrayReferenceValue",
  language,
  value: { _type: "reference", _ref },
});

const DATASET: RawDocument[] = [
  { _id: "home", _type: "page", language: "en", uri: { current: "/" } },
  { _id: "post-en", _type: "article", language: "en", uri: { current: "/blog/post" }, author: strongRef("person-en") },
  { _id: "post-fr", _type: "article", language: "fr", uri: { current: "/fr/blog/post" }, author: strongRef("person-fr") },
  { _id: "drafts.post-fr", _type: "article", language: "fr", author: strongRef("person-fr") },
  { _id: "versions.rspring.post-fr", _type: "article", author: strongRef("person-fr") },
  { _id: "person-en", _type: "person", language: "en", uri: { current: "/blog/authors/ada" } },
  { _id: "person-fr", _type: "person", language: "fr", uri: { current: "/fr/blog/authors/ada" } },
  { _id: "cat-1", _type: "articleCategory", name: { en: "News", fr: "Actualités" } },
  { _id: "tm-post", _type: "translation.metadata", translations: [link("en", "en", "post-en"), link("fr", "fr", "post-fr")] },
  {
    _id: "tm-person",
    _type: "translation.metadata",
    translations: [link("en", "en", "person-en"), link("fr", "fr", "person-fr")],
  },
  { _id: "image-1", _type: "sanity.imageAsset", altText: { en: "A desk", fr: "Un bureau" } },
  { _id: "_.releases.rspring", _type: "system.release", name: "rspring", state: "active", metadata: { title: "Spring" } },
];

/** What these tests use of groq-js, which a project cut before it was a dependency may not have. */
type Groq = {
  parse(query: string, options?: { params?: Record<string, unknown> }): unknown;
  evaluate(
    tree: unknown,
    options: { dataset: unknown[]; params?: Record<string, unknown> }
  ): Promise<{ get(): Promise<unknown> }>;
};

const GROQ = "groq-js";

async function loadGroq(): Promise<Groq | undefined> {
  try {
    return (await import(GROQ)) as Groq;
  } catch {
    return undefined;
  }
}

/** A client that reads a fixture through groq-js and records every write instead of sending it. */
function recordingClient(groq: Groq, dataset: RawDocument[]) {
  const writes: unknown[] = [];
  const client = {
    fetch: async (query: string, params: Record<string, unknown> = {}) =>
      (await groq.evaluate(groq.parse(query, { params }), { dataset, params })).get(),
    action: async (actions: unknown) => {
      writes.push({ action: actions });
      return {};
    },
    transaction: (mutations: unknown[]) => ({
      commit: async () => {
        writes.push({ transaction: mutations });
        return {};
      },
    }),
    patch: (id: string) => ({
      unset: (paths: string[]) => ({
        commit: async () => {
          writes.push({ patch: id, unset: paths });
          return {};
        },
      }),
    }),
  };

  return { client: client as unknown as SanityClient, writes };
}

test("a type purge deletes the translation groups it empties in the same transaction, and discards versions first", async (t) => {
  const groq = await loadGroq();

  if (!groq) {
    t.skip("groq-js is not installed");
    return;
  }

  for (const scope of [
    { context: CONTEXT, removed: [], cleanText: false },
    { removed: [], cleanText: false },
  ]) {
    const { client, writes } = recordingClient(groq, DATASET);
    const request = { documentTypes: ["article"], sectionTypes: [], scope };
    const result = await executePurge(client, await planPurge(client, request), request);

    assert.deepEqual(writes, [
      { action: [{ actionType: "sanity.action.document.version.discard", versionId: "versions.rspring.post-fr" }] },
      {
        transaction: [
          { delete: { id: "post-en" } },
          { delete: { id: "post-fr" } },
          { delete: { id: "drafts.post-fr" } },
          { delete: { id: "tm-post" } },
        ],
      },
    ]);
    assert.equal(result.deletedDocuments, 4);
    assert.equal(result.discardedVersions, 1);
    assert.equal(result.translationLinks, 1);
    assert.equal(result.cleanedDocuments, 0, "a type purge never touches text in other languages");
  }
});

test("a language purge deletes every copy, takes its links with it and cleans what stays", async (t) => {
  const groq = await loadGroq();

  if (!groq) {
    t.skip("groq-js is not installed");
    return;
  }

  const { client, writes } = recordingClient(groq, DATASET);
  const request = { documentTypes: [], sectionTypes: [], scope: DROP_FR };
  const plan = await planPurge(client, request);
  const result = await executePurge(client, plan, request);

  assert.deepEqual([...plan.deleteIds].sort(), ["drafts.post-fr", "person-fr", "post-fr", "versions.rspring.post-fr"]);
  assert.deepEqual([...plan.metadataDeletes].sort(), ["tm-person", "tm-post"]);
  assert.deepEqual(writes.at(-1), {
    transaction: [{ patch: { id: "cat-1", unset: ["name['fr']"] } }, { patch: { id: "image-1", set: { altText: "A desk" } } }],
  });
  assert.equal(result.cleanedDocuments, 2);
});

test("the purge re-plans from what the dataset holds now, and writes nothing that was not confirmed", async (t) => {
  const groq = await loadGroq();

  if (!groq) {
    t.skip("groq-js is not installed");
    return;
  }

  const request = { documentTypes: [], sectionTypes: [], scope: DROP_FR };
  const confirmed = await planPurge(recordingClient(groq, DATASET).client, request);
  const grown = recordingClient(groq, [...DATASET, { _id: "post-fr-2", _type: "article", language: "fr" }]);
  const shrunk = recordingClient(
    groq,
    DATASET.filter(({ _id }) => _id !== "drafts.post-fr")
  );

  await assert.rejects(planPurge(grown.client, { ...request, confirmed }), (error: unknown) => {
    assert.ok(error instanceof PlanChangedError);
    assert.deepEqual(error.reasons, ["delete post-fr-2"]);
    return true;
  });
  assert.deepEqual(grown.writes, []);
  await planPurge(shrunk.client, { ...request, confirmed });
});

test("a purge stops before writing on a scheduled release or a strong reference from what stays", async (t) => {
  const groq = await loadGroq();

  if (!groq) {
    t.skip("groq-js is not installed");
    return;
  }

  const scheduled = DATASET.map((document) =>
    document._id === "_.releases.rspring" ? { ...document, state: "scheduled" } : document
  );
  const held = [...DATASET, { _id: "landing", _type: "page", language: "en", featured: strongRef("person-fr") }];

  for (const dataset of [scheduled, held]) {
    const { client, writes } = recordingClient(groq, dataset);

    await assert.rejects(planPurge(client, { documentTypes: [], sectionTypes: [], scope: DROP_FR }), PlanChangedError);
    assert.deepEqual(writes, []);
  }
});

test("a language purge clears its own text on what stays, and every other unserved language's only when asked", async (t) => {
  const groq = await loadGroq();

  if (!groq) {
    t.skip("groq-js is not installed");
    return;
  }

  const dataset = DATASET.map((document) =>
    document._id === "cat-1" ? { ...document, name: { en: "News", fr: "Actualités", de: "Nachrichten" } } : document
  );
  const request = { documentTypes: [], sectionTypes: [] };
  const own = await planPurge(recordingClient(groq, dataset).client, { ...request, scope: DROP_FR });
  const swept = await planPurge(recordingClient(groq, dataset).client, { ...request, scope: { ...DROP_FR, strayText: true } });

  assert.deepEqual(own.fieldCleanups, [{ id: "cat-1", type: "articleCategory", arms: [{ field: "name", key: "fr" }] }]);
  assert.deepEqual(swept.fieldCleanups[0]?.arms, [
    { field: "name", key: "fr" },
    { field: "name", key: "de" },
  ]);
});

test("buildPatchTargetsQuery finds every copy a section strip or a field unset writes, release versions included", async (t) => {
  assert.throws(() => buildPatchTargetsQuery(["x']]|*[true"], []), /type name/);
  assert.throws(() => buildPatchTargetsQuery([], [{ documentType: "site", name: "a) || true || (b" }]), /field name/);
  assert.equal(buildPatchTargetsQuery([], []), "[]");

  const groq = await loadGroq();

  if (!groq) {
    t.skip("groq-js is not installed");
    return;
  }

  const section = (type: string) => ({ pageBuilder: { sectionsArray: [{ _key: "s", _type: type }] } });
  const dataset = [
    { _id: "home", _type: "page", ...section("ctaSection") },
    { _id: "versions.rq.home", _type: "page", ...section("ctaSection") },
    { _id: "drafts.about", _type: "page", ...section("heroSection") },
    { _id: "site", _type: "site", announcement: { text: "Hi" } },
    { _id: "drafts.site", _type: "site" },
  ];
  const read = async (query: string) => (await groq.evaluate(groq.parse(query), { dataset })).get();

  assert.deepEqual(await read(buildPatchTargetsQuery(["ctaSection"], [{ documentType: "site", name: "announcement" }])), [
    "home",
    "versions.rq.home",
    "site",
  ]);
});

test("a purge whose section strip would write to a version in a scheduled release stops before writing", async (t) => {
  const groq = await loadGroq();

  if (!groq) {
    t.skip("groq-js is not installed");
    return;
  }

  const dataset = [
    ...DATASET,
    { _id: "versions.rlocked.home", _type: "page", pageBuilder: { sectionsArray: [{ _key: "s", _type: "ctaSection" }] } },
    { _id: "_.releases.rlocked", _type: "system.release", name: "rlocked", state: "scheduled", metadata: { title: "Locked" } },
  ];
  const { client, writes } = recordingClient(groq, dataset);

  await assert.rejects(planPurge(client, { documentTypes: [], sectionTypes: ["ctaSection"] }), (error: unknown) => {
    assert.ok(error instanceof PlanChangedError);
    assert.match(error.reasons.join("\n"), /versions\.rlocked\.home: .*"Locked" \(rlocked\), which is scheduled/);
    return true;
  });
  assert.deepEqual(writes, []);
  await planPurge(client, { documentTypes: [], sectionTypes: ["heroSection"] });
});

test("a type purge reads no text in other languages, and a language needs the project's config", () => {
  const input = {
    documents: DATASET.filter(({ _type }) => _type !== "sanity.imageAsset"),
    assets: DATASET.filter(({ _type }) => _type === "sanity.imageAsset"),
  };
  const typesOnly = planScope({ ...input, alsoDeleting: ["post-en"] }, { context: CONTEXT, removed: [], cleanText: false });

  assert.deepEqual(typesOnly.fieldCleanups, []);
  assert.deepEqual(typesOnly.assetCleanups, []);
  assert.deepEqual(scopeConfig({ context: CONTEXT, removed: [], cleanText: false }).localizedFields, {});
  assert.throws(() => scopeConfig({ removed: ["fr"], cleanText: true }), /sanity\/i18n\.ts/);
  assert.throws(() => scopeConfig({ removed: [], cleanText: true }), /sanity\/i18n\.ts/);
});

test("buildRedirectsIntoQuery finds Settings redirects landing in a removed language, inline or referenced", async (t) => {
  assert.throws(() => buildRedirectsIntoQuery(["fr'] || true"]), /unexpected language/);

  const groq = await loadGroq();

  if (!groq) {
    t.skip("groq-js is not installed");
    return;
  }

  const dataset = [
    {
      _id: "siteSettings",
      _type: "siteSettings",
      redirects: [
        { _key: "a", from: "/old", to: "/fr/new" },
        { _key: "b", from: "/kept", to: "/about" },
        { _key: "c", _type: "reference", _ref: "redirect-1" },
        { _key: "d", from: "/root", to: "/fr" },
        { _key: "e", from: "/french", to: "/french-guide" },
      ],
    },
    { _id: "redirect-1", _type: "redirect", from: "/legacy", to: "/fr/legacy" },
  ];
  const read = async (query: string) => (await groq.evaluate(groq.parse(query), { dataset })).get();

  assert.deepEqual(await read(buildRedirectsIntoQuery(["fr"])), [
    { from: "/old", to: "/fr/new" },
    { from: "/legacy", to: "/fr/legacy" },
    { from: "/root", to: "/fr" },
  ]);
  assert.deepEqual(await read(buildRedirectsIntoQuery(["fr"]).replace("siteSettings", "missing")), []);
});

test("formatPurgePlan names the translation links a type purge repairs in its own transaction", () => {
  const plan = planLanguageRemoval(
    { documents: DATASET.filter(({ _type }) => _type === "translation.metadata"), alsoDeleting: ["post-en", "post-fr"] },
    { ...scopeConfig({ context: CONTEXT, removed: [], cleanText: false }) }
  );
  const lines = formatPurgePlan({ ...EMPTY, plan, scope: { removed: [], cleanText: false } }, ["article"]).join("\n");

  assert.match(lines, /Translation links: 1 group deleted, 0 repaired, in the same transaction/);
  assert.doesNotMatch(lines, /Language removal plan/);
});

test("formatPurgePlan prints a language run's own plan, and the redirects that now land on a 404", () => {
  const documents = DATASET.filter(({ _type }) => !String(_type).startsWith("sanity.") && !String(_type).startsWith("system."));
  const plan = planLanguageRemoval({ documents }, scopeConfig(DROP_FR));
  const lines = formatPurgePlan(
    {
      ...EMPTY,
      plan,
      scope: DROP_FR,
      languages: { counts: [], redirectsInto: [{ from: "/old", to: "/fr/new" }] },
    },
    [],
    { fr: "French" }
  ).join("\n");

  assert.match(lines, /Language removal plan \(keeping en\)/);
  assert.match(lines, /French \(fr\): 2 documents/);
  assert.match(lines, /1 redirect in Settings lands in a language that now answers 404/);
  assert.match(lines, /\/old → \/fr\/new/);
});

test("a type purge's refusals are printed, and every reason to stop comes back from purgeRefusals", () => {
  const usage: Usage = {
    ...EMPTY,
    blocked: [{ _id: "a1", _type: "article", blockedBy: [{ _id: "p1", _type: "page", uri: "/about" }] }],
    plan: {
      ...planLanguageRemoval({ documents: [] }, scopeConfig({ removed: [], cleanText: false })),
      refusals: [
        { id: "versions.rlater.a1", reason: 'it is a version in release "rlater", which is scheduled. Unschedule it first.' },
      ],
    },
  };

  assert.match(formatPurgePlan(usage, ["article"]).join("\n"), /Sanity would refuse these writes/);
  assert.deepEqual(purgeRefusals(usage), [
    "article a1 is strongly referenced by page /about.",
    'versions.rlater.a1: it is a version in release "rlater", which is scheduled. Unschedule it first.',
  ]);
  assert.deepEqual(purgeRefusals(EMPTY), []);
});

test("formatUsageReport counts what a language still holds", () => {
  const census = languageCensus(
    { documents: DATASET.filter(({ _type }) => !String(_type).startsWith("system.")) },
    { defaultLocale: "en", keep: ["en"], i18nTypes: CONTEXT.i18nTypes, localizedFields: CONTEXT.localizedFields }
  );
  const counts = census.languages.filter(({ language }) => language === "fr");

  assert.match(
    formatUsageReport({ ...EMPTY, scope: DROP_FR, languages: { counts, redirectsInto: [] } }).join("\n"),
    /language fr 2 documents \(\+1 draft, 1 in a release\), 2 translation links, 1 shared field/
  );
});

test("strandedLanguagesOf offers an unserved language, and counts text left with no document as work", () => {
  const config = { defaultLocale: "en", keep: ["en"], i18nTypes: CONTEXT.i18nTypes, localizedFields: CONTEXT.localizedFields };
  const withDocuments = languageCensus({ documents: DATASET }, config);
  const textOnly = languageCensus({ documents: DATASET.slice(7, 8) }, config);

  assert.deepEqual(
    strandedLanguagesOf({ languages: withDocuments }).removable.map(({ language }) => language),
    ["fr"]
  );
  assert.equal(strandedLanguagesOf({ languages: textOnly }).leftovers, true);
  assert.deepEqual(strandedLanguagesOf({}), { removable: [], leftovers: false });
});

test("a language run says what each language holds, nothing included, and warns about Markdown only when it deletes", () => {
  const scope: LanguageScope = { context: CONTEXT, removed: ["fr"], cleanText: true };
  const plan = planLanguageRemoval({ documents: [] }, scopeConfig(scope));
  const usage: Usage = {
    ...EMPTY,
    plan,
    scope,
    languages: { counts: [], redirectsInto: [] },
    staleMarkdownHolders: [{ _id: "p2", _type: "page", uri: "/" }],
  };

  assert.match(formatUsageReport(usage).join("\n"), /language fr nothing stored {2}✅ unused/);
  assert.doesNotMatch(formatPurgePlan(usage, []).join("\n"), /generated Markdown/);
  assert.match(formatPurgePlan(usage, []).join("\n"), /nothing to change/);
});

test("formatPurgePlan warns when one transaction would carry more writes than Sanity may accept", () => {
  const alsoDeleting = Array.from({ length: 2001 }, (_, index) => `post-${index}`);
  const plan = planLanguageRemoval({ documents: [], alsoDeleting }, scopeConfig({ removed: [], cleanText: false }));

  assert.match(formatPurgePlan({ ...EMPTY, plan }, ["article"]).join("\n"), /2001 writes in one transaction/);
  assert.doesNotMatch(
    formatPurgePlan({ ...EMPTY, plan: { ...plan, deleteIds: ["post-1"] } }, ["article"]).join("\n"),
    /writes in one/
  );
});

// The guided run offers a language's content from the survey, read before LOCALES changed: the flattening is only
// due once the run leaves one locale, so it is judged against the locales that stay.
test("switching a language off counts its content and the asset text one locale left cannot edit", () => {
  const english = [{ _id: "home", _type: "page", language: "en" }];
  const assets = [
    { _id: "image-1", _type: "sanity.imageAsset", altText: { en: "A desk" } },
    { _id: "image-2", _type: "sanity.imageAsset", altText: "A chair" },
  ];
  const nothingInFrench = languageWorkAfter({ documents: english, assets }, CONTEXT, ["fr"]);
  const withFrench = languageWorkAfter({ documents: DATASET, assets: [] }, CONTEXT, ["fr"]);

  assert.deepEqual(nothingInFrench, { counts: [], assetsToFlatten: 1 });
  assert.deepEqual(
    withFrench.counts.map(({ language, documents }) => ({ language, documents })),
    [{ language: "fr", documents: { published: 2, drafts: 1, versions: 1 } }]
  );
  // Several locales stay, or nothing is switched off: asset text keeps its arms.
  assert.equal(
    languageWorkAfter({ documents: english, assets }, { ...CONTEXT, active: ["en", "fr", "de"] }, ["fr"]).assetsToFlatten,
    0
  );
  assert.deepEqual(languageWorkAfter({ documents: english, assets }, CONTEXT, []), { counts: [], assetsToFlatten: 0 });
});
