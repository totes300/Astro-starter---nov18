import "../schemas/test-env";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { StudioFetch } from "../lib/studio-fetch";
import { AGENT_ERROR_MESSAGES } from "./agent-errors";
import {
  applySaved,
  createTranslateTransport,
  discardSaved,
  fetchPlan,
  linkTranslation,
  planUrl,
  postTranslate,
  publish,
  relink,
  STUDIO_MESSAGES,
  toApiFailure,
  translateLabels,
} from "./api";
import { type PairInput, TRANSLATE_MESSAGES } from "./wire";

const ENDPOINT = "/api/agents/translate";

type Sent = { url: string; method: string; headers: Headers; body: unknown };

/** A route stand-in: records each request and answers with `respond`; nothing leaves the process. */
function fakeFetch(respond: (sent: Sent) => Response | Promise<Response> = () => Response.json({ ok: true })) {
  const sent: Sent[] = [];
  const fetcher: StudioFetch = async (url, init = {}) => {
    const request: Sent = {
      url,
      method: init.method ?? "GET",
      headers: new Headers(init.headers),
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    };

    sent.push(request);

    return respond(request);
  };

  return { fetcher, sent };
}

const PAIR: PairInput = {
  sourceId: "about",
  language: "it",
  version: "published",
  overwrite: false,
  instructions: "",
};

const failed = (status: number, body: unknown) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": typeof body === "string" ? "text/plain" : "application/json" },
  });

describe("planUrl", () => {
  it("asks for one document or the whole site, with only the options set", () => {
    assert.equal(planUrl({ documentId: "about" }), `${ENDPOINT}?documentId=about`);
    assert.equal(
      planUrl({ useDraft: true, languages: ["it", "de"], policy: "refresh" }),
      `${ENDPOINT}?scope=site&useDraft=1&languages=it%2Cde&policy=refresh`
    );
  });
});

