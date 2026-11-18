import * as React from "react";
import { defineArrayMember, defineField, defineType, type ObjectFieldProps, type TextInputProps } from "sanity";
import { languageName, policyTitles } from "../../ai-translation/present";
import { readTranslationSettings, styleGuideIssues } from "../../ai-translation/style-guide";
import { AI_TRANSLATION_DEFAULTS, AI_TRANSLATION_STYLE_GUIDE_LIMIT } from "../../constants";
import { DEFAULT_LOCALE, getLocaleTitle, getStudioLocaleTitle, IS_I18N_ENABLED, LOCALES } from "../../i18n";
import { AgentMarkdownBackfillInput } from "../../inputs/agent-markdown-backfill-input";
import { AltTextInput } from "../../inputs/alt-text-input";
import { LlmsTxtInput } from "../../inputs/generate-text-input";
import { RedirectsDeployInput } from "../../inputs/redeploy-input";
import { redirectChains } from "./redirect-path";

const SOURCE_LANGUAGE = languageName(DEFAULT_LOCALE);
const POLICY_TITLES = policyTitles(SOURCE_LANGUAGE);
const STYLE_GUIDE_LIMIT = AI_TRANSLATION_STYLE_GUIDE_LIMIT.toLocaleString("en");
const TRANSLATION_TARGETS: readonly { id: string }[] = LOCALES.filter(({ id }) => id !== DEFAULT_LOCALE);

// With one locale the default stands in: Sanity rejects an object with no fields, and the group is hidden then.
const PER_LANGUAGE: readonly { id: string }[] = IS_I18N_ENABLED ? TRANSLATION_TARGETS : LOCALES;

// Loaded when Settings > Translations opens, not with every Studio page; until then the settings render as they are.
const TranslationPanel = React.lazy(() =>
  import("../../inputs/site-translation-input").then((module) => ({ default: module.SiteTranslationField }))
);
const StyleGuideRoom = React.lazy(() =>
  import("../../inputs/site-translation-input").then((module) => ({ default: module.StyleGuideInput }))
);

function SiteTranslationField(props: ObjectFieldProps) {
  return (
    <React.Suspense fallback={props.renderDefault(props)}>
      <TranslationPanel {...props} />
    </React.Suspense>
  );
}

function StyleGuideInput(props: TextInputProps) {
  return (
    <React.Suspense fallback={props.renderDefault(props)}>
      <StyleGuideRoom {...props} />
    </React.Suspense>
  );
}

/** The style guide alone; the compiled guide adds each language's notes and glossary on top. */
export function styleGuideLengthIssue(value: unknown): true | string {
  const length = typeof value === "string" ? value.length : 0;

  if (length <= AI_TRANSLATION_STYLE_GUIDE_LIMIT) {
    return true;
  }

  return `This is ${length.toLocaleString("en")} characters. Sanity AI accepts ${STYLE_GUIDE_LIMIT}, including each language's notes and glossary, so shorten it.`;
}

/** Each language's compiled guide: the style guide, then that language's notes and glossary. */
export function compiledStyleGuideIssue(value: unknown): true | string {
  const languages = TRANSLATION_TARGETS.map(({ id }) => ({ id, title: getLocaleTitle(id) }));
  const issues = styleGuideIssues(readTranslationSettings(value), languages);

  return issues.length > 0 ? issues.join(" ") : true;
}

/**
 * Configuration rather than copy: how the site is served, set once and rarely revisited.
 * Its counterpart is `site`, which holds what gets written and rewritten.
 */
