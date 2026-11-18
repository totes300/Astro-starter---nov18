import { defineQuery } from "groq";
import { GATED_ROUTE_FILTER } from "~/features/agents/markdown-eligibility";
import {
  ConfiguredLocaleFilter,
  configuredReference,
  LocaleField,
  localized,
  ParentLocaleFilter,
} from "~/features/i18n/fragment";
import { LinkFn, link } from "~/features/sanity/link/fragment";
import { localizedAssetText } from "~/features/sanity/media/fragment";
import {
  AI_TRANSLATION_RESULT_TYPE,
  SANITY_AGENT_SCHEMA_ID,
  SANITY_ARTICLE_DOCUMENT_TYPE,
  SANITY_LEGAL_PAGE_DOCUMENT_TYPE,
  SANITY_PAGE_DOCUMENT_TYPE,
  SANITY_PERSON_DOCUMENT_TYPE,
  SANITY_SINGLETON_BLOG_ID,
  SANITY_SINGLETON_SITE_ID,
  SANITY_SINGLETON_SITE_SETTINGS_ID,
} from "~/sanity/constants";
import { DEFAULT_LOCALE } from "~/sanity/i18n";

/** Site-wide Basic Auth is on. The files that index the whole site (`/llms.txt`, `/openapi.json`) answer 404 then. */
export const SiteLockedQuery = defineQuery(
  `*[_type == "${SANITY_SINGLETON_SITE_SETTINGS_ID}" && _id == "${SANITY_SINGLETON_SITE_SETTINGS_ID}"][0].basicAuth.siteWideEnabled == true`
);

/**
 * Content served at `/llms.txt`. Read from the published `siteSettings` singleton.
 * `enabled` gates serving (undefined is treated as on); `content` is the markdown body.
 */
export const LlmsTxtServeQuery =
  defineQuery(`*[_type == "${SANITY_SINGLETON_SITE_SETTINGS_ID}" && _id == "${SANITY_SINGLETON_SITE_SETTINGS_ID}"][0]{
  "enabled": llms.enabled,
  "content": llms.content,
  "gated": *[defined(uri.current) && (${GATED_ROUTE_FILTER})]{ "uri": uri.current, "type": _type }
}`);

// A shared routed type's title, description and Markdown hold one arm per language, read in TypeScript per language.
const SharedRoutedTypes = `["${SANITY_PERSON_DOCUMENT_TYPE}"]`;

// The routed types, each carrying `createAgentMarkdownField`.
const RoutedDocumentTypes = `["${SANITY_PAGE_DOCUMENT_TYPE}", "${SANITY_LEGAL_PAGE_DOCUMENT_TYPE}", "${SANITY_ARTICLE_DOCUMENT_TYPE}", "${SANITY_PERSON_DOCUMENT_TYPE}", "${SANITY_SINGLETON_BLOG_ID}"]`;

/** Site identity plus the indexable pages of every served language, on the sitemap's rules. Edit token, `published` perspective. */
export const LlmsTxtInventoryQuery = defineQuery(`{
  "site": *[_type == "${SANITY_SINGLETON_SITE_ID}" && _id == "${SANITY_SINGLETON_SITE_ID}"][0]{
    name,
    "summary": seoMetadata.description,
    "guidance": *[_type == "${SANITY_SINGLETON_SITE_SETTINGS_ID}" && _id == "${SANITY_SINGLETON_SITE_SETTINGS_ID}"][0].llms.guidance
  },
  "pages": *[
    _type in ${RoutedDocumentTypes}
    && defined(uri.current)
    && seoMetadata.noIndex != true
    && passwordProtected != true
    && ${ConfiguredLocaleFilter}
  ] | order(_type asc, coalesce(publishedAt, _createdAt) desc) {
    _type,
    "uri": uri.current,
    ${LocaleField},
    "title": coalesce(string(seoMetadata.title), title, name),
    "description": string(seoMetadata.description),
    "shared": select(_type in ${SharedRoutedTypes} => { "title": seoMetadata.title, "description": seoMetadata.description }),
    "publishedAt": publishedAt,
    "categories": categories[]->{ "name": ${localized("name")} }.name
  }
}`);

