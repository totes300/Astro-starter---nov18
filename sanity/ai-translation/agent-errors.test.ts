import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ClientError, ServerError } from "@sanity/client";
import { AGENT_ERROR_MESSAGES, agentErrorLog, classifyAgentError } from "./agent-errors";
import { TRANSLATE_MESSAGES } from "./wire";

function response(statusCode: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    statusCode,
    body,
    headers: { "content-type": "application/json", ...headers },
    url: "https://test.api.sanity.io/vX/agent/action/translate/test",
    method: "POST",
  };
}

describe("classifyAgentError", () => {
  it("tells a rate limit, retried after its hint for free, from a spent budget, which stops the run", () => {
    const rate = classifyAgentError(
      new ClientError(
        response(429, { error: "Too Many Requests", message: "Rate limit exceeded. Please try again in 45 seconds" })
      )
    );
    const budget = classifyAgentError(
      new ClientError(
        response(429, { error: "Too Many Requests", message: "Plan or Budget Limit reached.", usageValue: 1000, quota: 1000 })
      )
    );

    assert.deepEqual(rate, {
      status: 429,
      code: "rate_limited",
      creditMayBeSpent: false,
      retryable: true,
      retryAfterSeconds: 45,
    });
    assert.deepEqual(budget, {
      status: 429,
      code: "budget_exceeded",
      creditMayBeSpent: false,
      retryable: false,
      usage: { usageValue: 1000, quota: 1000 },
    });
  });

  it("prefers a Retry-After header, and waits 60 seconds when nothing says", () => {
    assert.equal(
      classifyAgentError(new ClientError(response(429, { error: "Rate limit" }, { "retry-after": "12" }))).retryAfterSeconds,
      12
    );
    assert.equal(classifyAgentError(new ClientError(response(429, "Too Many Requests"))).retryAfterSeconds, 60);
  });

  it("tells a missing schema from a missing document", () => {
    const schema = classifyAgentError(
      new ClientError(response(404, { error: "Not Found", message: "No deployed Studio schema found" }))
    );
    const document = classifyAgentError(
      new ClientError(response(404, { error: "Not Found", message: "Document with id 123 could not be found" }))
    );

    assert.equal(schema.code, "schema_missing");
    assert.equal(document.code, "document_not_found");
    assert.equal(document.creditMayBeSpent, false);
  });

  it("treats a 400 as a refused request and a 401 or 403 as the token, none of them billed", () => {
    for (const [status, code] of [
      [400, "invalid_request"],
      [422, "invalid_request"],
      [401, "unauthorized"],
      [403, "unauthorized"],
    ] as const) {
      const error = classifyAgentError(
        new ClientError(response(status, { error: "Bad", message: "async and noWrite cannot both be true" }))
      );

      assert.deepEqual([error.code, error.creditMayBeSpent, error.retryable], [code, false, false]);
    }
  });

  it("sends people to the schema deploy only when Sanity's refusal names the schema", () => {
    const schema = classifyAgentError(
      new ClientError(response(400, { error: "Bad Request", message: "Field `intro` is not in the schema for type page" }))
    );
    const other = classifyAgentError(new ClientError(response(400, { error: "Bad Request", message: "Document is too large" })));

    assert.deepEqual([schema.code, schema.creditMayBeSpent], ["schema_rejected", false]);
    assert.match(AGENT_ERROR_MESSAGES.schema_rejected, /sanity:schema-deploy/);
    assert.equal(other.code, "invalid_request");
    assert.doesNotMatch(AGENT_ERROR_MESSAGES.invalid_request, /schema-deploy/);
    assert.match(AGENT_ERROR_MESSAGES.invalid_request, /server log under \[ai-translate\]/);
  });

  it("logs the code, the status and Sanity's own words, cut short, for the server log only", () => {
    const long = `Document is too large: ${"x".repeat(400)}`;
    const line = agentErrorLog(new ClientError(response(400, { error: "Bad Request", message: long })));

    assert.match(line, /^invalid_request \(status 400\): .*Document is too large/);
    assert.ok(line.length < 360, `${line.length} characters`);
    assert.ok(line.endsWith("..."));
    assert.equal(agentErrorLog("a string"), "unknown (no status)");
  });

  it("never retries what may have billed: a 5xx, a gateway timeout, a client timeout, or a dropped connection", () => {
    const timeout = Object.assign(new Error("Request timed out"), { name: "TimeoutError" });
    const reset = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    const cases = [
      [new ServerError(response(500, { error: "Internal" })), "server_error"],
      [new ServerError(response(502, "<html>Bad Gateway</html>")), "server_error"],
      [new ServerError(response(504, "<html>Gateway Timeout</html>")), "timeout"],
      [timeout, "timeout"],
      [Object.assign(new Error("connect"), { code: "ETIMEDOUT" }), "timeout"],
      [reset, "unknown"],
      ["a string", "unknown"],
    ] as const;

    for (const [error, code] of cases) {
      const classified = classifyAgentError(error);

      assert.deepEqual([classified.code, classified.creditMayBeSpent, classified.retryable], [code, true, false], code);
    }
  });

  it("has fixed copy for every code, which never quotes Sanity", () => {
    for (const message of Object.values(AGENT_ERROR_MESSAGES)) {
      assert.ok(message.length > 0);
      assert.ok(![...message].some((character) => [0x2013, 0x2014].includes(character.codePointAt(0) ?? 0)));
    }
  });

  it("asks a developer for the schema deploy, which an editor in the Studio cannot run", () => {
    const naming = [...Object.values(AGENT_ERROR_MESSAGES), ...Object.values(TRANSLATE_MESSAGES)].filter((message) =>
      message.includes("sanity:schema-deploy")
    );

    assert.ok(naming.length >= 3);

    for (const message of naming) {
      assert.match(message, /Ask a developer to run npm run sanity:schema-deploy/);
    }
  });
});
