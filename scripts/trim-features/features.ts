/**
 * What each removable feature is made of.
 *
 * Pure data. Every path, anchor and package name here is checked against the real tree by
 * `manifest.test.ts`, so a rename that moves a registry fails the test suite instead of surfacing as
 * a half-trimmed repo months later. Adding a feature is a matter of adding an entry, not of writing
 * code: `edits.ts` already knows how to perform every kind of removal listed below.
 *
 * The starter is a superset on purpose, so nothing here runs unless someone asks for it.
 */

import type { Edit, FileEdits } from "./edits";
import type { StoredField } from "./schema";

export type { StoredField };

/**
 * A closing note. The object form is dropped when the feature named by `unless` goes in the same run,
 * for a note about something that run deletes after all.
 */
export type Note = string | { text: string; unless: string };

export type Feature = {
  /** Stable id, used by `--feature`. Sections are namespaced (`section:media`). */
  id: string;
  title: string;
  summary: string;
  /**
   * The day this feature was committed to the starter, as `YYYY-MM-DD`. A project cut before it never had it,
   * so a file there with the same name is the project's own. A merge after that day errs early, the safe side.
   */
  since: string;
  /** Features that cannot survive this one's removal, auto-selected with a printed note. */
  implies?: string[];
  /** Files and directories this feature owns outright. */
  paths: string[];
  /** Registry surgery, grouped by file. Each edit is asserted to match exactly once. */
  edits: FileEdits[];
  /** npm packages nothing else uses. */
  dependencies?: string[];
  /** Env vars to drop from the config schema, `src/lib/env.ts` and `.env.example`. */
  env?: string[];
  /** Sanity `_type`s to purge. They go in one transaction, so no order is needed. */
  documentTypes?: string[];
  /** `<name>SectionField` array-member types stored on `pageBuilder.sectionsArray`. */
  sectionTypes?: string[];
  /** `docs/**.md` files to delete. Links to them are pruned from the doc indexes automatically. */
  docs?: string[];
  /** `.agents/skills/<name>` folders to delete. */
  skills?: string[];
  /**
   * Paths nothing ships uses once this feature is gone, but which it does not own outright.
   *
   * A shared layer only one feature happened to use. Declared rather than discovered: the knip sweep
   * only names a file nothing at all imports, so a module kept alive by its own colocated test is
   * invisible to it. Whether these go is a judgement, so they are reported, never deleted.
   */
  orphans?: string[];
  /** Shared code with no Sanity surface at all, so there is nothing for a purge to delete. */
  codeOnly?: true;
  /** The locale this switches off. Its LOCALES entry is commented out, and the purge deletes its documents. */
  language?: string;
  /** Only works beside a second language, so a run switching off the last second language offers it too. */
  needsSecondLanguage?: true;
  /** Only offered in a project with a cut date: before that, it is what starts the next project. */
  afterCut?: true;
  /**
   * Fields this feature adds to a document type it does not own, such as a setting on `siteSettings`.
   * The schema edit removes the field; the purge unsets what documents still store under it.
   */
  fields?: StoredField[];
  /** What the trim deliberately leaves behind for a human, printed in the closing report. */
  notes?: Note[];
  /** Prose names for it, so docs and skills that still describe it after a trim can be listed. */
  mentions?: string[];
};

/** The first import of the starter: every feature that shipped with it has this `since`. */
const FIRST_CUT = "2026-07-16";

/**
 * The locale config. Its presence marks a tree with i18n: a group that unwires i18n code `requires`
 * it, and the old shape of an anchor the i18n work rewrote is kept under `requiresAbsent`.
 */
const I18N_CONFIG = "sanity/i18n.ts";

/**
 * Env vars are declared once per feature and expanded here, because every one of them is wired into
 * the same three places: the `runtimeEnv` map, its `server` or `client` schema, and `.env.example`.
 */
function envEdits(vars: string[]): FileEdits[] {
  return [
    { file: "src/lib/env.ts", edits: vars.map((name): Edit => ({ kind: "dropExport", id: name })) },
    {
      file: "astro.config.mjs",
      edits: vars.map((name): Edit => ({ kind: "dropObjectProperty", anchor: "schema", key: name })),
    },
  ];
}

/**
 * The blog, and with it the authors it bylines.
 *
 * The two are one removal in both directions, not two: an article's byline is a required part of the
 * article route and of its JSON-LD, and a person only exists as an article's author. This script
 * removes rather than rewires, so "blog without bylines" would mean rewriting the article route
 * rather than unwiring a registry. `implies` therefore points both ways.
 */
