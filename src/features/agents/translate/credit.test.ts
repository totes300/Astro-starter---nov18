import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import type { RequestHandler } from "@sanity/client";
import { AI_TRANSLATION_LEDGER_ID } from "~/features/agents/ai-ledger";
import { AI_TRANSLATION_LEDGER_TYPE } from "~/sanity/constants";
import { createFakeContentLake } from "~/sanity/test-support/fake-content-lake";
import { MIN_AGENT_CALL_MS, spendOneCredit } from "./credit";
import { WRITE_RESERVE_MS } from "./shared";

const NOW = new Date("2026-10-20T10:00:00.000Z");
const DAY = "2026-10-20";
const LEDGER_ID = AI_TRANSLATION_LEDGER_ID;
const OPTIONS = { maxCreditsPerDay: 3, label: "test" };

type Lake = ReturnType<typeof createFakeContentLake>;

function lakeWith(count?: number): Lake {
  return createFakeContentLake({
    documents: count === undefined ? [] : [{ _id: LEDGER_ID, _type: AI_TRANSLATION_LEDGER_TYPE, day: DAY, count }],
  });
}

// The call never reaches Sanity AI: each test answers it here, and the lake's tripwire stops anything else.
function deps(lake: Lake, deadline?: number) {
  return { client: lake.client, agentClient: lake.client, now: () => NOW, ...(deadline === undefined ? {} : { deadline }) };
}

function sanityError(fields: Record<string, unknown>): Error {
  return Object.assign(new Error(String(fields.message ?? "Sanity AI failed")), fields);
}

