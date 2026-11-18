// Every query a page renders from, evaluated over a dataset whose ghosts (documents in a language the site does not
// serve) sort first, in every locale and for every URI: nothing a visitor or a crawler reads may name one.

import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { evaluate, parse } from "groq-js";
import { DEFAULT_LOCALE, IS_I18N_ENABLED, LOCALE_IDS, withLocalePrefix } from "~/sanity/i18n";
import { localeParams } from "./fragment";
import { HOMEPAGE_LOCALES_QUERY } from "./homepage-locales-state";

const SRC = join(import.meta.dirname, "..", "..");

// Typed as a plain string: with one locale, `LOCALE_IDS` narrows to the default's literal.
const SECONDARY: string = LOCALE_IDS.find((id) => id !== DEFAULT_LOCALE) ?? DEFAULT_LOCALE;

const GHOST = "zz";

/** In every string a ghost carries, its id and its URI; `_ref`s are stripped first, since no renderer prints one. */
const GHOST_MARK = /GHOST|000-ghost|\/zz\b|"zz"/;

const LOCKED_URI = withLocalePrefix(SECONDARY, "/locked");

const block = (markDefs: unknown[]) => [
  { _type: "block", _key: "b", children: [{ _type: "span", _key: "s", text: "Read", marks: ["m"] }], markDefs },
];

const internalLink = (ref: string) => ({ type: "internal", internal: { link: { _type: "reference", _ref: ref } } });

const linkTo = (key: string, ref: string) => ({ _key: key, ...internalLink(ref) });

const ghostPage = (id: string, uri: string, extra: Record<string, unknown> = {}) => ({
  _id: `000-ghost-${id}`,
  _type: "page",
  language: GHOST,
  title: "GHOST page",
  uri: { current: uri },
  ...extra,
});

// Ghosts first: groq-js keeps dataset order, so an unguarded `[0]` would pick one.
const GHOSTS = [
  {
    _id: "000-ghost-site",
    _type: "site",
    language: GHOST,
    name: "GHOST site",
    header: { links: [linkTo("h", "000-ghost-page")] },
    footer: { links: [linkTo("f", "000-ghost-page")] },
    announcement: { enabled: true, text: "GHOST", appLink: internalLink("000-ghost-page") },
    notFound: { appLink: internalLink("000-ghost-page") },
  },
  ghostPage("page", "/zz/ghost", { pageBuilder: { sectionsArray: [{ _key: "000-ghost-section", _type: "textSectionField" }] } }),
  ghostPage("home", "/"),
  // Written through the API at a live page's URI, so only the guard tells the two apart.
  ghostPage("twin", "/about", { pageBuilder: { sectionsArray: [{ _key: "000-ghost-twin-section", _type: "ctaSectionField" }] } }),
  ghostPage("empty-language", "/empty", { language: "" }),
  { _id: "000-ghost-blog", _type: "blog", language: GHOST, title: "GHOST blog", heading: "GHOST", uri: { current: "/blog" } },
  { _id: "000-ghost-person", _type: "person", language: GHOST, name: "GHOST person", uri: { current: "/blog/authors/ada" } },
  {
    _id: "000-ghost-article",
    _type: "article",
    language: GHOST,
    title: "GHOST article",
    uri: { current: "/blog/hello" },
    publishedAt: "2026-02-01",
    author: { _ref: "000-ghost-person" },
    categories: [{ _key: "c", _ref: "category-ghost-only" }],
  },
];