describe("the calls", () => {
  it("send one action per POST as JSON, to the configured endpoint", async () => {
    const { fetcher, sent } = fakeFetch();

    await postTranslate(fetcher, PAIR);
    await applySaved(fetcher, { sourceId: "about", language: "it" });
    await translateLabels(fetcher, { ids: ["category-a"], publish: false });
    await relink(fetcher);
    await publish(fetcher, ["about-it"]);
    await fetchPlan(fetcher, { documentId: "about" });

    assert.deepEqual(
      sent.map(({ url, method, body }) => [url, method, (body as { action?: string } | undefined)?.action]),
      [
        [ENDPOINT, "POST", "translate"],
        [ENDPOINT, "POST", "apply"],
        [ENDPOINT, "POST", "labels"],
        [ENDPOINT, "POST", "relink"],
        [ENDPOINT, "POST", "publish"],
        [`${ENDPOINT}?documentId=about`, "GET", undefined],
      ]
    );
    assert.deepEqual(sent[0]?.body, { action: "translate", ...PAIR });
    assert.deepEqual(sent[3]?.body, { action: "relink", publish: false });
    assert.deepEqual(sent[4]?.body, { action: "publish", ids: ["about-it"] });
    assert.equal(sent[0]?.headers.get("content-type"), "application/json");
  });

  it("discards a saved result and links a document, for free, previewing the link first", async () => {
    const { fetcher, sent } = fakeFetch();
    const link = { sourceId: "home", language: "it", targetId: "home-it" };

    await discardSaved(fetcher, { sourceId: "about", language: "it" });
    await linkTranslation(fetcher, { ...link, preview: true });
    await linkTranslation(fetcher, link);

    assert.deepEqual(
      sent.map(({ body }) => body),
      [
        { action: "discard", sourceId: "about", language: "it" },
        { action: "link", ...link, preview: true },
        { action: "link", ...link },
      ]
    );

    const taken = { status: "refused", code: "link_taken", error: TRANSLATE_MESSAGES.link_taken, creditSpent: false };
    const refused = await linkTranslation(fakeFetch(() => failed(409, taken)).fetcher, link);

    assert.ok(!refused.ok);
    assert.deepEqual(
      [refused.error.code, refused.error.message, refused.error.creditMayBeSpent],
      ["link_taken", TRANSLATE_MESSAGES.link_taken, false]
    );
  });

  it("reads the off switch and a free Sanity outage as the route says them", async () => {
    const off = { error: TRANSLATE_MESSAGES.off, code: "off" };
    const plan = await fetchPlan(fakeFetch(() => failed(404, off)).fetcher, { documentId: "about" });
    const outage = { error: TRANSLATE_MESSAGES.sanity_unavailable, code: "sanity_unavailable", creditSpent: false };
    const pair = await postTranslate(fakeFetch(() => failed(503, outage)).fetcher, PAIR);

    assert.ok(!plan.ok && !pair.ok);
    assert.deepEqual([plan.error.code, plan.error.message], ["off", TRANSLATE_MESSAGES.off]);
    assert.deepEqual([pair.error.code, pair.error.creditMayBeSpent], ["sanity_unavailable", false]);
  });

  it("sends the revision each category draft was left at, so the route publishes only that draft", async () => {
    const { fetcher, sent } = fakeFetch();

    await publish(fetcher, ["about-it", "category-a"], { "category-a": "r1" });

    assert.deepEqual(
      sent.map(({ body }) => body),
      [{ action: "publish", ids: ["about-it", "category-a"], revs: { "category-a": "r1" } }]
    );
  });

  it("returns a 200 answer as data", async () => {
    const result = { status: "translated", sourceId: "about", language: "it", creditSpent: true };
    const { fetcher } = fakeFetch(() => Response.json(result));

    assert.deepEqual(await postTranslate(fetcher, PAIR), { ok: true, data: result });
  });

  it("keeps a refused pair's own answer, its code, its copy and whether it billed", async () => {
    const body = { status: "failed", code: "rate_limited", error: AGENT_ERROR_MESSAGES.rate_limited, creditSpent: false };
    const { fetcher } = fakeFetch(() => failed(429, { ...body, retryAfterSeconds: 47.2 }));
    const answer = await postTranslate(fetcher, PAIR);

    assert.ok(!answer.ok);
    assert.equal(answer.error.code, "rate_limited");
    assert.equal(answer.error.message, AGENT_ERROR_MESSAGES.rate_limited);
    assert.equal(answer.error.retryAfterSeconds, 48);
    assert.equal(answer.error.creditMayBeSpent, false);
    assert.equal(answer.error.result?.status, "failed");
  });

  it("reads a dropped connection as may-have-billed only for a billed call", async () => {
    const { fetcher } = fakeFetch(() => {
      throw new TypeError("Failed to fetch");
    });
    const paid = await postTranslate(fetcher, PAIR);
    const free = await relink(fetcher);

    assert.ok(!paid.ok && !free.ok);
    assert.deepEqual([paid.error.code, paid.error.status, paid.error.creditMayBeSpent], ["network", 0, true]);
    assert.equal(paid.error.message, STUDIO_MESSAGES.network);
    assert.equal(free.error.creditMayBeSpent, false);
  });

  it("reads a cancelled request as aborted", async () => {
    const controller = new AbortController();
    const { fetcher } = fakeFetch(() => {
      controller.abort();
      throw new DOMException("The operation was aborted.", "AbortError");
    });
    const answer = await fetchPlan(fetcher, { documentId: "about" }, controller.signal);

    assert.ok(!answer.ok);
    assert.equal(answer.error.code, "aborted");
  });

  it("gives the run store the same calls, through the fetcher it was built with", async () => {
    const { fetcher, sent } = fakeFetch();
    const transport = createTranslateTransport(fetcher);

    await transport.translate(PAIR);
    await transport.labels({ ids: ["category-a"] });
    await transport.relink({});

    assert.deepEqual(
      sent.map(({ body }) => (body as { action?: string } | undefined)?.action),
      ["translate", "labels", "relink"]
    );
    assert.deepEqual(Object.keys(transport).sort(), ["labels", "relink", "translate"], "the queue has no publish job");
  });
});

