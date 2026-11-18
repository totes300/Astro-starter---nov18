export const TEMPLATE_IDS = {
  pageSingleton: "pageSingletonTemplate",
} as const;

/** Singleton IDs as string literals (typegen resolves only literals, not member access); derive `SINGLETON_IDS` from these. */
export const SANITY_SINGLETON_SITE_ID = "site";
export const SANITY_SINGLETON_SITE_SETTINGS_ID = "siteSettings";
export const SANITY_SINGLETON_HOMEPAGE_ID = "homepage";
export const SANITY_SINGLETON_BLOG_ID = "blog";

/** Path the blog index singleton is served at. Articles slug under it (`/blog/<slug>`). */
export const SANITY_BLOG_INDEX_URI = "/blog";

/** Path people slug under (`/blog/authors/<slug>`). Nested under the blog so one prefix covers an article and the author panels it opens over itself. */
export const SANITY_AUTHOR_PATH_PREFIX = "/blog/authors";

/** Path new legal pages slug under (`/legal/<slug>`). A default, not a route: the catch-all serves whatever URI the document ends up with. */
export const SANITY_LEGAL_PATH_PREFIX = "/legal";

/** Where the always-gated section specimen lives; its own route answers every path under it. */
export const SECTION_PREVIEW_BASE_PATH = "/section-preview";

/** Reserved for the not-found page, so no document is published at an address a visitor reads as an error. */
export const NOT_FOUND_PATH = "/404";

export const SINGLETON_IDS = {
  site: SANITY_SINGLETON_SITE_ID,
  siteSettings: SANITY_SINGLETON_SITE_SETTINGS_ID,
  homepage: SANITY_SINGLETON_HOMEPAGE_ID,
  blog: SANITY_SINGLETON_BLOG_ID,
  // PLOP: Add Singleton ID
} as const;

/** Singleton URIs, used for `initialValueTemplate` when creating/opening singleton pages. */
export const SINGLETON_ROUTES = {
  [SINGLETON_IDS.homepage]: "/",
  [SINGLETON_IDS.blog]: SANITY_BLOG_INDEX_URI,
  // PLOP: Add Singleton Route
} as const;

/** Submission schema types; only delete and discardChanges are allowed in the Studio. */
export const API_ONLY_DOCUMENTS = {
  contactFormSubmission: "contactFormSubmission",
} as const;

export type ApiOnlyDocumentType = (typeof API_ONLY_DOCUMENTS)[keyof typeof API_ONLY_DOCUMENTS];

// Sanity keeps every id ever written, so a key is an opaque token (a UUID, a payment session id), never personal data.
const API_ONLY_ID_KEY = /^[A-Za-z0-9_-]+$/;
const MAX_SANITY_ID_LENGTH = 128;

/** Dotted ids are served only to token-authenticated reads; pass `key` for a deterministic (idempotency) id. */
export function apiOnlyDocumentId(type: ApiOnlyDocumentType, key: string = crypto.randomUUID()): string {
  const id = `${type}.${key}`;

  if (!API_ONLY_ID_KEY.test(key) || id.length > MAX_SANITY_ID_LENGTH) {
    throw new Error("[sanity/constants] apiOnlyDocumentId: the key must be letters, digits, _ or -, within Sanity's id length.");
  }

  return id;
}

/** Scratch types for Agent Actions to type-check against: never in the structure, a template, or edited by hand. */
export const AGENT_SCRATCH_DOCUMENTS = {
  imageAltText: "imageAltText",
} as const;

/** Agent Actions are only available on the experimental "vX" API version. */
export const SANITY_AGENT_API_VERSION = "vX" as const;

/** Run `npm run sanity:schema-deploy` after schema changes or the agent works off a stale copy. */
export const SANITY_AGENT_SCHEMA_ID = "_.schemas.default" as const;

