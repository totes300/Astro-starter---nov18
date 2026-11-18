import { defineField, type SlugOptions, type SlugRule, type SlugValue, type ValidationBuilder } from "sanity";
import { sanityConfig } from "../../config";
import {
  SANITY_ARTICLE_DOCUMENT_TYPE,
  SANITY_AUTHOR_PATH_PREFIX,
  SANITY_BLOG_INDEX_URI,
  SANITY_PERSON_DOCUMENT_TYPE,
  SANITY_SINGLETON_BLOG_ID,
} from "../../constants";
import { DEFAULT_LOCALE, getLocaleTitle, IS_I18N_ENABLED, isLocale, localePrefix, splitLocalePrefix } from "../../i18n";
import {
  localizeDocumentPath,
  resolveSectionRequest,
  SECTION_TYPES,
  SECTIONS,
  type SectionTypes,
  sectionPathIssue,
} from "../../sections";
import { slugifyText, uriFormatIssue } from "../../slug";
import { composeValidation } from "../../utils";
import { reservedPathProblem, uriGateProblem } from "./uri-gate";

type DocumentLike = Record<string, unknown> | null | undefined;

/** An unprefixed singleton route, prefilled, generated and required. It replaces `readOnly`: locked only while it holds. */
type FixedPath = string | ((document: DocumentLike) => string | undefined);

/** The document's own language, defaulting documents written before the field existed. */
function documentLanguage(document: DocumentLike): string {
  return typeof document?.language === "string" ? document.language : DEFAULT_LOCALE;
}

function documentType(document: DocumentLike): string | undefined {
  return typeof document?._type === "string" ? document._type : undefined;
}

/** The fixed path in the document's own language (section word included), or `undefined` when the path is authored. */
function expectedFixedPath(fixedPath: FixedPath | undefined, document: DocumentLike): string | undefined {
  const path = typeof fixedPath === "function" ? fixedPath(document) : fixedPath;

  return path ? localizeDocumentPath(documentType(document), documentLanguage(document), path) : undefined;
}

/** The document without its own URI, so a path typed on the way to another (`/` before `/about`) never decides what it is. */
function withoutField(document: DocumentLike, name: string): DocumentLike {
  if (!document) {
    return document;
  }

  const { [name]: _typed, ...rest } = document;

  return rest;
}

function normalizeSitePath(path: string) {
  const trimmed = path.trim();
  if (trimmed === "" || trimmed === "/") {
    return "/";
  }

  return trimmed.replace(/\/+$/, "") || "/";
}

/** Slug `current` may be `path` or `/path`; align with a leading slash when comparing. */
function comparableUriPath(value: string): string {
  const t = value.trim();
  if (t === "" || t === "/") {
    return "/";
  }

  return normalizeSitePath(t.startsWith("/") ? t : `/${t}`);
}

function sanitizeDocId(docId: string) {
  return docId.replace("drafts.", "");
}

/** The path the route files answer: locale routing strips the prefix and maps a language's section word to its folder. */
function routePath(uri: string): string {
  if (!IS_I18N_ENABLED) {
    return uri;
  }

  const { locale, pathname } = splitLocalePrefix(uri);
  const section = resolveSectionRequest(locale, pathname);

  return section && "rewrite" in section ? section.rewrite : pathname;
}

/** A section's `[slug]` route serves one segment under the section's word, so its item can sit no deeper. */
function sectionItemIssue(type: string | undefined, path: string): string | null {
  for (const section of SECTIONS) {
    // Widened, so this still compiles once a trim leaves no section and `Section` is `never`.
    const { item }: SectionTypes = SECTION_TYPES[section];
    const base = `/${section}/`;

    if (item === type) {
      const slug = path.startsWith(base) ? path.slice(base.length) : "";

      return slug && !slug.includes("/") ? null : `This document is served at ${base}<slug>. Use one segment under it.`;
    }
  }

  return null;
}

const ONE_SEGMENT = /^\/[^/]+$/;
// A person's page, and the `/modal` path a profile dialog may use.
const AUTHOR_ROUTE = /^\/[^/]+(?:\/modal)?$/;

/** `/blog/<slug>` and `/blog/authors/<slug>` are answered first by routes that serve only their own type. */
function blogRouteIssue(type: string | undefined, path: string): string | null {
  const isArticlePath =
    path.startsWith(`${SANITY_BLOG_INDEX_URI}/`) && ONE_SEGMENT.test(path.slice(SANITY_BLOG_INDEX_URI.length));
  const authorPath = path.startsWith(`${SANITY_AUTHOR_PATH_PREFIX}/`) ? path.slice(SANITY_AUTHOR_PATH_PREFIX.length) : "";

  if (type === SANITY_PERSON_DOCUMENT_TYPE) {
    return ONE_SEGMENT.test(authorPath)
      ? null
      : `A person's page is served at ${SANITY_AUTHOR_PATH_PREFIX}/<slug>. Use one segment under it.`;
  }

  // Its depth is the section rule's; the authors' own path is the one place under its word it cannot take.
  if (type === SANITY_ARTICLE_DOCUMENT_TYPE) {
    return path === SANITY_AUTHOR_PATH_PREFIX
      ? `${SANITY_AUTHOR_PATH_PREFIX} is kept for people's pages. Choose a different path.`
      : null;
  }

  if (isArticlePath || AUTHOR_ROUTE.test(authorPath)) {
    return `${SANITY_BLOG_INDEX_URI}/<slug> is kept for articles, and ${SANITY_AUTHOR_PATH_PREFIX}/<slug> with its /modal path for people. Choose a different path.`;
  }

  return null;
}

/** Why this path is kept from documents: the Studio, the not-found page or the section preview holds it, in any language. */
function reservedRouteIssue(uri: string): string | null {
  return reservedPathProblem(uri, sanityConfig.reservedStudioPaths);
}