// Lean Portable Text projection for Markdown: block style, list shape, span marks, link hrefs, media-block images.
const AgentMarkdownRichTextFn = `fn frag::agentRichText($value) = $value[]{
  _type,
  _type == "block" => {
    style,
    listItem,
    level,
    "children": children[]{ _type, text, marks },
    "markDefs": markDefs[]{
      _key,
      _type,
      _type == "linkField" => ${link("@")}
    }
  },
  _type == "mediaBlock" => {
    caption,
    "alt": appMedia.image{ "v": ${localizedAssetText("altText")} }.v,
    "imageUrl": appMedia.image.asset->url
  }
};`;

/** Shared with the RSS feed, which serializes the same reader-facing block shapes to HTML. */
export const agentRichText = (path: string) => `frag::agentRichText(${path})`;

/** `localizedRichText`'s read for Markdown: `$language`'s arm, else the default's, else a pre-translation array. */
const localizedAgentRichText = (path: string) =>
  `select(defined(${path}[0]) => frag::agentRichText(${path}), defined(${path}[$language]) => frag::agentRichText(${path}[$language]), frag::agentRichText(${path}.${DEFAULT_LOCALE}))`;

/** Interpolate once at the head of any query calling `agentRichText`. */
export const AgentMarkdownFunctions = `${LinkFn}\n${AgentMarkdownRichTextFn}`;

// The guaranteed page-builder factory outputs, aliased to the keys their default renderers in `markdown.ts` read.
const FactorySectionContentFragment = `
  "text": ${agentRichText("sectionContent.appRichText")},
  "media": sectionContent.appMedia{
    "alt": image{ "v": ${localizedAssetText("altText")} }.v,
    "imageUrl": image.asset->url
  },
  "cta": ${link("sectionContent.appLink")}
`;

// The per-project seam: add an alias here and a renderer in `markdown.ts`. Hand-written, since typegen needs a static string.
const AgentMarkdownSectionContentFragment = `
  ${FactorySectionContentFragment},
  "headline": sectionContent.headline,
  "caption": sectionContent.caption
`;

// No page builder: `renderArticleList` renders it, in the index's own language whatever `$language` the read binds.
const AgentMarkdownArticleListFragment = `
  "heading": heading,
  "intro": ${agentRichText("intro")},
  "articles": *[
    _type == "${SANITY_ARTICLE_DOCUMENT_TYPE}"
    && defined(uri.current)
    && seoMetadata.noIndex != true
    && passwordProtected != true
    && ${ParentLocaleFilter}
  ] | order(publishedAt desc){
    "uri": uri.current,
    title,
    "description": seoMetadata.description,
    publishedAt
  }`;

// Shared by Generate, the backfill and Translate with AI, so all serialize the same shape. Bind the page's `$language`.
const AgentMarkdownPageProjection = `{
  _id,
  _type,
  "uri": coalesce(uri.current, "/"),
  "title": coalesce(${localized("seoMetadata.title")}, title, name),
  "description": ${localized("seoMetadata.description")},
  publishedAt,
  "author": select(${configuredReference("author")} => author->name),
  "categories": categories[]->{ "name": ${localized("name")} }.name,
  "sections": pageBuilder.sectionsArray[sectionSettings.disabled != true]{
    _type,
    ${AgentMarkdownSectionContentFragment}
  },
  // Articles have no page builder: the body is one rich text field on the document.
  "content": ${agentRichText("content")},
  // A person's body is their bio, under a different field name, in $language (one person serves every language).
  _type == "${SANITY_PERSON_DOCUMENT_TYPE}" => {
    "content": ${localizedAgentRichText("bio")},
  },
  _type == "${SANITY_SINGLETON_BLOG_ID}" => {${AgentMarkdownArticleListFragment}
  }
}`;

// A shared routed document stores one URI for every language's URL, so it is also matched on `$sharedUri`.
const MatchesUri = `(uri.current == $uri || (_type in ${SharedRoutedTypes} && uri.current == $sharedUri))`;