/** Routed non-singleton `_type` names; use these literal bindings in `defineQuery` interpolations (typegen won't resolve member access). Site's `_type` is `SANITY_SINGLETON_SITE_ID`, also its cache tag. */
export const SANITY_PAGE_DOCUMENT_TYPE = "page" as const;
export const SANITY_ARTICLE_DOCUMENT_TYPE = "article" as const;
export const SANITY_ARTICLE_CATEGORY_DOCUMENT_TYPE = "articleCategory" as const;
export const SANITY_PERSON_DOCUMENT_TYPE = "person" as const;
export const SANITY_LEGAL_PAGE_DOCUMENT_TYPE = "legalPage" as const;

/** One document per language, linked through `translation.metadata`; each listed type carries `createLanguageField()`. */
export const I18N_DOCUMENT_TYPES: readonly string[] = [
  SANITY_SINGLETON_SITE_ID,
  SANITY_PAGE_DOCUMENT_TYPE,
  SANITY_SINGLETON_BLOG_ID,
  SANITY_ARTICLE_DOCUMENT_TYPE,
  SANITY_LEGAL_PAGE_DOCUMENT_TYPE,
  // PLOP: Add Translated Type
];

/** Fields a shared type translates in place (`createLocalizedField`), which accepts only a pair listed here; one dot nests a field in an object. */
export const LOCALIZED_FIELDS = {
  articleCategory: ["name"],
  person: ["role", "bio", "seoMetadata.title", "seoMetadata.description", "agentMarkdown.content"],
} as const satisfies Record<string, readonly string[]>;

export type LocalizedDocumentType = keyof typeof LOCALIZED_FIELDS;

/** Shared types with their own page: one stored default-language `uri`, served under every language's prefix. */
export const SHARED_ROUTED_DOCUMENT_TYPES: readonly string[] = [SANITY_PERSON_DOCUMENT_TYPE];

export type LocalizedFieldName<T extends LocalizedDocumentType> = (typeof LOCALIZED_FIELDS)[T][number];

/** The hidden provenance record a "Translate with AI" run writes on each translation it creates or refreshes. */
export const AI_TRANSLATION_FIELD = "aiTranslation";

/** Derived from one document's own content, so a translation starts without them instead of serving the source's. */
export const TRANSLATION_EXCLUDED_FIELDS: readonly string[] = ["agentMarkdown", AI_TRANSLATION_FIELD];

/** Sanity rejects a Translate style guide longer than this, after its params are filled in. */
export const AI_TRANSLATION_STYLE_GUIDE_LIMIT = 2000;

/** What an unset Settings > Translations value means: the existing settings document never received the initial values. */
export const AI_TRANSLATION_DEFAULTS = {
  policy: "missing",
  slugs: "translate",
  afterTranslate: "draft",
  maxCreditsPerRun: 25,
  maxCreditsPerDay: 100,
} as const;

/** Server bookkeeping for AI translation. Dotted `_type` and `_id`: only token reads see them, and no schema lists them. */
export const AI_TRANSLATION_LEASE_TYPE = "aiTranslation.lease";
export const AI_TRANSLATION_LEDGER_TYPE = "aiTranslation.ledger";
export const AI_TRANSLATION_RESULT_TYPE = "aiTranslation.result";

export type AiTranslationDocumentType =
  | typeof AI_TRANSLATION_LEASE_TYPE
  | typeof AI_TRANSLATION_LEDGER_TYPE
  | typeof AI_TRANSLATION_RESULT_TYPE;

const AI_TRANSLATION_KEY = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
const VERSIONED_ID = /^(?:drafts|versions)\./;

/** `<type>.<key>.<key>`, e.g. `aiTranslation.lease.<sourceId>.<lang>`: one per pair or day, so a create is the claim. */
export function aiTranslationDocumentId(type: AiTranslationDocumentType, ...keys: string[]): string {
  const id = [type, ...keys].join(".");
  const valid = keys.length > 0 && keys.every((key) => AI_TRANSLATION_KEY.test(key) && !VERSIONED_ID.test(key));

  if (!valid || id.length > MAX_SANITY_ID_LENGTH) {
    throw new Error(
      "[sanity/constants] aiTranslationDocumentId: each key must be a published id, a locale or a day, within Sanity's id length."
    );
  }

  return id;
}