const LIVE = [
  {
    _id: "site",
    _type: "site",
    language: DEFAULT_LOCALE,
    name: "Live site",
    header: { links: [linkTo("h1", "page-about"), linkTo("h2", "000-ghost-page")] },
    footer: { links: [linkTo("f1", "000-ghost-page")], legalLinks: [linkTo("f2", "000-ghost-twin")] },
    announcement: { enabled: true, text: "Live", appLink: internalLink("000-ghost-page") },
    notFound: { appRichText: block([linkTo("m", "000-ghost-page")]), appLink: internalLink("000-ghost-page") },
  },
  { _id: "page-home", _type: "page", language: DEFAULT_LOCALE, title: "Home", uri: { current: "/" } },
  {
    _id: "page-about",
    _type: "page",
    language: DEFAULT_LOCALE,
    title: "About",
    uri: { current: "/about" },
    pageBuilder: {
      sectionsArray: [
        { _key: "text", _type: "textSectionField", sectionContent: { appRichText: block([linkTo("m", "000-ghost-page")]) } },
        { _key: "cta", _type: "ctaSectionField", sectionContent: { appLink: internalLink("000-ghost-page") } },
      ],
    },
  },
  { _id: "blog", _type: "blog", language: DEFAULT_LOCALE, title: "Blog", uri: { current: "/blog" } },
  {
    _id: "person",
    _type: "person",
    language: DEFAULT_LOCALE,
    name: "Ada",
    uri: { current: "/blog/authors/ada" },
    links: [linkTo("p", "000-ghost-page")],
    bio: block([linkTo("m", "000-ghost-person")]),
  },
  {
    _id: "category-design",
    _type: "articleCategory",
    name: { [DEFAULT_LOCALE]: "Design", [GHOST]: "GHOST" },
    slug: { current: "design" },
  },
  {
    _id: "category-ghost-only",
    _type: "articleCategory",
    name: { [DEFAULT_LOCALE]: "GHOST only" },
    slug: { current: "ghost-only" },
  },
  {
    _id: "article-ghost-author",
    _type: "article",
    language: DEFAULT_LOCALE,
    title: "Hello",
    uri: { current: "/blog/hello" },
    publishedAt: "2026-01-01",
    author: { _ref: "000-ghost-person" },
    categories: [{ _key: "c", _ref: "category-design" }],
    content: block([linkTo("m", "000-ghost-page")]),
  },
  {
    _id: "article-live-author",
    _type: "article",
    language: DEFAULT_LOCALE,
    title: "Hello again",
    uri: { current: "/blog/hello-again" },
    publishedAt: "2026-01-02",
    author: { _ref: "person" },
    categories: [{ _key: "c", _ref: "category-design" }],
  },
  {
    _id: "translations-about",
    _type: "translation.metadata",
    translations: [
      { _key: GHOST, value: { _ref: "000-ghost-page" } },
      { _key: DEFAULT_LOCALE, value: { _ref: "page-about" } },
      ...(IS_I18N_ENABLED ? [{ _key: SECONDARY, value: { _ref: "page-locked" } }] : []),
    ],
  },
  {
    _id: "translations-home",
    _type: "translation.metadata",
    translations: [
      { _key: GHOST, value: { _ref: "000-ghost-home" } },
      { _key: DEFAULT_LOCALE, value: { _ref: "page-home" } },
    ],
  },
  ...[
    ["blog", "000-ghost-blog"],
    ["person", "000-ghost-person"],
    ["article-ghost-author", "000-ghost-article"],
  ].map(([live, ghost]) => ({
    _id: `translations-${live}`,
    _type: "translation.metadata",
    translations: [
      { _key: GHOST, value: { _ref: ghost } },
      { _key: DEFAULT_LOCALE, value: { _ref: live } },
    ],
  })),
];

// A translation behind a password: served behind the gate, never named by another page.
const LOCKED = IS_I18N_ENABLED
  ? [
      {
        _id: "page-locked",
        _type: "page",
        language: SECONDARY,
        title: "LOCKED",
        passwordProtected: true,
        uri: { current: LOCKED_URI },
      },
    ]
  : [];

const DATASET = [...GHOSTS, ...LIVE, ...LOCKED];

const URIS = DATASET.flatMap((document) => {
  const uri = (document as { uri?: { current?: string } }).uri?.current;

  return uri ? [uri] : [];
});

/** Every value the fixture binds for each param a query can reference; a new param fails until it is added here. */
const PARAM_VALUES: Record<string, unknown[]> = {
  language: [...LOCALE_IDS],
  uri: [...new Set(URIS)],
  docId: ["page-about"],
  sectionKey: ["text", "cta"],
  categories: [[], ["design"], ["ghost-only"]],
};

