// The run queue over a fake transport and a fake clock: nothing reaches a route, and no real time passes.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ApiFailure, ApiResult } from "./api";
import type { RunStep, TranslationPlan } from "./plan";
import {
  BUSY_RETRY_MS,
  createRunStore,
  documentRunJobs,
  guardUnload,
  type JobInput,
  jobCredits,
  labelsNote,
  pairJob,
  RATE_LIMIT_STOP_AFTER,
  RUN_MESSAGES,
  RUN_STEPS,
  type RunTransport,
  rateLimitStop,
  runTotals,
  STOP_CODES,
  siteRunJobs,
  sourceProgress,
  UPDATE_LINKS,
} from "./run-store";
import type { LabelsInput, LabelsResult, PairInput, PairResult, RelinkResult } from "./wire";

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Timers wait until the test fires them, so a pause can be watched before it ends. */
function fakeClock() {
  let time = 1_000_000;
  const timers: { at: number; resolve: () => void }[] = [];
  const sleeps: number[] = [];

  async function next(): Promise<boolean> {
    // Let the work in flight queue its timers first.
    await settle();
    timers.sort((a, b) => a.at - b.at);

    const timer = timers.shift();

    if (!timer) {
      return false;
    }

    time = Math.max(time, timer.at);
    timer.resolve();
    await settle();

    return true;
  }

  return {
    now: () => time,
    sleep: (ms: number) =>
      new Promise<void>((resolve) => {
        sleeps.push(ms);
        timers.push({ at: time + ms, resolve });
      }),
    sleeps,
    next,
    async runAll() {
      while (await next()) {
        // Each timer may queue the next one.
      }
    },
  };
}

type Answer = ApiResult<unknown>;
type Call = { kind: "translate" | "labels" | "relink"; label: string; input: unknown };

function labelOf(kind: Call["kind"], input: unknown): string {
  if (kind === "translate") {
    const { sourceId, language } = input as PairInput;

    return `${sourceId}.${language}`;
  }

  return kind;
}

/** Each call waits for `answer` (the test's script, told how many times this label was sent) or for the test to resolve it. */
function fakeTransport(answer?: (call: Call, count: number) => Answer | Promise<Answer>) {
  const calls: Call[] = [];
  const pending: (Call & { resolve: (answer: Answer) => void })[] = [];
  let inFlight = 0;
  let maxInFlight = 0;

  const send =
    (kind: Call["kind"]) =>
    async (input: unknown): Promise<Answer> => {
      const call = { kind, label: labelOf(kind, input), input };

      calls.push(call);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);

      try {
        if (answer) {
          return await answer(call, calls.filter(({ label }) => label === call.label).length);
        }

        return await new Promise<Answer>((resolve) => pending.push({ ...call, resolve }));
      } finally {
        inFlight -= 1;
      }
    };

  return {
    transport: {
      translate: send("translate"),
      labels: send("labels"),
      relink: send("relink"),
    } as unknown as RunTransport,
    calls,
    started: () => calls.map(({ label }) => label),
    waiting: () => pending.map(({ label }) => label),
    get maxInFlight() {
      return maxInFlight;
    },
    async resolve(label: string, value: Answer) {
      const index = pending.findIndex((call) => call.label === label);

      assert.ok(index >= 0, `${label} is not waiting for an answer`);

      const [call] = pending.splice(index, 1);

      call?.resolve(value);
      await settle();
    },
  };
}

function pairResult(input: unknown, extra: Partial<PairResult> = {}): ApiResult<PairResult> {
  const { sourceId, language } = input as PairInput;

  return {
    ok: true,
    data: {
      status: "translated",
      sourceId,
      language,
      creditSpent: true,
      durationMs: 1,
      ...extra,
    },
  };
}

function labelsResult(extra: Partial<LabelsResult> = {}): ApiResult<LabelsResult> {
  return {
    ok: true,
    data: {
      status: "translated",
      creditSpent: true,
      languages: ["it"],
      remaining: 0,
      durationMs: 1,
      ...extra,
    },
  };
}

function failure(code: string, extra: Partial<ApiFailure> = {}): Answer {
  return {
    ok: false,
    error: { code, message: `Message for ${code}.`, status: 409, creditSpent: false, creditMayBeSpent: false, ...extra },
  };
}

/** Every pair translated for 1 credit; labels and relink answer as done. */
function happy(call: Call): Answer {
  switch (call.kind) {
    case "translate":
      return pairResult(call.input);
    case "labels":
      return labelsResult();
    case "relink":
      return { ok: true, data: { relinked: [], published: [], conflicts: [], remaining: 0 } satisfies RelinkResult };
  }
}

function pair(sourceId: string, language = "it", step: RunStep = "page"): JobInput {
  return {
    kind: "pair",
    step,
    title: sourceId,
    input: { sourceId, language, version: "published", overwrite: false, instructions: "" },
  };
}

const labels = (ids: string[] = ["category-a"]): JobInput => ({ kind: "labels", input: { ids, publish: false } });

