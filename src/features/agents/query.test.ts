// The agent reads over a dataset whose ghosts (documents in a language the site does not serve) sort first: none is
// listed, served or generated from, and every ghost URI is gated so stored llms.txt and Markdown drop links to it.

import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluate, parse } from "groq-js";
import { localeParams } from "~/features/i18n/fragment";
import { SANITY_SINGLETON_SITE_SETTINGS_ID } from "~/sanity/constants";
import { DEFAULT_LOCALE, IS_I18N_ENABLED, LOCALE_IDS, withLocalePrefix } from "~/sanity/i18n";
import {
  AGENT_MARKDOWN_STATE_QUERY,
  type AgentMarkdownPayload,
  isAgentMarkdownEligible,
  toAgentMarkdownState,
} from "./markdown-eligibility";
import {
  AgentMarkdownBackfillQuery,
  AgentMarkdownBacklogQuery,
  AgentMarkdownContentQuery,
  AgentMarkdownServeQuery,
  AiTranslationMarkdownQuery,
  AltTextSettingsQuery,
  LlmsTxtInventoryQuery,
  LlmsTxtServeQuery,
} from "./query";

const SETTINGS_BY_ID = `*[_type == "${SANITY_SINGLETON_SITE_SETTINGS_ID}" && _id == "${SANITY_SINGLETON_SITE_SETTINGS_ID}"][0]`;

// Typed as a plain string: with one locale, `LOCALE_IDS` narrows to the default's literal.
const SECONDARY: string = LOCALE_IDS.find((id) => id !== DEFAULT_LOCALE) ?? DEFAULT_LOCALE;

const GHOST = "zz";

/** In every string a ghost carries and in its id; `_ref`s are stripped first, since nothing serializes one. */
const GHOST_MARK = /GHOST|000-ghost|\/zz\b/;

const GHOST_URIS = ["/zz/ghost", "/empty"];

const IMAGE = { asset: { _ref: "image-asset" } };

const markdown = (content: string) => ({ enabled: true, content });

const ghost = (id: string, uri: string, extra: Record<string, unknown> = {}) => ({
  _id: `000-ghost-${id}`,
  _type: "page",
  language: GHOST,
  title: "GHOST page",
  uri: { current: uri },
  agentMarkdown: markdown("# GHOST"),
  ...extra,
});

// Ghosts first: groq-js keeps dataset order, so an unguarded `[0]` would pick one.
const DATASET = [
  { _id: SANITY_SINGLETON_SITE_SETTINGS_ID, _type: SANITY_SINGLETON_SITE_SETTINGS_ID, llms: { content: "# Site" } },
  {
    _id: "image-asset",
    _type: "sanity.imageAsset",
    url: "https://cdn.example/a.png",
    altText: { [DEFAULT_LOCALE]: "default alt" },
  },
  ghost("page", "/zz/ghost"),
  // Written through the API at a live page's URI, so only the guard tells the two apart.
  ghost("twin", "/about"),
  ghost("empty-language", "/empty", { language: "" }),
  {
    _id: "page-about",
    _type: "page",
    language: DEFAULT_LOCALE,
    title: "About",
    uri: { current: "/about" },
    agentMarkdown: markdown("# About"),
    pageBuilder: {
      sectionsArray: [
        {
          _key: "media",
          _type: "anySectionField",
          sectionContent: {
            appMedia: { image: IMAGE },
            appRichText: [{ _key: "block", _type: "mediaBlock", appMedia: { image: IMAGE } }],
          },
        },
      ],
    },
  },
  { _id: "page-legacy", _type: "page", title: "Written before languages", uri: { current: "/legacy" } },
  {
    _id: "page-hidden",
    _type: "page",
    language: DEFAULT_LOCALE,
    title: "Hidden",
    uri: { current: "/hidden" },
    seoMetadata: { noIndex: true },
    agentMarkdown: markdown("# Hidden"),
  },
];

const ALL_IDS = DATASET.map(({ _id }) => _id);

/** A translation about to be written, linking a ghost: its Markdown is read from it, never from the dataset. */
const TRANSLATION = {
  _id: "drafts.translation",
  _type: "page",
  language: SECONDARY,
  title: "Translated",
  uri: { current: `/${SECONDARY}/translated` },
  pageBuilder: {
    sectionsArray: [
      {
        _key: "cta",
        _type: "anySectionField",
        sectionContent: { appLink: { type: "internal", internal: { link: { _ref: "000-ghost-page" } } } },
      },
    ],
  },
};

