import { defineField, defineType, getPublishedId } from "sanity";
import { sanityConfig } from "../../config";
import { DEFAULT_LOCALE, LOCALES } from "../../i18n";
import { createLocalizedField } from "../fields/create-localized-field";

// The blog filter reads the slug from its URL and drops one outside a bounded charset or length.
const SLUG = /^[a-z0-9-]+$/;
const MAX_SLUG_LENGTH = 64;

// A name stored before it was translated is a plain string, read as the default language's spelling.
const DUPLICATE_NAME_QUERY = `count(*[
  _type == "articleCategory" && !sanity::versionOf($id)
  && lower(coalesce(name[$locale], select($locale == $defaultLocale => string(name)))) == lower($spelling)
])`;

/** One document for every language: `name` is translated in place and `slug` stays one value, so filter URLs never change. */
export const articleCategory = defineType({
  __experimental_formPreviewTitle: false,
  name: "articleCategory",
  type: "document",
  title: "Article Category",
  icon: () => <>🔍</>,
  fields: [
    createLocalizedField({
      documentType: "articleCategory",
      name: "name",
      title: "Name",
      required: true,
      // Per language: two categories may not share a spelling in the same one.
      validate: async (value, context) => {
        const client = context.getClient({ apiVersion: sanityConfig.apiVersion });
        // Its draft and release versions are the same category, not a second one.
        const id = context.document ? getPublishedId(context.document._id) : "";

        for (const { id: locale } of LOCALES) {
          const arm = value?.[locale];
          const spelling = typeof arm === "string" ? arm.trim() : "";

          if (!spelling) {
            continue;
          }

          const count = await client.fetch<number>(DUPLICATE_NAME_QUERY, {
            id,
            locale,
            defaultLocale: DEFAULT_LOCALE,
            spelling,
          });

          if (count > 0) {
            return `An article category named “${spelling}” already exists.`;
          }
        }

        return true;
      },
    }),
    defineField({
      name: "slug",
      type: "slug",
      title: "Slug",
      description:
        "The value this category uses in the blog index URL, e.g. `/blog?category=engineering`. One value for every language.",
      options: { source: `name.${DEFAULT_LOCALE}`, maxLength: MAX_SLUG_LENGTH },
      validation: (R) =>
        R.required().custom((slug) => {
          const current = slug?.current;

          if (!current) {
            return true;
          }

          if (current.length > MAX_SLUG_LENGTH) {
            return `Keep the slug to ${MAX_SLUG_LENGTH} characters or fewer.`;
          }

          return SLUG.test(current) || "Use lowercase letters, digits and hyphens only (e.g., `design-systems`).";
        }),
    }),
  ],
  preview: {
    select: { name: "name", subtitle: "slug.current" },
    prepare({ name, subtitle }) {
      return { title: typeof name === "string" ? name : name?.[DEFAULT_LOCALE], subtitle };
    },
  },
});