const blog: Feature = {
  id: "blog",
  since: FIRST_CUT,
  title: "Blog",
  summary: "The blog index, articles, categories and the author profiles that byline them.",
  mentions: ["RSS feed"],
  implies: ["authors"],
  paths: [
    "src/pages/blog",
    "src/pages/feed.xml.ts",
    "src/features/blog",
    "src/features/feed",
    "sanity/schemas/documents/article.tsx",
    "sanity/schemas/documents/article.test.ts",
    "sanity/schemas/documents/article-category.tsx",
    "sanity/schemas/documents/article-category.test.ts",
    "sanity/schemas/documents/blog.tsx",
  ],
  edits: [
    {
      // So scaffolding the type again lists it once; optional, since Translate with AI's trim deletes the file.
      file: "sanity/ai-translation/fields.ts",
      optional: true,
      edits: [
        { kind: "dropObjectProperty", anchor: "CONDITIONAL_PATHS", key: "blog" },
        { kind: "dropObjectProperty", anchor: "CONDITIONAL_PATHS", key: "article" },
      ],
    },
    {
      file: "sanity/schemas/index.ts",
      edits: [
        { kind: "dropImport", id: "article" },
        { kind: "dropImport", id: "articleCategory" },
        { kind: "dropImport", id: "blog" },
        { kind: "dropArrayElement", arrayName: "schemaTypes", id: "article" },
        { kind: "dropArrayElement", arrayName: "schemaTypes", id: "articleCategory" },
        { kind: "dropArrayElement", arrayName: "schemaTypes", id: "blog" },
      ],
    },
    {
      file: "sanity/constants.ts",
      edits: [
        { kind: "dropVariableStatement", name: "SANITY_SINGLETON_BLOG_ID" },
        { kind: "dropVariableStatement", name: "SANITY_BLOG_INDEX_URI" },
        { kind: "dropVariableStatement", name: "SANITY_ARTICLE_DOCUMENT_TYPE" },
        { kind: "dropVariableStatement", name: "SANITY_ARTICLE_CATEGORY_DOCUMENT_TYPE" },
        { kind: "dropObjectProperty", anchor: "SINGLETON_IDS", key: "blog" },
        { kind: "dropObjectProperty", anchor: "SINGLETON_ROUTES", key: "blog" },
        { kind: "dropArrayElement", arrayName: "I18N_DOCUMENT_TYPES", id: "SANITY_SINGLETON_BLOG_ID" },
        { kind: "dropArrayElement", arrayName: "I18N_DOCUMENT_TYPES", id: "SANITY_ARTICLE_DOCUMENT_TYPE" },
        { kind: "dropObjectProperty", anchor: "LOCALIZED_FIELDS", key: "articleCategory" },
      ],
    },
    {
      file: "sanity/sections.ts",
      requires: I18N_CONFIG,
      edits: [
        { kind: "dropImport", id: "SANITY_SINGLETON_BLOG_ID" },
        { kind: "dropImport", id: "SANITY_ARTICLE_DOCUMENT_TYPE" },
        // The section routes authors under its word, so the person type goes with it here.
        { kind: "dropImport", id: "SANITY_PERSON_DOCUMENT_TYPE" },
        { kind: "dropObjectProperty", anchor: "SECTION_SEGMENTS", key: "blog" },
        { kind: "dropObjectProperty", anchor: "SECTION_TYPES", key: "blog" },
      ],
    },
    { file: "sanity/structure.tsx", edits: [{ kind: "dropCallInArray", anchor: "items", title: "Blog" }] },
    {
      file: "sanity/templates.tsx",
      edits: [{ kind: "dropStringFromArray", anchor: "SCHEMA_TYPES_SINGLETON_VIA_DESK_ONLY", value: "blog" }],
    },
    {
      file: "sanity/schemas/fields/create-uri-field.tsx",
      edits: [
        { kind: "dropImport", id: "SANITY_BLOG_INDEX_URI" },
        { kind: "dropImport", id: "SANITY_SINGLETON_BLOG_ID" },
        // `authors` implies `blog` and back, so the author half of the route rule goes with it here.
        { kind: "dropImport", id: "SANITY_ARTICLE_DOCUMENT_TYPE" },
        { kind: "dropImport", id: "SANITY_AUTHOR_PATH_PREFIX" },
        { kind: "dropImport", id: "SANITY_PERSON_DOCUMENT_TYPE" },
        { kind: "dropVariableStatement", name: "ONE_SEGMENT" },
        { kind: "dropVariableStatement", name: "AUTHOR_ROUTE" },
        { kind: "dropLines", contains: "are answered first by routes that serve only their own type" },
        { kind: "dropBlock", opens: "function blogRouteIssue(" },
        {
          kind: "replaceText",
          find: "reservedRouteIssue(uriP) ?? blogRouteIssue(context.document?._type, uriP)",
          with: "reservedRouteIssue(uriP)",
        },
        // Cosmetic: the sentence above a guard that is going anyway.
        { kind: "dropLines", contains: "The blog index is its own singleton on its own route", optional: true },
      ],
    },
    {
      file: "sanity/schemas/fields/create-uri-field.tsx",
      requires: I18N_CONFIG,
      edits: [
        {
          kind: "replaceText",
          label: "remove the reserved-path guard for the blog index",
          find: `if (uriP === SANITY_BLOG_INDEX_URI && type !== SANITY_SINGLETON_BLOG_ID) {
        return \`This URI is reserved for the Blog index (\${SANITY_BLOG_INDEX_URI}). Choose a different path.\`;
      }`,
          with: "",
        },
      ],
    },
    {
      file: "sanity/schemas/fields/create-uri-field.tsx",
      requiresAbsent: I18N_CONFIG,
      edits: [
        {
          kind: "replaceText",
          label: "remove the reserved-path guard for the blog index",
          find: `const docId = typeof context.document?._id === "string" ? sanitizeDocId(context.document._id) : null;

    if (uriP === comparableUriPath(SANITY_BLOG_INDEX_URI) && docId !== SINGLETON_IDS.blog) {
      return \`This URI is reserved for the Blog index (\${SANITY_BLOG_INDEX_URI}). Choose a different path.\`;
    }`,
          with: "",
        },
      ],
    },
    {
      file: "sanity/schemas/schemas.test.ts",
      edits: [
        { kind: "dropCallStatement", fn: "test", titleContains: "the article and author routes keep their paths" },
        { kind: "dropCallStatement", fn: "test", titleContains: "the blog index, its articles and its people keep their routes" },
      ],
    },
    {
      file: "sanity/schemas/fields/create-link.tsx",
      edits: [
        { kind: "dropObjectFromArray", anchor: "to", property: "type", value: "article" },
        { kind: "dropObjectFromArray", anchor: "to", property: "type", value: "blog" },
      ],
    },
    {
      file: "src/pages/sitemap.xml.ts",
      edits: [
        { kind: "dropStringFromArray", anchor: "tags", value: "article" },
        { kind: "dropStringFromArray", anchor: "tags", value: "blog" },
      ],
    },
    {
      file: "src/features/agents/query.ts",
      edits: [
        { kind: "dropImport", id: "SANITY_ARTICLE_DOCUMENT_TYPE" },
        { kind: "dropImport", id: "SANITY_SINGLETON_BLOG_ID" },
        // Only the blog index's article list reads this; `configuredReference` stays for Translate with AI's variants query.
        { kind: "dropImport", id: "ParentLocaleFilter" },
        { kind: "dropVariableStatement", name: "AgentMarkdownArticleListFragment" },
        {
          kind: "replaceText",
          label: "drop article and blog from the routed type list",
          find: `"\${SANITY_ARTICLE_DOCUMENT_TYPE}", "\${SANITY_PERSON_DOCUMENT_TYPE}", "\${SANITY_SINGLETON_BLOG_ID}"]`,
          with: "]",
        },
        {
          kind: "replaceText",
          label: "drop the blog index branch from the agent Markdown projection",
          find: `,
  _type == "\${SANITY_SINGLETON_BLOG_ID}" => {\${AgentMarkdownArticleListFragment}
  }`,
          with: "",
        },
      ],
    },
    {
      file: "src/features/agents/query.ts",
      requires: I18N_CONFIG,
      edits: [
        {
          kind: "replaceText",
          label: "drop the article category projection from the llms.txt inventory",
          // Anchored on the line above it: the same projection appears in the agent Markdown query,
          // and whitespace-tolerant matching would otherwise find both.
          find: `"publishedAt": publishedAt,
    "categories": categories[]->{ "name": \${localized("name")} }.name`,
          with: `"publishedAt": publishedAt`,
        },
        {
          kind: "replaceText",
          label: "drop the article byline and categories from the agent Markdown projection",
          find: `  "author": select(\${configuredReference("author")} => author->name),
  "categories": categories[]->{ "name": \${localized("name")} }.name,
`,
          with: "",
        },
      ],
    },
    {
      file: "src/features/agents/query.ts",
      requiresAbsent: I18N_CONFIG,
      edits: [
        {
          kind: "replaceText",
          label: "drop the article category projection from the llms.txt inventory",
          find: `"publishedAt": publishedAt,
    "categories": categories[]->name`,
          with: `"publishedAt": publishedAt`,
        },
        {
          kind: "replaceText",
          label: "drop the article byline and categories from the agent Markdown projection",
          find: `  "author": author->name,
  "categories": categories[]->name,
`,
          with: "",
        },
      ],
    },
    {
      file: "src/features/agents/query.test.ts",
      edits: [
        // Only the blog index's article list reads a second language's paths.
        { kind: "dropImport", id: "withLocalePrefix" },
        { kind: "dropCallStatement", fn: "test", titleContains: "the blog index's article list never name a ghost" },
      ],
    },
    {
      file: "src/sanity/queries.ts",
      edits: [
        { kind: "dropImport", id: "AuthorFragment" },
        { kind: "dropImport", id: "localized" },
        // Only the article and author queries join a person or their language's blog index.
        { kind: "dropImport", id: "configuredReference" },
        { kind: "dropImport", id: "ParentLocaleFilter" },
        { kind: "dropImport", id: "LocaleFilter" },
        { kind: "dropImport", id: "LocalizedSeoMetadataFragment" },
        { kind: "dropImport", id: "SANITY_ARTICLE_DOCUMENT_TYPE" },
        { kind: "dropImport", id: "SANITY_BLOG_INDEX_URI" },
        { kind: "dropImport", id: "SANITY_PERSON_DOCUMENT_TYPE" },
        { kind: "dropImport", id: "SANITY_SINGLETON_BLOG_ID" },
        { kind: "dropVariableStatement", name: "ArticlePageQ" },
        { kind: "dropVariableStatement", name: "BlogPageQ" },
        { kind: "dropVariableStatement", name: "AuthorPageQ" },
      ],
    },
    {
      file: "src/features/agents/not-found-markdown.ts",
      edits: [{ kind: "dropObjectFromArray", anchor: "NOT_FOUND_LINKS", property: "path", value: "/blog" }],
    },
    {
      file: "src/pages/api/agents/llms-txt.ts",
      edits: [
        {
          kind: "replaceText",
          label: "stop labelling entries as articles",
          find: `type: page._type === "article" ? "article" : "page",`,
          with: `type: "page",`,
        },
        {
          kind: "replaceText",
          label: "drop the category list from each llms.txt entry",
          find: `
          categories: page.categories?.filter((category): category is string => Boolean(category)) ?? undefined,`,
          with: "",
        },
        {
          kind: "replaceText",
          label: "drop categories from the entry shape described to the model",
          find: `each has type, title, url, and optional description, publishedAt, categories`,
          with: `each has type, title, url, and optional description, publishedAt`,
        },
        {
          kind: "replaceText",
          label: "drop the article-specific grouping guidance from the prompt",
          find: ` A good default is "## Pages" for entries with type "page" and "## Articles" for entries with type "article"; rename or merge them if it reads better.`,
          with: "",
        },
        {
          kind: "replaceText",
          label: "drop the blog example from the orientation guidance",
          find: ` (for example: the blog index for discovery, individual articles for deep dives)`,
          with: "",
        },
      ],
    },
    {
      file: "src/features/site/seo/structured-data.ts",
      edits: [
        { kind: "dropVariableStatement", name: "BlogInput" },
        { kind: "dropVariableStatement", name: "BlogPostingInput" },
        { kind: "dropVariableStatement", name: "blogLd" },
        { kind: "dropVariableStatement", name: "blogPostingLd" },
      ],
    },
    {
      file: "src/features/site/seo/structured-data.test.ts",
      edits: [
        { kind: "dropImport", id: "blogLd" },
        { kind: "dropImport", id: "blogPostingLd" },
        { kind: "dropCallStatement", fn: "test", titleContains: "blogLd" },
        { kind: "dropCallStatement", fn: "test", titleContains: "blogPostingLd", count: 3 },
      ],
    },
    {
      file: "src/features/auth/excluded-paths.ts",
      requires: "src/features/feed",
      edits: [
        { kind: "dropImport", id: "FEED_PATH" },
        { kind: "dropLines", contains: "The feed carries whole article bodies", optional: true },
        {
          kind: "replaceText",
          label: "stop excusing the feed from the dot-path skip",
          find: `if (pathname === FEED_PATH) {
    return false;
  }`,
          with: "",
        },
      ],
    },
    {
      file: "src/features/auth/excluded-paths.test.ts",
      requires: "src/features/feed",
      edits: [
        { kind: "dropImport", id: "FEED_PATH" },
        { kind: "dropCallStatement", fn: "test", titleContains: "the feed despite its extension" },
      ],
    },
    {
      file: "src/features/auth/request-gate.test.ts",
      requires: "src/features/feed",
      edits: [
        { kind: "dropCallStatement", fn: "test", titleContains: "the feed is a file route kept behind the gate" },
        { kind: "dropCallStatement", fn: "test", titleContains: "the feed answers in the default language only" },
      ],
    },
    {
      file: "src/features/agents/markdown-rewrite.ts",
      requires: "src/features/feed",
      edits: [
        { kind: "dropImport", id: "FEED_PATH" },
        {
          kind: "replaceText",
          label: "stop excusing the feed from Markdown content negotiation",
          find: `context.request.method !== "GET" || pathname === FEED_PATH || !prefersMarkdown`,
          with: `context.request.method !== "GET" || !prefersMarkdown`,
        },
      ],
    },
    {
      file: "src/features/agents/llms-txt-resources.ts",
      requires: "src/features/feed",
      edits: [{ kind: "dropLines", contains: "[RSS feed](" }],
    },
    {
      file: "src/features/agents/llms-txt-resources.test.ts",
      requires: "src/features/feed",
      edits: [{ kind: "dropLines", contains: "feed\\.xml" }],
    },
  ],
  dependencies: [],
  documentTypes: ["article", "articleCategory", "blog"],
  docs: ["docs/features/rss-feed.md"],
  notes: [
    "`sanity/schemas/documents/page.tsx` and the Site singleton may still link to blog URLs in their copy.",
    "`features/agents/markdown.ts` keeps its article-list renderer: it is inert once the query stops projecting `articles`, and removing it is a serializer decision rather than a registry one.",
  ],
};

/** Author profiles. See `blog`: the two imply each other, because the byline is part of the article route. */
const authors: Feature = {
  id: "authors",
  since: FIRST_CUT,
  title: "Authors",
  summary: "Person documents, the author profile page and the panel an article's byline opens.",
  implies: ["blog"],
  paths: ["sanity/schemas/documents/person.tsx"],
  edits: [
    {
      file: "sanity/schemas/index.ts",
      edits: [
        { kind: "dropImport", id: "person" },
        { kind: "dropArrayElement", arrayName: "schemaTypes", id: "person" },
      ],
    },
    {
      file: "sanity/constants.ts",
      edits: [
        { kind: "dropVariableStatement", name: "SANITY_PERSON_DOCUMENT_TYPE" },
        { kind: "dropVariableStatement", name: "SANITY_AUTHOR_PATH_PREFIX" },
        { kind: "dropObjectProperty", anchor: "LOCALIZED_FIELDS", key: "person" },
        { kind: "dropArrayElement", arrayName: "SHARED_ROUTED_DOCUMENT_TYPES", id: "SANITY_PERSON_DOCUMENT_TYPE" },
      ],
    },
    {
      file: "src/pages/sitemap.xml.ts",
      edits: [{ kind: "dropStringFromArray", anchor: "tags", value: "person" }],
    },
    {
      file: "src/features/agents/query.ts",
      requires: I18N_CONFIG,
      edits: [
        { kind: "dropImport", id: "SANITY_PERSON_DOCUMENT_TYPE" },
        { kind: "dropImport", id: "DEFAULT_LOCALE" },
        { kind: "dropVariableStatement", name: "localizedAgentRichText" },
        {
          kind: "replaceText",
          label: "empty the shared routed types the agent queries expand",
          find: 'const SharedRoutedTypes = `["${SANITY_PERSON_DOCUMENT_TYPE}"]`;',
          with: 'const SharedRoutedTypes = "[]";',
        },
        {
          kind: "replaceText",
          // Spans its leading comma to stay disjoint from the blog branch below, comment and all.
          label: "drop the person bio branch from the agent Markdown projection",
          find: `,
  // A person's body is their bio, under a different field name, in $language (one person serves every language).
  _type == "\${SANITY_PERSON_DOCUMENT_TYPE}" => {
    "content": \${localizedAgentRichText("bio")},
  }`,
          with: "",
        },
      ],
    },
    {
      // A cut from before i18n: the bio is one array for the one language.
      file: "src/features/agents/query.ts",
      requiresAbsent: I18N_CONFIG,
      edits: [
        { kind: "dropImport", id: "SANITY_PERSON_DOCUMENT_TYPE" },
        {
          kind: "replaceText",
          label: "drop the person bio branch from the agent Markdown projection",
          find: `,
  // A person's body is their bio, under a different field name.
  _type == "\${SANITY_PERSON_DOCUMENT_TYPE}" => {
    "content": \${agentRichText("bio")},
  }`,
          with: "",
        },
      ],
    },
    {
      // Translate with AI's protected names, gone with its route: the route reads a missing list as none, and an older cut has no line.
      file: "src/features/agents/query.ts",
      requires: "src/pages/api/agents/translate.ts",
      edits: [{ kind: "dropLines", contains: '"personNames": *[', optional: true }],
    },
    { file: "src/env.d.ts", edits: [{ kind: "dropLines", contains: '"author-dialog": import(' }] },
    { file: "sanity/structure.tsx", edits: [{ kind: "dropCallInArray", anchor: "items", title: "Authors" }] },
    {
      file: "src/features/site/seo/structured-data.ts",
      edits: [
        { kind: "dropVariableStatement", name: "ProfilePageInput" },
        { kind: "dropVariableStatement", name: "PersonInput" },
        { kind: "dropVariableStatement", name: "profilePageLd" },
        { kind: "dropVariableStatement", name: "personLd" },
      ],
    },
    {
      file: "src/features/site/seo/structured-data.test.ts",
      edits: [
        { kind: "dropImport", id: "personLd" },
        { kind: "dropImport", id: "profilePageLd" },
        { kind: "dropCallStatement", fn: "test", titleContains: "profilePageLd" },
        { kind: "dropCallStatement", fn: "test", titleContains: "personLd" },
      ],
    },
  ],
  documentTypes: ["person"],
};