const RUN = { scope: { kind: "site" } as const, publish: false, maxCredits: 25 };

function stateOf(store: ReturnType<typeof createRunStore>) {
  return Object.fromEntries((store.getSnapshot()?.jobs ?? []).map((job) => [job.title, job.state]));
}

describe("the run order", () => {
  it("runs the label batches first, then each step only after every earlier one finished", async () => {
    const clock = fakeClock();
    const store = createRunStore(clock);
    const fake = fakeTransport();
    const started = store.start(
      { ...RUN, jobs: [pair("page-a"), pair("page-b"), pair("ada", "it", "person"), labels(), pair("site", "it", "site")] },
      fake.transport
    );

    assert.ok(started.ok);
    await settle();
    assert.deepEqual(fake.waiting(), ["labels"], "labels alone, though two could run");

    await fake.resolve("labels", labelsResult());
    assert.deepEqual(fake.waiting(), ["ada.it"]);

    await fake.resolve("ada.it", pairResult({ sourceId: "ada", language: "it" }));
    assert.deepEqual(fake.waiting(), ["page-a.it", "page-b.it"], "one step runs two at a time");

    await fake.resolve("page-b.it", pairResult({ sourceId: "page-b", language: "it" }));
    assert.deepEqual(fake.waiting(), ["page-a.it"], "the Site waits for the whole page step");

    await fake.resolve("page-a.it", pairResult({ sourceId: "page-a", language: "it" }));
    await fake.resolve("site.it", pairResult({ sourceId: "site", language: "it" }));

    const run = await started.finished;

    assert.deepEqual(fake.started(), ["labels", "ada.it", "page-a.it", "page-b.it", "site.it"]);
    assert.equal(run.status, "done");
    assert.deepEqual(
      run.jobs.map(({ step }) => step),
      ["labels", "person", "page", "page", "site"]
    );
  });

  it("never has two languages of one source in flight", async () => {
    const store = createRunStore(fakeClock());
    const fake = fakeTransport();
    const started = store.start(
      { ...RUN, jobs: [pair("about", "it"), pair("about", "de"), pair("contact", "it")] },
      fake.transport
    );

    assert.ok(started.ok);
    await settle();
    assert.deepEqual(fake.waiting(), ["about.it", "contact.it"]);

    await fake.resolve("about.it", pairResult({ sourceId: "about", language: "it" }));
    assert.deepEqual(fake.waiting(), ["contact.it", "about.de"]);

    await fake.resolve("about.de", pairResult({ sourceId: "about", language: "de" }));
    await fake.resolve("contact.it", pairResult({ sourceId: "contact", language: "it" }));
    assert.equal((await started.finished).status, "done");
  });

  it("runs at most two at once", async () => {
    const store = createRunStore(fakeClock());
    const fake = fakeTransport();
    const started = store.start({ ...RUN, jobs: ["a", "b", "c", "d"].map((id) => pair(id)) }, fake.transport);

    assert.ok(started.ok);
    await settle();
    assert.deepEqual(fake.waiting(), ["a.it", "b.it"]);

    await fake.resolve("a.it", pairResult({ sourceId: "a", language: "it" }));
    assert.deepEqual(fake.waiting(), ["b.it", "c.it"]);

    await fake.resolve("b.it", pairResult({ sourceId: "b", language: "it" }));
    await fake.resolve("c.it", pairResult({ sourceId: "c", language: "it" }));
    await fake.resolve("d.it", pairResult({ sourceId: "d", language: "it" }));
    await started.finished;
    assert.equal(fake.maxInFlight, 2);
  });
});