describe("toApiFailure", () => {
  const paid = { billable: true, fallback: "Failed." };
  const free = { billable: false, fallback: "Failed." };

  it("reads the host's plain-text 504 as a timeout that may have billed", async () => {
    const res = failed(504, "504 Gateway Timeout");
    const failure = toApiFailure(res, null, paid);

    assert.deepEqual([failure.code, failure.creditSpent, failure.creditMayBeSpent], ["timeout", false, true]);
    assert.equal(failure.message, AGENT_ERROR_MESSAGES.timeout);
    assert.equal(toApiFailure(res, null, free).message, STUDIO_MESSAGES.slow);
    assert.equal(toApiFailure(res, null, free).creditMayBeSpent, false);
  });

  it("trusts the route's own word on billing", () => {
    const timeout = { status: "failed", code: "timeout", error: AGENT_ERROR_MESSAGES.timeout, creditSpent: true };
    const unbilled = { ...timeout, creditSpent: false };

    assert.equal(toApiFailure(failed(504, timeout), timeout, paid).creditSpent, true);
    assert.equal(toApiFailure(failed(504, unbilled), unbilled, paid).creditMayBeSpent, false);
  });

  it("reads 401 and 403 as the editor's session, whatever the gate says", () => {
    const unauthorized = { error: "Unauthorized.", code: "unauthorized", hint: "Sign in." };
    const agentToken = { status: "failed", code: "unauthorized", error: AGENT_ERROR_MESSAGES.unauthorized, creditSpent: false };

    assert.equal(toApiFailure(failed(401, unauthorized), unauthorized, paid).message, STUDIO_MESSAGES.unauthorized);
    assert.equal(toApiFailure(failed(403, "Forbidden"), null, paid).code, "forbidden");
    assert.equal(toApiFailure(failed(403, "Forbidden"), null, paid).message, STUDIO_MESSAGES.forbidden);
    assert.equal(toApiFailure(failed(502, agentToken), agentToken, paid).message, AGENT_ERROR_MESSAGES.unauthorized);
    assert.match(AGENT_ERROR_MESSAGES.unauthorized, /Ask a developer to check that SANITY_API_EDIT_TOKEN/);
  });

  it("uses the server's fixed copy, then the copy for its code, then the fallback", () => {
    const refusal = { status: "refused", code: "wrong_target_language", error: TRANSLATE_MESSAGES.wrong_target_language };

    assert.equal(toApiFailure(failed(409, refusal), refusal, paid).message, TRANSLATE_MESSAGES.wrong_target_language);
    assert.equal(
      toApiFailure(failed(429, { code: "daily_cap" }), { code: "daily_cap" }, paid).message,
      TRANSLATE_MESSAGES.daily_cap
    );
    assert.equal(toApiFailure(failed(400, { code: "brand_new" }), { code: "brand_new" }, paid).message, "Failed.");
  });

  it("reads a host's error page as host_error, and a route error without a result as unbilled below 500", () => {
    const page = toApiFailure(failed(502, "<html>Bad gateway</html>"), null, paid);
    const badInput = { error: "Send a JSON body.", code: "bad_input" };

    assert.deepEqual([page.code, page.message, page.creditMayBeSpent], ["host_error", STUDIO_MESSAGES.host_error, true]);
    assert.equal(toApiFailure(failed(400, badInput), badInput, paid).creditMayBeSpent, false);
    assert.equal(toApiFailure(failed(400, badInput), badInput, paid).result, undefined);
  });

  it("carries a budget stop's usage", () => {
    const budget = { status: "failed", code: "budget_exceeded", creditSpent: false, usage: { usageValue: 10, quota: 10 } };

    assert.deepEqual(toApiFailure(failed(429, budget), budget, paid).usage, { usageValue: 10, quota: 10 });
  });
});