// Matched on `uri.current`, so new routed types are covered; serving is gated elsewhere, not here.
export const AgentMarkdownContentQuery = defineQuery(`${AgentMarkdownFunctions}
*[
  defined(uri.current)
  && ${MatchesUri}
  && ${ConfiguredLocaleFilter}
][0]${AgentMarkdownPageProjection}`);

/** Every published and draft version with serving on, each its own language's document. Run under the `raw` perspective. */
export const AgentMarkdownBacklogQuery = defineQuery(`*[
  _type in ${RoutedDocumentTypes}
  && defined(uri.current)
  && !(_id in path("versions.**"))
  && agentMarkdown.enabled != false
  && passwordProtected != true
  && ${ConfiguredLocaleFilter}
] | order(_updatedAt desc) {
  _id,
  _type,
  "uri": uri.current,
  "missing": !defined(agentMarkdown.content) || agentMarkdown.content == "",
  "arms": select(_type in ${SharedRoutedTypes} => agentMarkdown.content)
}`);

/** The backfill's batch: exact versions by `_id`, under the `raw` perspective, all in the one `$language`. */
export const AgentMarkdownBackfillQuery = defineQuery(`${AgentMarkdownFunctions}
*[_id in $ids && ${ConfiguredLocaleFilter}]${AgentMarkdownPageProjection}`);

/** Translate with AI: `$document`, a translation not written yet, in its `$language`; null when it serves no Markdown. Run published. */
export const AiTranslationMarkdownQuery = defineQuery(`${AgentMarkdownFunctions}
select(
  $document._type in ${RoutedDocumentTypes} && $document.agentMarkdown.enabled != false => $document${AgentMarkdownPageProjection}
)`);

/** `enabled` gates serving (undefined is on); `content` is the Markdown body. Never matches a gated page or a locked site. */
export const AgentMarkdownServeQuery = defineQuery(`*[
  defined(uri.current)
  && ${MatchesUri}
  && seoMetadata.noIndex != true
  && passwordProtected != true
  && ${ConfiguredLocaleFilter}
  && *[_type == "${SANITY_SINGLETON_SITE_SETTINGS_ID}" && _id == "${SANITY_SINGLETON_SITE_SETTINGS_ID}"][0].basicAuth.siteWideEnabled != true
][0]{
  "enabled": agentMarkdown.enabled,
  // A shared document's Markdown in $language only: one language's text is never served at another's URL.
  "content": coalesce(string(agentMarkdown.content[$language]), string(agentMarkdown.content))
}`);

/** `enabled` gates only the upload path (undefined is off, since it spends credits); a backfill runs either way. */
export const AltTextSettingsQuery =
  defineQuery(`*[_type == "${SANITY_SINGLETON_SITE_SETTINGS_ID}" && _id == "${SANITY_SINGLETON_SITE_SETTINGS_ID}"][0]{
  "enabled": altText.enabled,
  "guidance": altText.guidance
}`);

/** Alt text lives on the asset, so one description covers every document using it. Raw: a string, or one arm per language. */
export const AltTextAssetQuery = defineQuery(`*[_type == "sanity.imageAsset" && _id == $assetId][0]{
  _id,
  url,
  extension,
  altText,
  "filename": originalFilename
}`);

/** Not sliced or filtered in GROQ: the languages each asset lacks are worked out in TypeScript, the batch by the time budget. */
export const AltTextAssetsQuery = defineQuery(`*[
  _type == "sanity.imageAsset"
  && extension != "svg"
] | order(_createdAt desc) {
  _id,
  url,
  extension,
  altText,
  "filename": originalFilename
}`);

/** Translate with AI, read published: the settings, the default Site's name and every person's name, all kept as written. */
export const AiTranslationSettingsQuery = defineQuery(`{
  "translations": *[_type == "${SANITY_SINGLETON_SITE_SETTINGS_ID}" && _id == "${SANITY_SINGLETON_SITE_SETTINGS_ID}"][0].translations,
  "siteName": *[_type == "${SANITY_SINGLETON_SITE_ID}" && _id == "${SANITY_SINGLETON_SITE_ID}"][0].name,
  "personNames": *[_type == "${SANITY_PERSON_DOCUMENT_TYPE}" && defined(name) && ${ConfiguredLocaleFilter}].name
}`);

