import type { SanityClient } from "@sanity/client";
import { AI_TRANSLATION_RESULT_TYPE, aiTranslationDocumentId } from "~/sanity/constants";

type Pair = { sourceId: string; language: string };

/** A call that ran this long and still timed out is too large for one request; a gateway's quick 504 is not. */
export const TOO_LARGE_AFTER_MS = 30_000;

function resultId({ sourceId, language }: Pair): string {
  return aiTranslationDocumentId(AI_TRANSLATION_RESULT_TYPE, sourceId, language);
}

/** Beside the pair's saved result, without its `sourceId` and `language` fields, so it is never listed as one. */
export function timeoutMarkerId({ sourceId, language }: Pair): string {
  return aiTranslationDocumentId(AI_TRANSLATION_RESULT_TYPE, sourceId, language, "timeout");
}

/** The source text the call timed out on: the plan holds the pair out of bulk until that text changes. */
export async function markTimeout(client: SanityClient, pair: Pair, sourceTextHash: string, now: Date): Promise<void> {
  await client.createOrReplace({
    _id: timeoutMarkerId(pair),
    _type: AI_TRANSLATION_RESULT_TYPE,
    timedOut: { sourceId: pair.sourceId, language: pair.language, sourceTextHash, at: now.toISOString() },
  });
}

/** Once the translation is written: its paid result, and any timeout marker, in one transaction. */
export async function deleteScratch(client: SanityClient, pair: Pair): Promise<void> {
  await client.mutate([{ delete: { id: resultId(pair) } }, { delete: { id: timeoutMarkerId(pair) } }]);
}
