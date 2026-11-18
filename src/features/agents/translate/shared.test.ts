import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { retried } from "./shared";

function failing(statuses: (number | undefined)[]) {
  let calls = 0;

  return {
    write: async () => {
      const status = statuses[calls];

      calls += 1;

      if (calls <= statuses.length) {
        throw Object.assign(new Error("write failed"), status === undefined ? {} : { statusCode: status });
      }

      return "written";
    },
    calls: () => calls,
  };
}

describe("retried", () => {
  it("sends an idempotent write again after a throttle, a gateway failure or a dropped connection", async () => {
    for (const statuses of [[429], [503, undefined]]) {
      const write = failing(statuses);

      assert.equal(await retried(write.write, { delayMs: 1 }), "written");
      assert.equal(write.calls(), statuses.length + 1);
    }
  });

  it("never resends a conflict or a refusal, and gives up after its attempts", async () => {
    for (const status of [409, 400]) {
      const write = failing([status]);

      await assert.rejects(retried(write.write, { delayMs: 1 }), /write failed/);
      assert.equal(write.calls(), 1);
    }

    const down = failing([503, 503, 503, 503]);

    await assert.rejects(retried(down.write, { delayMs: 1 }), /write failed/);
    assert.equal(down.calls(), 3);
  });
});
