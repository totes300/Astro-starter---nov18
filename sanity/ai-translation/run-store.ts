// The Translate with AI run queue: one per Studio tab, shared by the document action and the Settings panel, so a
// run outlives its dialog. Its rules (order, barriers, caps, retries): docs/features/ai-translation.md

import * as React from "react";
import type { ApiFailure, ApiResult, TranslateTransport } from "./api";
import { type PlanRow, RUN_ORDER, type RunStep } from "./plan";
import type { LabelsInput, LabelsResult, PairInput, PairResult, PlanResponse, RelinkResult } from "./wire";

export const RUN_CONCURRENCY = 2;

/** Another request holds the pair's lease, or Sanity did not answer before the AI call: wait this long, once. */
export const BUSY_RETRY_MS = 5_000;

/** Sanity's rate limit hint when it names none. */
const DEFAULT_RATE_LIMIT_SECONDS = 60;

/** Rate limited this many times in a row: a lasting limit, so the run stops instead of failing each job in turn. */
export const RATE_LIMIT_STOP_AFTER = 3;

/** Relink answers 50 at a time; a pass that changes nothing ends the loop before this. */
const RELINK_MAX_ROUNDS = 20;

/** Every later request would be refused the same way, so nothing else starts. */
export const STOP_CODES: ReadonlySet<string> = new Set([
  "budget_exceeded",
  "daily_cap",
  "schema_drift",
  "unauthorized",
  "forbidden",
  "i18n_disabled",
  "off",
]);

/** The run order, then the free relink, so it can point at what the run published. */
export const RUN_STEPS = [...RUN_ORDER, "relink"] as const;

export type RunStepName = (typeof RUN_STEPS)[number];

export const RUN_MESSAGES = {
  busy: "A translation run is already going. Wait for it to finish, or stop it first.",
  empty: "Nothing to translate.",
  stopped: "Stopped. Requests already running were allowed to finish.",
  crashed: "Something went wrong in the Studio. Try again.",
} as const;

/** The free pass that re-points references at translations published since, by the name editors see. */
export const UPDATE_LINKS = "Update links";

export type JobKind = "labels" | "pair" | "relink";

export type JobState = "queued" | "running" | "done" | "skipped" | "failed" | "saved_result" | "stopped";

/** What a caller queues; `siteRunJobs` and `documentRunJobs` build these from a plan. */
export type JobInput =
  | { kind: "pair"; input: PairInput; step: RunStep; title?: string }
  | { kind: "labels"; input: LabelsInput; title?: string }
  | { kind: "relink"; input?: { publish?: boolean }; title?: string };

type JobBase = {
  id: string;
  step: RunStepName;
  /** Jobs sharing a key never run at once: one source's languages share its translation group, label batches one lease. */
  key: string;
  title: string;
  state: JobState;
  attempts: number;
  /** `outOfTime` goes again at once; `unavailable` (Sanity did not answer before the AI call) after 5 s, as `busy`. */
  retries: { rateLimited: number; busy: number; outOfTime: number; unavailable?: number };
  /** The latest attempt. */
  startedAt?: number;
  finishedAt?: number;
  /** A busy pair's retry waits until then. */
  notBefore?: number;
  creditSpent: boolean;
  /** Spent, or may have been: a billed call that timed out or lost its answer. */
  creditMayBeSpent: boolean;
  code?: string;
  message?: string;
  retryAfterSeconds?: number;
  failure?: ApiFailure;
};

export type PairJob = JobBase & { kind: "pair"; input: PairInput; sourceId: string; language: string; result?: PairResult };

export type LabelsJob = JobBase & { kind: "labels"; input: LabelsInput; result?: LabelsResult };

export type RelinkJob = JobBase & { kind: "relink"; input: { publish?: boolean }; result?: RelinkResult };

export type RunJob = PairJob | LabelsJob | RelinkJob;

export type RunScope = { kind: "document"; sourceId: string } | { kind: "site" };

export type RunStatus = "running" | "stopping" | "done" | "stopped";

export type StopReason = { code: string; message: string; usage?: ApiFailure["usage"] };

