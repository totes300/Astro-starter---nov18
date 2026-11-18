import type { SanityClient } from "@sanity/client";
import { getPublishedId } from "@sanity/client/csm";
import { isConflict } from "~/features/agents/ai-ledger";
import { run } from "~/features/utils/common";
import { aiWriteState } from "~/sanity/ai-translation/plan";
import { PUBLISH_SKIP_REASONS, type PublishResult, type PublishSkipCode } from "~/sanity/ai-translation/wire";
import { I18N_DOCUMENT_TYPES, LOCALIZED_FIELDS } from "~/sanity/constants";
import { DEFAULT_LOCALE } from "~/sanity/i18n";
import type { TranslationDocument } from "~/sanity/translation-stub";
import { byPublishedId, readDocuments } from "./reads";
import { pastDeadline } from "./shared";

/** `conflict`: the draft is no longer at `rev`, or the published copy it was made from no longer at `publishedRev`. */
export async function publishDraft(
  client: SanityClient,
  draftId: string,
  rev?: string,
  publishedRev?: string
): Promise<"published" | "conflict" | "failed"> {
  try {
    await client.action({
      actionType: "sanity.action.document.publish",
      draftId,
      publishedId: getPublishedId(draftId),
      ...(rev ? { ifDraftRevisionId: rev } : {}),
      ...(publishedRev ? { ifPublishedRevisionId: publishedRev } : {}),
    });

    return "published";
  } catch (error) {
    console.error(`[ai-translate] ${getPublishedId(draftId)} was saved but not published:`, error);

    return isConflict(error) ? "conflict" : "failed";
  }
}

/** The Studio's own revision lock: unsetting a field no document has changes nothing but checks `ifRevisionID`. */
const REVISION_LOCK = "_revision_lock_pseudo_field_";

/** Deletes a draft this request made, only while it is still at `rev`: once anyone touched it, it is theirs. */
export async function discardOwnDraft(client: SanityClient, draftId: string, rev: string | undefined): Promise<boolean> {
  if (!rev) {
    return false;
  }

  try {
    await client.mutate([{ patch: { id: draftId, ifRevisionID: rev, unset: [REVISION_LOCK] } }, { delete: { id: draftId } }], {
      visibility: "sync",
    });

    return true;
  } catch (error) {
    if (!isConflict(error)) {
      console.error(`[ai-translate] ${draftId} was made from a stale copy and could not be discarded:`, error);
    }

    return false;
  }
}

/** A draft made from a published copy read earlier: kept while that copy is still at `publishedRev`, discarded if not. */
export async function keepIfPublishedUnchanged(
  client: SanityClient,
  draftId: string,
  { rev, publishedRev }: { rev?: string; publishedRev?: string }
): Promise<boolean> {
  const id = getPublishedId(draftId);
  const published = byPublishedId(await readDocuments(client, [id])).get(id)?.published;

  if (publishedRev !== undefined && published?._rev === publishedRev) {
    return true;
  }

  await discardOwnDraft(client, draftId, rev);

  return false;
}

/** Why `publish` leaves this draft alone, if it does. */
function publishProblem(draft: TranslationDocument, rev: string | undefined): PublishSkipCode | undefined {
  if (rev !== undefined && draft._rev !== rev) {
    return "changed_since";
  }

  // A category name's draft carries no record: only the revision a labels pass left proves it is that pass's.
  if (Object.hasOwn(LOCALIZED_FIELDS, draft._type)) {
    return rev === undefined ? "not_ai_translation" : undefined;
  }

  if (!I18N_DOCUMENT_TYPES.includes(draft._type) || draft.language === DEFAULT_LOCALE) {
    return "not_ai_translation";
  }

  const state = aiWriteState(draft);

  if (state === "none") {
    return "not_ai_translation";
  }

  return state === "edited" ? "edited_by_hand" : undefined;
}

/** Publishes AI drafts after review: a translation as the AI wrote it, or a draft still at a run's revision. */
export async function publishTranslations(
  client: SanityClient,
  ids: readonly string[],
  options: { revs?: Readonly<Record<string, string>>; deadline?: number } = {}
): Promise<PublishResult> {
  const copies = byPublishedId(await readDocuments(client, ids));
  const result: PublishResult = { published: [], skipped: [] };
  const skip = (id: string, code: PublishSkipCode) => {
    result.skipped.push({ id, reason: PUBLISH_SKIP_REASONS[code], code });
  };

  for (const id of ids) {
    const draft = copies.get(id)?.draft;
    const rev = options.revs?.[id];
    const problem = run(() => {
      if (pastDeadline(options.deadline)) {
        return "out_of_time";
      }
      if (draft) {
        return publishProblem(draft, rev);
      }
      return "no_draft";
    });

    if (problem || !draft) {
      skip(id, problem ?? "no_draft");
      continue;
    }

    const outcome = await publishDraft(client, draft._id, rev ?? (typeof draft._rev === "string" ? draft._rev : undefined));

    if (outcome === "published") {
      result.published.push(id);
    } else {
      skip(id, outcome === "conflict" ? "changed_since" : "publish_failed");
    }
  }

  return result;
}