describe("credits", () => {
  it("stops before the run's cap, counting the pairs in flight", async () => {
    const store = createRunStore(fakeClock());
    const fake = fakeTransport();
    const started = store.start({ ...RUN, maxCredits: 2, jobs: ["a", "b", "c", "d"].map((id) => pair(id)) }, fake.transport);

    assert.ok(started.ok);
    await settle();
    assert.deepEqual(fake.waiting(), ["a.it", "b.it"]);

    await fake.resolve("a.it", pairResult({ sourceId: "a", language: "it" }));
    assert.deepEqual(fake.waiting(), ["b.it"], "a third would pass the cap if the second bills");

    await fake.resolve("b.it", pairResult({ sourceId: "b", language: "it" }));

    const run = await started.finished;

    assert.equal(run.status, "stopped");
    assert.equal(run.stopReason?.code, "credit_cap");
    assert.match(run.stopReason?.message ?? "", /limit of 2 AI requests/);
    assert.deepEqual(stateOf(store), { a: "done", b: "done", c: "stopped", d: "stopped" });
    assert.equal(fake.calls.length, 2);
    assert.equal(runTotals(run).creditsUsed, 2);
  });

  it("lets the next pair run when one comes back free", async () => {
    const store = createRunStore(fakeClock());
    const fake = fakeTransport((call) =>
      call.label === "a.it" ? pairResult(call.input, { status: "skipped", creditSpent: false }) : happy(call)
    );
    const started = store.start({ ...RUN, maxCredits: 2, jobs: ["a", "b", "c", "d"].map((id) => pair(id)) }, fake.transport);

    assert.ok(started.ok);

    const run = await started.finished;

    assert.deepEqual(stateOf(store), { a: "skipped", b: "done", c: "done", d: "stopped" });
    assert.equal(run.stopReason?.code, "credit_cap");
  });

  it("counts a timed-out call against the cap, since it may have billed", async () => {
    const store = createRunStore(fakeClock());
    const fake = fakeTransport((call) =>
      call.label === "a.it" ? failure("timeout", { status: 504, creditMayBeSpent: true }) : happy(call)
    );
    const started = store.start({ ...RUN, maxCredits: 1, jobs: [pair("a"), pair("b")] }, fake.transport);

    assert.ok(started.ok);

    const run = await started.finished;
    const totals = runTotals(run);

    assert.deepEqual(stateOf(store), { a: "failed", b: "stopped" });
    assert.equal(fake.calls.length, 1, "a timeout is never retried");
    assert.deepEqual([totals.creditsSpent, totals.creditsMaybeSpent, totals.creditsUsed], [0, 1, 1]);
  });

  it("ends only the paid jobs at the cap: the relink after them still runs, and the next run picks up the rest", async () => {
    const store = createRunStore(fakeClock());
    const fake = fakeTransport(happy);
    const started = store.start(
      {
        ...RUN,
        publish: true,
        maxCredits: 2,
        jobs: [...["a", "b", "c"].map((id) => pair(id)), { kind: "relink", input: { publish: true } }],
      },
      fake.transport
    );

    assert.ok(started.ok);

    const run = await started.finished;

    assert.deepEqual(fake.started(), ["a.it", "b.it", "relink"]);
    assert.equal(run.status, "stopped");
    assert.equal(run.stopReason?.code, "credit_cap");
    assert.equal(
      run.stopReason?.message,
      "Stopped at this run's limit of 2 AI requests. Translate the site again to continue: the next run picks up what is left."
    );
    assert.equal(run.jobs.find((job) => job.kind === "relink")?.state, "done");
    assert.equal(pairJob(run, "c", "it")?.state, "stopped");
  });

  it("asks a draft run stopped at the cap to publish its drafts before the next run replaces it", async () => {
    const store = createRunStore(fakeClock());
    const started = store.start({ ...RUN, maxCredits: 1, jobs: [pair("a"), pair("b")] }, fakeTransport(happy).transport);

    assert.ok(started.ok);
    assert.equal(
      (await started.finished).stopReason?.message,
      "Stopped at this run's limit of 1 AI request. Publish this run's drafts, then translate the site again to continue: the next run picks up what is left."
    );
  });

  it("keeps the cap as the reason when the editor stops the relink that follows it", async () => {
    const store = createRunStore(fakeClock());
    const fake = fakeTransport((call) => (call.kind === "relink" ? new Promise<Answer>(() => undefined) : happy(call)));
    const started = store.start(
      { ...RUN, maxCredits: 1, jobs: [pair("a"), pair("b"), { kind: "relink", input: { publish: true } }] },
      fake.transport
    );

    assert.ok(started.ok);
    await settle();
    await settle();
    assert.deepEqual(fake.started(), ["a.it", "relink"]);

    store.stop();

    assert.equal(store.getSnapshot()?.status, "stopping");
    assert.equal(store.getSnapshot()?.stopReason?.code, "credit_cap");
  });

  it("counts one AI request per pair and per label batch", () => {
    assert.equal(jobCredits([pair("a"), labels(), { kind: "relink" }]), 2);
  });
});