/** Legal pages: prose documents served by the same catch-all route as a page. */
const legalPages: Feature = {
  id: "legal-pages",
  since: FIRST_CUT,
  title: "Legal pages",
  summary: "The `legalPage` document type and the prose route that renders it.",
  paths: ["src/features/legal", "sanity/schemas/documents/legal-page.tsx"],
  edits: [
    {
      file: "sanity/ai-translation/fields.ts",
      optional: true,
      edits: [{ kind: "dropObjectProperty", anchor: "CONDITIONAL_PATHS", key: "legalPage" }],
    },
    {
      file: "sanity/schemas/index.ts",
      edits: [
        { kind: "dropImport", id: "legalPage" },
        { kind: "dropArrayElement", arrayName: "schemaTypes", id: "legalPage" },
      ],
    },
    {
      file: "sanity/constants.ts",
      edits: [
        { kind: "dropVariableStatement", name: "SANITY_LEGAL_PAGE_DOCUMENT_TYPE" },
        { kind: "dropVariableStatement", name: "SANITY_LEGAL_PATH_PREFIX" },
        { kind: "dropArrayElement", arrayName: "I18N_DOCUMENT_TYPES", id: "SANITY_LEGAL_PAGE_DOCUMENT_TYPE" },
      ],
    },
    { file: "sanity/structure.tsx", edits: [{ kind: "dropCallInArray", anchor: "items", title: "Legal" }] },
    {
      file: "sanity/schemas/fields/create-link.tsx",
      edits: [{ kind: "dropObjectFromArray", anchor: "to", property: "type", value: "legalPage" }],
    },
    {
      file: "src/pages/sitemap.xml.ts",
      edits: [{ kind: "dropStringFromArray", anchor: "tags", value: "legalPage" }],
    },
    {
      file: "src/features/agents/query.ts",
      edits: [
        { kind: "dropImport", id: "SANITY_LEGAL_PAGE_DOCUMENT_TYPE" },
        {
          kind: "replaceText",
          label: "drop legalPage from the routed type list",
          find: `"\${SANITY_PAGE_DOCUMENT_TYPE}", "\${SANITY_LEGAL_PAGE_DOCUMENT_TYPE}"`,
          with: `"\${SANITY_PAGE_DOCUMENT_TYPE}"`,
        },
      ],
    },
    {
      file: "src/sanity/queries.ts",
      edits: [
        { kind: "dropImport", id: "SANITY_LEGAL_PAGE_DOCUMENT_TYPE" },
        {
          kind: "replaceText",
          label: "narrow the catch-all query to `page`",
          find: `_type in ["\${SANITY_PAGE_DOCUMENT_TYPE}", "\${SANITY_LEGAL_PAGE_DOCUMENT_TYPE}"]`,
          with: `_type == "\${SANITY_PAGE_DOCUMENT_TYPE}"`,
        },
        {
          kind: "replaceText",
          label: "drop the legal-page prose projection",
          find: `    _type == "\${SANITY_LEGAL_PAGE_DOCUMENT_TYPE}" => {
      "content": \${richText("content")},
    },
`,
          with: "",
        },
        {
          kind: "replaceText",
          label: "drop the two-type comment above the catch-all query",
          optional: true,
          find: `// Both catch-all types resolve here: \`page\` assembles a page builder, \`legalPage\` is prose in one field.
`,
          with: `// A document's URI is the only thing that decides where it is served.
`,
        },
      ],
    },
    {
      file: "src/pages/[...uri].astro",
      edits: [
        { kind: "dropImport", id: "LegalPage" },
        {
          kind: "replaceText",
          label: "render the page builder unconditionally",
          find: `{page._type === 'legalPage' ? <LegalPage page={page} /> : <PageSections docId={page._id} pageSections={pageSections} />}`,
          with: `<PageSections docId={page._id} pageSections={pageSections} />`,
        },
      ],
    },
  ],
  documentTypes: ["legalPage"],
  notes: ["Legal copy is often linked from the footer in the Site singleton; those links become dangling references."],
};

/**
 * The shared form layer: validation, the Turnstile human check, and the controls a form is built from.
 *
 * Not the contact form, which is its own feature and is only the first thing to use this. Whether
 * this goes is a judgement about the forms a project plans to build, so it is a feature to pick
 * rather than something a contact form removal takes with it.
 */
const forms: Feature = {
  id: "forms",
  since: FIRST_CUT,
  title: "Form layer",
  summary: "Shared form validation, the Turnstile human check, and the field components a form is built from.",
  mentions: ["form layer", "Turnstile", "human check"],
  codeOnly: true,
  // One way only: a project can drop the contact form and keep the layer to build its own forms,
  // but the contact form is built out of this and cannot outlive it.
  implies: ["contact-form"],
  paths: [
    "src/features/forms",
    "src/features/turnstile",
    "src/components/Form",
    "src/components/SubmitButton.astro",
    "src/components/Spinner.astro",
  ],
  edits: [
    {
      file: "src/env.d.ts",
      edits: [
        { kind: "dropLines", contains: '"form-field": import(' },
        { kind: "dropLines", contains: "readonly PUBLIC_TURNSTILE_SITE_KEY: string;" },
      ],
    },
    {
      file: ".env.example",
      edits: [
        { kind: "dropLines", contains: "# Cloudflare Turnstile, the human check every form runs", optional: true },
        { kind: "dropLines", contains: "# Cloudflare's always-pass test keys, right for local runs.", optional: true },
        {
          kind: "dropLines",
          contains: "# PUBLIC_TURNSTILE_SITE_KEY build variable, the secret is set on the Worker.",
          optional: true,
        },
        { kind: "dropLines", contains: "# form submission is refused.", optional: true },
        { kind: "dropLines", contains: "PUBLIC_TURNSTILE_SITE_KEY=" },
        { kind: "dropLines", contains: "TURNSTILE_SECRET_KEY=" },
      ],
    },
    ...envEdits(["PUBLIC_TURNSTILE_SITE_KEY", "TURNSTILE_SECRET_KEY"]),
    {
      file: ".github/workflows/deploy.yml",
      optional: true,
      edits: [{ kind: "dropLines", contains: "TURNSTILE_SITE_KEY", every: true }],
    },
    {
      file: ".github/actions/setup/action.yml",
      optional: true,
      edits: [
        {
          kind: "replaceText",
          label: "drop the Turnstile input",
          find: `  turnstile-site-key:
    description: The Turnstile widget's site key; Cloudflare's always-pass test key when a job renders no form anyone submits
    required: false
    default: "1x00000000000000000000AA"
`,
          with: "",
        },
        { kind: "dropLines", contains: "TURNSTILE_SITE_KEY", every: true },
      ],
    },
    {
      file: "src/lib/security-headers.ts",
      optional: true,
      edits: [
        { kind: "dropLines", contains: "// Turnstile's script and its challenge frame" },
        { kind: "dropStringFromArray", anchor: "script-src", value: "https://challenges.cloudflare.com" },
        { kind: "dropStringFromArray", anchor: "frame-src", value: "https://challenges.cloudflare.com" },
      ],
    },
    {
      file: "src/lib/security-headers.test.ts",
      optional: true,
      edits: [
        { kind: "dropLines", contains: '    "https://challenges.cloudflare.com",' },
        { kind: "dropLines", contains: 'policy.get("frame-src")' },
      ],
    },
    {
      file: "docs/features/security-headers.md",
      optional: true,
      edits: [{ kind: "dropLines", contains: "| Turnstile's ", every: true }],
    },
  ],
  env: ["PUBLIC_TURNSTILE_SITE_KEY", "TURNSTILE_SECRET_KEY"],
  docs: ["docs/features/forms.md", "docs/features/turnstile.md"],
  notes: ["`zod` stays: `astro.config.mjs` and the dataset scripts use it too, so it is not this feature's to uninstall."],
};

/** The contact form section, its submissions inbox and the Resend notification path. */
const contactForm: Feature = {
  id: "contact-form",
  since: FIRST_CUT,
  title: "Contact form",
  summary: "The contact form section, the submissions inbox, and the Resend notification emails.",
  mentions: ["contact form", "Resend", "form submissions", "notification emails"],
  implies: ["section:contact-form"],
  paths: ["sanity/schemas/documents/contact-form-submission.tsx", "src/pages/api/contact-form.ts"],
  edits: [
    {
      file: "sanity/schemas/index.ts",
      edits: [
        { kind: "dropImport", id: "contactFormSubmission" },
        { kind: "dropArrayElement", arrayName: "schemaTypes", id: "contactFormSubmission" },
      ],
    },
    {
      file: "sanity/constants.ts",
      edits: [{ kind: "dropObjectProperty", anchor: "API_ONLY_DOCUMENTS", key: "contactFormSubmission" }],
    },
    {
      file: "sanity/structure.tsx",
      edits: [
        { kind: "dropImport", id: "changeCase" },
        { kind: "dropImport", id: "API_ONLY_DOCUMENTS" },
        { kind: "dropCallInArray", anchor: "items", title: "Form Submissions" },
      ],
    },
    {
      file: "sanity/schemas/documents/site-settings.tsx",
      edits: [
        { kind: "dropFieldByName", anchor: "fields", name: "contactFormNotificationEmails" },
        { kind: "dropObjectFromArray", anchor: "groups", property: "name", value: "emailNotifications" },
      ],
    },
    {
      file: ".env.example",
      edits: [
        { kind: "dropLines", contains: "# Resend, for contact form notification emails", optional: true },
        { kind: "dropLines", contains: "RESEND_API_KEY=" },
        { kind: "dropLines", contains: "RESEND_EMAIL_FROM=" },
      ],
    },
    ...envEdits(["RESEND_API_KEY", "RESEND_EMAIL_FROM"]),
    { file: "src/env.d.ts", edits: [{ kind: "dropLines", contains: '"contact-form": import(' }] },
    { file: "README.md", edits: [{ kind: "dropLines", contains: "Contact form with Turnstile", optional: true }] },
  ],
  dependencies: ["resend"],
  env: ["RESEND_API_KEY", "RESEND_EMAIL_FROM"],
  documentTypes: ["contactFormSubmission"],
  fields: [{ documentType: "siteSettings", name: "contactFormNotificationEmails" }],
  orphans: ["src/features/forms", "src/features/turnstile", "src/components/Form", "src/components/SubmitButton.astro"],
  docs: ["docs/features/contact-form-notifications.md"],
  notes: [
    {
      unless: "forms",
      text: "`src/features/forms/`, `src/features/turnstile/` and `src/components/Form/` stay: they are the shared form layer rather than this feature. Whether they go is a judgement about the forms you plan to build, so trim `forms` when you are sure.",
    },
  ],
};

