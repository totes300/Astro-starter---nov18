import type { Mutation, SanityClient } from "@sanity/client";
import { getPublishedId } from "@sanity/client/csm";
import { isConflict } from "~/features/agents/ai-ledger";
import { relinkedMarkdown } from "~/features/agents/translation-markdown";
import { isPlainObject } from "~/sanity/ai-translation/fields";
import { FREE_PASS_BATCH, type RelinkResult } from "~/sanity/ai-translation/wire";
import { I18N_DOCUMENT_TYPES } from "~/sanity/constants";
import { DEFAULT_LOCALE } from "~/sanity/i18n";
import { buildReferencePatch, collectReferences, variantTargets } from "~/sanity/translation-references";
import { referenceOnlyChanges, type TranslationDocument } from "~/sanity/translation-stub";
import { discardOwnDraft, keepIfPublishedUnchanged, publishDraft } from "./publish";
import { byPublishedId, readDocumentsOfTypes, readVariantGroups } from "./reads";
import { draftOf, pastDeadline, revisionOf } from "./shared";

type RelinkItem = {
  id: string;
  draft?: TranslationDocument;
  published?: TranslationDocument;
  current: TranslationDocument;
  language: string;
  /** The references to move now; empty for a draft an earlier relink left. */
  patch: Record<string, string>;
  /** The draft differs from the published copy only by moves to published variants: a relink's, safe to publish. */
  relinkDraft?: Record<string, string>;
};

/** A draft's ref moves over its published copy, when each goes to this language's variant and nothing else differs. */
function relinkOnlyMoves(
  draft: TranslationDocument,
  published: TranslationDocument,
  targets: ReadonlyMap<string, string>
): Record<string, string> | undefined {
  const changes = referenceOnlyChanges(published, draft, [["agentMarkdown", "content"]]);
  const moves = Object.entries(changes ?? {});
  const allMoves = moves.every(([, { from, to }]) => targets.get(getPublishedId(from)) === getPublishedId(to));

  return moves.length > 0 && allMoves ? Object.fromEntries(moves.map(([path, { to }]) => [path, to])) : undefined;
}

function markdownContent(document: TranslationDocument | undefined): unknown {
  return isPlainObject(document?.agentMarkdown) ? document.agentMarkdown.content : undefined;
}

/** A draft an earlier relink left: its agent Markdown is the published one, or exactly what that relink writes. */
async function isRelinkDraft(client: SanityClient, item: RelinkItem, siteUrl: string): Promise<boolean> {
  const { draft, published, relinkDraft, language } = item;

  if (!draft || !published || !relinkDraft) {
    return false;
  }

  const content = markdownContent(draft);

  if (content === markdownContent(published)) {
    return true;
  }

  const relinked = await relinkedMarkdown(client, { document: published, patch: relinkDraft }, { language, siteUrl }).catch(
    () => undefined
  );

  return relinked !== undefined && relinked === content;
}

/** Free: re-points references, and unedited agent Markdown, at variants published since. Drafts only, unless `publish`. */
export async function relinkReferences(
  client: SanityClient,
  options: { publish?: boolean; limit?: number; siteUrl: string; deadline?: number }
): Promise<RelinkResult> {
  const documents = await readDocumentsOfTypes(client, I18N_DOCUMENT_TYPES);
  const copies = [...byPublishedId(documents)].flatMap(([id, { draft, published }]) => {
    const current = draft ?? published;
    const language = current?.language;

    return current && typeof language === "string" && language !== DEFAULT_LOCALE
      ? [{ id, draft, published, current, language }]
      : [];
  });
  const groups = await readVariantGroups(
    client,
    copies.flatMap(({ draft, published }) =>
      [draft, published].flatMap((copy) => (copy ? collectReferences(copy).map(({ ref }) => ref) : []))
    )
  );
  const work = copies.flatMap((copy): RelinkItem[] => {
    const targets = variantTargets(groups, copy.language);
    const patch = buildReferencePatch(collectReferences(copy.current), ({ ref }) => targets.get(getPublishedId(ref)));
    const relinkDraft =
      options.publish && copy.draft && copy.published ? relinkOnlyMoves(copy.draft, copy.published, targets) : undefined;

    if (Object.keys(patch).length === 0 && !relinkDraft) {
      return [];
    }

    return [{ ...copy, patch, ...(relinkDraft ? { relinkDraft } : {}) }];
  });
  const batch = work.slice(0, options.limit ?? FREE_PASS_BATCH);
  const result: RelinkResult = { relinked: [], published: [], conflicts: [], remaining: work.length };

  for (const item of batch) {
    if (pastDeadline(options.deadline)) {
      break;
    }

    result.remaining -= 1;

    const { id, draft, published, current, language, patch } = item;
    const draftId = `drafts.${id}`;
    const publishedRev = typeof published?._rev === "string" ? published._rev : undefined;

    try {
      // A draft this pass makes, or one an earlier relink left: an editor's open draft is theirs to publish.
      const publishable = options.publish === true && (!draft || (await isRelinkDraft(client, item, options.siteUrl)));
      let rev = typeof draft?._rev === "string" ? draft._rev : undefined;

      if (Object.keys(patch).length > 0) {
        const markdown = await relinkedMarkdown(
          client,
          { document: current, patch },
          { language, siteUrl: options.siteUrl }
        ).catch((error: unknown) => {
          console.error(`[ai-translate] ${id} is relinked with its agent Markdown as it was:`, error);

          return undefined;
        });
        const set = markdown ? { ...patch, "agentMarkdown.content": markdown } : patch;
        const mutations: Mutation[] = [
          ...(draft ? [] : [{ create: draftOf(published as TranslationDocument) }]),
          { patch: { id: draftId, ...(rev ? { ifRevisionID: rev } : {}), set } },
        ];
        const written = await client.mutate(mutations, { returnDocuments: true, visibility: "sync" });

        rev = revisionOf(written, draftId);

        // Made from the copy this pass read at its start: one published over or deleted since is never drafted from.
        if (!draft && !(await keepIfPublishedUnchanged(client, draftId, { rev, publishedRev }))) {
          result.conflicts.push(id);
          continue;
        }

        result.relinked.push(id);
      }

      if (publishable) {
        const outcome = await publishDraft(client, draftId, rev, publishedRev);

        if (outcome === "published") {
          result.published.push(id);
        } else if (outcome === "conflict") {
          if (!draft && (await discardOwnDraft(client, draftId, rev))) {
            result.relinked = result.relinked.filter((relinked) => relinked !== id);
          }

          result.conflicts.push(id);
        }
      }
    } catch (error) {
      if (isConflict(error)) {
        result.conflicts.push(id);
      } else {
        console.error(`[ai-translate] ${id} could not be relinked; the next pass tries again:`, error);
        result.failed = [...(result.failed ?? []), id];
      }
    }
  }

  return result;
}
