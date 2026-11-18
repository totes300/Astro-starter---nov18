import { defineField } from "sanity";
import type { LocalizedDocumentType, LocalizedFieldName } from "../../constants";
import { SeoImageInput } from "../../inputs/seo-image-input";
import { isHomepageDocument } from "../../utils";
import { createLocalizedField } from "./create-localized-field";
import { noIndexValidation, seoDescriptionValidation, seoTitleValidation } from "./seo-validation";

const NO_INDEX_DESCRIPTION =
  "Keep this page out of search engines, the sitemap, the RSS feed, llms.txt and agent Markdown. An article also leaves the blog index, its author's page and the category filter. The page itself stays reachable at its URL.";

const NO_INDEX_WARNING = "On: this page leaves search results and the sitemap. Leave it on only if that is the intent.";

type SeoFieldOptions = {
  group?: string;
  name?: string;
  /** For a document whose switch means something other than hiding one page (the Site singleton's applies to every page). */
  noIndexDescription?: string;
  /** A shared type whose `LOCALIZED_FIELDS` list `seoMetadata.title` and `seoMetadata.description`: they translate in place. */
  localizedFor?: LocalizedDocumentType;
  /** The document field the route shows when the SEO Title is empty. */
  titleFallback?: string;
  /** The document field the route shows when the description is empty; left out, the page shows the Site's default. */
  descriptionFallback?: string;
  noIndexWarning?: string;
};

export function createSeoField({
  group,
  name = "seoMetadata",
  noIndexDescription = NO_INDEX_DESCRIPTION,
  localizedFor,
  titleFallback = "title",
  descriptionFallback,
  noIndexWarning = NO_INDEX_WARNING,
}: SeoFieldOptions = {}) {
  const hidden = ({ document }: { document?: Record<string, unknown> }) => isHomepageDocument(document);
  const text = localizedFor
    ? [
        createLocalizedField({
          documentType: localizedFor,
          name: "seoMetadata.title" as LocalizedFieldName<typeof localizedFor>,
          title: "SEO Title",
          description: "The title of the page for search engines.",
        }),
        createLocalizedField({
          documentType: localizedFor,
          name: "seoMetadata.description" as LocalizedFieldName<typeof localizedFor>,
          title: "Description",
          description: "A brief description of the page for search engines.",
          type: "text",
          rows: 3,
        }),
      ]
    : [
        defineField({
          name: "title",
          type: "string",
          title: "SEO Title",
          description: "The title of the page for search engines.",
          hidden,
          validation: seoTitleValidation(titleFallback),
        }),
        defineField({
          name: "description",
          type: "text",
          title: "Description",
          description: "A brief description of the page for search engines.",
          rows: 3,
          hidden,
          validation: seoDescriptionValidation(descriptionFallback),
        }),
      ];

  return defineField({
    name,
    type: "object",
    title: "SEO Metadata",
    description: "Setup SEO meta data for this document.",
    group,
    options: {
      collapsed: false,
      collapsible: false,
    },
    fields: [
      defineField({
        name: "noIndex",
        type: "boolean",
        title: "No Index",
        description: noIndexDescription,
        initialValue: false,
        options: { layout: "switch" },
        validation: noIndexValidation(noIndexWarning),
      }),
      ...text,
      defineField({
        name: "sourceUrl",
        type: "url",
        title: "Source URL",
        description: "An https page on this site (apex or www) to screenshot for the share image. Required to use auto-generate.",
        validation: (R) => R.uri({ scheme: ["https"] }),
        hidden: ({ document }) => isHomepageDocument(document),
      }),
      defineField({
        name: "screenshotWaitSeconds",
        type: "number",
        title: "Screenshot wait (seconds)",
        description:
          "Extra time to wait after page load before capturing. Bump this for sites with intro animations or lazy content.",
        initialValue: 2,
        validation: (R) => R.min(0).max(10).integer(),
        hidden: ({ document }) => isHomepageDocument(document),
      }),
      defineField({
        name: "image",
        type: "image",
        title: "Image",
        description: "An image to represent the page for search engines.",
        options: {
          hotspot: true,
        },
        components: {
          input: SeoImageInput,
        },
        hidden: ({ document }) => isHomepageDocument(document),
      }),
    ],
  });
}