export type TranslationRun = {
  id: string;
  scope: RunScope;
  publish: boolean;
  /** Settings' `maxCreditsPerRun`: no job that calls the AI starts once requests made, plus those in flight, would pass it. */
  maxCredits: number;
  status: RunStatus;
  stopReason?: StopReason;
  startedAt: number;
  finishedAt?: number;
  /** Sanity's rate limit: no job starts before then. */
  pausedUntil?: number;
  jobs: RunJob[];
};

export type RunInput = {
  id?: string;
  scope: RunScope;
  publish: boolean;
  maxCredits: number;
  jobs: JobInput[];
};

export type RunTransport = TranslateTransport;

export type StartResult = { ok: true; run: TranslationRun; finished: Promise<TranslationRun> } | { ok: false; message: string };

export type RunStore = {
  subscribe(listener: () => void): () => void;
  getSnapshot(): TranslationRun | null;
  /** Refused while another run is going; a finished run is replaced. */
  start(input: RunInput, transport: RunTransport): StartResult;
  /** "Stop after the N running": queued jobs never start, running ones finish and save what they paid for. */
  stop(): void;
  /** Forgets a finished run; refused (false) while one is going. */
  clear(): boolean;
};

export type RunStoreOptions = {
  concurrency?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

type Outcome = {
  state: JobState;
  patch: Partial<JobBase> & { result?: unknown };
  stop?: StopReason;
  pauseUntil?: number;
};

const TERMINAL: ReadonlySet<JobState> = new Set(["done", "skipped", "failed", "saved_result", "stopped"]);

function stepIndex(step: RunStepName): number {
  return RUN_STEPS.indexOf(step);
}

function isPaid(job: { kind: JobKind }): boolean {
  return job.kind === "pair" || job.kind === "labels";
}

export function isRunActive(run: TranslationRun | null | undefined): boolean {
  return run?.status === "running" || run?.status === "stopping";
}

/** A draft run's drafts are published first, so the next run's Update links can point at them. */
export function creditCap(maxCredits: number, scope: RunScope["kind"] = "document", publish = true): StopReason {
  const requests = `${maxCredits} AI request${maxCredits === 1 ? "" : "s"}`;
  const again = publish ? "Translate the site again" : "Publish this run's drafts, then translate the site again";
  const next =
    scope === "site"
      ? `${again} to continue: the next run picks up what is left.`
      : "Raise it in Settings > Translations, or translate fewer languages.";

  return { code: "credit_cap", message: `Stopped at this run's limit of ${requests}. ${next}` };
}

/** Why a run stopped on Sanity's rate limit; the jobs it kept from starting are offered again with Try again. */
export function rateLimitStop(): StopReason {
  return {
    code: "rate_limited",
    message: `Stopped: Sanity's rate limit for AI requests refused ${RATE_LIMIT_STOP_AFTER} requests in a row. Try again in a few minutes. If it keeps happening, check your organization's AI usage in Sanity Manage.`,
  };
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** What a labels batch left: names changed meanwhile, not saved, or failing the checks. */
export function labelsNote(result: Pick<LabelsResult, "conflicts" | "failed" | "invalid">): string | undefined {
  const conflicts = result.conflicts?.length ?? 0;
  const failed = result.failed?.length ?? 0;
  const invalid = result.invalid?.length ?? 0;
  const notes = [
    ...(conflicts > 0 ? [`${plural(conflicts, "category name")} changed while translating; run again to fill them.`] : []),
    ...(failed > 0 ? [`${plural(failed, "category name")} could not be saved; the next run writes them for free.`] : []),
    ...(invalid > 0
      ? [
          `${plural(invalid, "category name")} failed the checks or ${invalid === 1 ? "was" : "were"} left out twice: ${invalid === 1 ? "fill it" : "fill them"} in by hand.`,
        ]
      : []),
  ];

  return notes.length > 0 ? notes.join(" ") : undefined;
}

/** A retried batch: names an earlier attempt wrote before it failed stay counted, and their drafts stay publishable. */
function withEarlierWrites(earlier: LabelsResult | undefined, result: LabelsResult): LabelsResult {
  if (!earlier?.written?.length) {
    return result;
  }

  const drafts = { ...earlier.drafts, ...result.drafts };

  return {
    ...result,
    written: [...new Set([...earlier.written, ...(result.written ?? [])])],
    labels: { ...earlier.labels, ...result.labels },
    ...(Object.keys(drafts).length > 0 ? { drafts } : {}),
  };
}

/** Relink answers 50 at a time: ask again until none is left or a pass changes nothing. */
export async function relinkAll(
  send: (input: { publish?: boolean }) => Promise<ApiResult<RelinkResult>>,
  publish: boolean
): Promise<ApiResult<RelinkResult>> {
  const total: RelinkResult = { relinked: [], published: [], conflicts: [], remaining: 0 };
  const failed = new Set<string>();

  for (let round = 0; round < RELINK_MAX_ROUNDS; round++) {
    const answer = await send({ publish });

    if (!answer.ok) {
      return { ok: false, error: { ...answer.error, result: total } };
    }

    total.relinked.push(...answer.data.relinked);
    total.published.push(...answer.data.published);
    total.conflicts.push(...answer.data.conflicts);
    total.remaining = answer.data.remaining;

    for (const id of answer.data.failed ?? []) {
      failed.add(id);
    }

    if (answer.data.remaining === 0 || (answer.data.relinked.length === 0 && answer.data.published.length === 0)) {
      break;
    }
  }

  const stillFailed = [...failed].filter((id) => !total.relinked.includes(id));

  return { ok: true, data: { ...total, ...(stillFailed.length > 0 ? { failed: stillFailed } : {}) } };
}

function defaultTitle(job: JobInput): string {
  switch (job.kind) {
    case "pair":
      return job.input.sourceId;
    case "labels":
      return "Category names";
    case "relink":
      return UPDATE_LINKS;
  }
}

function toJob(input: JobInput, id: string): RunJob {
  const base = {
    id,
    title: input.title ?? defaultTitle(input),
    state: "queued" as const,
    attempts: 0,
    retries: { rateLimited: 0, busy: 0, outOfTime: 0 },
    creditSpent: false,
    creditMayBeSpent: false,
  };

  switch (input.kind) {
    case "pair":
      return {
        ...base,
        kind: "pair",
        step: input.step,
        key: `source:${input.input.sourceId}`,
        input: input.input,
        sourceId: input.input.sourceId,
        language: input.input.language,
      };
    case "labels":
      return { ...base, kind: "labels", step: "labels", key: "labels", input: input.input };
    case "relink":
      return { ...base, kind: "relink", step: "relink", key: "relink", input: input.input ?? {} };
  }
}

/** AI requests the cap counts: made or possibly made, plus one per job in flight that calls the AI. */
function committedCredits(run: TranslationRun): number {
  const used = run.jobs.filter((job) => job.creditSpent || job.creditMayBeSpent).length;
  const inFlight = run.jobs.filter((job) => job.state === "running" && isPaid(job)).length;

  return used + inFlight;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

let runCounter = 0;

export function createRunStore(options: RunStoreOptions = {}): RunStore {
  const concurrency = Math.max(1, options.concurrency ?? RUN_CONCURRENCY);
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? wait;
  const listeners = new Set<() => void>();

  let run: TranslationRun | null = null;
  let transport: RunTransport | null = null;
  let resolveFinished: ((run: TranslationRun) => void) | null = null;
  let wakeAt: number | undefined;
  let rateLimitedInARow = 0;

  function emit() {
    for (const listener of listeners) {
      listener();
    }
  }

  function setRun(next: TranslationRun) {
    run = next;
    emit();
  }

  function patchJob(id: string, patch: Partial<RunJob>) {
    if (!run) {
      return;
    }

    setRun({ ...run, jobs: run.jobs.map((job) => (job.id === id ? ({ ...job, ...patch } as RunJob) : job)) });
  }

  function wake(at: number) {
    if (wakeAt !== undefined && wakeAt <= at) {
      return;
    }

    wakeAt = at;

    void sleep(Math.max(0, at - now())).then(() => {
      if (wakeAt === at) {
        wakeAt = undefined;
      }

      pump();
    });
  }

  function settleIfIdle() {
    if (!run || !isRunActive(run)) {
      return;
    }

    const busy = run.jobs.some((job) => job.state === "running" || job.state === "queued");

    if (busy) {
      return;
    }

    setRun({ ...run, status: run.stopReason ? "stopped" : "done", finishedAt: now(), pausedUntil: undefined });
    resolveFinished?.(run);
    resolveFinished = null;
  }

  function halt(reason: StopReason) {
    // A refusal after the editor's Stop says why later runs would fail too, so it names the stop.
    if (run?.status === "stopping" && run.stopReason?.code === "stopped" && STOP_CODES.has(reason.code)) {
      setRun({ ...run, stopReason: reason });

      return;
    }

    if (run?.status !== "running") {
      return;
    }

    const keepsCap = reason.code === "stopped" && run.stopReason?.code === "credit_cap";

    setRun({
      ...run,
      status: "stopping",
      stopReason: keepsCap ? run.stopReason : reason,
      jobs: run.jobs.map((job) => (job.state === "queued" ? { ...job, state: "stopped" as const, notBefore: undefined } : job)),
    });
  }

  /** The limit ends only the paid jobs: the relink after them still runs on what was published. */
  function stopAtCap() {
    if (run?.status !== "running") {
      return;
    }

    setRun({
      ...run,
      stopReason: creditCap(run.maxCredits, run.scope.kind, run.publish),
      jobs: run.jobs.map((job) =>
        job.state === "queued" && isPaid(job) ? { ...job, state: "stopped" as const, notBefore: undefined } : job
      ),
    });
  }

  /** Starts whatever may start now, in order: within the open step, one job per key, up to the concurrency and the cap. */
  function pump() {
    if (!run || !transport || run.status !== "running") {
      settleIfIdle();

      return;
    }

    const open = Math.min(
      ...run.jobs.filter((job) => job.state === "queued" || job.state === "running").map((job) => stepIndex(job.step))
    );
    let capReached = false;

    for (const candidate of run.jobs) {
      const current: TranslationRun = run;
      const running = current.jobs.filter((job) => job.state === "running");

      if (running.length >= concurrency || stepIndex(candidate.step) > open) {
        break;
      }

      if (candidate.state !== "queued" || running.some((job) => job.key === candidate.key)) {
        continue;
      }

      if (current.pausedUntil !== undefined && current.pausedUntil > now()) {
        wake(current.pausedUntil);
        break;
      }

      if (candidate.notBefore !== undefined && candidate.notBefore > now()) {
        wake(candidate.notBefore);
        continue;
      }

      if (isPaid(candidate) && committedCredits(current) + 1 > current.maxCredits) {
        // In flight may still come back free; with nothing in flight, the cap is reached.
        capReached = capReached || !running.some(isPaid);
        continue;
      }

      launch(candidate);
    }

    if (capReached && run && !run.jobs.some((job) => job.state === "running" && isPaid(job))) {
      stopAtCap();
      pump();

      return;
    }

    settleIfIdle();
  }

  function launch(job: RunJob) {
    if (!run || !transport) {
      return;
    }

    const runId = run.id;
    const send = transport;

    patchJob(job.id, { state: "running", startedAt: now(), attempts: job.attempts + 1, notBefore: undefined });

    void execute(job, send).then(
      (outcome) => settle(runId, job.id, outcome),
      () => settle(runId, job.id, crashed(job))
    );
  }

  function crashed(job: RunJob): Outcome {
    return { state: "failed", patch: { code: "crashed", message: RUN_MESSAGES.crashed, creditMayBeSpent: isPaid(job) } };
  }

  /** A failure, with the retries each kind allows: a rate limit pauses every worker, a busy pair waits alone. */
  function failed(job: RunJob, failure: ApiFailure, extra: Outcome["patch"] = {}): Outcome {
    const patch: Outcome["patch"] = {
      ...extra,
      code: failure.code,
      message: failure.message,
      failure,
      creditSpent: failure.creditSpent,
      creditMayBeSpent: failure.creditSpent || failure.creditMayBeSpent,
      ...(failure.retryAfterSeconds ? { retryAfterSeconds: failure.retryAfterSeconds } : {}),
    };

    // Asked again after each pause; `settle` stops the run once the limit holds three answers in a row.
    if (failure.code === "rate_limited") {
      const seconds = failure.retryAfterSeconds ?? DEFAULT_RATE_LIMIT_SECONDS;

      return {
        state: "queued",
        patch: { ...patch, creditMayBeSpent: false, retries: { ...job.retries, rateLimited: job.retries.rateLimited + 1 } },
        pauseUntil: now() + seconds * 1000,
      };
    }

    if (failure.code === "busy" && job.retries.busy === 0) {
      return { state: "queued", patch: { ...patch, retries: { ...job.retries, busy: 1 }, notBefore: now() + BUSY_RETRY_MS } };
    }

    if (failure.code === "sanity_unavailable" && !failure.creditSpent && (job.retries.unavailable ?? 0) === 0) {
      return {
        state: "queued",
        patch: {
          ...patch,
          creditMayBeSpent: false,
          retries: { ...job.retries, unavailable: 1 },
          notBefore: now() + BUSY_RETRY_MS,
        },
      };
    }

    // Free, and a new request gets the whole time cap.
    if (failure.code === "out_of_time" && job.retries.outOfTime === 0) {
      return { state: "queued", patch: { ...patch, retries: { ...job.retries, outOfTime: 1 } } };
    }

    if (STOP_CODES.has(failure.code)) {
      return { state: "failed", patch, stop: { code: failure.code, message: failure.message, usage: failure.usage } };
    }

    return { state: "failed", patch };
  }

  /** A 200 that is not a success (busy, or a refusal the route chose to answer as one) read as a failure. */
  function asFailure(result: PairResult | LabelsResult): ApiFailure {
    return {
      code: result.code ?? result.status,
      message: result.error ?? result.message ?? RUN_MESSAGES.crashed,
      status: 200,
      creditSpent: result.creditSpent === true,
      creditMayBeSpent: result.creditSpent === true,
      ...(result.retryAfterSeconds ? { retryAfterSeconds: result.retryAfterSeconds } : {}),
      ...(result.usage ? { usage: result.usage } : {}),
    };
  }

  function succeeded(state: JobState, result: PairResult | LabelsResult, message?: string): Outcome {
    const spent = result.creditSpent === true;

    return {
      state,
      patch: {
        result,
        creditSpent: spent,
        creditMayBeSpent: spent,
        code: result.code,
        message: message ?? result.message ?? result.error,
        failure: undefined,
        retryAfterSeconds: undefined,
      },
    };
  }

  async function executePair(job: PairJob, send: RunTransport): Promise<Outcome> {
    const answer = await send.translate(job.input);

    if (!answer.ok) {
      return failed(job, answer.error, answer.error.result ? { result: answer.error.result } : {});
    }

    const result = answer.data;

    switch (result.status) {
      case "translated":
        return succeeded("done", result);
      case "skipped":
        return succeeded("skipped", result);
      case "saved_result":
        return succeeded("saved_result", result);
      default:
        return failed(job, asFailure(result), { result });
    }
  }

  async function executeLabels(job: LabelsJob, send: RunTransport): Promise<Outcome> {
    const answer = await send.labels(job.input);

    if (!answer.ok) {
      const result = answer.error.result && withEarlierWrites(job.result, answer.error.result);

      return failed(job, answer.error, result ? { result } : {});
    }

    const result = withEarlierWrites(job.result, answer.data);

    switch (result.status) {
      case "translated":
        return succeeded("done", result, labelsNote(result));
      case "skipped":
        return succeeded("skipped", result);
      default:
        return failed(job, asFailure(result), { result });
    }
  }

  async function executeRelink(job: RelinkJob, send: RunTransport): Promise<Outcome> {
    const answer = await relinkAll((input) => send.relink(input), job.input.publish === true);

    if (!answer.ok) {
      return failed(job, answer.error, { result: answer.error.result });
    }

    return { state: "done", patch: { result: answer.data, failure: undefined } };
  }

  function execute(job: RunJob, send: RunTransport): Promise<Outcome> {
    switch (job.kind) {
      case "pair":
        return executePair(job, send);
      case "labels":
        return executeLabels(job, send);
      case "relink":
        return executeRelink(job, send);
    }
  }

  function settle(runId: string, jobId: string, settled: Outcome) {
    if (!run || run.id !== runId) {
      return;
    }

    rateLimitedInARow = settled.patch.code === "rate_limited" ? rateLimitedInARow + 1 : 0;

    const outcome = rateLimitedInARow >= RATE_LIMIT_STOP_AFTER && !settled.stop ? { ...settled, stop: rateLimitStop() } : settled;
    const retry = outcome.state === "queued";

    // A retry after Stop is a job that never starts again.
    if (retry && run.status !== "running") {
      patchJob(jobId, { ...outcome.patch, state: "stopped", notBefore: undefined, finishedAt: now() } as Partial<RunJob>);
    } else if (retry) {
      patchJob(jobId, { ...outcome.patch, state: "queued" } as Partial<RunJob>);
    } else {
      patchJob(jobId, { ...outcome.patch, state: outcome.state, finishedAt: now() } as Partial<RunJob>);
    }

    if (outcome.pauseUntil !== undefined && run.status === "running") {
      setRun({ ...run, pausedUntil: Math.max(run.pausedUntil ?? 0, outcome.pauseUntil) });
    }

    if (outcome.stop) {
      halt(outcome.stop);
    }

    pump();
  }

  return {
    subscribe(listener) {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },

    getSnapshot() {
      return run;
    },

    start(input, nextTransport) {
      if (isRunActive(run)) {
        return { ok: false, message: RUN_MESSAGES.busy };
      }

      if (input.jobs.length === 0) {
        return { ok: false, message: RUN_MESSAGES.empty };
      }

      const id = input.id ?? `run-${now().toString(36)}-${++runCounter}`;
      const jobs = input.jobs
        .map((job, index) => toJob(job, `${id}:${index}`))
        .map((job, index) => ({ job, index }))
        .sort((a, b) => stepIndex(a.job.step) - stepIndex(b.job.step) || a.index - b.index)
        .map(({ job }) => job);
      const finished = new Promise<TranslationRun>((resolve) => {
        resolveFinished = resolve;
      });

      transport = nextTransport;
      wakeAt = undefined;
      rateLimitedInARow = 0;
      setRun({
        id,
        scope: input.scope,
        publish: input.publish,
        maxCredits: Math.max(0, Math.floor(input.maxCredits)),
        status: "running",
        startedAt: now(),
        jobs,
      });

      pump();

      return { ok: true, run: run as TranslationRun, finished };
    },

    stop() {
      halt({ code: "stopped", message: RUN_MESSAGES.stopped });
      settleIfIdle();
    },

    clear() {
      if (isRunActive(run)) {
        return false;
      }

      run = null;
      transport = null;
      emit();

      return true;
    },
  };
}

export type RunTotals = {
  total: number;
  /** Every job that will not run again: done, skipped, failed, saved_result or stopped. */
  finished: number;
  done: number;
  skipped: number;
  failed: number;
  savedResults: number;
  stopped: number;
  running: number;
  queued: number;
  creditsSpent: number;
  /** Not confirmed either way: a billed call that timed out or lost its answer. */
  creditsMaybeSpent: number;
  /** What the cap counts: spent plus maybe spent. */
  creditsUsed: number;
  /** Jobs still queued that call the AI: one request each at most. */
  creditsQueued: number;
  elapsedMs: number;
  /** From the average job so far, at the run's concurrency; unset until a job has finished. */
  remainingMs?: number;
};

export function runTotals(run: TranslationRun | null | undefined, at: number = Date.now()): RunTotals {
  const jobs = run?.jobs ?? [];
  const count = (state: JobState) => jobs.filter((job) => job.state === state).length;
  const timed = jobs.filter((job) => job.startedAt !== undefined && job.finishedAt !== undefined);
  const average =
    timed.length > 0 ? timed.reduce((sum, job) => sum + ((job.finishedAt ?? 0) - (job.startedAt ?? 0)), 0) / timed.length : 0;
  const creditsSpent = jobs.filter((job) => job.creditSpent).length;
  const creditsUsed = jobs.filter((job) => job.creditSpent || job.creditMayBeSpent).length;
  const pending = jobs.filter((job) => job.state === "queued" || job.state === "running");
  // Jobs sharing a key run one after another, so one source's languages use a single lane.
  const lanes = Math.max(1, Math.min(RUN_CONCURRENCY, new Set(pending.map(({ key }) => key)).size));

  return {
    total: jobs.length,
    finished: jobs.filter((job) => TERMINAL.has(job.state)).length,
    done: count("done"),
    skipped: count("skipped"),
    failed: count("failed"),
    savedResults: count("saved_result"),
    stopped: count("stopped"),
    running: count("running"),
    queued: count("queued"),
    creditsSpent,
    creditsMaybeSpent: creditsUsed - creditsSpent,
    creditsUsed,
    creditsQueued: jobs.filter((job) => job.state === "queued" && isPaid(job)).length,
    elapsedMs: run ? (run.finishedAt ?? at) - run.startedAt : 0,
    ...(timed.length > 0 && isRunActive(run) ? { remainingMs: Math.round((average * pending.length) / lanes) } : {}),
  };
}

/** One source's pairs in the run, for the document action's label ("Translating... 1 of 2"); null when it has none. */
export function sourceProgress(
  run: TranslationRun | null | undefined,
  sourceId: string
): { total: number; finished: number; running: number; active: boolean } | null {
  const jobs = (run?.jobs ?? []).filter((job): job is PairJob => job.kind === "pair" && job.sourceId === sourceId);

  if (jobs.length === 0) {
    return null;
  }

  const finished = jobs.filter((job) => TERMINAL.has(job.state)).length;

  return {
    total: jobs.length,
    finished,
    running: jobs.filter((job) => job.state === "running").length,
    active: isRunActive(run) && finished < jobs.length,
  };
}

export function pairKey(sourceId: string, language: string): string {
  return `${sourceId}:${language}`;
}

/** The pairs whose AI result waits on the server: applying one is free, translating it again makes another AI request. */
export function savedPairs(results: readonly Pick<PlanResponse["savedResults"][number], "sourceId" | "language">[] = []) {
  return new Set(results.map(({ sourceId, language }) => pairKey(sourceId, language)));
}

export function pairJob(run: TranslationRun | null | undefined, sourceId: string, language: string): PairJob | undefined {
  return run?.jobs.find((job): job is PairJob => job.kind === "pair" && job.sourceId === sourceId && job.language === language);
}

/** One AI request per pair and per label batch; relink makes none. */
export function jobCredits(jobs: readonly JobInput[]): number {
  return jobs.filter(isPaid).length;
}

export type RunJobOptions = {
  publish: boolean;
  slugs?: PairInput["slugs"];
  instructions?: string;
};

function pairInput(
  sourceId: string,
  language: string,
  options: RunJobOptions & { version: PairInput["version"]; overwrite: boolean }
) {
  return {
    sourceId,
    language,
    version: options.version,
    overwrite: options.overwrite,
    ...(options.slugs ? { slugs: options.slugs } : {}),
    publish: options.publish,
    instructions: options.instructions ?? "",
  } satisfies PairInput;
}

/** A whole-site run from the plan: each label batch, then every pair the plan picked for bulk, then relink if asked. */
export function siteRunJobs(
  response: Pick<PlanResponse, "plan">,
  options: RunJobOptions & { languages?: string[]; relink?: boolean }
): JobInput[] {
  const { plan } = response;
  const picked = (language: string) => !options.languages?.length || options.languages.includes(language);
  const nameBatches = plan.labelBatches.filter((batch) => batch[0]?.kind !== "document");
  const labels: JobInput[] = nameBatches.map((batch, index) => ({
    kind: "labels",
    title: nameBatches.length > 1 ? `Category names (${index + 1} of ${nameBatches.length})` : "Category names",
    input: {
      ids: batch.map(({ id }) => id),
      ...(options.languages?.length ? { languages: options.languages } : {}),
      publish: options.publish,
    },
  }));
  // A person translates in place, one job per language its plan batch names.
  const people: JobInput[] = plan.labelBatches.flatMap((batch) =>
    batch[0]?.kind === "document"
      ? batch.flatMap(({ id, text, missing }) =>
          missing.filter(picked).map((language) => ({
            kind: "labels" as const,
            title: text,
            input: { ids: [id], languages: [language], publish: options.publish },
          }))
        )
      : []
  );
  const pairs: JobInput[] = plan.rows.flatMap((row) =>
    row.skipped
      ? []
      : row.targets
          .filter((target) => target.bulk && picked(target.language))
          .map((target) => ({
            kind: "pair" as const,
            step: row.step,
            title: row.title,
            input: pairInput(row.sourceId, target.language, {
              ...options,
              version: row.version ?? "published",
              overwrite: false,
            }),
          }))
  );

  return [
    ...labels,
    ...people,
    ...pairs,
    ...(options.relink ? [{ kind: "relink" as const, input: { publish: options.publish } }] : []),
  ];
}

/** The free relink after a run that publishes, so other pages point at the translations it published. */
function updateLinksJob(): JobInput {
  return { kind: "relink", title: UPDATE_LINKS, input: { publish: true } };
}

/** One document's run: the languages the editor ticked, each with its own `overwrite`, then Update links when it publishes. */
export function documentRunJobs(
  row: Pick<PlanRow, "sourceId" | "title" | "step" | "version">,
  picks: readonly { language: string; overwrite?: boolean }[],
  options: RunJobOptions & { version?: PairInput["version"] }
): JobInput[] {
  const pairs: JobInput[] = picks.map(({ language, overwrite = false }) => ({
    kind: "pair",
    step: row.step,
    title: row.title,
    input: pairInput(row.sourceId, language, { ...options, version: options.version ?? row.version ?? "published", overwrite }),
  }));

  return options.publish && pairs.length > 0 ? [...pairs, updateLinksJob()] : pairs;
}

type UnloadTarget = Pick<EventTarget, "addEventListener" | "removeEventListener">;

function askBeforeUnload(event: Event) {
  event.preventDefault();
  // Browsers that predate preventDefault() here ask only when returnValue is set to something truthy.
  (event as BeforeUnloadEvent).returnValue = true;
}

/** While a run is going, closing or reloading the tab asks first: the queue lives in this tab and ends with it. */
export function guardUnload(store: Pick<RunStore, "subscribe" | "getSnapshot">, target: UnloadTarget): () => void {
  let isGuarded = false;

  const sync = () => {
    const isActive = isRunActive(store.getSnapshot());

    if (isActive && !isGuarded) {
      target.addEventListener("beforeunload", askBeforeUnload);
    } else if (!isActive && isGuarded) {
      target.removeEventListener("beforeunload", askBeforeUnload);
    }

    isGuarded = isActive;
  };
  const unsubscribe = store.subscribe(sync);

  sync();

  return () => {
    unsubscribe();
    target.removeEventListener("beforeunload", askBeforeUnload);
  };
}

const STORE_KEY = Symbol.for("tca.ai-translation.run-store");
const GUARD_KEY = Symbol.for("tca.ai-translation.unload-guard");
const registry = globalThis as unknown as Record<symbol, unknown>;

// One queue per tab even across a hot reload in development, so an edited module cannot start a second, parallel run.
export const runStore: RunStore = (registry[STORE_KEY] as RunStore | undefined) ?? createRunStore();

registry[STORE_KEY] = runStore;

const serverSnapshot = () => null;

export function useTranslationRun(): TranslationRun | null {
  if (typeof window !== "undefined" && !registry[GUARD_KEY]) {
    registry[GUARD_KEY] = guardUnload(runStore, window);
  }

  return React.useSyncExternalStore(runStore.subscribe, runStore.getSnapshot, serverSnapshot);
}