describe("stopping", () => {
  it("stops after the ones running: nothing queued starts, the running ones finish and keep what they paid for", async () => {
    const store = createRunStore(fakeClock());
    const fake = fakeTransport();
    const started = store.start({ ...RUN, jobs: ["a", "b", "c", "d"].map((id) => pair(id)) }, fake.transport);

    assert.ok(started.ok);
    await settle();
    store.stop();

    assert.equal(store.getSnapshot()?.status, "stopping");
    assert.deepEqual(stateOf(store), { a: "running", b: "running", c: "stopped", d: "stopped" });

    await fake.resolve("a.it", pairResult({ sourceId: "a", language: "it" }));
    await fake.resolve("b.it", pairResult({ sourceId: "b", language: "it" }, { status: "saved_result", code: "conflict" }));

    const run = await started.finished;

    assert.equal(run.status, "stopped");
    assert.equal(run.stopReason?.code, "stopped");
    assert.deepEqual(stateOf(store), { a: "done", b: "saved_result", c: "stopped", d: "stopped" });
    assert.equal(fake.calls.length, 2);
  });

  it("stops the queue at once on a spent budget, and lets the pair in flight finish", async () => {
    const store = createRunStore(fakeClock());
    const fake = fakeTransport();
    const started = store.start({ ...RUN, jobs: ["a", "b", "c", "d"].map((id) => pair(id)) }, fake.transport);

    assert.ok(started.ok);
    await settle();
    await fake.resolve("a.it", failure("budget_exceeded", { status: 429, usage: { usageValue: 1000, quota: 1000 } }));

    assert.equal(store.getSnapshot()?.status, "stopping");
    assert.deepEqual(stateOf(store), { a: "failed", b: "running", c: "stopped", d: "stopped" });

    await fake.resolve("b.it", pairResult({ sourceId: "b", language: "it" }));

    const run = await started.finished;

    assert.equal(run.status, "stopped");
    assert.deepEqual(run.stopReason, {
      code: "budget_exceeded",
      message: "Message for budget_exceeded.",
      usage: { usageValue: 1000, quota: 1000 },
    });
    assert.equal(fake.calls.length, 2);
  });

  it("names a stop code that answers after Stop, so the summary and Try again follow it", async () => {
    const store = createRunStore(fakeClock());
    const fake = fakeTransport();
    const started = store.start({ ...RUN, jobs: ["a", "b", "c"].map((id) => pair(id)) }, fake.transport);

    assert.ok(started.ok);
    await settle();
    store.stop();
    await fake.resolve("a.it", failure("budget_exceeded", { status: 429 }));
    await fake.resolve("b.it", pairResult({ sourceId: "b", language: "it" }));

    const run = await started.finished;

    assert.equal(run.status, "stopped");
    assert.equal(run.stopReason?.code, "budget_exceeded");
    assert.deepEqual(stateOf(store), { a: "failed", b: "done", c: "stopped" });
  });

  it("stops on every code that would refuse each later request the same way", async () => {
    for (const code of STOP_CODES) {
      const store = createRunStore({ ...fakeClock(), concurrency: 1 });
      const fake = fakeTransport((call) => (call.label === "a.it" ? failure(code) : happy(call)));
      const started = store.start({ ...RUN, jobs: [pair("a"), pair("b")] }, fake.transport);

      assert.ok(started.ok);

      const run = await started.finished;

      assert.equal(run.stopReason?.code, code, code);
      assert.deepEqual(stateOf(store), { a: "failed", b: "stopped" }, code);
    }

    assert.ok(STOP_CODES.has("off"), "the switch in Settings refuses every request");
  });
});

