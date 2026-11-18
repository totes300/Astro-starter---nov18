// Purges go through a Queue because the Workers Cache allows 5 purge calls a minute (bucket of 25, 100 tags a call)
// on every plan: a batch of publishes becomes one call, and a rate-limited call is retried later.

import { encodeCacheTags } from "./cache-tags";

/** Any purge naming it empties the whole cache; every entry is tagged with it too. */
export const ROUTE_CACHE_ALL_TAG = "route-cache:all";

export const PURGE_TAGS_PER_CALL = 100;

/** A call refused for the rate limit waits for the bucket, which refills one call every 12 seconds. */
export const PURGE_RETRY_SECONDS = 30;

export type PurgeMessage = { tags: string[] };

export type PurgeOptions = { tags: string[] } | { purgeEverything: true };

export type PurgeResult = { success: boolean; errors: { code: number; message: string }[] };

export type PurgeQueue = { send(message: PurgeMessage): Promise<void> };

export type PurgeBatch = {
  readonly messages: readonly { readonly body: unknown }[];
  ackAll(): void;
  retryAll(options?: { delaySeconds?: number }): void;
};

export async function enqueuePurge(queue: PurgeQueue, tags: readonly string[]): Promise<void> {
  const encoded = encodeCacheTags(tags);

  if (encoded.length > 0) {
    await queue.send({ tags: encoded });
  }
}

function isPurgeMessage(body: unknown): body is PurgeMessage {
  return (
    typeof body === "object" &&
    body !== null &&
    Array.isArray((body as PurgeMessage).tags) &&
    (body as PurgeMessage).tags.every((tag) => typeof tag === "string")
  );
}

/** One call for the batch: its tags, or everything once they would need more than one call. */
export function purgeOptions(messages: readonly PurgeMessage[]): PurgeOptions | null {
  const tags = [...new Set(messages.flatMap((message) => message.tags.map((tag) => tag.toLowerCase())))];

  if (tags.length === 0) {
    return null;
  }

  if (tags.includes(ROUTE_CACHE_ALL_TAG) || tags.length > PURGE_TAGS_PER_CALL) {
    return { purgeEverything: true };
  }

  return { tags };
}

export async function consumePurgeBatch(
  batch: PurgeBatch,
  purge: (options: PurgeOptions) => Promise<PurgeResult>
): Promise<void> {
  const options = purgeOptions(batch.messages.map(({ body }) => body).filter(isPurgeMessage));

  if (!options) {
    batch.ackAll();

    return;
  }

  const result = await purge(options).catch(
    (error: unknown): PurgeResult => ({ success: false, errors: [{ code: 0, message: String(error) }] })
  );

  if (!result.success) {
    console.error("route-cache: purge failed, retrying", result.errors);
    batch.retryAll({ delaySeconds: PURGE_RETRY_SECONDS });

    return;
  }

  batch.ackAll();
}