/** The bar above the header, and the setting on the Site singleton that holds its copy. */
const announcementBar: Feature = {
  id: "announcement-bar",
  since: "2026-08-24",
  title: "Announcement bar",
  summary: "The dismissible bar above the header, written on the Site singleton.",
  mentions: ["announcement bar", "the announcement"],
  paths: ["src/features/site/site-announcement"],
  edits: [
    {
      file: "src/features/site/SiteShell.astro",
      edits: [
        { kind: "dropImport", id: "SiteAnnouncement" },
        { kind: "dropLines", contains: "<SiteAnnouncement />" },
      ],
    },
    { file: "src/env.d.ts", edits: [{ kind: "dropLines", contains: '"site-announcement": import(' }] },
    {
      file: "sanity/schemas/documents/site.tsx",
      edits: [
        { kind: "dropFieldByName", anchor: "fields", name: "announcement" },
        { kind: "dropObjectFromArray", anchor: "groups", property: "name", value: "announcement" },
        { kind: "dropVariableStatement", name: "requiredIfEnabled" },
        { kind: "dropImport", id: "requiredIf" },
      ],
    },
  ],
  fields: [{ documentType: "site", name: "announcement" }],
  // The bar is the marquee's only caller, but a marquee is worth keeping for the next one.
  orphans: ["src/components/Marquee"],
};

/** Umami analytics: the tracking script, its website id and the event helpers. */
const umami: Feature = {
  id: "umami",
  since: FIRST_CUT,
  title: "Umami analytics",
  summary: "The Umami tracking script, its website id and the event helpers.",
  mentions: ["Umami"],
  codeOnly: true,
  paths: ["src/features/umami"],
  edits: [
    {
      file: "src/layouts/Web.astro",
      edits: [
        { kind: "dropImport", id: "PUBLIC_UMAMI_WEBSITE_ID" },
        {
          kind: "replaceText",
          label: "drop the Umami domain allowlist",
          find: `/** Public hostnames only, so preview visits neither send events nor log gateway 400s; null on localhost. */
const umamiApex = site.hostname.replace(/^www\\./, "");
const umamiDomains = umamiApex === "localhost" || umamiApex === "127.0.0.1" ? null : \`\${umamiApex},www.\${umamiApex}\`;

`,
          with: "",
        },
        {
          kind: "replaceText",
          label: "drop the Umami script tag",
          find: `<ClientRouter />

    {
      PUBLIC_UMAMI_WEBSITE_ID && umamiDomains && (
        <script
          is:inline
          defer
          src="https://cloud.umami.is/script.js"
          data-website-id={PUBLIC_UMAMI_WEBSITE_ID}
          data-domains={umamiDomains}
        ></script>
      )
    }`,
          with: "<ClientRouter />",
        },
      ],
    },
    {
      file: ".env.example",
      edits: [
        { kind: "dropLines", contains: "# Umami analytics website id", optional: true },
        { kind: "dropLines", contains: "PUBLIC_UMAMI_WEBSITE_ID=" },
      ],
    },
    ...envEdits(["PUBLIC_UMAMI_WEBSITE_ID"]),
    {
      file: ".github/workflows/deploy.yml",
      optional: true,
      edits: [{ kind: "dropLines", contains: "umami-website-id:" }],
    },
    {
      file: ".github/actions/setup/action.yml",
      optional: true,
      edits: [
        {
          kind: "replaceText",
          label: "drop the Umami input",
          find: `  umami-website-id:
    description: The Umami website id; empty builds the site without the tracker
    required: false
    default: ""
`,
          with: "",
        },
        { kind: "dropLines", contains: "PUBLIC_UMAMI_WEBSITE_ID", every: true },
      ],
    },
    {
      file: "src/lib/security-headers.ts",
      optional: true,
      edits: [
        { kind: "dropStringFromArray", anchor: "script-src", value: "https://cloud.umami.is" },
        { kind: "dropStringFromArray", anchor: "connect-src", value: "https://cloud.umami.is" },
        { kind: "dropStringFromArray", anchor: "connect-src", value: "https://gateway.umami.is" },
      ],
    },
    {
      file: "src/lib/security-headers.test.ts",
      optional: true,
      edits: [{ kind: "dropLines", contains: '    "https://cloud.umami.is",' }],
    },
    {
      file: "docs/features/security-headers.md",
      optional: true,
      edits: [
        { kind: "dropLines", contains: "| Umami tracker (" },
        { kind: "dropLines", contains: "| Umami collector (" },
      ],
    },
  ],
  env: ["PUBLIC_UMAMI_WEBSITE_ID"],
  docs: ["docs/features/umami-tracking.md"],
  skills: ["umami-analytics"],
};

/** The published OpenAPI description. The JSON error shape it documents stays: every endpoint uses it. */
const openapi: Feature = {
  id: "openapi",
  since: "2026-08-23",
  title: "OpenAPI description",
  summary: "The `/openapi.json` description of the public endpoints, and the links to it for agents.",
  mentions: ["OpenAPI"],
  codeOnly: true,
  paths: ["src/pages/openapi.json.ts", "src/features/api/openapi.ts", "src/features/api/openapi.test.ts"],
  edits: [
    { file: "src/features/agents/llms-txt-resources.ts", edits: [{ kind: "dropLines", contains: "[OpenAPI description](" }] },
    {
      file: "src/features/agents/llms-txt-resources.test.ts",
      edits: [{ kind: "dropLines", contains: "openapi\\.json", count: 2 }],
    },
    {
      file: "src/features/agents/not-found-markdown.ts",
      edits: [{ kind: "dropObjectFromArray", anchor: "NOT_FOUND_LINKS", property: "path", value: "/openapi.json" }],
    },
    {
      file: "src/features/agents/not-found-markdown.test.ts",
      edits: [{ kind: "dropLines", contains: "openapi\\.json" }],
    },
    {
      file: "src/features/api/errors.ts",
      edits: [{ kind: "dropLines", contains: "Documented in the OpenAPI description", optional: true }],
    },
    {
      file: "src/pages/api/agents/llms-txt.ts",
      edits: [
        {
          kind: "replaceText",
          label: "stop naming OpenAPI among the appended endpoints",
          find: "(OpenAPI, sitemap, crawler policy)",
          with: "(sitemap, crawler policy)",
        },
      ],
    },
    { file: "README.md", edits: [{ kind: "dropLines", contains: "**Published API description**", optional: true }] },
  ],
  docs: ["docs/features/openapi.md"],
};

/** The media field's schema, its GROQ fragment and the renderer dispatch: every media kind is wired into all three. */
const MEDIA_SCHEMA = "sanity/schemas/fields/create-media.tsx";
const MEDIA_FRAGMENT = "src/features/sanity/media/fragment.ts";
const MEDIA_TYPES = "src/sanity/media/types.ts";
const MEDIA_RENDERERS = "src/sanity/media/SanityMedia.astro";

/** Both file inputs that read dimensions are built from it; it is left once neither is. */
const DIMENSIONS_INPUT = "sanity/inputs/asset-dimensions-input.tsx";

/** `section:media` deletes it, while Rive only edits it. */
const MEDIA_SECTION_SCHEMA = "sanity/schemas/page-sections/media-section.tsx";

/**
 * Media items are objects nested in pages, sections and rich text, so no purge reaches them. Set to a
 * removed kind, one renders nothing, and the Studio shows its leftover fields as unknown.
 */
function mediaNote(kind: string): string {
  return `Media items already set to ${kind} render nothing now, and the Studio flags their ${kind} fields as unknown until an editor picks another media type.`;
}

/** One media kind: its option in the media field, its fields, its GROQ branch and its renderer. */
function mediaKind(options: {
  value: string;
  renderer: string;
  schema: FileEdits["edits"];
  fragment: FileEdits["edits"];
  types?: string[];
}): FileEdits[] {
  const { value, renderer, schema, fragment, types = [] } = options;

  return [
    {
      file: MEDIA_SCHEMA,
      edits: [
        { kind: "dropUnionMember", anchor: "MediaType", value },
        { kind: "dropObjectFromArray", anchor: "MEDIA_TYPE_OPTIONS", property: "value", value },
        { kind: "dropSwitchCase", value },
        ...schema,
      ],
    },
    {
      file: MEDIA_FRAGMENT,
      edits: [
        { kind: "dropBlock", opens: `type == "${value}"` },
        { kind: "dropUnionMember", anchor: "type", value },
        ...fragment,
      ],
    },
    ...(types.length > 0 ? [{ file: MEDIA_TYPES, edits: types.map((id): Edit => ({ kind: "dropExport", id })) }] : []),
    {
      file: MEDIA_RENDERERS,
      edits: [
        { kind: "dropImport", id: renderer },
        { kind: "dropObjectProperty", anchor: "renderers", key: value },
      ],
    },
  ];
}

