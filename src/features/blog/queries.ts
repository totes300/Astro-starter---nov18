import { defineQuery } from "groq";
import { configuredReference, LocaleFilter, localized } from "~/features/i18n/fragment";
import { RichTextFunctions, richText } from "~/features/rich-text/fragment";
import { image } from "~/features/sanity/media/fragment";
import {
  SANITY_ARTICLE_CATEGORY_DOCUMENT_TYPE,
  SANITY_ARTICLE_DOCUMENT_TYPE,
  SANITY_SINGLETON_BLOG_ID,
} from "~/sanity/constants";

/**
 * The blog index's own copy plus every article in the page's language, newest first; `$categories` is the URL's selection.
 * `categories` is derived from the listed articles, so a chip never names a category only a hidden article uses.
 */
export const BlogArticleListQ = defineQuery(`${RichTextFunctions}
*[_type == "${SANITY_SINGLETON_BLOG_ID}" && ${LocaleFilter}][0]{
  heading,
  "intro": ${richText("intro")},
  "articles": *[
    _type == "${SANITY_ARTICLE_DOCUMENT_TYPE}"
    && defined(uri.current)
    && seoMetadata.noIndex != true
    && passwordProtected != true
    && ${LocaleFilter}
    && (count($categories) == 0 || count(categories[@->slug.current in $categories]) > 0)
  ] | order(publishedAt desc){
    _id,
    title,
    "href": uri.current,
    publishedAt,
    "author": select(${configuredReference("author")} => author->name),
    "categories": categories[]->{ "name": ${localized("name")} }.name,
    "image": ${image("image")},
  },
  "categories": *[
    _type == "${SANITY_ARTICLE_CATEGORY_DOCUMENT_TYPE}"
    && defined(slug.current)
    && _id in *[
      _type == "${SANITY_ARTICLE_DOCUMENT_TYPE}"
      && defined(uri.current)
      && seoMetadata.noIndex != true
      && passwordProtected != true
      && ${LocaleFilter}
    ].categories[]._ref
  ] | order(lower(${localized("name")}) asc){
    "key": _id,
    "name": ${localized("name")},
    "slug": slug.current,
  },
}`);