/** Keeping prefix and `language` in step is what lets every route resolve a page by URI alone. */
function languagePrefixIssue(type: string | undefined, language: string, uri: string): string | null {
  // An unconfigured language has no prefix to agree with; the language field's own warning covers it.
  if (!isLocale(language)) {
    return null;
  }

  const { localeInPath, pathname } = splitLocalePrefix(uri);

  // `/en/...` is redirected to the unprefixed path, so the default language owns no prefix at all.
  if ((localeInPath ?? DEFAULT_LOCALE) === language && localeInPath !== DEFAULT_LOCALE) {
    return null;
  }

  const prefix = localePrefix(language);
  const rule = prefix ? `start with "${prefix}"` : "have no language prefix";
  const expected = localizeDocumentPath(type, language, pathname);

  return `This document is in ${getLocaleTitle(language)}, so its URI must ${rule}. Use "${expected}".`;
}

function uriValidation(fixedPath: FixedPath | undefined): ValidationBuilder<SlugRule> {
  return (R) =>
    R.custom((value: SlugValue | undefined, context) => {
      const current = value?.current?.trim();

      if (!current) {
        return true;
      }

      const formatIssue = uriFormatIssue(current);

      if (formatIssue) {
        return formatIssue;
      }

      const uriP = routePath(current);
      const reservedIssue =
        reservedRouteIssue(uriP) ??
        blogRouteIssue(context.document?._type, uriP) ??
        sectionItemIssue(context.document?._type, uriP);

      if (reservedIssue) {
        return reservedIssue;
      }

      const type = documentType(context.document);

      // The blog index is its own singleton on its own route; a second document here would never be served.
      if (uriP === SANITY_BLOG_INDEX_URI && type !== SANITY_SINGLETON_BLOG_ID) {
        return `This URI is reserved for the Blog index (${SANITY_BLOG_INDEX_URI}). Choose a different path.`;
      }

      const language = documentLanguage(context.document);
      const prefixIssue = IS_I18N_ENABLED ? languagePrefixIssue(type, language, current) : null;

      if (prefixIssue) {
        return prefixIssue;
      }

      const expectedFixed = expectedFixedPath(fixedPath, context.document);

      if (expectedFixed && current !== expectedFixed) {
        return `This URI is fixed at "${expectedFixed}".`;
      }

      // Under a section's word sit its own documents only, or a route would never serve them.
      return sectionPathIssue(type, language, current) ?? true;
    });
}

// A malformed URI already fails the format check; the rest is read as stored and as routed.
function uriGateCheck(value: SlugValue | undefined) {
  const uri = value?.current;

  if (!uri?.trim() || uriFormatIssue(uri.trim())) {
    return null;
  }

  return uriGateProblem(uri) ?? uriGateProblem(routePath(comparableUriPath(uri)));
}

function isPasswordProtected(document: unknown): boolean {
  return (document as { passwordProtected?: boolean } | undefined)?.passwordProtected === true;
}

// A warning, so existing pages keep publishing; an error once Password protect would silently do nothing.
const gateSafeUriValidation = (R: SlugRule) => [
  R.custom((value: SlugValue | undefined, context) =>
    isPasswordProtected(context.document) ? (uriGateCheck(value) ?? true) : true
  ),
  R.custom((value: SlugValue | undefined, context) =>
    isPasswordProtected(context.document) ? true : (uriGateCheck(value) ?? true)
  ).warning(),
];

export function createUriField({
  group,
  options,
  source,
  slugify,
  name = "uri",
  title = "URI",
  description = "The URI of the document.",
  hidden,
  readOnly,
  fixedPath,
  validation: externalValidation,
}: {
  group?: string;
  options?: Omit<SlugOptions, "slugify" | "source">;
  source: SlugOptions["source"];
  /** Return the default-language path (`/blog/<slug>`); the factory adds the language prefix and section word. */
  slugify?: (args: { originalInput: string; slug: string; parentId: string }) => string;
  name?: string;
  title?: string;
  description?: string;
  hidden?: (props: { parent: { [key: string]: unknown } }) => boolean;
  readOnly?: boolean | ((props: { parent: { [key: string]: unknown } }) => boolean);
  fixedPath?: FixedPath;
  validation?: ValidationBuilder<SlugRule, SlugValue>;
}) {
  return defineField({
    type: "slug",
    name,
    title,
    group,
    description,
    hidden,
    // Locked only by what the document is, and only while right: a homepage by URI alone would lock any page typed through `/`.
    readOnly: fixedPath
      ? ({ document, value }) => {
          const expected = expectedFixedPath(fixedPath, withoutField(document as DocumentLike, name));

          return Boolean(expected) && (value as SlugValue | undefined)?.current === expected;
        }
      : readOnly,
    initialValue: typeof fixedPath === "string" ? { current: fixedPath } : undefined,
    validation: (rule) => [
      ...[composeValidation(uriValidation(fixedPath), externalValidation)(rule)].flat(),
      ...gateSafeUriValidation(rule),
    ],
    options: {
      ...options,
      source,
      slugify: (input, _, { parent }) => {
        const document = parent as DocumentLike;
        const parentId = typeof document?._id === "string" ? sanitizeDocId(document._id) : null;

        if (!parentId) {
          return "";
        }

        const expectedFixed = expectedFixedPath(fixedPath, document);

        if (expectedFixed) {
          return expectedFixed;
        }

        const slug = slugifyText(input);
        const path = slugify ? slugify({ slug, parentId, originalInput: input }) : `/${slug}`;

        return localizeDocumentPath(documentType(document), documentLanguage(document), path);
      },
    },
  });
}
