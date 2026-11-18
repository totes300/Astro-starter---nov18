import assert from "node:assert/strict";
import { test } from "node:test";
import {
  consumePurgeBatch,
  enqueuePurge,
  PURGE_RETRY_SECONDS,
  PURGE_TAGS_PER_CALL,
  type PurgeOptions,
  purgeOptions,
  ROUTE_CACHE_ALL_TAG,
} from "./purge-queue";

function batch(bodies: unknown[]) {
  const outcome: { acked: boolean; retried?: number } = { acked: false };

  return {
    outcome,
    messages: bodies.map((body) => ({ body })),
    ackAll() {
      outcome.acked = true;
    },
    retryAll(options?: { delaySeconds?: number }) {
      outcome.retried = options?.delaySeconds;
    },
  };
}

test("a batch of publishes becomes one purge of their tags, deduped across case", () => {
  assert.deepEqual(purgeOptions([{ tags: ["page", "doc:about"] }, { tags: ["Page", "/about"] }]), {
    tags: ["page", "doc:about", "/about"],
  });
});

test("the purge-all tag, or more tags than one call takes, purges everything in one call", () => {
  const many = Array.from({ length: PURGE_TAGS_PER_CALL + 1 }, (_, index) => `doc:${index}`);

  assert.deepEqual(purgeOptions([{ tags: ["page"] }, { tags: [ROUTE_CACHE_ALL_TAG] }]), { purgeEverything: true });
  assert.deepEqual(purgeOptions([{ tags: many }]), { purgeEverything: true });
  assert.equal(purgeOptions([]), null);
});

test("a purge refused for the rate limit retries the whole batch later; a done one acks it", async () => {
  const calls: PurgeOptions[] = [];
  const refused = batch([{ tags: ["page"] }]);

  await consumePurgeBatch(refused, async (options) => {
    calls.push(options);

    return { success: false, errors: [{ code: 1, message: "rate limited" }] };
  });

  assert.deepEqual(refused.outcome, { acked: false, retried: PURGE_RETRY_SECONDS });

  const thrown = batch([{ tags: ["page"] }]);

  await consumePurgeBatch(thrown, async () => {
    throw new Error("binding down");
  });

  assert.equal(thrown.outcome.retried, PURGE_RETRY_SECONDS);

  const done = batch([{ tags: ["page"] }, { nonsense: true }]);

  await consumePurgeBatch(done, async (options) => {
    calls.push(options);

    return { success: true, errors: [] };
  });

  assert.equal(done.outcome.acked, true);
  assert.deepEqual(calls, [{ tags: ["page"] }, { tags: ["page"] }]);
});

test("a batch with nothing to purge is acked without a call", async () => {
  const empty = batch([{ tags: [] }, "not a message"]);

  await consumePurgeBatch(empty, async () => assert.fail("no purge call"));

  assert.equal(empty.outcome.acked, true);
});

test("enqueuePurge sends the tags encoded, and nothing for none", async () => {
  const sent: unknown[] = [];
  const queue = {
    async send(message: unknown) {
      sent.push(message);
    },
  };

  await enqueuePurge(queue, []);
  await enqueuePurge(queue, ["/über-uns", "page"]);

  assert.deepEqual(sent, [{ tags: ["/%C3%BCber-uns", "page"] }]);
});
