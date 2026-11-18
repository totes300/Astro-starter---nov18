import { defineArrayMember, defineField, defineType } from "sanity";
import { requiredIf } from "../../utils";
import { createLanguageField } from "../fields/create-language-field";
import { createLinkField } from "../fields/create-link";
import { createRichTextField } from "../fields/create-rich-text";
import { createSeoField } from "../fields/create-seo-field";
import { hasSocialProfile } from "../fields/seo-rules";

// Only the switch decides whether the announcement bar renders. The copy stays on screen either
// way, so it can be written, reviewed and kept between runs without the bar being live.
const requiredIfEnabled = requiredIf("enabled");

/** The copy that renders on every page, one document per language; configuration set once lives on `siteSettings` instead. */
export const site = defineType({
  __experimental_formPreviewTitle: false,
  name: "site",
  type: "document",
  title: "Site",
  icon: () => <>🖥</>,
  groups: [
    { name: "site", title: "Site", icon: () => <>🖥</>, default: true },
    { name: "announcement", title: "Announcement", icon: () => <>📣</> },
    { name: "seo", title: "SEO", icon: () => <>🔍</> },
    { name: "contacts", title: "Contacts", icon: () => <>📞</> },
    { name: "header", title: "Header", icon: () => <>🔗</> },
    { name: "footer", title: "Footer", icon: () => <>👟</> },
  ],
  fields: [
    createLanguageField({ group: "site" }),
    defineField({
      group: "site",
      name: "name",
      type: "string",
      title: "Site Name",
      initialValue: "The Content Architecture",
      validation: (R) => R.required(),
    }),
    defineField({
      group: "site",
      name: "notFound",
      type: "object",
      fields: [
        createRichTextField({ title: "Text", validation: (R) => R.required() }),
        createLinkField({ title: "Link", validation: (R) => R.required() }),
        defineField({
          name: "showHeader",
          type: "boolean",
          title: "Show site header",
          description: "Renders the site header (navigation) on this page.",
          initialValue: true,
          options: { layout: "switch" },
        }),
        defineField({
          name: "showFooter",
          type: "boolean",
          title: "Show site footer",
          description: "Renders the site footer on this page.",
          initialValue: true,
          options: { layout: "switch" },
        }),
      ],
    }),
    defineField({
      group: "announcement",
      name: "announcement",
      type: "object",
      title: "Announcement",
      description:
        "The bar above the header on every page. Switching it off leaves the copy here untouched. A visitor who dismisses the bar does not see it again for 24 hours, including if it is rewritten in the meantime.",
      options: { collapsed: false, collapsible: false },
      fields: [
        defineField({
          name: "enabled",
          type: "boolean",
          title: "Show announcement",
          initialValue: false,
          options: { layout: "switch" },
        }),
        defineField({
          name: "theme",
          type: "string",
          title: "Theme",
          initialValue: "dark",
          options: {
            layout: "radio",
            list: [
              { title: "Dark", value: "dark" },
              { title: "Light", value: "light" },
            ],
          },
        }),
        defineField({
          name: "text",
          type: "string",
          title: "Text",
          description: "Keep it to one line; it scrolls as a marquee on any viewport too narrow to fit it.",
          ...requiredIfEnabled(true),
        }),
        createLinkField({
          title: "Link",
          description: "Optional call to action after the text.",
        }),
      ],
      preview: {
        select: { enabled: "enabled", text: "text" },
        prepare: ({ enabled, text }) => ({
          title: text || "Announcement",
          subtitle: enabled ? "Visible" : "Hidden",
        }),
      },
    }),
    defineField({
      group: "header",
      name: "header",
      type: "object",
      fields: [
        defineField({
          name: "links",
          type: "array",
          title: "Links",
          validation: (R) => R.required().min(1),
          of: [createLinkField({ title: "Link", validation: (R) => R.required() })],
        }),
      ],
    }),
    defineField({
      group: "contacts",
      name: "contacts",
      type: "array",
      title: "Contacts",
      validation: (R) =>
        R.custom((contacts) =>
          hasSocialProfile(contacts)
            ? true
            : "No contact links to a profile outside the site (LinkedIn, X and so on). Search engines read those as the organization's official profiles."
        ).warning(),
      of: [
        defineArrayMember({
          type: "object",
          fields: [
            defineField({
              name: "name",
              type: "string",
              validation: (R) => R.required(),
            }),
            createLinkField({ title: "Link", validation: (R) => R.required() }),
          ],
        }),
      ],
    }),
    defineField({
      group: "footer",
      name: "footer",
      type: "object",
      fields: [
        defineField({
          name: "tagline",
          type: "string",
          title: "Tagline",
          description: "A one-line sign-off beside the logo.",
        }),
        defineField({
          name: "links",
          type: "array",
          title: "Links",
          validation: (R) => R.required().min(1),
          of: [createLinkField({ title: "Link", validation: (R) => R.required() })],
        }),
        defineField({
          name: "legalLinks",
          type: "array",
          title: "Legal Links",
          of: [createLinkField({ title: "Link", validation: (R) => R.required() })],
        }),
      ],
    }),
    createSeoField({
      group: "seo",
      titleFallback: "name",
      noIndexDescription:
        "Adds noindex to every page in this language. The sitemap, the RSS feed, llms.txt, agent Markdown and the blog lists still include those pages; to hide the site, turn on Protect entire site in Settings.",
      noIndexWarning: "On: every page in this language tells search engines to leave it out of their results.",
    }),
  ],
});
