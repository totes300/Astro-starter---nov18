// Studio validation for what search results and screen readers read: lengths, duplicates, a missing description, alt text.
// The pure rules are `seo-rules.ts`; this file adds the document context and the reads of other documents.

import { type BooleanRule, getPublishedId, type StringRule, type TextRule, type ValidationContext } from "sanity";
import { SANITY_SINGLETON_SITE_ID } from "../../constants";
import { DEFAULT_LOCALE, IS_I18N_ENABLED } from "../../i18n";
import { readForValidation } from "../../lib/read-for-validation";
import { isHomepageDocument } from "../../utils";
import { effectiveText, hasAltText, lengthIssue, SEO_DESCRIPTION_LENGTH, SEO_TITLE_LENGTH } from "./seo-rules";

type Document = Record<string, unknown> | undefined;

const LIVE_PAGES = `defined(uri.current) && !(_id in path("drafts.**")) && !(_id in path("versions.**")) && _id != $id && coalesce(language, $defaultLanguage) == $language && seoMetadata.noIndex != true`;

function languageOf(document: Document): string {
  return typeof document?.language === "string" ? document.language : DEFAULT_LOCALE;
}

function isSiteDefaults(document: Document): boolean {
  return document?._type === SANITY_SINGLETON_SITE_ID;
}

/** The homepage takes the Site defaults and a noindex page is not in search results, so neither is held to these rules. */
function isExempt(context: ValidationContext): boolean {
  const parent = context.parent as { noIndex?: boolean } | undefined;

  return isHomepageDocument(context.document) || parent?.noIndex === true;
}

function quoted(titles: unknown[]): string {
  return titles
    .filter((title): title is string => typeof title === "string")
    .map((title) => `"${title}"`)
    .join(", ");
}

/** `fallback` is the document field the route shows when the SEO Title is empty. */
export function seoTitleValidation(fallback: string) {
  return (R: StringRule) => [
    R.custom((value, context) => {
      if (isExempt(context)) {
        return true;
      }

      const own = typeof value === "string" && value.trim() !== "";
      const label = own ? "This title" : `The ${fallback} shown while this is empty`;

      return lengthIssue(effectiveText(value, context.document?.[fallback]), SEO_TITLE_LENGTH, label) ?? true;
    }).warning(),
    R.custom(async (value, context) => {
      const text = effectiveText(value, context.document?.[fallback]);

      if (!text || isExempt(context) || isSiteDefaults(context.document)) {
        return true;
      }

      const titles = await readForValidation<unknown[]>(
        context,
        `*[${LIVE_PAGES} && coalesce(seoMetadata.title, title) == $text][0...3].title`,
        {
          id: getPublishedId(context.document?._id ?? ""),
          language: languageOf(context.document),
          defaultLanguage: DEFAULT_LOCALE,
          text,
        }
      );

      return (
        !titles?.length || `Another page already uses this title in search results: ${quoted(titles)}. Give each page its own.`
      );
    }).warning(),
  ];
}

/** `fallback` is the document field the route shows when the description is empty; without one, every page shares the Site's. */
export function seoDescriptionValidation(fallback?: string) {
  return (R: TextRule) => [
    R.custom((value, context) => {
      if (isExempt(context) || effectiveText(value, fallback ? context.document?.[fallback] : undefined)) {
        return true;
      }

      return isSiteDefaults(context.document)
        ? "Write a description. Every page that has none of its own shows this one."
        : "Write a description. Without one, search results show the Site's default description, the same on every page that has none.";
    }),
    R.custom((value, context) => {
      if (isExempt(context)) {
        return true;
      }

      const own = typeof value === "string" && value.trim() !== "";
      const label = own ? "This description" : `The ${fallback} shown while this is empty`;
      const text = effectiveText(value, fallback ? context.document?.[fallback] : undefined);

      return lengthIssue(text, SEO_DESCRIPTION_LENGTH, label) ?? true;
    }).warning(),
    R.custom(async (value, context) => {
      const text = effectiveText(value, undefined);

      if (!text || isExempt(context) || isSiteDefaults(context.document)) {
        return true;
      }

      const params = {
        id: getPublishedId(context.document?._id ?? ""),
        language: languageOf(context.document),
        defaultLanguage: DEFAULT_LOCALE,
        site: SANITY_SINGLETON_SITE_ID,
        text,
      };
      const result = await readForValidation<{ titles: unknown[]; siteDefault?: string }>(
        context,
        `{
          "titles": *[${LIVE_PAGES} && seoMetadata.description == $text][0...3].title,
          "siteDefault": *[_type == $site && !(_id in path("drafts.**")) && !(_id in path("versions.**")) && coalesce(language, $defaultLanguage) == $language][0].seoMetadata.description
        }`,
        params
      );

      if (!result) {
        return true;
      }

      const { titles, siteDefault } = result;

      if (siteDefault?.trim() === text) {
        return "This is the Site's default description word for word. Write one for this page.";
      }

      return titles.length === 0 || `Another page already uses this description: ${quoted(titles)}. Give each page its own.`;
    }).warning(),
  ];
}

export function noIndexValidation(message: string) {
  return (R: BooleanRule) => R.custom((value) => (value === true ? message : true)).warning();
}

/** A warning, not an error: automatic alt text writes the asset a few seconds after upload, which an error would not notice. */
export async function imageAltTextIssue(value: unknown, context: ValidationContext): Promise<string | true> {
  const ref = (value as { asset?: { _ref?: string } } | undefined)?.asset?._ref;

  if (!ref) {
    return true;
  }

  const language = languageOf(context.document);
  const asset = await readForValidation<{ altText?: unknown } | null>(context, `*[_id == $ref][0]{altText}`, { ref });

  if (asset === undefined || hasAltText(asset?.altText, language, DEFAULT_LOCALE)) {
    return true;
  }

  const where = IS_I18N_ENABLED ? ` in "${language}"` : "";

  return `This image has no alt text${where}. Add it in Media, or run the backfill in Settings, Agents, Automatic alt text.`;
}