describe("spendOneCredit", () => {
  it("reserves the credit before the call, keeps it once the call answers, and gives the call what time is left", async () => {
    const lake = lakeWith();
    const left = 40_000;
    let countDuringCall: unknown;
    let timeout: unknown;
    const spend = await spendOneCredit(deps(lake, Date.now() + left), OPTIONS, async (agent) => {
      countDuringCall = lake.get(LEDGER_ID)?.count;
      timeout = agent.config().timeout;

      return "answer";
    });

    assert.deepEqual(spend, { ok: true, value: "answer", credits: { day: DAY, used: 1, max: 3 } });
    assert.equal(countDuringCall, 1, "reserved before the call");
    assert.equal(lake.get(LEDGER_ID)?.count, 1);
    assert.ok(Number(timeout) <= left - WRITE_RESERVE_MS, `the call got ${timeout} ms`);
    assert.ok(Number(timeout) > left - WRITE_RESERVE_MS - 5_000, `the call got ${timeout} ms`);
  });

  it("gives the credit back when Sanity refused the call, and keeps it when the call may have run", async () => {
    const errors = mock.method(console, "error", () => {});

    try {
      const limited = lakeWith();
      const refused = await spendOneCredit(deps(limited), OPTIONS, () =>
        Promise.reject(sanityError({ message: "Rate limit exceeded. Please try again in 60 seconds", statusCode: 429 }))
      );

      assert.ok(!refused.ok && refused.reason === "agent_error", JSON.stringify(refused));
      assert.equal(refused.error.code, "rate_limited");
      assert.equal(refused.error.creditMayBeSpent, false);
      assert.deepEqual(refused.credits, { day: DAY, used: 0, max: 3 }, "today's count no longer holds the refunded credit");
      assert.equal(limited.get(LEDGER_ID)?.count, 0, "refunded");

      const slow = lakeWith();
      const timedOut = await spendOneCredit(deps(slow), OPTIONS, () => Promise.reject(sanityError({ name: "TimeoutError" })));

      assert.ok(!timedOut.ok && timedOut.reason === "agent_error", JSON.stringify(timedOut));
      assert.equal(timedOut.error.code, "timeout");
      assert.equal(timedOut.error.creditMayBeSpent, true);
      assert.deepEqual(timedOut.credits, { day: DAY, used: 1, max: 3 });
      assert.equal(slow.get(LEDGER_ID)?.count, 1, "kept: Sanity may still bill it");
    } finally {
      errors.mock.restore();
    }
  });

  it("never calls at the daily cap", async () => {
    const lake = lakeWith(3);
    let called = false;
    const spend = await spendOneCredit(deps(lake), OPTIONS, async () => {
      called = true;
    });

    assert.deepEqual(spend, { ok: false, reason: "daily_cap", credits: { day: DAY, used: 3, max: 3 } });
    assert.equal(called, false);
    assert.equal(lake.get(LEDGER_ID)?.count, 3);
  });

  it("reserves nothing when the request is too short for the call", async () => {
    const lake = lakeWith();
    let called = false;
    const spend = await spendOneCredit(
      deps(lake, Date.now() + WRITE_RESERVE_MS + MIN_AGENT_CALL_MS - 1_000),
      OPTIONS,
      async () => {
        called = true;
      }
    );

    assert.deepEqual(spend, { ok: false, reason: "out_of_time" });
    assert.equal(called, false);
    assert.equal(lake.get(LEDGER_ID), undefined);
  });

  it("gives the credit back when the ledger took the time the call needed", async () => {
    mock.timers.enable({ apis: ["Date"], now: Date.now() });

    try {
      const lake = lakeWith();
      const slowLedger = lake.client.withConfig({
        requestHandler: (request, next) => {
          const mutations = (request.body as { mutations?: Record<string, { _id?: string }>[] } | undefined)?.mutations ?? [];

          if (mutations.some(({ create }) => create?._id === LEDGER_ID)) {
            mock.timers.tick(1_000);
          }

          return (lake.client.config().requestHandler as RequestHandler)(request, next);
        },
      });
      let called = false;
      const spend = await spendOneCredit(
        { ...deps(lake, Date.now() + WRITE_RESERVE_MS + MIN_AGENT_CALL_MS + 500), client: slowLedger },
        OPTIONS,
        async () => {
          called = true;
        }
      );

      assert.deepEqual(spend, { ok: false, reason: "out_of_time", credits: { day: DAY, used: 0, max: 3 } });
      assert.equal(called, false);
      assert.equal(lake.get(LEDGER_ID)?.count, 0, "refunded");
    } finally {
      mock.timers.reset();
    }
  });

  it("takes a caller's own budget and minimum, as alt text keeps a longer reserve", async () => {
    const budgets = [20_000, 14_000];
    const short = await spendOneCredit(deps(lakeWith()), { ...OPTIONS, budget: () => 14_000, minCallMs: 15_000 }, async () => {
      throw new Error("never called");
    });
    const lake = lakeWith();
    const late = await spendOneCredit(
      deps(lake),
      { ...OPTIONS, budget: () => budgets.shift() ?? 0, minCallMs: 15_000 },
      async () => "answer"
    );
    let timeout: unknown;
    const spend = await spendOneCredit(
      deps(lakeWith()),
      { ...OPTIONS, budget: () => 20_000, minCallMs: 15_000 },
      async (agent) => {
        timeout = agent.config().timeout;
      }
    );

    assert.deepEqual(short, { ok: false, reason: "out_of_time" });
    assert.ok(!late.ok && late.reason === "out_of_time", JSON.stringify(late));
    assert.equal(lake.get(LEDGER_ID)?.count, 0, "refunded once the ledger left less than the minimum");
    assert.ok(spend.ok);
    assert.equal(timeout, 20_000);
  });
});

describe("spendOneCredit, around the call", () => {
  it("says when the billed call starts, never for a call it refused before, so a later failure is known free", async () => {
    const started: string[] = [];
    const track = (lake: Lake) => ({ ...deps(lake), onBilledCall: () => started.push("call") });

    await spendOneCredit(track(lakeWith(3)), OPTIONS, async () => "never");

    assert.equal(started.length, 0, "nothing starts at the daily cap");

    await spendOneCredit(track(lakeWith()), OPTIONS, async () => {
      started.push("answered");
    });

    assert.deepEqual(started, ["call", "answered"]);
  });

  it("logs the failed call's status and Sanity's own words, never only its code", async () => {
    const errors = mock.method(console, "error", () => {});

    try {
      await spendOneCredit(deps(lakeWith()), { ...OPTIONS, label: "about -> it" }, () =>
        Promise.reject(
          sanityError({ statusCode: 400, responseBody: JSON.stringify({ error: { description: "Document is too large" } }) })
        )
      );

      assert.equal(
        errors.mock.calls[0]?.arguments[0],
        "[ai-translate] about -> it: invalid_request (status 400): Sanity AI failed Document is too large"
      );
    } finally {
      errors.mock.restore();
    }
  });
});