describe("retries", () => {
  it("waits out a rate limit once, with every worker paused, then carries on", async () => {
    const clock = fakeClock();
    const store = createRunStore(clock);
    const fake = fakeTransport();
    const started = store.start({ ...RUN, jobs: [pair("a"), pair("b"), pair("c")] }, fake.transport);

    assert.ok(started.ok);
    await settle();
    await fake.resolve("a.it", failure("rate_limited", { status: 429, retryAfterSeconds: 48 }));

    assert.deepEqual(fake.waiting(), ["b.it"], "nothing new starts during the pause");
    assert.equal(store.getSnapshot()?.pausedUntil, clock.now() + 48_000);

    await fake.resolve("b.it", pairResult({ sourceId: "b", language: "it" }));
    assert.deepEqual(fake.waiting(), [], "still paused after a pair finished");

    await clock.next();
    assert.deepEqual(fake.waiting(), ["a.it", "c.it"]);
    assert.deepEqual(clock.sleeps, [48_000]);

    await fake.resolve("a.it", pairResult({ sourceId: "a", language: "it" }));
    await fake.resolve("c.it", pairResult({ sourceId: "c", language: "it" }));

    const run = await started.finished;

    assert.equal(run.status, "done");
    assert.equal(pairJob(run, "a", "it")?.attempts, 2);
    assert.equal(pairJob(run, "a", "it")?.creditMayBeSpent, true);
  });

  it("stops the run when the rate limit holds for three answers in a row, instead of failing each job", async () => {
    const clock = fakeClock();
    const store = createRunStore({ ...clock, concurrency: 1 });
    const fake = fakeTransport((call) => (call.kind === "translate" ? failure("rate_limited", { status: 429 }) : happy(call)));
    const started = store.start({ ...RUN, jobs: [pair("a"), pair("b"), pair("c")] }, fake.transport);

    assert.ok(started.ok);
    await clock.runAll();

    const run = await started.finished;

    assert.equal(RATE_LIMIT_STOP_AFTER, 3);
    assert.deepEqual(fake.started(), ["a.it", "a.it", "a.it"], "nothing else is sent into a lasting limit");
    assert.deepEqual(stateOf(store), { a: "stopped", b: "stopped", c: "stopped" }, "left for Try again, none failed");
    assert.equal(run.status, "stopped");
    assert.deepEqual(run.stopReason, rateLimitStop());
    assert.match(run.stopReason?.message ?? "", /rate limit/);
    assert.equal(runTotals(run).creditsUsed, 0);
    assert.equal(STOP_CODES.has("rate_limited"), false, "Try again stays on offer");
  });

  it("asks a rate limited pair again after each pause while the limit lets an answer through", async () => {
    const clock = fakeClock();
    const store = createRunStore({ ...clock, concurrency: 1 });
    const limitedFirst = new Set(["a.it", "b.it", "c.it"]);
    const fake = fakeTransport((call, count) =>
      limitedFirst.has(call.label) && count <= 2 ? failure("rate_limited", { status: 429, retryAfterSeconds: 5 }) : happy(call)
    );
    const started = store.start({ ...RUN, jobs: [pair("a"), pair("b"), pair("c")] }, fake.transport);

    assert.ok(started.ok);
    await clock.runAll();

    const run = await started.finished;

    assert.deepEqual(fake.started(), ["a.it", "a.it", "a.it", "b.it", "b.it", "b.it", "c.it", "c.it", "c.it"]);
    assert.deepEqual(stateOf(store), { a: "done", b: "done", c: "done" });
    assert.equal(run.status, "done");
  });

  it("asks a busy pair once more after 5 s, then reports it", async () => {
    const clock = fakeClock();
    const store = createRunStore(clock);
    const busy = (input: unknown) => pairResult(input, { status: "busy", code: "busy", message: "Busy.", creditSpent: false });
    const fake = fakeTransport((call, count) => (call.label === "a.it" && count === 1 ? busy(call.input) : happy(call)));
    const started = store.start({ ...RUN, jobs: [pair("a")] }, fake.transport);

    assert.ok(started.ok);
    await clock.runAll();

    const run = await started.finished;

    assert.deepEqual(clock.sleeps, [BUSY_RETRY_MS]);
    assert.equal(pairJob(run, "a", "it")?.state, "done");
    assert.equal(pairJob(run, "a", "it")?.code, undefined);

    const twice = createRunStore(clock);
    const alwaysBusy = fakeTransport((call) => busy(call.input));
    const again = twice.start({ ...RUN, jobs: [pair("a")] }, alwaysBusy.transport);

    assert.ok(again.ok);
    await clock.runAll();
    assert.deepEqual(stateOf(twice), { a: "failed" });
    assert.equal(pairJob(await again.finished, "a", "it")?.code, "busy");
    assert.equal(alwaysBusy.calls.length, 2);
  });

  it("asks once more after 5 s when Sanity did not answer before the AI call, which spent nothing", async () => {
    const clock = fakeClock();
    const store = createRunStore(clock);
    const unavailable = () => failure("sanity_unavailable", { status: 503 });
    const fake = fakeTransport((call, count) => (call.label === "a.it" && count === 1 ? unavailable() : happy(call)));
    const started = store.start({ ...RUN, jobs: [pair("a")] }, fake.transport);

    assert.ok(started.ok);
    await clock.runAll();

    const run = await started.finished;

    assert.deepEqual(clock.sleeps, [BUSY_RETRY_MS]);
    assert.equal(pairJob(run, "a", "it")?.state, "done");
    assert.equal(fake.calls.length, 2);

    const twice = createRunStore(clock);
    const down = fakeTransport(() => unavailable());
    const again = twice.start({ ...RUN, jobs: [pair("a")] }, down.transport);

    assert.ok(again.ok);
    await clock.runAll();

    const failedRun = await again.finished;

    assert.deepEqual(stateOf(twice), { a: "failed" });
    assert.equal(down.calls.length, 2);
    assert.equal(runTotals(failedRun).creditsUsed, 0, "a free failure never counts against the run's limit");
  });

  it("asks again at once, once, when the route had too little time left for the AI call", async () => {
    const clock = fakeClock();
    const store = createRunStore(clock);
    const short = (input: unknown) =>
      pairResult(input, { status: "busy", code: "out_of_time", message: "Short of time.", creditSpent: false });
    const fake = fakeTransport((call, count) => (call.label === "a.it" && count === 1 ? short(call.input) : happy(call)));
    const started = store.start({ ...RUN, jobs: [pair("a")] }, fake.transport);

    assert.ok(started.ok);
    await clock.runAll();

    const run = await started.finished;

    assert.deepEqual(clock.sleeps, [], "a fresh request has the whole time cap, so it goes at once");
    assert.equal(pairJob(run, "a", "it")?.state, "done");
    assert.equal(pairJob(run, "a", "it")?.attempts, 2);

    const twice = createRunStore(clock);
    const alwaysShort = fakeTransport((call) => short(call.input));
    const again = twice.start({ ...RUN, jobs: [pair("a"), labels()] }, alwaysShort.transport);

    assert.ok(again.ok);
    await clock.runAll();

    const failedRun = await again.finished;

    assert.equal(pairJob(failedRun, "a", "it")?.state, "failed");
    assert.equal(pairJob(failedRun, "a", "it")?.code, "out_of_time");
    assert.equal(pairJob(failedRun, "a", "it")?.creditMayBeSpent, false);
    assert.deepEqual(alwaysShort.started(), ["labels", "labels", "a.it", "a.it"]);
  });

  it("keeps the names and drafts a labels batch wrote before an answer it retried", async () => {
    const clock = fakeClock();
    const store = createRunStore(clock);
    // The first attempt wrote a saved answer's names, then the AI call was rate limited.
    const first = labelsResult({
      status: "failed",
      code: "rate_limited",
      creditSpent: false,
      written: ["category-a"],
      labels: { "category-a": { it: "Pubblicazione" } },
      drafts: { "category-a": "rev-a" },
    });
    const second = labelsResult({ written: ["category-b"], labels: { "category-b": { it: "Design" } }, drafts: {} });
    const limited = failure("rate_limited", { status: 429, retryAfterSeconds: 5, result: first.ok ? first.data : undefined });
    const fake = fakeTransport((_call, count) => (count === 1 ? limited : second));
    const started = store.start({ ...RUN, jobs: [labels(["category-a", "category-b"])] }, fake.transport);

    assert.ok(started.ok);
    await clock.runAll();

    const job = (await started.finished).jobs[0];
    const result = job?.kind === "labels" ? job.result : undefined;

    assert.equal(job?.state, "done");
    assert.equal(fake.calls.length, 2);
    assert.deepEqual(result?.written, ["category-a", "category-b"]);
    assert.deepEqual(result?.drafts, { "category-a": "rev-a" }, "still offered by Publish N drafts");
    assert.deepEqual(Object.keys(result?.labels ?? {}), ["category-a", "category-b"]);
  });

  it("never retries a conflict, a saved result, a wrong target language or a timeout", async () => {
    const answers: Record<string, (input: unknown) => Answer> = {
      a: (input) => pairResult(input, { status: "saved_result", code: "conflict" }),
      b: () => failure("wrong_target_language"),
      c: () => failure("timeout", { status: 504, creditMayBeSpent: true }),
      d: (input) => pairResult(input, { status: "saved_result", code: "saved_result_exists", creditSpent: false }),
    };
    const clock = fakeClock();
    const store = createRunStore(clock);
    const fake = fakeTransport((call) => (answers[(call.input as PairInput).sourceId] as (input: unknown) => Answer)(call.input));
    const started = store.start({ ...RUN, jobs: Object.keys(answers).map((id) => pair(id)) }, fake.transport);

    assert.ok(started.ok);
    await clock.runAll();

    const run = await started.finished;

    assert.equal(run.status, "done");
    assert.equal(fake.calls.length, 4);
    assert.deepEqual(clock.sleeps, []);
    assert.deepEqual(stateOf(store), {
      a: "saved_result",
      b: "failed",
      c: "failed",
      d: "saved_result",
    });
    assert.equal(pairJob(run, "b", "it")?.message, "Message for wrong_target_language.");
    assert.equal(pairJob(run, "d", "it")?.creditSpent, false, "a saved result waiting costs nothing and counts toward no cap");
  });
});