const muxVideo: Feature = {
  id: "media:mux",
  since: FIRST_CUT,
  title: "Mux video",
  summary: "Mux-hosted video as a media kind: the Studio plugin, the player and its poster helpers.",
  mentions: ["Mux"],
  codeOnly: true,
  paths: ["src/sanity/media/SanityMuxVideo.astro", "src/features/mux"],
  edits: [
    ...mediaKind({
      value: "videoMux",
      renderer: "SanityMuxVideo",
      schema: [
        { kind: "dropVariableStatement", name: "buildPosterUrl" },
        { kind: "dropLines", contains: "playbackId", count: 6 },
        { kind: "dropLines", contains: "thumbTime", count: 4 },
        { kind: "dropFieldByName", anchor: "fields", name: "video" },
        { kind: "dropFieldByName", anchor: "fields", name: "animatedThumbnail" },
        { kind: "dropStringFromArray", anchor: "visibleIfType", value: "videoMux", count: 2 },
      ],
      fragment: [
        { kind: "dropVariableStatement", name: "VideoFragment" },
        { kind: "dropVariableStatement", name: "VideoFragmentResult" },
        { kind: "dropVariableStatement", name: "AnimatedThumbnailFragmentResult" },
        { kind: "dropLines", contains: '"video": null,', every: true, optional: true },
        { kind: "dropLines", contains: "video?: VideoFragmentResult | null;" },
        { kind: "dropLines", contains: "animatedThumbnail?: AnimatedThumbnailFragmentResult | null;" },
      ],
      types: ["VideoFragmentResult"],
    }),
    {
      file: "src/features/sanity/media/constants.ts",
      edits: [
        { kind: "dropVariableStatement", name: "POSTER_PREVIEW_MAX_EDGE" },
        { kind: "dropVariableStatement", name: "POSTER_PLAYER_MAX_EDGE" },
      ],
    },
    {
      file: "sanity/schemas/schemas.test.ts",
      edits: [
        { kind: "dropLines", contains: "video.asset.playbackId", count: 2 },
        { kind: "dropLines", contains: "video.asset.thumbTime", count: 2 },
      ],
    },
    {
      file: "sanity.config.ts",
      edits: [
        { kind: "dropImport", id: "muxInput" },
        { kind: "dropArrayElement", arrayName: "plugins", id: "muxInput" },
      ],
    },
    {
      file: "src/lib/security-headers.ts",
      optional: true,
      edits: [
        { kind: "dropStringFromArray", anchor: "img-src", value: "https://image.mux.com" },
        { kind: "dropStringFromArray", anchor: "connect-src", value: "https://stream.mux.com" },
        { kind: "dropStringFromArray", anchor: "connect-src", value: "https://*.mux.com" },
        { kind: "dropStringFromArray", anchor: "connect-src", value: "https://*.litix.io" },
      ],
    },
    {
      file: "docs/features/security-headers.md",
      optional: true,
      edits: [
        { kind: "dropLines", contains: "| `https://image.mux.com` |" },
        { kind: "dropLines", contains: "https://*.litix.io` |" },
      ],
    },
  ],
  dependencies: ["@mux/mux-player", "sanity-plugin-mux-input"],
  notes: [
    mediaNote("Mux"),
    "The dataset keeps its `mux.videoAsset` documents, and Mux keeps the videos: delete them in the Mux dashboard, then the documents with `--dataset-only` once nothing references them.",
    "`src/sanity/media/VideoPlayerElement.ts` still looks for a `mux-player` beside a `video`; it is harmless, and a one-word cleanup.",
  ],
};

const videoUrl: Feature = {
  id: "media:video-url",
  since: FIRST_CUT,
  title: "Video URL",
  summary: "An external video URL as a media kind, played in the same element as an uploaded file.",
  mentions: ["Video URL", "videoUrl"],
  codeOnly: true,
  paths: ["src/sanity/media/SanityVideoUrl.astro"],
  edits: mediaKind({
    value: "videoUrl",
    renderer: "SanityVideoUrl",
    schema: [
      { kind: "dropFieldByName", anchor: "fields", name: "videoUrl" },
      { kind: "dropStringFromArray", anchor: "visibleIfType", value: "videoUrl", count: 2 },
      { kind: "dropStringFromArray", anchor: "requiredIfType", value: "videoUrl" },
    ],
    fragment: [
      { kind: "dropLines", contains: '"videoUrl": null,', every: true, optional: true },
      { kind: "dropLines", contains: "videoUrl?: VideoFileFragmentResult | null;" },
    ],
  }),
  notes: [mediaNote("Video URL")],
};

const rive: Feature = {
  id: "media:rive",
  since: FIRST_CUT,
  title: "Rive",
  summary: "Rive animations as a media kind: the canvas element, its options and the Studio dimension reader.",
  mentions: ["Rive"],
  codeOnly: true,
  paths: [
    "src/sanity/media/SanityRive.astro",
    "src/sanity/media/RiveElement.ts",
    "sanity/schemas/fields/rive-options.tsx",
    "sanity/lib/parse-rive-dimensions.ts",
    "sanity/inputs/rive-file-input.tsx",
  ],
  edits: [
    ...mediaKind({
      value: "rive",
      renderer: "SanityRive",
      schema: [
        { kind: "dropImport", id: "RiveFileInput" },
        { kind: "dropFieldByName", anchor: "fields", name: "riveFile" },
        { kind: "dropFieldByName", anchor: "fields", name: "riveDimensions" },
        { kind: "dropFieldByName", anchor: "fields", name: "riveOptions" },
        { kind: "dropLines", contains: "withCustomRiveOptions", count: 3 },
      ],
      fragment: [
        { kind: "dropBlock", opens: "riveOptions{" },
        { kind: "dropVariableStatement", name: "RiveOptions" },
        { kind: "dropVariableStatement", name: "RiveFragmentResult" },
        { kind: "dropLines", contains: '"rive": null,', every: true, optional: true },
        { kind: "dropLines", contains: "rive?: RiveFragmentResult | null;" },
        { kind: "dropLines", contains: "riveOptions?: RiveOptions | null;" },
      ],
      types: ["RiveFragmentResult"],
    }),
    // The callers that switch the Rive options on. The media section's is gone once that section is trimmed.
    {
      file: MEDIA_SECTION_SCHEMA,
      requires: MEDIA_SECTION_SCHEMA,
      edits: [{ kind: "dropLines", contains: "withCustomRiveOptions: true" }],
    },
    ...["sanity/schemas/fields/create-rich-text/index.tsx", "sanity/schemas/fields/create-rich-text/blocks/media-block.tsx"].map(
      (file): FileEdits => ({ file, edits: [{ kind: "dropLines", contains: "withCustomRiveOptions: true" }] })
    ),
    {
      file: "sanity/schemas/index.ts",
      edits: [
        { kind: "dropImport", id: "riveOptions" },
        { kind: "dropArrayElement", arrayName: "schemaTypes", id: "riveOptions" },
      ],
    },
    { file: "src/env.d.ts", edits: [{ kind: "dropLines", contains: '"rive-canvas": import(' }] },
  ],
  dependencies: ["@rive-app/canvas", "@rive-app/canvas-advanced-single"],
  orphans: [DIMENSIONS_INPUT],
  notes: [mediaNote("Rive")],
};

const lottie: Feature = {
  id: "media:lottie",
  since: FIRST_CUT,
  title: "Lottie",
  summary: "Lottie animations as a media kind: the player element, its options and the Studio dimension reader.",
  mentions: ["Lottie"],
  codeOnly: true,
  paths: [
    "src/sanity/media/SanityLottie.astro",
    "src/sanity/media/lottie-player.ts",
    "sanity/schemas/fields/lottie-options.tsx",
    "sanity/lib/parse-lottie-dimensions.ts",
    "sanity/inputs/lottie-file-input.tsx",
  ],
  edits: [
    ...mediaKind({
      value: "lottie",
      renderer: "SanityLottie",
      schema: [
        { kind: "dropImport", id: "LottieFileInput" },
        { kind: "dropFieldByName", anchor: "fields", name: "lottieFile" },
        { kind: "dropFieldByName", anchor: "fields", name: "lottieDimensions" },
        { kind: "dropFieldByName", anchor: "fields", name: "lottieOptions" },
        { kind: "dropLines", contains: "withCustomLottieOptions", count: 3 },
      ],
      fragment: [
        { kind: "dropBlock", opens: "lottieOptions{" },
        { kind: "dropVariableStatement", name: "LottieOptions" },
        { kind: "dropVariableStatement", name: "LottieFragmentResult" },
        { kind: "dropLines", contains: '"lottie": null,', every: true, optional: true },
        { kind: "dropLines", contains: "lottie?: LottieFragmentResult | null;" },
        { kind: "dropLines", contains: "lottieOptions?: LottieOptions | null;" },
      ],
      types: ["LottieFragmentResult"],
    }),
    {
      file: "sanity/schemas/index.ts",
      edits: [
        { kind: "dropImport", id: "lottieOptions" },
        { kind: "dropArrayElement", arrayName: "schemaTypes", id: "lottieOptions" },
      ],
    },
  ],
  dependencies: ["@lottiefiles/dotlottie-wc", "@lottiefiles/dotlottie-web"],
  orphans: [DIMENSIONS_INPUT],
  notes: [mediaNote("Lottie")],
};

/** What a new project is started with: the seed content and the Sanity setup wizard. Done once, then dead weight. */
const bootstrap: Feature = {
  id: "bootstrap",
  since: FIRST_CUT,
  title: "Starter bootstrap",
  summary: "The seed dataset and the Sanity project setup wizard, which only matter before the first deploy.",
  mentions: ["seed dataset", "sanity:project-setup", "project setup"],
  codeOnly: true,
  afterCut: true,
  paths: ["seed", "scripts/sanity-project-setup", "scripts/sanity-dataset/seed.test.ts"],
  edits: [
    { file: "package.json", edits: [{ kind: "dropJsonKey", key: "sanity:project-setup", in: "scripts" }] },
    { file: "scripts/README.md", edits: [{ kind: "dropLines", contains: "**`sanity-project-setup/`**" }] },
    { file: ".gitignore", edits: [{ kind: "dropLines", contains: "!/seed/seed-dataset.tar.gz" }] },
    {
      file: ".env.example",
      edits: [
        {
          kind: "replaceText",
          find: "# Sanity project (public; `npm run sanity:project-setup` fills these).",
          with: "# Sanity project (public).",
        },
        {
          kind: "replaceText",
          find: "# Server-only Sanity tokens (never reach the browser); `npm run sanity:project-setup` creates both.",
          with: "# Server-only Sanity tokens (never reach the browser).",
        },
        {
          kind: "replaceText",
          find: "# `npm run sanity:project-setup` fills it with a random 64-hex value when empty. At least 32 characters when set",
          with: "# A random 64-hex value. At least 32 characters when set",
        },
      ],
    },
    {
      file: "README.md",
      edits: [
        { kind: "dropLines", contains: "- Starter **seed dataset** (`seed/`)" },
        { kind: "dropLines", contains: "- `npm run sanity:project-setup`: Interactive wizard" },
        { kind: "dropLines", contains: "See [`docs/sanity/seed-dataset.md`](docs/sanity/seed-dataset.md)." },
        { kind: "dropLines", contains: "|-- seed/" },
      ],
    },
    {
      file: "docs/README.md",
      edits: [
        { kind: "dropLines", contains: "(./sanity/seed-dataset.md)", count: 2 },
        { kind: "dropLines", contains: "(./sanity/project-setup.md)", count: 2 },
      ],
    },
    {
      file: "docs/sanity/README.md",
      edits: [
        { kind: "dropLines", contains: "| `npm run sanity:project-setup`" },
        { kind: "dropLines", contains: "(./seed-dataset.md)" },
        { kind: "dropLines", contains: "- [Sanity project setup](./project-setup.md)" },
      ],
    },
  ],
  docs: ["docs/sanity/project-setup.md", "docs/sanity/seed-dataset.md"],
};

