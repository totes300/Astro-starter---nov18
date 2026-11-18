import { defineQuery } from "groq";
import { AuthorFragment } from "~/features/blog/author/fragment";
import {
  AlternatesFragment,
  ConfiguredLocaleFilter,
  configuredReference,
  LocaleField,
  LocaleFilter,
  localized,
  ParentLocaleFilter,
} from "~/features/i18n/fragment";
import { RichTextFunctions, richText } from "~/features/rich-text/fragment";
import { image } from "~/features/sanity/media/fragment";
import { LocalizedSeoMetadataFragment, SeoFunctions, SeoMetadataFragment } from "~/features/site/seo/fragment";
import {
  SANITY_ARTICLE_DOCUMENT_TYPE,
  SANITY_BLOG_INDEX_URI,
  SANITY_LEGAL_PAGE_DOCUMENT_TYPE,
  SANITY_PAGE_DOCUMENT_TYPE,
  SANITY_PERSON_DOCUMENT_TYPE,
  SANITY_SINGLETON_BLOG_ID,
} from "~/sanity/constants";

// Route-level queries for the pages model. Fragments live beside their features
// (src/features/**/fragment.ts); section queries live in src/features/page-builder/queries.ts.

// Both catch-all types resolve here: `page` assembles a page builder, `legalPage` is prose in one field.
export const PageQ = defineQuery(`${RichTextFunctions}

  *[_type in ["${SANITY_PAGE_DOCUMENT_TYPE}", "${SANITY_LEGAL_PAGE_DOCUMENT_TYPE}"] && defined(uri.current) && uri.current == $uri && ${ConfiguredLocaleFilter}][0]{
    _id,
    _type,
    title,
    "uri": coalesce(uri.current, "/"),
    ${LocaleField},
    "noIndex": seoMetadata.noIndex == true,
    "showHeader": coalesce(showHeader, true),
    "showFooter": coalesce(showFooter, true),
    seoMetadata{${SeoMetadataFragment}},
    ${AlternatesFragment},
    _type == "${SANITY_LEGAL_PAGE_DOCUMENT_TYPE}" => {
      "content": ${richText("content")},
    },
  }
`);

export const ArticlePageQ = defineQuery(`${RichTextFunctions}

  *[_type == "${SANITY_ARTICLE_DOCUMENT_TYPE}" && defined(uri.current) && uri.current == $uri && ${ConfiguredLocaleFilter}][0]{
    _id,
    _type,
    title,
    _updatedAt,
    publishedAt,
    "author": select(${configuredReference("author")} => author->{ name, "href": uri.current }),
    "categories": categories[]->{ "name": ${localized("name")}, "slug": slug.current },
    "image": ${image("image")},
    "blog": *[_type == "${SANITY_SINGLETON_BLOG_ID}" && ${ParentLocaleFilter}][0]{ title, "uri": uri.current },
    "uri": coalesce(uri.current, "${SANITY_BLOG_INDEX_URI}"),
    ${LocaleField},
    "noIndex": seoMetadata.noIndex == true,
    "showHeader": coalesce(showHeader, true),
    "showFooter": coalesce(showFooter, true),
    "content": ${richText("content")},
    seoMetadata{${SeoMetadataFragment}},
    ${AlternatesFragment},
  }
`);

// One document per language, found by its URI. There is no page builder: the page is always the article list.
export const BlogPageQ = defineQuery(`${SeoFunctions}

  *[_type == "${SANITY_SINGLETON_BLOG_ID}" && defined(uri.current) && uri.current == $uri && ${ConfiguredLocaleFilter}][0]{
    _id,
    _type,
    title,
    heading,
    "uri": coalesce(uri.current, "${SANITY_BLOG_INDEX_URI}"),
    ${LocaleField},
    "noIndex": seoMetadata.noIndex == true,
    "showHeader": coalesce(showHeader, true),
    "showFooter": coalesce(showFooter, true),
    seoMetadata{${SeoMetadataFragment}},
    ${AlternatesFragment},
  }
`);

// The page and the byline panel render the same profile, so they read the same document through one query.
// One person for every language: `$uri` is its stored path, and its fields and lists are read in `$language`.
export const AuthorPageQ = defineQuery(`${RichTextFunctions}

  *[_type == "${SANITY_PERSON_DOCUMENT_TYPE}" && defined(uri.current) && uri.current == $uri && ${ConfiguredLocaleFilter}][0]{
    ${AuthorFragment}
    _createdAt,
    _updatedAt,
    "noIndex": seoMetadata.noIndex == true,
    "showHeader": coalesce(showHeader, true),
    "showFooter": coalesce(showFooter, true),
    "blog": *[_type == "${SANITY_SINGLETON_BLOG_ID}" && ${LocaleFilter}][0]{ title, "uri": uri.current },
    seoMetadata{${LocalizedSeoMetadataFragment}},
    // Matched on the author's URI rather than their id, because under the drafts perspective a
    // document's own id is a draft id while the reference still points at the published one.
    "articles": *[
      _type == "${SANITY_ARTICLE_DOCUMENT_TYPE}"
      && defined(uri.current)
      && seoMetadata.noIndex != true
      && passwordProtected != true
      && ${LocaleFilter}
      && author->uri.current == ^.uri.current
    ] | order(publishedAt desc){
      _id,
      title,
      "href": uri.current,
      publishedAt,
      "categories": categories[]->{ "name": ${localized("name")} }.name,
      "image": ${image("image")},
    },
  }
`);

// Every language; documents sharing a `translation.metadata` are one cluster of hreflang alternates, and a shared
// routed document (`SHARED_ROUTED_DOCUMENT_TYPES`) is expanded into one row per language by `withSharedRows`.
export const SitemapQ = defineQuery(`
  *[defined(uri.current) && seoMetadata.noIndex != true && passwordProtected != true && ${ConfiguredLocaleFilter}]{
    _id,
    _type,
    "uri": uri.current,
    ${LocaleField},
    "translationGroup": *[_type == "translation.metadata" && references(^._id)][0]._id,
    "updatedAt": _updatedAt,
  }
`);

// PLOP: Add Route Query