/** Params bound at parse time too, as the read seams bind them: unbound there, groq-js reads `[$language]` as a filter. */
async function run(query: string, params: Record<string, unknown> = {}, dataset: unknown[] = DATASET): Promise<unknown> {
  const bound = { ...localeParams(params), ...(params.locales ? { locales: params.locales } : {}) };

  return (await evaluate(parse(query, { params: bound }), { dataset, params: bound })).get();
}

function visibleText(result: unknown): string {
  return JSON.stringify(result ?? null).replace(/"_ref":"[^"]*"/g, "");
}

test("the serve query matches nothing while the site is locked, on its own fresh read", () => {
  assert.ok(AgentMarkdownServeQuery.includes(`&& ${SETTINGS_BY_ID}.basicAuth.siteWideEnabled != true`));
});

test("the alt-text settings query reads the settings singleton by id, so a second document of its type cannot stand in", () => {
  assert.ok(AltTextSettingsQuery.startsWith(`${SETTINGS_BY_ID}{`));
});

test("no agent read lists, serves or generates from a ghost, in any language and at any URI", async () => {
  const uris = [...new Set(DATASET.flatMap((document) => (document as { uri?: { current: string } }).uri?.current ?? []))];
  const reads: [string, string, Record<string, unknown>][] = [
    ["LlmsTxtInventoryQuery", LlmsTxtInventoryQuery, {}],
    ["AgentMarkdownBacklogQuery", AgentMarkdownBacklogQuery, {}],
    ["AgentMarkdownBackfillQuery", AgentMarkdownBackfillQuery, { ids: ALL_IDS }],
    ["AiTranslationMarkdownQuery", AiTranslationMarkdownQuery, { document: TRANSLATION }],
    ...uris.flatMap((uri): [string, string, Record<string, unknown>][] => [
      ["AgentMarkdownContentQuery", AgentMarkdownContentQuery, { uri }],
      ["AgentMarkdownServeQuery", AgentMarkdownServeQuery, { uri }],
    ]),
  ];

  for (const language of LOCALE_IDS) {
    for (const [name, query, params] of reads) {
      const text = visibleText(await run(query, { ...params, language }));

      assert.doesNotMatch(text, GHOST_MARK, `${name} ${JSON.stringify(params)} in ${language}: ${text.slice(0, 300)}`);
    }
  }
});

test("a live page at a URI a ghost shares is still the one generated and served", async () => {
  const content = (await run(AgentMarkdownContentQuery, { uri: "/about" })) as { _id?: string } | null;
  const served = (await run(AgentMarkdownServeQuery, { uri: "/about" })) as { content?: string } | null;

  assert.equal(content?._id, "page-about");
  assert.equal(served?.content, "# About");
  assert.equal(await run(AgentMarkdownContentQuery, { uri: "/zz/ghost" }), null);
  assert.equal(await run(AgentMarkdownServeQuery, { uri: "/empty" }), null);
});

test("the llms.txt inventory lists every live, indexable page with its language, written before languages included", async () => {
  const { pages } = (await run(LlmsTxtInventoryQuery)) as { pages: { uri: string; language: string }[] };

  assert.deepEqual(pages.map(({ uri, language }) => `${language} ${uri}`).sort(), [
    `${DEFAULT_LOCALE} /about`,
    `${DEFAULT_LOCALE} /legacy`,
  ]);
});

test("the backlog lists each live version with the URI its language is read from", async () => {
  const backlog = (await run(AgentMarkdownBacklogQuery)) as { _id: string; uri: string; missing: boolean }[];

  assert.deepEqual(backlog.map(({ _id, uri, missing }) => `${_id} ${uri} ${missing}`).sort(), [
    "page-about /about false",
    "page-hidden /hidden false",
    "page-legacy /legacy true",
  ]);
});

test("every ghost URI is gated, so stored llms.txt and agent Markdown drop links to it at serve time", async () => {
  const { gated } = (await run(LlmsTxtServeQuery)) as { gated: { uri: string }[] };
  const gatedPaths = gated.map(({ uri }) => uri);
  const state = toAgentMarkdownState((await run(AGENT_MARKDOWN_STATE_QUERY)) as AgentMarkdownPayload);

  for (const uri of GHOST_URIS) {
    assert.ok(gatedPaths.includes(uri), `llms.txt gates ${uri}`);
    assert.ok(state.gatedPathSet.has(uri), `agent Markdown gates ${uri}`);
    assert.equal(isAgentMarkdownEligible(state, uri), false, uri);
  }

  assert.equal(isAgentMarkdownEligible(state, "/about"), true);
  assert.equal(isAgentMarkdownEligible(state, "/legacy"), false);
});

