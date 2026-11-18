import { defineField, defineType, getPublishedId, type SlugValue, type ValidationContext } from "sanity";
import { sanityConfig } from "../../config";
import { SANITY_SINGLETON_HOMEPAGE_ID } from "../../constants";
import { DEFAULT_LOCALE, getLocaleTitle, IS_I18N_ENABLED, isLocale, withLocalePrefix } from "../../i18n";
import { isHomepageDocument } from "../../utils";
import { createAgentMarkdownField } from "../fields/create-agent-markdown-field";
import { createLanguageField } from "../fields/create-language-field";
import { createPageBuilderField } from "../fields/create-page-builder";
import { createSeoField } from "../fields/create-seo-field";
import { createUriField } from "../fields/create-uri-field";

// A translation's id is generated, so once its URI has moved only the metadata still names it a homepage.
const HOMEPAGE_TRANSLATION_QUERY = `count(*[
  _type == "translation.metadata" && $homepage in translations[].value._ref && $id in translations[].value._ref
]) > 0`;

async function translatedHomepageIssue(context: ValidationContext, id: string, language: string): Promise<true | string> {
  let isTranslation: boolean;

  // A validator that throws becomes an error, so a failed read never blocks publishing.
  try {
    isTranslation = await context
      .getClient({ apiVersion: sanityConfig.apiVersion })
      .fetch<boolean>(HOMEPAGE_TRANSLATION_QUERY, { homepage: SANITY_SINGLETON_HOMEPAGE_ID, id: getPublishedId(id) });
  } catch (error) {
    console.error("Could not check whether this page translates the homepage:", error);

    return true;
  }

  return isTranslation
    ? `This is the ${getLocaleTitle(language)} homepage, so its URI is fixed at "${withLocalePrefix(language, "/")}".`
    : true;
}

/** Keeps the homepage's translation at its language's home path, which is all the routes and the desk find it by. */
export function homepageTranslationIssue(
  value: SlugValue | undefined,
  context: ValidationContext
): true | Promise<true | string> {
  const { document } = context;
  const language = typeof document?.language === "string" ? document.language : DEFAULT_LOCALE;

  // The default language's homepage is the fixed id, and a URI already at a home path is `fixedPath`'s to check.
  if (!IS_I18N_ENABLED || !document || !value?.current || language === DEFAULT_LOCALE || !isLocale(language)) {
    return true;
  }

  return isHomepageDocument(document) ? true : translatedHomepageIssue(context, document._id, language);
}

export const page = defineType({
  __experimental_formPreviewTitle: false,
  name: "page",
  type: "document",
  title: "Page",
  icon: () => <>📄</>,
  groups: [
    { name: "page", title: "Page", icon: () => <>📄</>, default: true },
    { name: "content", title: "Content", icon: () => <>🍱</> },
    { name: "seo", title: "SEO", icon: () => <>🔍</> },
    { name: "agents", title: "Agents", icon: () => <>🤖</> },
  ],
  fields: [
    createLanguageField({ group: "page" }),
    defineField({
      group: "page",
      name: "title",
      type: "string",
      title: "Title",
      hidden: ({ parent }) => isHomepageDocument(parent),
      validation: (R) =>
        R.custom((value, context) => {
          if (isHomepageDocument(context.document)) {
            return true;
          }

          return typeof value === "string" && value.length > 0 ? true : "Required";
        }),
    }),
    createUriField({
      group: "page",
      source: "title",
      fixedPath: (document) => (isHomepageDocument(document) ? "/" : undefined),
      validation: (R) => [R.required(), R.custom(homepageTranslationIssue)],
    }),
    defineField({
      group: "page",
      name: "passwordProtected",
      type: "boolean",
      title: "Password protect",
      description:
        "When “Protect entire site” is off, only this URL requires Basic Auth (same BASIC_AUTH_* env credentials as site-wide). When site-wide protection is on, this is redundant. Takes effect on Publish (not on save): from the first request after the publish webhook's settle wait, or within about five minutes without the webhook. With more than one language, each translation has its own switch: a new translation copies this one when it is created, but turning it on or off later changes this language's URL only.",
      initialValue: false,
      options: { layout: "switch" },
    }),
    defineField({
      group: "page",
      name: "showHeader",
      type: "boolean",
      title: "Show site header",
      description: "Renders the site header (navigation) on this page.",
      initialValue: true,
      options: { layout: "switch" },
    }),
    defineField({
      group: "page",
      name: "showFooter",
      type: "boolean",
      title: "Show site footer",
      description: "Renders the site footer on this page.",
      initialValue: true,
      options: { layout: "switch" },
    }),
    createPageBuilderField({
      group: "content",
    }),
    createSeoField({
      group: "seo",
    }),
    createAgentMarkdownField({
      group: "agents",
    }),
  ],
});