/** Exact copies by `_id`, whole: run under the `raw` perspective with each published id and its `drafts.` id. */
export const AiTranslationDocumentsQuery = defineQuery(`*[_id in $ids && ${ConfiguredLocaleFilter}]`);

/** The translation group linking `$id`; the oldest wins should a manual and an AI translation have raced to make two. */
export const AiTranslationGroupQuery = defineQuery(`*[
  _type == "translation.metadata"
  && references($id)
  && !(_id in path("drafts.**"))
] | order(_createdAt asc)[0]{
  _id,
  _rev,
  _createdAt,
  translations,
  "groupCount": count(*[_type == "translation.metadata" && references($id) && !(_id in path("drafts.**"))])
}`);

/** Read published: a reference moves to a variant once that variant is published, as the translation callback does. */
export const AiTranslationVariantsQuery = defineQuery(`*[_type == "translation.metadata" && references($ids)]{
  "variants": translations[]{
    "id": value._ref,
    "language": select(${configuredReference("value")} => value->language)
  }
}`);

/** One page of whole documents of `$types` after `$after`, every published and draft copy; run under `raw`. */
export const AiTranslationPlanPageQuery = defineQuery(`*[
  _type in $types
  && _id > $after
  && !(_id in path("versions.**"))
  && ${ConfiguredLocaleFilter}
] | order(_id asc)[0...200]`);

export const AiTranslationGroupsPageQuery = defineQuery(`*[
  _type == "translation.metadata"
  && _id > $after
  && !(_id in path("drafts.**"))
] | order(_id asc)[0...200]{ _id, _rev, _createdAt, translations }`);

/** Release versions of `$types`, raw: a translation made inside a release exists with no published or draft copy. */
export const AiTranslationVersionsQuery = defineQuery(`*[
  _type in $types
  && _id in path("versions.**")
  && ${ConfiguredLocaleFilter}
]{ _id, _type, language, uri, title, name }`);

/** Every URI starting with `$uri`, drafts included under `raw`, so a translated slug gets a free suffix. */
export const AiTranslationTakenUrisQuery = defineQuery(
  `*[defined(uri.current) && string::startsWith(uri.current, $uri) && ${ConfiguredLocaleFilter}].uri.current`
);

/** What a new translation would duplicate, release versions too: the fixed `$uri`'s document, else `$type`'s in `$language`. */
export const AiTranslationHoldersQuery = defineQuery(`*[
  !(_id in $exclude)
  && ((defined($uri) && uri.current == $uri) || (!defined($uri) && _type == $type && language == $language))
  && ${ConfiguredLocaleFilter}
][0...5]{ _id, _type, language, uri, title, name }`);

/** Settings > Redirects' sources: a page there is never reached, since the redirect answers first. */
export const AiTranslationRedirectSourcesQuery = defineQuery(
  `*[_type == "${SANITY_SINGLETON_SITE_SETTINGS_ID}" && _id == "${SANITY_SINGLETON_SITE_SETTINGS_ID}"][0].redirects[]{ "from": coalesce(from, @->from) }.from`
);

/** The schema Agent Actions read: a JSON string, compared field by field with the local extract before a run. */
export const AiTranslationDeployedSchemaQuery = defineQuery(`*[_id == "${SANITY_AGENT_SCHEMA_ID}"][0]{ _updatedAt, schema }`);

/** `0` AI requests a day in Settings > Translations switches Translate with AI off; unset reads as the default limit. */
export const AiTranslationOffQuery = defineQuery(
  `*[_type == "${SANITY_SINGLETON_SITE_SETTINGS_ID}" && _id == "${SANITY_SINGLETON_SITE_SETTINGS_ID}"][0].translations.defaults.maxCreditsPerDay == 0`
);

/** The markers a timed-out call leaves (no paid result came back), so the plan holds that pair out of bulk. */
export const AiTranslationTimeoutsQuery = defineQuery(`*[_type == "${AI_TRANSLATION_RESULT_TYPE}" && defined(timedOut)]{
  "sourceId": timedOut.sourceId,
  "language": timedOut.language,
  "sourceTextHash": timedOut.sourceTextHash
}`);