describe("the store", () => {
  it("keeps running with nobody subscribed, and tells only current subscribers", async () => {
    const store = createRunStore(fakeClock());
    const fake = fakeTransport();
    let heard = 0;
    const unsubscribe = store.subscribe(() => {
      heard += 1;
    });
    const started = store.start({ ...RUN, jobs: [pair("a"), pair("b")] }, fake.transport);

    assert.ok(started.ok);
    await settle();

    const before = heard;

    assert.ok(before > 0);
    unsubscribe();

    await fake.resolve("a.it", pairResult({ sourceId: "a", language: "it" }));
    await fake.resolve("b.it", pairResult({ sourceId: "b", language: "it" }));

    const run = await started.finished;

    assert.equal(heard, before);
    assert.equal(run.status, "done");
    assert.equal(store.getSnapshot(), run, "the snapshot is the finished run");
  });

  it("refuses a second run while one is going, and clears only a finished one", async () => {
    const store = createRunStore(fakeClock());
    const fake = fakeTransport();
    const started = store.start({ ...RUN, jobs: [pair("a")] }, fake.transport);

    assert.ok(started.ok);
    assert.deepEqual(store.start({ ...RUN, jobs: [pair("b")] }, fake.transport), { ok: false, message: RUN_MESSAGES.busy });
    assert.equal(store.clear(), false);

    await fake.resolve("a.it", pairResult({ sourceId: "a", language: "it" }));
    await started.finished;

    assert.equal(store.clear(), true);
    assert.equal(store.getSnapshot(), null);
    assert.deepEqual(store.start({ ...RUN, jobs: [] }, fake.transport), { ok: false, message: RUN_MESSAGES.empty });
  });

  it("gives every change a new snapshot, as useSyncExternalStore needs", async () => {
    const store = createRunStore(fakeClock());
    const fake = fakeTransport();
    const snapshots = new Set<unknown>();

    store.subscribe(() => snapshots.add(store.getSnapshot()));

    const started = store.start({ ...RUN, jobs: [pair("a")] }, fake.transport);

    assert.ok(started.ok);
    await settle();

    const running = store.getSnapshot();

    await fake.resolve("a.it", pairResult({ sourceId: "a", language: "it" }));
    await started.finished;

    assert.notEqual(store.getSnapshot(), running);
    assert.equal(running?.jobs[0]?.state, "running", "an old snapshot never changes");
    assert.ok(snapshots.size >= 3);
  });

  it("loops relink until nothing is left, after every other step", async () => {
    const relinked = [
      { relinked: ["x"], remaining: 1 },
      { relinked: ["y"], remaining: 0 },
    ];
    let round = 0;
    const fake = fakeTransport((call) => {
      if (call.kind === "relink") {
        const answer = relinked[round++] ?? { relinked: [], remaining: 0 };

        return { ok: true, data: { ...answer, published: [], conflicts: [] } };
      }

      return happy(call);
    });
    const store = createRunStore(fakeClock());
    const started = store.start({ ...RUN, jobs: [{ kind: "relink" }, pair("a")] }, fake.transport);

    assert.ok(started.ok);

    const run = await started.finished;
    const [first, relink] = run.jobs;

    assert.deepEqual(fake.started(), ["a.it", "relink", "relink"], "the pair first, so relink can point at it");
    assert.equal(first?.kind, "pair");
    assert.equal(relink?.title, UPDATE_LINKS);
    assert.deepEqual(relink?.kind === "relink" && relink.result?.relinked, ["x", "y"]);
    assert.equal(RUN_STEPS.at(-1), "relink");
  });

  it("keeps relinking while a pass publishes drafts an earlier relink left, though it relinked nothing", async () => {
    const passes: RelinkResult[] = [
      { relinked: [], published: ["x"], conflicts: [], failed: ["y"], remaining: 1 },
      { relinked: ["y"], published: ["y"], conflicts: [], remaining: 0 },
    ];
    const fake = fakeTransport((call) =>
      call.kind === "relink"
        ? { ok: true, data: passes.shift() ?? { relinked: [], published: [], conflicts: [], remaining: 0 } }
        : happy(call)
    );
    const store = createRunStore(fakeClock());
    const started = store.start({ ...RUN, jobs: [{ kind: "relink", input: { publish: true } }] }, fake.transport);

    assert.ok(started.ok);

    const [relink] = (await started.finished).jobs;

    assert.deepEqual(fake.started(), ["relink", "relink"]);
    assert.deepEqual(relink?.kind === "relink" && relink.result, {
      relinked: ["y"],
      published: ["x", "y"],
      conflicts: [],
      remaining: 0,
    });
  });

  it("reports category names that changed while translating", async () => {
    const fake = fakeTransport(() => labelsResult({ conflicts: ["category-a"] }));
    const store = createRunStore(fakeClock());
    const started = store.start({ ...RUN, jobs: [labels()] }, fake.transport);

    assert.ok(started.ok);

    const [job] = (await started.finished).jobs;

    assert.equal(job?.state, "done");
    assert.match(job?.message ?? "", /1 category name changed/);
  });

  it("reports category names it could not save, and those that failed the checks", async () => {
    const fake = fakeTransport(() => labelsResult({ failed: ["category-a"], invalid: ["category-b", "category-c"] }));
    const store = createRunStore(fakeClock());
    const started = store.start({ ...RUN, jobs: [labels()] }, fake.transport);

    assert.ok(started.ok);

    const [job] = (await started.finished).jobs;

    assert.equal(job?.state, "done");
    assert.equal(
      job?.message,
      "1 category name could not be saved; the next run writes them for free. 2 category names failed the checks or were left out twice: fill them in by hand."
    );
    assert.equal(labelsNote({}), undefined);
  });
});