function referencedParams(query: string): string[] {
  const names = new Set<string>();

  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") {
      return;
    }

    const { type, name } = node as { type?: unknown; name?: unknown };

    if (type === "Parameter" && typeof name === "string") {
      names.add(name);
    }

    for (const child of Object.values(node)) {
      walk(child);
    }
  };

  walk(parse(query));

  return [...names];
}

/** Every combination of the values of the params a query references, `locales` bound by `localeParams` as the seams do. */
function paramSets(query: string): Record<string, unknown>[] {
  const names = referencedParams(query).filter((name) => name !== "locales");

  for (const name of names) {
    assert.ok(PARAM_VALUES[name], `bind $${name} in the fixture's PARAM_VALUES`);
  }

  return names
    .reduce<Record<string, unknown>[]>(
      (sets, name) => sets.flatMap((set) => (PARAM_VALUES[name] ?? []).map((value) => ({ ...set, [name]: value }))),
      [{}]
    )
    .map((set) => localeParams(set));
}

async function run(query: string, params: Record<string, unknown>): Promise<unknown> {
  // Bound at parse time too: unbound there, groq-js reads `[$language]` as a filter.
  return (await evaluate(parse(query, { params }), { dataset: DATASET, params })).get();
}

/** The rendered-facing queries; agent queries list gated paths, ghosts included on purpose, so they need checks of their own. */
async function renderQueries(): Promise<Map<string, string>> {
  const files = readdirSync(SRC, { recursive: true, encoding: "utf8" }).filter(
    (file) => /(^|\/)(query|queries)\.ts$/.test(file) && !file.includes("agents")
  );
  const queries = new Map<string, string>([["HOMEPAGE_LOCALES_QUERY", HOMEPAGE_LOCALES_QUERY]]);

  for (const file of files) {
    const module: Record<string, unknown> = await import(pathToFileURL(join(SRC, file)).href);

    for (const [name, value] of Object.entries(module)) {
      if (/Q(uery)?$/.test(name) && typeof value === "string") {
        queries.set(name, value);
      }
    }
  }

  return queries;
}

function visibleText(result: unknown): string {
  return JSON.stringify(result ?? null).replace(/"_ref":"[^"]*"/g, "");
}

describe("rendered queries over a dataset with ghosts sorted first", () => {
  it("never name a ghost, in any locale, for any URI", async () => {
    const queries = await renderQueries();

    assert.ok(queries.has("PageQ") && queries.has("SitemapQ") && queries.has("SiteQuery"), "the scan finds the route queries");

    for (const [name, query] of queries) {
      for (const params of paramSets(query)) {
        const text = visibleText(await run(query, params));

        assert.doesNotMatch(text, GHOST_MARK, `${name} ${JSON.stringify(params)}: ${text.slice(0, 300)}`);
      }
    }
  });

  it("never name a password-protected translation, except on its own page behind the gate", {
    skip: !IS_I18N_ENABLED,
  }, async () => {
    for (const [name, query] of await renderQueries()) {
      for (const params of paramSets(query)) {
        if (params.uri === LOCKED_URI) {
          continue;
        }

        const text = visibleText(await run(query, params));

        assert.doesNotMatch(text, /LOCKED|\/locked/, `${name} ${JSON.stringify(params)}`);
      }
    }
  });

  it("hide ghosts through the guard: serve their language and they are found", async () => {
    const queries = await renderQueries();
    const widened = { ...localeParams({ uri: "/zz/ghost" }), locales: [...LOCALE_IDS, GHOST] };
    const page = (await run(queries.get("PageQ") ?? "", widened)) as { _id?: string } | null;
    const sitemap = (await run(queries.get("SitemapQ") ?? "", widened)) as { uri: string }[];

    assert.equal(page?._id, "000-ghost-page");
    assert.ok(sitemap.some(({ uri }) => uri === "/zz/ghost"));
  });

  it("keep every live, unprotected page listed", async () => {
    const sitemap = (await run((await renderQueries()).get("SitemapQ") ?? "", localeParams())) as { uri: string }[];

    assert.deepEqual(sitemap.map(({ uri }) => uri).sort(), [
      "/",
      "/about",
      "/blog",
      "/blog/authors/ada",
      "/blog/hello",
      "/blog/hello-again",
    ]);
  });
});