test("the guard is the only thing hiding a ghost: serve its language and every agent read finds it again", async () => {
  const widened = { locales: [...LOCALE_IDS, GHOST] };
  const content = (await run(AgentMarkdownContentQuery, { ...widened, uri: "/zz/ghost" })) as { _id?: string } | null;
  const { pages } = (await run(LlmsTxtInventoryQuery, widened)) as { pages: { uri: string }[] };
  const state = toAgentMarkdownState((await run(AGENT_MARKDOWN_STATE_QUERY, widened)) as AgentMarkdownPayload);

  assert.equal(content?._id, "000-ghost-page");
  assert.ok(pages.some(({ uri }) => uri === "/zz/ghost"));
  assert.equal(isAgentMarkdownEligible(state, "/zz/ghost"), true);
});

test("agent Markdown alt text reads the page's language, then the default, then a plain string", async () => {
  const altOf = async (language: string, altText: unknown) => {
    const dataset = DATASET.map((document) => (document._id === "image-asset" ? { ...document, altText } : document));
    const page = (await run(AgentMarkdownContentQuery, { uri: "/about", language }, dataset)) as {
      sections: { media: { alt: unknown }; text: { alt: unknown }[] }[];
    };

    return { section: page.sections[0]?.media.alt, inline: page.sections[0]?.text[0]?.alt };
  };

  const twice = (alt: string | null) => ({ section: alt, inline: alt });

  assert.deepEqual(await altOf(DEFAULT_LOCALE, { [DEFAULT_LOCALE]: "default alt" }), twice("default alt"));
  assert.deepEqual(await altOf(SECONDARY, { [DEFAULT_LOCALE]: "default alt" }), twice("default alt"));
  assert.deepEqual(await altOf(SECONDARY, "legacy alt"), twice("legacy alt"));
  assert.deepEqual(await altOf(DEFAULT_LOCALE, {}), twice(null));

  if (IS_I18N_ENABLED) {
    const both = { [DEFAULT_LOCALE]: "default alt", [SECONDARY]: "secondary alt" };

    assert.deepEqual(await altOf(SECONDARY, both), twice("secondary alt"));
  }
});

test("the agent Markdown byline and the blog index's article list never name a ghost, each index in its own language", async () => {
  const article = (id: string, language: string, extra: Record<string, unknown> = {}) => ({
    _id: id,
    _type: "article",
    language,
    title: id,
    uri: { current: withLocalePrefix(language === GHOST ? DEFAULT_LOCALE : language, `/blog/${id}`) },
    publishedAt: "2026-01-01",
    ...extra,
  });
  const blogDocuments = [
    { _id: "000-ghost-person", _type: "person", language: GHOST, name: "GHOST person", uri: { current: "/blog/authors/ghost" } },
    article("000-ghost-article", GHOST, { title: "GHOST article" }),
    article("000-ghost-untagged", "", { title: "GHOST article" }),
    { _id: "person", _type: "person", language: DEFAULT_LOCALE, name: "Ada", uri: { current: "/blog/authors/ada" } },
    { _id: "blog", _type: "blog", language: DEFAULT_LOCALE, title: "Blog", uri: { current: "/blog" } },
    article("credited", DEFAULT_LOCALE, { author: { _ref: "person" } }),
    article("ghost-credited", DEFAULT_LOCALE, { author: { _ref: "000-ghost-person" } }),
    ...(IS_I18N_ENABLED
      ? [
          { _id: "blog-secondary", _type: "blog", language: SECONDARY, uri: { current: withLocalePrefix(SECONDARY, "/blog") } },
          article("translated", SECONDARY),
        ]
      : []),
  ];
  const dataset = [...blogDocuments, ...DATASET];
  const ids = blogDocuments.map(({ _id }) => _id);
  // One read, one `$language`, several languages' indexes: the backfill's own shape.
  const pages = (await run(AgentMarkdownBackfillQuery, { ids }, dataset)) as {
    _id: string;
    author?: string | null;
    articles?: { uri: string }[];
  }[];
  const byId = new Map(pages.map((page) => [page._id, page]));

  assert.doesNotMatch(visibleText(pages), GHOST_MARK);
  assert.equal(byId.get("credited")?.author, "Ada");
  assert.equal(byId.get("ghost-credited")?.author, null);
  assert.deepEqual(
    byId
      .get("blog")
      ?.articles?.map(({ uri }) => uri)
      .sort(),
    ["/blog/credited", "/blog/ghost-credited"]
  );

  if (IS_I18N_ENABLED) {
    assert.deepEqual(
      byId.get("blog-secondary")?.articles?.map(({ uri }) => uri),
      [withLocalePrefix(SECONDARY, "/blog/translated")]
    );
  }
});
