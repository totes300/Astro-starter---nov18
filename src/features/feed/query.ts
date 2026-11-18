import { defineQuery } from "groq";
import { AgentMarkdownFunctions, agentRichText } from "~/features/agents/query";
import { configuredReference, DefaultLocaleFilter, localized } from "~/features/i18n/fragment";
import { SANITY_ARTICLE_DOCUMENT_TYPE, SANITY_SINGLETON_BLOG_ID, SANITY_SINGLETON_SITE_ID } from "~/sanity/constants";
import { FEED_ITEM_LIMIT } from "./constants";

// One channel, in the default language. Site-wide Basic Auth gates it; a per-article lock cannot, so those articles drop out.
export const FeedXmlQ = defineQuery(`${AgentMarkdownFunctions}
{
  "siteName": *[_type == "${SANITY_SINGLETON_SITE_ID}" && ${DefaultLocaleFilter}][0].name,
  "blog": *[_type == "${SANITY_SINGLETON_BLOG_ID}" && ${DefaultLocaleFilter}][0]{
    title,
    "description": seoMetadata.description,
    "uri": uri.current
  },
  "items": *[
    _type == "${SANITY_ARTICLE_DOCUMENT_TYPE}"
    && defined(uri.current)
    && defined(publishedAt)
    && seoMetadata.noIndex != true
    && passwordProtected != true
    && ${DefaultLocaleFilter}
  ] | order(publishedAt desc, _createdAt desc)[0...${FEED_ITEM_LIMIT}]{
    title,
    "href": uri.current,
    publishedAt,
    _updatedAt,
    "description": seoMetadata.description,
    "author": select(${configuredReference("author")} => author->name),
    "categories": categories[]->{ "name": ${localized("name")} }.name,
    "content": ${agentRichText("content")}
  }
}`);
