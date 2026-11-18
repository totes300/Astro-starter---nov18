import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it, mock } from "node:test";
import type { RequestHandler } from "@sanity/client";
import { AI_TRANSLATION_LEDGER_ID, ledgerDay, readCreditsToday } from "~/features/agents/ai-ledger";
import { altTextArms, DESCRIBE_RESERVE_MS, describeAsset, describeBacklog, type StoredAltText } from "~/features/agents/alt-text";
import { ASSET_ID, describingLake, imageAsset } from "~/features/agents/alt-text-fixtures";
import { FUNCTION_CAP_MS } from "~/lib/function-cap";
import { AI_TRANSLATION_LEDGER_TYPE } from "~/sanity/constants";
import { DEFAULT_LOCALE, IS_I18N_ENABLED, LOCALE_IDS } from "~/sanity/i18n";
import { agentActionOf } from "~/sanity/test-support/agent-actions";
import { createFakeContentLake } from "~/sanity/test-support/fake-content-lake";
import { altTextDailyLimit, DAILY_CAP_REASON, ledgerCredit } from "./alt-text-credit";

const LEDGER_ID = AI_TRANSLATION_LEDGER_ID;
const DEADLINE = FUNCTION_CAP_MS;

/** The route's options, its credit bound to a limit the test chooses. */
const options = (client: Parameters<typeof ledgerCredit>[0], clock: { now: number }, maxCreditsPerDay: number) => ({
  guidance: "",
  force: false,
  credit: ledgerCredit(client, async () => maxCreditsPerDay),
  deadline: DEADLINE,
  now: () => clock.now,
});

const spentToday = (lake: ReturnType<typeof createFakeContentLake>, used: number) =>
  lake.client.create({ _id: LEDGER_ID, _type: AI_TRANSLATION_LEDGER_TYPE, day: ledgerDay(), count: used });

describe("alt text and the daily AI request ledger", () => {
  it("reserves a credit per description in the ledger translations count, so today's credits include it", async () => {
    const { lake, clock, calls, client } = describingLake([imageAsset()]);

    await describeAsset(client, ASSET_ID, options(client, clock, 100));

    assert.equal(lake.get(LEDGER_ID)?.count, LOCALE_IDS.length);
    assert.equal((await readCreditsToday(lake.client, { maxCreditsPerDay: 100 })).used, LOCALE_IDS.length);
    assert.deepEqual(
      calls.map(({ timeout }) => timeout),
      LOCALE_IDS.map(() => DEADLINE - DESCRIBE_RESERVE_MS),
      "the time left, as without the ledger"
    );
  });

  it("starts no description at the day's limit, and says so", async () => {
    const { lake, clock, calls, client } = describingLake([imageAsset()]);

    await spentToday(lake, 3);

    const result = await describeAsset(client, ASSET_ID, options(client, clock, 3));

    assert.deepEqual(result, { _id: ASSET_ID, status: "failed", reason: DAILY_CAP_REASON, code: "daily_cap" });
    assert.equal(calls.length, 0);
    assert.equal(lake.get(LEDGER_ID)?.count, 3);
    assert.equal(lake.get(ASSET_ID)?.altText, undefined);
  });

  it("ends a backlog at the limit, keeping the languages it could pay for", { skip: !IS_I18N_ENABLED }, async () => {
    const SECOND_ASSET = "image-def456-10x10-jpg";
    const { lake, clock, calls, client } = describingLake([imageAsset(), imageAsset(SECOND_ASSET)]);

    await spentToday(lake, 2);

    const batch = await describeBacklog(client, [{ _id: ASSET_ID }, { _id: SECOND_ASSET }], {
      ...options(client, clock, 3),
      limit: 3,
    });

    assert.deepEqual(
      batch.results.map(({ _id, status, code }) => [_id, status, code]),
      [[ASSET_ID, "partial", "daily_cap"]]
    );
    assert.equal(calls.length, 1);
    assert.deepEqual(Object.keys(altTextArms(lake.get(ASSET_ID)?.altText as StoredAltText)), [DEFAULT_LOCALE]);
    assert.equal(lake.get(SECOND_ASSET)?.altText, undefined, "the next image waits for tomorrow");
  });

  it("gives the credit back when Sanity refused a description, and keeps it when the call may have run", async () => {
    const errors = mock.method(console, "error", () => {});

    try {
      for (const [failure, kept] of [
        [Object.assign(new Error("Rate limit exceeded"), { statusCode: 429 }), 0],
        [Object.assign(new Error("The operation timed out"), { name: "TimeoutError" }), LOCALE_IDS.length],
      ] as const) {
        const lake = createFakeContentLake({ documents: [imageAsset()] });
        const inner = lake.client.config().requestHandler as RequestHandler;
        const refusing: RequestHandler = (request, next) =>
          agentActionOf(request.url) === "transform" ? Promise.reject(failure) : inner(request, next);
        const client = lake.client.withConfig({ requestHandler: refusing });
        const result = await describeAsset(client, ASSET_ID, options(client, { now: 0 }, 100));

        assert.equal(result.status, "failed", failure.message);
        assert.equal(lake.get(LEDGER_ID)?.count, kept, failure.message);
      }
    } finally {
      errors.mock.restore();
    }
  });

  it("reads the limit once per request, on the first description", async () => {
    const { clock, client } = describingLake([imageAsset()]);
    let reads = 0;

    await describeAsset(client, ASSET_ID, {
      ...options(client, clock, 100),
      credit: ledgerCredit(client, async () => {
        reads += 1;

        return 100;
      }),
    });

    assert.equal(reads, 1);
  });

  it("caps descriptions at Settings' daily limit only where an editor can set it", async () => {
    const lake = createFakeContentLake({
      documents: [{ _id: "siteSettings", _type: "siteSettings", translations: { defaults: { maxCreditsPerDay: 7 } } }],
    });

    assert.equal(await altTextDailyLimit(lake.client), IS_I18N_ENABLED ? 7 : Number.POSITIVE_INFINITY);
  });

  it("is how the alt text route pays for every description, on the upload path and the backfill alike", () => {
    const route = readFileSync(new URL("../../../pages/api/agents/image-alt-text.ts", import.meta.url), "utf8");
    const calls = [...route.matchAll(/\b(describeAsset|describeBacklog)\(sanityEditClient, [^{]*\{([^}]*)\}/g)];

    assert.deepEqual(calls.map(([, name]) => name).sort(), ["describeAsset", "describeBacklog"]);

    for (const [, name, options] of calls) {
      assert.match(options ?? "", /\bcredit: ledgerCredit\(sanityEditClient\)/, `${name} bills outside the daily ledger`);
    }
  });
});
