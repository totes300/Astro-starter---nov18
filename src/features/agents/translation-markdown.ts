// Translate with AI's agent Markdown: a translation serialized before it is written, so both land in one transaction.
// When it runs and what a failure leaves: docs/features/ai-translation.md

import type { SanityClient } from "@sanity/client";
import { isPlainObject } from "~/sanity/ai-translation/fields";
import { toPatchPath } from "~/sanity/lib/patch-path";
import { collectReferences, type PathSegment } from "~/sanity/translation-references";
import { setAt, type TranslationDocument, type TranslationStub } from "~/sanity/translation-stub";
import { fetchSanity } from "../../sanity/lib/fetch";
import { type AgentMarkdownPage, pageToMarkdown } from "./markdown";
import { AiTranslationMarkdownQuery } from "./query";

/** `written` with the translation, `unchanged` when a refresh left it current, `failed` when the translation went without it. */
export type AgentMarkdownStatus = "written" | "unchanged" | "failed";

const PLAIN_PATH = /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/;

/** The stub as `stubMutations` leaves it: the copy, then its move into the language (URI, share image, references). */
export function stubAsWritten({ document, patch }: Pick<TranslationStub, "document" | "patch">): TranslationDocument {
  const written = structuredClone(document);
  const references = new Map(
    collectReferences(written).map(({ path }) => [toPatchPath([...path, "_ref"]), [...path, "_ref"] as PathSegment[]])
  );

  for (const [key, value] of Object.entries(patch)) {
    const path = references.get(key) ?? (PLAIN_PATH.test(key) ? key.split(".") : undefined);

    if (path) {
      setAt(written, path, value);
    }
  }

  return written;
}

/** The agent Markdown of a document not written yet; null when its type serves none or its serving switch is off. */
export async function translationMarkdown(
  client: SanityClient,
  document: TranslationDocument,
  options: { language: string; siteUrl: string }
): Promise<string | null> {
  // Published: the text goes public with the page, so its links and the blog index's list name published pages only.
  const page = await fetchSanity<AgentMarkdownPage | null>(
    client,
    AiTranslationMarkdownQuery,
    { document, language: options.language },
    { perspective: "published" }
  );

  return page ? pageToMarkdown(page, options.siteUrl).trim() || null : null;
}

/** The Markdown a relink `patch` leaves: replaced only while it still reads as generated, so a hand edit is never lost. */
export async function relinkedMarkdown(
  client: SanityClient,
  { document, patch }: Pick<TranslationStub, "document" | "patch">,
  options: { language: string; siteUrl: string }
): Promise<string | undefined> {
  const stored = isPlainObject(document.agentMarkdown) ? document.agentMarkdown.content : undefined;

  if (typeof stored !== "string" || stored === "") {
    return undefined;
  }

  const [before, after] = await Promise.all([
    translationMarkdown(client, document, options),
    translationMarkdown(client, stubAsWritten({ document, patch }), options),
  ]);

  return before === stored && after && after !== stored ? after : undefined;
}