describe("selectors", () => {
  it("sums a run and one source's progress", async () => {
    const store = createRunStore(fakeClock());
    const fake = fakeTransport();
    const started = store.start({ ...RUN, jobs: [pair("about", "it"), pair("about", "de"), pair("contact")] }, fake.transport);

    assert.ok(started.ok);
    await settle();
    await fake.resolve("about.it", pairResult({ sourceId: "about", language: "it" }));

    const run = store.getSnapshot();
    const totals = runTotals(run);

    assert.deepEqual(
      [totals.total, totals.finished, totals.done, totals.running, totals.queued, totals.creditsSpent, totals.creditsQueued],
      [3, 1, 1, 2, 0, 1, 0]
    );
    assert.deepEqual(sourceProgress(run, "about"), { total: 2, finished: 1, running: 1, active: true });
    assert.equal(sourceProgress(run, "nobody"), null);
    assert.equal(runTotals(null).total, 0);

    await fake.resolve("about.de", pairResult({ sourceId: "about", language: "de" }));
    await fake.resolve("contact.it", pairResult({ sourceId: "contact", language: "it" }));
    assert.equal(sourceProgress(await started.finished, "about")?.active, false);
  });

  it("estimates the time left from the lanes the queue can use: one source's languages go one at a time", async () => {
    let time = 0;
    const options = { now: () => time, sleep: () => new Promise<void>(() => undefined) };
    const document = createRunStore(options);
    const one = fakeTransport();
    const languages = document.start(
      { ...RUN, jobs: [pair("about", "it"), pair("about", "de"), pair("about", "fr")] },
      one.transport
    );

    assert.ok(languages.ok);
    await settle();
    time = 10_000;
    await one.resolve("about.it", pairResult({ sourceId: "about", language: "it" }));
    assert.equal(runTotals(document.getSnapshot(), time).remainingMs, 20_000, "one lane for the two languages left");

    time = 0;

    const site = createRunStore(options);
    const many = fakeTransport();
    const sources = site.start({ ...RUN, jobs: [pair("a"), pair("b"), pair("c")] }, many.transport);

    assert.ok(sources.ok);
    await settle();
    time = 10_000;
    await many.resolve("a.it", pairResult({ sourceId: "a", language: "it" }));
    assert.equal(runTotals(site.getSnapshot(), time).remainingMs, 10_000, "two lanes for two sources left");
  });

  it("builds a whole-site run from the plan, and a document's from the editor's picks", () => {
    const target = (language: string, bulk: boolean) => ({ language, status: "notTranslated" as const, hasDraft: false, bulk });
    const plan: Pick<TranslationPlan, "rows" | "labelBatches"> = {
      labelBatches: [[{ id: "category-a", type: "articleCategory", field: "name", text: "A", missing: ["it"] }]],
      rows: [
        {
          sourceId: "about",
          type: "page",
          title: "About",
          step: "page",
          version: "published",
          hasUnpublishedChanges: false,
          targets: [target("it", true), target("de", false)],
        },
        {
          sourceId: "draft-only",
          type: "page",
          title: "Draft",
          step: "page",
          skipped: "notPublished",
          hasUnpublishedChanges: false,
          targets: [target("it", true)],
        },
      ],
    };
    const jobs = siteRunJobs({ plan: plan as TranslationPlan }, { publish: true, slugs: "keep", relink: true });

    assert.deepEqual(jobs, [
      { kind: "labels", title: "Category names", input: { ids: ["category-a"], publish: true } satisfies LabelsInput },
      {
        kind: "pair",
        step: "page",
        title: "About",
        input: {
          sourceId: "about",
          language: "it",
          version: "published",
          overwrite: false,
          slugs: "keep",
          publish: true,
          instructions: "",
        },
      },
      { kind: "relink", input: { publish: true } },
    ]);

    const picks = documentRunJobs(
      { sourceId: "about", title: "About", step: "page", version: "published" },
      [{ language: "it" }, { language: "de", overwrite: true }],
      { publish: false, version: "draft", instructions: "Be brief." }
    );

    assert.deepEqual(
      picks.map((job) => job.kind === "pair" && [job.input.language, job.input.overwrite, job.input.version]),
      [
        ["it", false, "draft"],
        ["de", true, "draft"],
      ]
    );
  });

  it("updates links after a document run that publishes, and only then", () => {
    const row = { sourceId: "about", title: "About", step: "page" as const, version: "published" as const };
    const published = documentRunJobs(row, [{ language: "it" }], { publish: true });

    assert.deepEqual(published.at(-1), { kind: "relink", title: UPDATE_LINKS, input: { publish: true } });
    assert.equal(jobCredits(published), 1, "free");
    assert.deepEqual(
      documentRunJobs(row, [{ language: "it" }], { publish: false }).map(({ kind }) => kind),
      ["pair"],
      "a draft links nothing until it is published"
    );
    assert.deepEqual(documentRunJobs(row, [], { publish: true }), []);
  });
});