/** One UI dictionary per language beside the default, registered in `UI_STRINGS`. */
const DICTIONARIES_DIR = "src/features/i18n/dictionaries";
const UI_STRINGS_FILE = "src/features/i18n/strings.ts";

/**
 * A language the starter ships beside the default. Its LOCALES entry is commented out rather than
 * deleted: the commented line is the way back, and the candidate `npm run i18n:check` switches on.
 */
function language(options: { id: string; title: string; dictionary: string; since: string }): Feature {
  const { id, title, dictionary, since } = options;

  return {
    id: `language:${id}`,
    title,
    summary: `${title} as a site language: its LOCALES entry and UI dictionary, and with --dataset every ${title} document, its translation links and its text on shared documents and assets.`,
    since,
    language: id,
    // Only the configuration sentence: docs and tests use it as their example second language.
    mentions: [`English and ${title}`],
    paths: [`${DICTIONARIES_DIR}/${id}.ts`],
    edits: [
      {
        file: I18N_CONFIG,
        requires: I18N_CONFIG,
        edits: [{ kind: "commentOutObjectInArray", anchor: "LOCALES", property: "id", value: id }],
      },
      {
        file: UI_STRINGS_FILE,
        requires: I18N_CONFIG,
        edits: [
          { kind: "dropImport", id: dictionary },
          { kind: "dropObjectProperty", anchor: "UI_STRINGS", key: id },
        ],
      },
    ],
    notes: [
      {
        unless: "blog",
        text: `\`SECTION_SEGMENTS\` in \`sanity/sections.ts\` keeps its ${title} words: inert while ${title} is off, and ready when it comes back.`,
      },
      {
        unless: "bootstrap",
        text: `\`seed/seed-dataset.tar.gz\` is not edited; the setup wizard and \`npm run sanity:dataset-import\` leave out ${title} content while ${title} is off. Trim \`bootstrap\` once the project is set up.`,
      },
      {
        unless: "ai-translation",
        text: `Settings > Translations keeps any ${title} glossary renderings and language notes: hidden while ${title} is off, and back when it returns.`,
      },
    ],
  };
}

const italian = language({ id: "it", title: "Italian", dictionary: "italian", since: "2026-10-19" });

/** Groups for a feature that only ever shipped beside i18n: a project from before it has none of their anchors. */
function besideI18n(groups: FileEdits[]): FileEdits[] {
  return groups.map((group) => ({ ...group, requires: I18N_CONFIG }));
}

/** Every type `withAiTranslationRecord` gives the hidden `aiTranslation` record, so the purge can unset it. */
const AI_TRANSLATION_RECORD = "sanity/schemas/fields/create-ai-translation-field.tsx";
const AI_TRANSLATED_TYPES = ["site", "page", "blog", "article", "legalPage"];

/**
 * Translate with AI: the document action, the Settings > Translations panel, the route and the daily
 * AI request ledger. Offered when a run switches off the last second language, and on its own otherwise.
 */
const aiTranslation: Feature = {
  id: "ai-translation",
  since: "2026-10-20",
  title: "Translate with AI",
  summary:
    "The Translate with AI action and Settings panel, its route, AI request ledger and schema check (it only works with a second language); with --dataset, the record it keeps on each translation and its settings.",
  mentions: ["Translate with AI", "AI translation", "sanity:schema-check", "Update links"],
  needsSecondLanguage: true,
  paths: [
    "sanity/ai-translation",
    "sanity/inputs/site-translation-input.tsx",
    "sanity/inputs/site-translation-input.test.ts",
    "sanity/inputs/site-translation-run.tsx",
    AI_TRANSLATION_RECORD,
    "sanity/schemas/fields/create-ai-translation-field.test.ts",
    "sanity/schemas/documents/site-settings-translations.test.ts",
    "src/features/agents/translate",
    "src/features/agents/translate.test.ts",
    "src/features/agents/translation-markdown.ts",
    "src/features/agents/ai-ledger.ts",
    "src/features/agents/ai-ledger.test.ts",
    "src/pages/api/agents/translate.ts",
    "scripts/sanity-migrations/lib/ai-results.ts",
    "scripts/sanity-migrations/lib/ai-results.test.ts",
    "scripts/sanity-schema-check",
  ],
  edits: besideI18n([
    {
      // The generator's steps that list a type here go with the folder they write to.
      file: "plopfile.mjs",
      edits: [
        { kind: "dropObjectFromArray", anchor: "actions", property: "path", value: "./sanity/ai-translation/fields.ts" },
        { kind: "dropObjectFromArray", anchor: "actions", property: "path", value: "./sanity/ai-translation/plan.ts" },
        { kind: "dropObjectFromArray", anchor: "actions", property: "path", value: "./sanity/ai-translation/site-run.ts" },
        { kind: "dropObjectFromArray", anchor: "actions", property: "path", value: "./sanity/ai-translation/dialog-model.ts" },
        { kind: "dropVariableStatement", name: "unlessListed" },
        { kind: "dropImport", id: "existsSync" },
        { kind: "dropImport", id: "readFileSync" },
        { kind: "dropImport", id: "join" },
      ],
    },
    {
      file: "sanity.config.ts",
      edits: [
        { kind: "dropImport", id: "withAiTranslationRecord" },
        {
          kind: "replaceText",
          label: "stop adding the AI translation record to every translated type",
          find: "withTranslationExclusions(withAiTranslationRecord(type))",
          with: "withTranslationExclusions(type)",
        },
      ],
    },
    { file: "sanity/i18n-studio.ts", edits: [{ kind: "dropExport", id: "withAiTranslationRecord" }] },
    {
      file: "sanity/actions.tsx",
      edits: [
        { kind: "dropImport", id: "createTranslateWithAiAction" },
        { kind: "dropBlock", opens: "if (IS_I18N_ENABLED && (I18N_DOCUMENT_TYPES.includes(schemaType)" },
      ],
    },
    {
      file: "sanity/actions.test.ts",
      edits: [
        { kind: "dropLines", contains: "let translateWithAi: string;" },
        { kind: "dropLines", contains: "TRANSLATE_WITH_AI_ACTION: translateWithAi" },
        { kind: "dropCallStatement", fn: "it", titleContains: "Translate with AI", count: 3 },
        // Only those three read the actions by display name.
        { kind: "dropVariableStatement", name: "displayed" },
      ],
    },
    {
      file: "sanity/constants.ts",
      edits: [
        { kind: "dropVariableStatement", name: "AI_TRANSLATION_FIELD" },
        { kind: "dropArrayElement", arrayName: "TRANSLATION_EXCLUDED_FIELDS", id: "AI_TRANSLATION_FIELD" },
        { kind: "dropVariableStatement", name: "AI_TRANSLATION_STYLE_GUIDE_LIMIT" },
        { kind: "dropVariableStatement", name: "AI_TRANSLATION_DEFAULTS" },
        { kind: "dropVariableStatement", name: "AI_TRANSLATION_LEASE_TYPE" },
        { kind: "dropVariableStatement", name: "AI_TRANSLATION_LEDGER_TYPE" },
        { kind: "dropVariableStatement", name: "AI_TRANSLATION_RESULT_TYPE" },
        { kind: "dropVariableStatement", name: "AiTranslationDocumentType" },
        { kind: "dropVariableStatement", name: "AI_TRANSLATION_KEY" },
        { kind: "dropVariableStatement", name: "VERSIONED_ID" },
        { kind: "dropVariableStatement", name: "aiTranslationDocumentId" },
      ],
    },
    { file: "sanity/config.ts", edits: [{ kind: "dropObjectProperty", anchor: "endpoints", key: "aiTranslate" }] },
    {
      file: "sanity/translation-stub.ts",
      edits: [
        { kind: "dropImport", id: "AI_TRANSLATION_FIELD" },
        {
          kind: "replaceText",
          label: "stop removing the AI translation record from a new translation",
          find: "[...SYSTEM_FIELDS, ...excludedFields, AI_TRANSLATION_FIELD]",
          with: "[...SYSTEM_FIELDS, ...excludedFields]",
        },
        {
          kind: "replaceText",
          label: "stop keeping the AI translation record on a refresh",
          find: '["uri", "passwordProtected", AI_TRANSLATION_FIELD]',
          with: '["uri", "passwordProtected"]',
        },
        {
          kind: "replaceText",
          find: "its URI, Password protect and the record.",
          with: "its URI and Password protect.",
          optional: true,
        },
      ],
    },
    {
      file: "sanity/translation-stub.test.ts",
      edits: [
        { kind: "dropLines", contains: 'aiTranslation: { sourceId: "x" },' },
        { kind: "dropLines", contains: '"a provenance record never carries over"' },
      ],
    },
    {
      file: "sanity/translation-callback.ts",
      edits: [
        { kind: "dropImport", id: "AI_TRANSLATION_FIELD" },
        { kind: "dropLines", contains: 'const { copyRecord } = await import("./ai-translation/plan");' },
        { kind: "dropLines", contains: "// On use: the AI plan reads translation-stub", optional: true },
        { kind: "dropLines", contains: "// Stamped as made, so Translate with AI tells", optional: true },
        { kind: "dropBlock", opens: "if (destinationLanguageId !== sourceLanguageId) {" },
      ],
    },
    {
      file: "sanity/translation-callback.test.ts",
      edits: [
        { kind: "dropImport", id: "copyRecord" },
        { kind: "dropImport", id: "translationStatus" },
        { kind: "dropVariableStatement", name: "newDocument" },
        { kind: "dropLines", contains: "aiTranslation: copyRecord(newDocument" },
        { kind: "dropCallStatement", fn: "it", titleContains: "stamps the copy as made" },
      ],
    },
    {
      file: "sanity/editor-copy.test.ts",
      edits: [
        { kind: "dropImport", id: "AGENT_ERROR_MESSAGES" },
        { kind: "dropImport", id: "TRANSLATE_MESSAGES" },
        { kind: "dropCallStatement", fn: "it", titleContains: "never starts a sentence with Run npm" },
        { kind: "dropCallStatement", fn: "it", titleContains: "names the token a developer checks" },
      ],
    },
    ...["sanity/schemas/fields/create-language-field.tsx", "sanity/schemas/fields/create-language-field.test.ts"].map(
      (file): FileEdits => ({
        file,
        edits: [
          {
            kind: "replaceText",
            label: "stop pointing a cross-language warning at Update links",
            find: " Once that translation is published, Update links in Settings > Translations points this at it.",
            with: "",
          },
        ],
      })
    ),
    {
      file: "sanity/schemas/documents/site-settings.tsx",
      edits: [
        { kind: "dropImport", id: "languageName" },
        { kind: "dropImport", id: "policyTitles" },
        { kind: "dropImport", id: "readTranslationSettings" },
        { kind: "dropImport", id: "styleGuideIssues" },
        { kind: "dropImport", id: "AI_TRANSLATION_DEFAULTS" },
        { kind: "dropImport", id: "AI_TRANSLATION_STYLE_GUIDE_LIMIT" },
        { kind: "dropVariableStatement", name: "SOURCE_LANGUAGE" },
        { kind: "dropVariableStatement", name: "POLICY_TITLES" },
        { kind: "dropVariableStatement", name: "STYLE_GUIDE_LIMIT" },
        { kind: "dropVariableStatement", name: "TRANSLATION_TARGETS" },
        { kind: "dropVariableStatement", name: "PER_LANGUAGE" },
        { kind: "dropVariableStatement", name: "TranslationPanel" },
        { kind: "dropVariableStatement", name: "StyleGuideRoom" },
        { kind: "dropVariableStatement", name: "SiteTranslationField" },
        { kind: "dropVariableStatement", name: "StyleGuideInput" },
        { kind: "dropVariableStatement", name: "styleGuideLengthIssue" },
        { kind: "dropVariableStatement", name: "compiledStyleGuideIssue" },
        { kind: "dropFieldByName", anchor: "fields", name: "translations" },
        { kind: "dropObjectFromArray", anchor: "groups", property: "name", value: "translations" },
      ],
    },
    {
      file: "src/features/agents/query.ts",
      edits: [
        { kind: "dropImport", id: "AI_TRANSLATION_RESULT_TYPE" },
        { kind: "dropImport", id: "SANITY_AGENT_SCHEMA_ID" },
        ...[
          "AiTranslationMarkdownQuery",
          "AiTranslationSettingsQuery",
          "AiTranslationDocumentsQuery",
          "AiTranslationGroupQuery",
          "AiTranslationVariantsQuery",
          "AiTranslationPlanPageQuery",
          "AiTranslationGroupsPageQuery",
          "AiTranslationVersionsQuery",
          "AiTranslationTakenUrisQuery",
          "AiTranslationHoldersQuery",
          "AiTranslationRedirectSourcesQuery",
          "AiTranslationDeployedSchemaQuery",
          "AiTranslationOffQuery",
          "AiTranslationTimeoutsQuery",
        ].map((name): Edit => ({ kind: "dropVariableStatement", name })),
      ],
    },
    {
      file: "src/features/agents/query.test.ts",
      edits: [
        { kind: "dropImport", id: "AiTranslationMarkdownQuery" },
        { kind: "dropVariableStatement", name: "TRANSLATION" },
        { kind: "dropLines", contains: '["AiTranslationMarkdownQuery", AiTranslationMarkdownQuery,' },
      ],
    },
    {
      file: "src/sanity/lib/query-budget.test.ts",
      edits: [
        {
          kind: "replaceText",
          find: 'new Set<string>(["AiTranslationMarkdownQuery"])',
          with: "new Set<string>()",
          optional: true,
        },
      ],
    },
    {
      file: "src/features/api/revalidate.ts",
      edits: [
        { kind: "dropVariableStatement", name: "UNRENDERED_TYPE_PREFIX" },
        { kind: "dropBlock", opens: "if (parsed.data._type.startsWith(UNRENDERED_TYPE_PREFIX)) {" },
      ],
    },
    {
      file: "src/features/api/revalidate.test.ts",
      edits: [
        { kind: "dropImport", id: "AI_TRANSLATION_LEASE_TYPE" },
        { kind: "dropImport", id: "AI_TRANSLATION_LEDGER_TYPE" },
        { kind: "dropImport", id: "AI_TRANSLATION_RESULT_TYPE" },
        { kind: "dropCallStatement", fn: "test", titleContains: "AI translation bookkeeping answers 200 at once" },
      ],
    },
    {
      // Automatic alt text stays, each description one direct call again.
      file: "src/pages/api/agents/image-alt-text.ts",
      edits: [
        { kind: "dropImport", id: "ledgerCredit" },
        { kind: "dropLines", contains: "credit: ledgerCredit(sanityEditClient),", count: 2 },
      ],
    },
    {
      file: "scripts/sanity-migrations/lib/language.ts",
      edits: [
        // As text: the first import, so a structural drop would take the module header above it too.
        {
          kind: "replaceText",
          label: "remove the import of `copyRecord`",
          find: 'import { copyRecord } from "../../../sanity/ai-translation/plan";',
          with: "",
        },
        { kind: "dropImport", id: "AI_TRANSLATION_FIELD" },
        { kind: "dropLines", contains: "// Stamped as made, so Translate with AI tells", optional: true },
        { kind: "dropLines", contains: "stub.document[AI_TRANSLATION_FIELD] = copyRecord(" },
        {
          kind: "replaceText",
          label: "stop pointing at Translate with AI to link a translation",
          find: "link it as the translation from Translate with AI in the Studio, or delete it and run this again.",
          with: "delete it and run this again.",
        },
      ],
    },
    {
      file: "scripts/sanity-migrations/lib/language.test.ts",
      edits: [
        { kind: "dropImport", id: "copyRecord" },
        { kind: "dropImport", id: "readRecord" },
        { kind: "dropImport", id: "translationStatus" },
        { kind: "dropCallStatement", fn: "it", titleContains: "stamps each copy as made" },
      ],
    },
    {
      file: "scripts/sanity-migrations/remove-language.ts",
      edits: [
        ...[
          "AI_RESULTS_QUERY",
          "AiResultCleanup",
          "AiResultDocument",
          "aiResultCleanupMutations",
          "describeAiResultCleanup",
          "isEmptyCleanup",
          "planAiResultCleanup",
        ].map((id): Edit => ({ kind: "dropImport", id })),
        { kind: "dropVariableStatement", name: "readAiCleanup" },
        {
          kind: "replaceText",
          label: "stop passing the AI results cleanup to the write",
          find: "plan: LanguageRemovalPlan, ai: AiResultCleanup): Promise<void> {",
          with: "plan: LanguageRemovalPlan): Promise<void> {",
        },
        { kind: "dropBlock", opens: "if (!isEmptyCleanup(ai)) {" },
        { kind: "dropLines", contains: "const ai = await readAiCleanup(migration, removed);" },
        { kind: "dropLines", contains: "const freshAi = await readAiCleanup(migration, removed);" },
        {
          kind: "replaceText",
          find: "[...formatLanguageRemovalPlan(plan), ...describeAiResultCleanup(ai)]",
          with: "formatLanguageRemovalPlan(plan)",
        },
        { kind: "replaceText", find: "if (isEmptyPlan(plan) && isEmptyCleanup(ai)) {", with: "if (isEmptyPlan(plan)) {" },
        { kind: "replaceText", find: "await write(migration, fresh, freshAi);", with: "await write(migration, fresh);" },
      ],
    },
    { file: "package.json", edits: [{ kind: "dropJsonKey", key: "sanity:schema-check", in: "scripts" }] },
    { file: "README.md", edits: [{ kind: "dropLines", contains: "`npm run sanity:schema-check`", optional: true }] },
    { file: "scripts/README.md", edits: [{ kind: "dropLines", contains: "**`sanity-schema-check/`**", optional: true }] },
    { file: "AGENTS.md", edits: [{ kind: "dropLines", contains: "- `npm run sanity:schema-check` compares", optional: true }] },
  ]),
  fields: [
    { documentType: "siteSettings", name: "translations" },
    ...AI_TRANSLATED_TYPES.map((documentType) => ({ documentType, name: "aiTranslation", addedBy: AI_TRANSLATION_RECORD })),
  ],
  docs: ["docs/features/ai-translation.md"],
  notes: [
    "Automatic alt text stays: each description is one direct call again, counted against no daily limit.",
    "The dataset keeps Translate with AI's bookkeeping (`aiTranslation.lease`, `.ledger` and `.result` documents). Nothing reads them now, and their dotted ids keep them out of every purge: delete them with `npm run sanity:cli -- documents delete <id>` if you want them gone.",
    "`sanity/translation-stub.ts` keeps the refresh and URI helpers only Translate with AI called; the knip sweep names them.",
    "`npm run sanity:schema-check` went with it, since its comparison was Translate with AI's. Run `npm run sanity:schema-deploy` after a schema change all the same: automatic alt text reads the deployed schema.",
  ],
};

