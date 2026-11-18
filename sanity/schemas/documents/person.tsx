import { defineField, defineType } from "sanity";
import { SANITY_AUTHOR_PATH_PREFIX, SANITY_PERSON_DOCUMENT_TYPE } from "../../constants";
import { DEFAULT_LOCALE } from "../../i18n";
import { createAgentMarkdownField } from "../fields/create-agent-markdown-field";
import { createLinkField } from "../fields/create-link";
import { createLocalizedField } from "../fields/create-localized-field";
import { createSeoField } from "../fields/create-seo-field";
import { createUriField } from "../fields/create-uri-field";

// One document for every language: the person is the same everywhere, so only their words translate, in place.
export const person = defineType({
  __experimental_formPreviewTitle: false,
  name: "person",
  type: "document",
  title: "Person",
  icon: () => <>👤</>,
  groups: [
    { name: "page", title: "Page", icon: () => <>📄</>, default: true },
    { name: "content", title: "Content", icon: () => <>🍱</> },
    { name: "seo", title: "SEO", icon: () => <>🔍</> },
    { name: "agents", title: "Agents", icon: () => <>🤖</> },
  ],
  fields: [
    defineField({
      group: "page",
      name: "name",
      type: "string",
      title: "Name",
      validation: (R) => R.required(),
    }),
    createUriField({
      group: "page",
      source: "name",
      slugify: ({ slug }) => `${SANITY_AUTHOR_PATH_PREFIX}/${slug}`,
      validation: (R) => R.required(),
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
    createLocalizedField({
      documentType: SANITY_PERSON_DOCUMENT_TYPE,
      group: "content",
      name: "role",
      title: "Role",
      description: "The line under the name, e.g. “Head of Engineering”.",
    }),
    defineField({
      group: "content",
      name: "image",
      type: "image",
      title: "Portrait",
      options: { hotspot: true, collapsed: false, collapsible: false, accept: "image/*" },
    }),
    createLocalizedField({
      documentType: SANITY_PERSON_DOCUMENT_TYPE,
      group: "content",
      name: "bio",
      title: "Bio",
      type: "richText",
      description: "Shown in full on the person's page and in the panel an article's byline opens.",
    }),
    defineField({
      group: "content",
      name: "links",
      type: "array",
      title: "Links",
      description: "Profiles and personal sites; also published as the Person's `sameAs` in structured data.",
      of: [createLinkField({ title: "Link", validation: (R) => R.required() })],
    }),
    createSeoField({
      group: "seo",
      localizedFor: SANITY_PERSON_DOCUMENT_TYPE,
    }),
    createAgentMarkdownField({
      group: "agents",
      localizedFor: SANITY_PERSON_DOCUMENT_TYPE,
    }),
  ],
  preview: {
    select: { title: "name", role: "role", media: "image" },
    // A role saved before it was translated in place is still a plain string.
    prepare: ({ title, role, media }) => ({
      title,
      subtitle: typeof role === "string" ? role : (role as Record<string, string> | undefined)?.[DEFAULT_LOCALE],
      media,
    }),
  },
});