export const siteSettings = defineType({
  __experimental_formPreviewTitle: false,
  name: "siteSettings",
  type: "document",
  title: "Settings",
  icon: () => <>⚙️</>,
  groups: [
    { name: "general", title: "General", icon: () => <>⚙️</>, default: true },
    { name: "security", title: "Security", icon: () => <>🔐</> },
    { name: "agents", title: "Agents", icon: () => <>🤖</> },
    { name: "translations", title: "Translations", icon: () => <>🌐</>, hidden: !IS_I18N_ENABLED },
    { name: "emailNotifications", title: "Email Notifications", icon: () => <>✉️</> },
  ],
  fields: [
    defineField({
      group: "general",
      name: "redirects",
      type: "array",
      title: "Redirects",
      description:
        "Define site-wide redirects here. For security and performance they are applied at build time, so publish your changes and then use the Redeploy button below to make them live.",
      of: [{ type: "redirect" }],
      components: { input: RedirectsDeployInput },
      // Redirects must have unique `from` values.
      validation: (R) => {
        return R.custom((redirects) => {
          if (!redirects) {
            return true;
          }

          const seen = new Set();
          for (const item of redirects) {
            // @ts-expect-error The prop is part of the redirect schema.
            const from = item?.from;

            if (!from) {
              continue;
            }

            if (seen.has(from)) {
              return `Duplicate redirect detected for "${from}".`;
            }

            seen.add(from);
          }

          // Each hop is a round trip and a crawler gives up after a few, so a chain is refused rather than warned.
          const [chain, ...more] = redirectChains(redirects as { from?: unknown; to?: unknown }[]);

          if (chain) {
            return more.length > 0 ? `${chain} ${more.length} more redirect chains follow.` : chain;
          }

          return true;
        });
      },
    }),
    defineField({
      group: "general",
      name: "favicon",
      type: "object",
      title: "Favicon",
      description:
        "Tab icons per system color scheme. Each image is cropped to a square when served. Upload one asset to use everywhere, or two when you need different art for light vs dark browser chrome.",
      fields: [
        defineField({
          name: "iconLight",
          type: "image",
          title: "Light scheme",
          description:
            "Used when the system prefers light mode (or as the only icon if dark is empty). Non-square images are cropped to a centered square.",
          options: {
            hotspot: false,
          },
        }),
        defineField({
          name: "iconDark",
          type: "image",
          title: "Dark scheme",
          description:
            "Used when the system prefers dark mode (optional if one icon works in both). Non-square images are cropped to a centered square.",
          options: {
            hotspot: false,
          },
        }),
      ],
    }),
    defineField({
      group: "security",
      name: "basicAuth",
      type: "object",
      title: "HTTP Basic Auth",
      description:
        "Toggles only. Set BASIC_AUTH_USERNAME and BASIC_AUTH_PASSWORD in your deployment environment (not in the CMS).",
      fields: [
        defineField({
          name: "siteWideEnabled",
          type: "boolean",
          title: "Protect entire site",
          description:
            "When enabled, every page (except Studio and API routes) requires Basic Auth using env credentials. When off, only individual pages or articles with “Password protect” are gated. Takes effect on Publish (not on save): from the first request after the publish webhook's settle wait, or within about five minutes without the webhook.",
          initialValue: false,
          options: { layout: "switch" },
        }),
      ],
    }),
    // Each machine-readable surface is its own object, so `mcp` or `agentsTxt` can be added without reshaping this one.
    defineField({
      group: "agents",
      name: "llms",
      type: "object",
      title: "llms.txt",
      description:
        "Configures the /llms.txt file (format: llmstxt.org): a curated map of this site for AI assistants. Draft it with Sanity AI from your content, then publish to serve it.",
      fields: [
        defineField({
          name: "enabled",
          type: "boolean",
          title: "Serve /llms.txt",
          description: "When on, the published content below is served at /llms.txt. Turn off to return 404 there.",
          initialValue: true,
          options: { layout: "switch" },
        }),
        defineField({
          name: "guidance",
          type: "text",
          rows: 3,
          title: "Generation guidance",
          description:
            "Optional. Steer the AI when generating: tone, audience, what to emphasize or leave out. Leave empty for a neutral summary.",
        }),
        defineField({
          name: "content",
          type: "text",
          rows: 18,
          title: "Content",
          description:
            "Markdown served at /llms.txt. Click Generate to draft it with Sanity AI from your site content, then edit and publish.",
          components: { input: LlmsTxtInput },
        }),
      ],
    }),
    // Holds no value: the per-page Markdown lives on each document, and this field only hosts the backfill panel.
    defineField({
      group: "agents",
      name: "agentMarkdown",
      type: "string",
      title: "Agent Markdown",
      description:
        "Each page stores its own Markdown for AI agents, under that page's Agents tab. Fill the pages where it was never generated in one go.",
      readOnly: true,
      components: { input: AgentMarkdownBackfillInput },
    }),
    defineField({
      group: "agents",
      name: "altText",
      type: "object",
      title: "Automatic alt text",
      description:
        "Describes uploaded images with Sanity AI and stores the result as the asset's alternative text, which is what every document using that image renders. Editors can always rewrite it in the media browser.",
      components: { input: AltTextInput },
      fields: [
        defineField({
          name: "enabled",
          type: "boolean",
          title: "Describe new uploads",
          description:
            "When on, an image uploaded without alternative text is described automatically. Off by default, since each description is an AI request. Backfill below works either way.",
          initialValue: false,
          options: { layout: "switch" },
        }),
        defineField({
          name: "guidance",
          type: "text",
          rows: 3,
          title: "Description guidance",
          description:
            "Optional. Steer the AI: vocabulary to prefer, how much detail to give, what to leave out. Overrides the built-in style rules. Leave empty for the default concise style.",
        }),
      ],
      options: {
        collapsed: false,
        collapsible: false,
      },
    }),
    defineField({
      group: "translations",
      name: "translations",
      type: "object",
      title: "Translation settings",
      description: "How Sanity AI writes each language. Translations read the published settings, so publish after a change.",
      hidden: !IS_I18N_ENABLED,
      components: { field: SiteTranslationField },
      options: {
        collapsed: false,
        collapsible: false,
      },
      fieldsets: [{ name: "writing", title: "How the AI writes", options: { collapsible: true, collapsed: true } }],
      validation: (R) => R.custom(compiledStyleGuideIssue),
      fields: [
        defineField({
          fieldset: "writing",
          name: "styleGuide",
          type: "text",
          rows: 6,
          title: "Style guide",
          description: `How the AI should write: tone, formality, audience. Sent with every translation, together with that language's notes and glossary, within Sanity's limit of ${STYLE_GUIDE_LIMIT} characters.`,
          components: { input: StyleGuideInput },
          validation: (R) => R.custom(styleGuideLengthIssue),
        }),
        defineField({
          fieldset: "writing",
          name: "protectedPhrases",
          type: "array",
          title: "Protected phrases",
          description:
            "Never translated: brand, product and feature names. Cheaper than spelling them out in the style guide. The site's name and every person's name are always protected.",
          of: [defineArrayMember({ type: "string", validation: (R) => R.max(100) })],
          options: { layout: "tags" },
          validation: (R) => R.unique().max(100),
        }),
        defineField({
          fieldset: "writing",
          name: "glossary",
          type: "array",
          title: "Glossary",
          description:
            "How to translate a term in each language. Each entry is sent with that language only, and counts toward its style guide.",
          of: [
            defineArrayMember({
              name: "glossaryTerm",
              type: "object",
              title: "Term",
              fields: [
                defineField({
                  name: "term",
                  type: "string",
                  title: `Term in ${SOURCE_LANGUAGE}`,
                  validation: (R) => R.required().max(100),
                }),
                defineField({
                  name: "renderings",
                  type: "object",
                  title: "Translations",
                  options: { columns: PER_LANGUAGE.length > 1 ? 2 : 1 },
                  fields: PER_LANGUAGE.map(({ id }) =>
                    defineField({ name: id, type: "string", title: getStudioLocaleTitle(id), validation: (R) => R.max(100) })
                  ),
                }),
              ],
              preview: {
                select: { title: "term", renderings: "renderings" },
                prepare: ({ title, renderings }: { title?: string; renderings?: Record<string, unknown> }) => ({
                  title,
                  subtitle: Object.values(renderings ?? {})
                    .filter((value): value is string => typeof value === "string" && value !== "")
                    .join(", "),
                }),
              },
            }),
          ],
        }),
        defineField({
          fieldset: "writing",
          name: "languageNotes",
          type: "object",
          title: "Notes per language",
          description: "Added to that language's style guide only, for example which form of address to use.",
          fields: PER_LANGUAGE.map(({ id }) => defineField({ name: id, type: "text", rows: 3, title: getStudioLocaleTitle(id) })),
        }),
        defineField({
          name: "defaults",
          type: "object",
          title: "Defaults",
          description: "What a translation starts with. Each run can still change its own options before it spends anything.",
          options: { collapsed: true, collapsible: true },
          fields: [
            defineField({
              name: "languages",
              type: "array",
              title: "Languages",
              description: "The languages translating the whole site goes into. None ticked means all of them.",
              of: [defineArrayMember({ type: "string" })],
              options: {
                list: TRANSLATION_TARGETS.map(({ id }) => ({ title: getStudioLocaleTitle(id), value: id })),
                layout: "grid",
              },
              validation: (R) => R.unique(),
            }),
            defineField({
              name: "policy",
              type: "string",
              title: "Translate",
              options: {
                list: [
                  { title: POLICY_TITLES.missing, value: "missing" },
                  { title: POLICY_TITLES.refresh, value: "refresh" },
                ],
                layout: "radio",
              },
              initialValue: AI_TRANSLATION_DEFAULTS.policy,
            }),
            defineField({
              name: "slugs",
              type: "string",
              title: "URL slugs of new translations",
              description: "A refresh always keeps a translation's current URL.",
              options: {
                list: [
                  { title: "Translate the slug", value: "translate" },
                  { title: `Keep the ${SOURCE_LANGUAGE} slug`, value: "keep" },
                ],
                layout: "radio",
              },
              initialValue: AI_TRANSLATION_DEFAULTS.slugs,
            }),
            defineField({
              name: "afterTranslate",
              type: "string",
              title: "After translating",
              options: {
                list: [
                  { title: "Save as draft", value: "draft" },
                  { title: "Publish", value: "publish" },
                ],
                layout: "radio",
              },
              initialValue: AI_TRANSLATION_DEFAULTS.afterTranslate,
            }),
            defineField({
              name: "maxCreditsPerRun",
              type: "number",
              title: "AI request limit per run",
              description: `A whole-site run stops when it reaches this limit, and the next run picks up the rest; each run can set its own. Translating one document asks for fewer languages instead. Default ${AI_TRANSLATION_DEFAULTS.maxCreditsPerRun}.`,
              initialValue: AI_TRANSLATION_DEFAULTS.maxCreditsPerRun,
              validation: (R) => R.integer().min(1).max(500),
            }),
            defineField({
              name: "maxCreditsPerDay",
              type: "number",
              title: "AI request limit per day",
              description: `Counted on the server per UTC day, across every editor and tab, automatic alt text included. AI requests use your Sanity organization's AI credits; check usage in your organization settings. 0 switches Translate with AI off; automatic alt text then uses the default. Default ${AI_TRANSLATION_DEFAULTS.maxCreditsPerDay}.`,
              initialValue: AI_TRANSLATION_DEFAULTS.maxCreditsPerDay,
              validation: (R) => R.integer().min(0).max(1000),
            }),
          ],
        }),
      ],
    }),
    defineField({
      group: "emailNotifications",
      name: "contactFormNotificationEmails",
      type: "array",
      title: "Contact Form Notifications",
      description: "Emails to notify when the contact form is submitted.",
      of: [
        defineArrayMember({
          type: "string",
          validation: (R) => R.required().email(),
        }),
      ],
    }),
  ],
});