/** Where captured section thumbnails live. A section that declares none has nothing there to delete. */
export const THUMBNAILS_DIR = "public/page-builder-section-thumbs";

/** Shared section-preview fixtures. Reported once no section fixture left imports them. */
const PREVIEW_SAMPLES = "src/features/page-builder/section-preview-samples.ts";

/** One page-builder section. The preview registry globs each folder, so only the thumbnail manifest needs naming. */
function section(options: {
  id: string;
  name: string;
  title: string;
  summary: string;
  component: string;
  renderer: string;
  schema: string;
  since?: string;
  /** Features that cannot survive this section's removal, for a section something else reaches into. */
  implies?: string[];
  thumbnail?: string;
  extraPaths?: string[];
  /** Shared code this section is the only caller of. See `Feature.orphans`. */
  orphans?: string[];
}): Feature {
  const {
    id,
    name,
    title,
    summary,
    component,
    renderer,
    schema,
    since = FIRST_CUT,
    implies,
    thumbnail,
    extraPaths = [],
    orphans,
  } = options;
  // Keyed by the thumbnail's own filename, so that path is the only source for it.
  const thumbnailKey = thumbnail
    ?.split("/")
    .pop()
    ?.replace(/\.jpg$/, "");

  return {
    id: `section:${id}`,
    title,
    summary,
    since,
    implies,
    orphans,
    paths: [renderer, schema, ...(thumbnail ? [thumbnail] : []), ...extraPaths],
    edits: [
      {
        file: "src/features/page-builder/PageSections.astro",
        edits: [
          { kind: "dropImport", id: component },
          { kind: "dropObjectProperty", anchor: "sections", key: `${name}Field` },
        ],
      },
      // Each section's query lives in the shared file rather than its folder, so it is unwired by name.
      {
        file: "src/features/page-builder/queries.ts",
        edits: [{ kind: "dropVariableStatement", name: `${component}Q` }],
      },
      {
        file: "sanity/schemas/page-sections/index.ts",
        edits: [
          { kind: "dropImport", id: name },
          { kind: "dropArrayElement", arrayName: "sections", id: name },
        ],
      },
      // A section that does not photograph has no thumbnail and no line in the manifest.
      ...(thumbnailKey
        ? [
            {
              file: `${THUMBNAILS_DIR}/manifest.json`,
              // Generated: a project that has never run the capture simply has no such file.
              optional: true,
              edits: [{ kind: "dropJsonKey" as const, key: thumbnailKey }],
            },
          ]
        : []),
    ],
    sectionTypes: [`${name}Field`],
  };
}