describe("guardUnload", () => {
  it("asks before the tab closes only while a run is going", async () => {
    const store = createRunStore(fakeClock());
    const tab = new EventTarget();
    const unload = () => {
      const event = new Event("beforeunload", { cancelable: true });

      tab.dispatchEvent(event);

      return event.defaultPrevented;
    };
    const stopGuarding = guardUnload(store, tab);

    assert.equal(unload(), false, "nothing to lose before a run");

    const fake = fakeTransport();
    const started = store.start({ ...RUN, jobs: [pair("a")] }, fake.transport);

    assert.ok(started.ok);
    await settle();
    assert.equal(unload(), true, "the queue lives in this tab");

    await fake.resolve("a.it", pairResult({ sourceId: "a", language: "it" }));
    await started.finished;
    assert.equal(unload(), false, "a finished run lets the tab close");

    const next = store.start({ ...RUN, jobs: [pair("b")] }, fake.transport);

    assert.ok(next.ok);
    await settle();
    stopGuarding();
    assert.equal(unload(), false);
  });

  it("also sets a truthy returnValue, which browsers that predate preventDefault() here read", async () => {
    const store = createRunStore(fakeClock());
    let listener: ((event: Event) => void) | undefined;
    const tab = {
      addEventListener: (_type: string, added: (event: Event) => void) => {
        listener = added;
      },
      removeEventListener: () => {
        listener = undefined;
      },
    } as unknown as EventTarget;

    guardUnload(store, tab);
    assert.ok(store.start({ ...RUN, jobs: [pair("a")] }, fakeTransport().transport).ok);
    await settle();

    const event = { preventDefault: () => undefined, returnValue: "" as unknown };

    listener?.(event as unknown as Event);
    assert.ok(event.returnValue, "an empty string asks nothing there");
  });
});
