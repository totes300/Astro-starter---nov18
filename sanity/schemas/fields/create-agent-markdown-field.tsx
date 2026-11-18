import { type BooleanInputProps, defineField, type ValidationContext } from "sanity";
import type { LocalizedDocumentType, LocalizedFieldName } from "../../constants";
import { DEFAULT_LOCALE, LOCALES } from "../../i18n";
import { AgentMarkdownInput } from "../../inputs/generate-text-input";
import { localizedFieldFor } from "./create-localized-field";

// Serving treats an unset toggle as on, so the switch shows it that way too (documents created before the field existed).
function DefaultOnSwitchInput(props: BooleanInputProps) {
  return props.renderDefault({ ...props, value: props.value ?? true });
}

const CONTENT_DESCRIPTION =
  "Markdown served to agents, required while serving is on. Click Generate to draft it from this page's current content, then edit and publish. Nothing is served until you publish, and it does not refresh on its own, so regenerate after you change the page.";

const isServing = (context: ValidationContext) =>
  (context.document?.agentMarkdown as { enabled?: boolean } | undefined)?.enabled !== false;

const isFilled = (value: unknown) => typeof value === "string" && value.trim() !== "";

/** A shared routed type's Markdown: one text per language, each generated from its own page; only the default one is required. */
function localizedContent(documentType: LocalizedDocumentType) {
  const field = localizedFieldFor(
    {
      documentType,
      name: "agentMarkdown.content" as LocalizedFieldName<typeof documentType>,
      title: "Content",
      description: `${CONTENT_DESCRIPTION} Each language is served at its own URL; one left empty serves no Markdown there.`,
      type: "text",
      rows: 20,
      validate: (value, context) =>
        !isServing(context) || isFilled(value?.[DEFAULT_LOCALE])
          ? true
          : "Generate or write the Markdown, or turn off serving to agents.",
    },
    LOCALES
  );

  return { ...field, fields: field.fields.map((arm) => ({ ...arm, components: { input: AgentMarkdownInput } })) };
}

export function createAgentMarkdownField({
  group,
  localizedFor,
}: {
  group?: string;
  /** A shared routed type (`SHARED_ROUTED_DOCUMENT_TYPES`) listing `agentMarkdown.content` in `LOCALIZED_FIELDS`. */
  localizedFor?: LocalizedDocumentType;
} = {}) {
  return defineField({
    name: "agentMarkdown",
    type: "object",
    title: "Agent Markdown",
    description:
      "A Markdown version of this page served to AI agents that request it (Accept: text/markdown). Draft it from the page's content with one click, then publish. It is served as-is and does not update on its own, so regenerate when the page changes.",
    group,
    options: {
      collapsed: false,
      collapsible: false,
    },
    fields: [
      defineField({
        name: "enabled",
        type: "boolean",
        title: "Serve Markdown to agents",
        description:
          "When on, the published Markdown below is served to AI agents that request this page with an Accept: text/markdown header. Turn off to keep this page HTML-only. Nothing is served for a noindex or password-protected page, or for any page while the whole site is password protected, and the Backfill under Settings skips password-protected pages.",
        initialValue: true,
        options: { layout: "switch" },
        components: { input: DefaultOnSwitchInput },
      }),
      localizedFor
        ? localizedContent(localizedFor)
        : defineField({
            name: "content",
            type: "text",
            rows: 20,
            title: "Content",
            description: CONTENT_DESCRIPTION,
            components: { input: AgentMarkdownInput },
            validation: (R) =>
              R.custom((value, { parent }) => {
                if ((parent as { enabled?: boolean } | undefined)?.enabled === false) {
                  return true;
                }

                return isFilled(value) ? true : "Generate or write the Markdown, or turn off serving to agents.";
              }),
          }),
    ],
  });
}