const sections: Feature[] = [
  section({
    id: "media",
    name: "mediaSection",
    title: "Media section",
    summary: "The page-builder section that renders one image, video, Lottie or Rive asset.",
    component: "MediaSection",
    renderer: "src/features/page-builder/sections/MediaSection",
    schema: MEDIA_SECTION_SCHEMA,
    thumbnail: "public/page-builder-section-thumbs/media-section.jpg",
  }),
  section({
    id: "cta",
    name: "ctaSection",
    title: "CTA section",
    summary: "The page-builder section that renders a headline and a call-to-action link.",
    component: "CtaSection",
    renderer: "src/features/page-builder/sections/CtaSection",
    schema: "sanity/schemas/page-sections/cta-section.tsx",
    thumbnail: "public/page-builder-section-thumbs/cta-section.jpg",
    orphans: [PREVIEW_SAMPLES],
  }),
  section({
    id: "text",
    name: "textSection",
    title: "Text section",
    summary: "The page-builder section that renders one rich text body.",
    component: "TextSection",
    renderer: "src/features/page-builder/sections/TextSection",
    schema: "sanity/schemas/page-sections/text-section.tsx",
    thumbnail: "public/page-builder-section-thumbs/text-section.jpg",
    orphans: [PREVIEW_SAMPLES],
  }),
  section({
    id: "contact-form",
    name: "contactFormSection",
    title: "Contact form section",
    summary: "The page-builder section that renders the contact form itself.",
    // The endpoint imports the validator colocated here, so it cannot outlive the section.
    implies: ["contact-form"],
    component: "ContactFormSection",
    renderer: "src/features/page-builder/sections/ContactFormSection",
    schema: "sanity/schemas/page-sections/contact-form-section.tsx",
    thumbnail: "public/page-builder-section-thumbs/contact-form-section.jpg",
  }),
  section({
    id: "headline",
    name: "headlineSection",
    title: "Headline section",
    summary: "The page-builder section that holds one statement on a screen of its own.",
    component: "HeadlineSection",
    renderer: "src/features/page-builder/sections/HeadlineSection",
    schema: "sanity/schemas/page-sections/headline-section.tsx",
    since: "2026-09-09",
    thumbnail: "public/page-builder-section-thumbs/headline-section.jpg",
    orphans: ["src/components/ReadingText"],
  }),
];

/**
 * Document types the starter itself is built on, which no trim removes. Plugin types need no entry:
 * `isSystemType` covers anything namespaced with a dot. A project's own types live in `project.json`.
 */
export const CORE_DOCUMENT_TYPES: readonly string[] = ["imageAltText", "page", "redirect", "site", "siteSettings"];

export const FEATURES: readonly Feature[] = [
  blog,
  authors,
  legalPages,
  forms,
  contactForm,
  announcementBar,
  umami,
  openapi,
  muxVideo,
  videoUrl,
  rive,
  lottie,
  bootstrap,
  italian,
  aiTranslation,
  ...sections,
];

/** What a routed document left in the dataset still does once its route is gone, for the closing report. */
export const STRANDED_ROUTE_EFFECT =
  "the sitemap selects every document with a `uri.current` regardless of type. So `/sitemap.xml` still advertises the removed URLs even though the routes are gone and they now 404. Search engines read that sitemap.";

/** Where API endpoints live: file-based routing, served at `/api/*`. */
const API_DIR = "src/pages/api";

/** The URL an endpoint file serves, so prose and tests naming `/api/contact-form` can be found. */
export function apiRouteOf(path: string): string | undefined {
  if (!path.startsWith(`${API_DIR}/`)) {
    return undefined;
  }

  return `/api/${path
    .slice(API_DIR.length + 1)
    .replace(/\.(ts|js)$/, "")
    .replace(/(^|\/)index$/, "")}`;
}

/** Where sections live, and what tells one apart from a stray file beside it. */
export const SECTIONS_DIR = "src/features/page-builder/sections";
export const SECTION_FILE = /\.astro$/;
const SECTION_EXTENSION = ".astro";

/**
 * The shapes a path can take on disk. A section is a flat file until it grows a companion, so a
 * project cut from an older starter may hold the flat file where the manifest names the folder.
 */
export function shapesOf(path: string): string[] {
  const rest = path.startsWith(`${SECTIONS_DIR}/`) ? path.slice(SECTIONS_DIR.length + 1) : undefined;

  return rest && !rest.includes("/") && !SECTION_FILE.test(rest) ? [path, `${path}${SECTION_EXTENSION}`] : [path];
}

/** A colocated test: deleted with its feature, but never evidence of one, since a cut may predate it. */
export function isTestPath(path: string): boolean {
  return /\.test\.[a-z]+$/.test(path);
}

/** The paths a feature owns that are missing here, a test it never had aside. */
export function missingPaths(feature: Pick<Feature, "paths">, exists: (path: string) => boolean): string[] {
  return feature.paths.filter((path) => !isTestPath(path) && onDisk(path, exists).length === 0);
}

/** The shapes of `path` that exist: what to delete, and whether anything of it is left. */
export function onDisk(path: string, exists: (path: string) => boolean): string[] {
  return shapesOf(path).filter(exists);
}

/** The section names a feature owns: the first segment under the sections folder, flat or folder. */
export function sectionNamesOf(feature: Feature): string[] {
  return feature.paths
    .filter((path) => path.startsWith(`${SECTIONS_DIR}/`))
    .map((path) => (path.slice(SECTIONS_DIR.length + 1).split("/")[0] ?? "").replace(SECTION_FILE, ""));
}

export function findFeature(id: string): Feature | undefined {
  return FEATURES.find((feature) => feature.id === id);
}

/**
 * Whether a feature is still in this tree.
 *
 * A feature is gone once nothing it owns outright is left, which makes its manifest entry inert:
 * none of its anchors can resolve any more. `manifest.test.ts` uses this to stop asserting on a
 * feature that has actually been removed, and the dataset-only purge uses it in reverse, to work out
 * what was trimmed on an earlier run and might still be owed a cleanup.
 *
 * `exists` is injected so this stays pure and the callers keep the filesystem access.
 */
export function isFeaturePresent(feature: Feature, exists: (path: string) => boolean): boolean {
  return feature.paths.some((path) => onDisk(path, exists).length > 0);
}

/**
 * The shared registries this manifest is written around: the files more than one feature edits.
 *
 * They are the evidence that the manifest describes *this* repository. A feature's own files are
 * supposed to disappear, because that is what trimming does, but `sanity/schemas/index.ts` does not
 * vanish from a project that still has a schema. So when a landmark is missing, the tree has been
 * restructured rather than trimmed, and every conclusion drawn from `isFeaturePresent` is a guess.
 */
export function manifestLandmarks(): string[] {
  const counts = new Map<string, number>();

  for (const feature of FEATURES) {
    // A file the manifest tolerates being absent, or edits only beside something, is evidence of nothing.
    const required = feature.edits
      .filter((entry) => !entry.optional && !entry.requires && !entry.requiresAbsent)
      .map((entry) => entry.file);

    for (const file of new Set(required)) {
      counts.set(file, (counts.get(file) ?? 0) + 1);
    }
  }

  return [...counts]
    .filter(([, count]) => count > 1)
    .map(([file]) => file)
    .sort();
}

/**
 * The landmarks missing from this tree. Empty means the manifest still describes it.
 *
 * This is the difference between "the blog was trimmed" and "this is a different project that moved
 * its schema folder". Both look identical to a per-feature path check, and only one of them makes it
 * safe to infer that a feature's documents are stranded and should be offered up for deletion.
 */
export function findMissingLandmarks(exists: (path: string) => boolean): string[] {
  return manifestLandmarks().filter((file) => !exists(file));
}

/**
 * Selections the manifest can express but the starter cannot survive.
 *
 * Every edit in such a selection resolves perfectly on its own, so the anchor checking passes it: it
 * is the *combination* that is invalid. Without this the trim would apply cleanly and only fail at
 * the quality gates afterwards, leaving a broken tree behind, which is exactly the half-applied
 * outcome the rest of the design exists to prevent.
 */
export function findSelectionConflicts(
  features: Feature[],
  sectionsOnDisk: readonly string[],
  locales?: { defaultLocale: string }
): string[] {
  const conflicts: string[] = [];

  for (const feature of features.filter((candidate) => locales && candidate.language === locales.defaultLocale)) {
    conflicts.push(
      `${feature.id}: "${feature.language}" is the default locale. Changing the default is a URI rewrite, not a removal.`
    );
  }
  const removed = new Set(features.flatMap(sectionNamesOf));
  const left = sectionsOnDisk.filter((name) => !removed.has(name));

  // The page builder is an enumeration with a non-empty contract: `sections` is what types
  // `SectionName`, so emptying it collapses that to `never` and takes `createPageBuilderField`, the
  // registry and the build with it.
  if (sectionsOnDisk.length > 0 && left.length === 0) {
    conflicts.push(
      "This removes every page-builder section, and the page builder needs at least one: an empty `sections` registry types `SectionName` as `never`, which breaks the Studio and the build. Keep one section, or remove the page builder itself (which the manifest does not model)."
    );
  }

  return conflicts;
}

/**
 * What a run switching off the last second language should offer beside it: features that only work with
 * a second language. Not `implies`, since a project may keep one for a language it plans to add.
 */
export function offeredWithOneLocale(selected: readonly Feature[], activeLocales: readonly string[]): Feature[] {
  const switchedOff = new Set(selected.flatMap((feature) => (feature.language ? [feature.language] : [])));
  const left = activeLocales.filter((locale) => !switchedOff.has(locale));

  if (switchedOff.size === 0 || left.length > 1) {
    return [];
  }

  return FEATURES.filter((feature) => feature.needsSecondLanguage && !selected.includes(feature));
}

/**
 * Closes `ids` over `implies`, so picking one half of a coupled pair always removes both. Returns
 * the selection in manifest order, plus the ids that were pulled in rather than chosen, so the flow
 * can say which ones it added and why.
 */
export function resolveSelection(ids: string[]): { features: Feature[]; implied: string[]; unknown: string[] } {
  const unknown = ids.filter((id) => !findFeature(id));
  const selected = new Set(ids.filter((id) => findFeature(id)));
  const implied = new Set<string>();
  const queue = [...selected];

  while (queue.length > 0) {
    const current = queue.shift();
    const feature = current ? findFeature(current) : undefined;

    for (const id of feature?.implies ?? []) {
      if (selected.has(id)) {
        continue;
      }

      selected.add(id);
      implied.add(id);
      queue.push(id);
    }
  }

  return {
    features: FEATURES.filter((feature) => selected.has(feature.id)),
    implied: [...implied],
    unknown,
  };
}

/** The closing notes for one run, minus those about a feature the same run removes after all. */
export function notesFor(features: readonly Feature[]): string[] {
  const removed = new Set(features.map((feature) => feature.id));

  return features.flatMap((feature) =>
    (feature.notes ?? []).flatMap((note) => {
      if (typeof note === "string") {
        return [note];
      }

      return removed.has(note.unless) ? [] : [note.text];
    })
  );
}

/** Whether a section removal leaves a capture behind: it declares no thumbnail for the trim to delete. */
export function lacksThumbnail(feature: Feature): boolean {
  return (feature.sectionTypes?.length ?? 0) > 0 && !feature.paths.some((path) => path.startsWith(`${THUMBNAILS_DIR}/`));
}

/** Every field the manifest knows a feature stores on a document it does not own: what the stranded scan looks for. */
export function storedFields(): StoredField[] {
  return FEATURES.flatMap((feature) => feature.fields ?? []);
}
