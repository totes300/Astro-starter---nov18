import assert from "node:assert/strict";
import { test } from "node:test";
import { inspect } from "node:util";
import { apiErrorResponse } from "./errors";
import { handleRedeploy, type RedeploySteps } from "./redeploy";

const REPOSITORY = "acme/acme-web";
const DISPATCH_URL = "https://api.github.com/repos/acme/acme-web/actions/workflows/deploy.yml/dispatches";
const TOKEN = "github_pat_secret-token";

function redeploy(body?: string): Request {
  return new Request("https://example.com/api/redeploy", { method: "POST", body });
}

function recordingSteps(overrides: Partial<RedeploySteps> = {}) {
  const calls: { url: string; init: RequestInit }[] = [];

  const steps: RedeploySteps = {
    authorize: async () => null,
    repository: REPOSITORY,
    token: TOKEN,
    post: async (url, init) => {
      calls.push({ url, init });
      return new Response(null, { status: 204 });
    },
    ...overrides,
  };

  return { calls, steps };
}

const refuse = async () => apiErrorResponse(401, { error: "Sign in to the Studio.", code: "unauthenticated" });

test("a caller the Studio gate refuses gets its answer and never reaches GitHub", async () => {
  const { calls, steps } = recordingSteps({ authorize: refuse });

  assert.equal((await handleRedeploy(redeploy(), steps)).status, 401);
  assert.deepEqual(calls, []);
});

test("the gate runs before the config check, so an anonymous caller cannot learn whether redeploy is set up", async () => {
  const { steps } = recordingSteps({ authorize: refuse, token: undefined, repository: undefined });

  assert.equal((await handleRedeploy(redeploy(), steps)).status, 401);
});

test("an editor's request dispatches the workflow once on main, with GitHub's headers and a timeout", async () => {
  const { calls, steps } = recordingSteps();

  const response = await handleRedeploy(redeploy(), steps);
  const headers = new Headers(calls[0]?.init.headers);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, DISPATCH_URL);
  assert.equal(calls[0]?.init.method, "POST");
  assert.ok(calls[0]?.init.signal instanceof AbortSignal);
  assert.equal(headers.get("authorization"), `Bearer ${TOKEN}`);
  assert.equal(headers.get("accept"), "application/vnd.github+json");
  assert.equal(headers.get("x-github-api-version"), "2022-11-28");
  assert.ok(headers.get("user-agent"));
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), { ref: "main" });
});

test("the request body is never read, so nothing a caller sends can steer the dispatch", async () => {
  const { calls, steps } = recordingSteps();
  const request = redeploy(JSON.stringify({ repository: "evil/repo", ref: "attacker-branch" }));

  await handleRedeploy(request, steps);

  assert.equal(request.bodyUsed, false);
  assert.equal(calls[0]?.url, DISPATCH_URL);
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), { ref: "main" });
});

test("without the token or the repository an editor gets a private 500 and nothing is called", async () => {
  for (const missing of [{ token: undefined }, { repository: undefined }]) {
    const { calls, steps } = recordingSteps(missing);

    const response = await handleRedeploy(redeploy(), steps);

    assert.equal(response.status, 500);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal((await response.json()).code, "deploy_not_configured");
    assert.deepEqual(calls, []);
  }
});

test("a repository that is not owner/repo is refused before any call and never logged", async (t) => {
  for (const repository of [
    "acme",
    "acme/acme-web/extra",
    "../acme-web",
    "acme/..",
    "acme/.",
    "-acme/acme-web",
    "acme/acme web",
    "acme/acme-web?x=1",
    "evil.example/acme-web",
    "https://evil.example/acme/acme-web",
  ]) {
    const logged = t.mock.method(console, "error", () => {});
    const { calls, steps } = recordingSteps({ repository });

    const response = await handleRedeploy(redeploy(), steps);
    const text = await response.text();

    assert.equal(response.status, 500, repository);
    assert.equal(JSON.parse(text).code, "deploy_misconfigured", repository);
    assert.deepEqual(calls, [], repository);
    assert.ok(!inspect(logged.mock.calls.map((call) => call.arguments)).includes(repository), repository);
    logged.mock.restore();
  }
});

test("a dispatch GitHub refuses answers a fixed 502 that never echoes its answer or the token", async (t) => {
  const logged = t.mock.method(console, "error", () => {});
  const { steps } = recordingSteps({ post: async () => new Response(`Bad credentials ${TOKEN}`, { status: 401 }) });

  const response = await handleRedeploy(redeploy(), steps);
  const text = await response.text();

  assert.equal(response.status, 502);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(JSON.parse(text).code, "deploy_rejected");
  assert.doesNotMatch(text + inspect(logged.mock.calls.map((call) => call.arguments)), /Bad credentials|secret-token/);
});

test("a dispatch that throws answers a fixed 502 and logs only the error's name and network code", async (t) => {
  const logged = t.mock.method(console, "error", () => {});
  const cause = Object.assign(new Error(`getaddrinfo ENOTFOUND, token ${TOKEN}`), { code: "ENOTFOUND" });
  const { steps } = recordingSteps({
    post: async () => {
      throw new TypeError("fetch failed", { cause });
    },
  });

  const response = await handleRedeploy(redeploy(), steps);
  const text = await response.text();
  const log = inspect(
    logged.mock.calls.map((call) => call.arguments),
    { depth: 5 }
  );

  assert.equal(response.status, 502);
  assert.equal(JSON.parse(text).code, "deploy_unreachable");
  assert.match(log, /TypeError \(ENOTFOUND\)/);
  assert.doesNotMatch(text + log, /secret-token/);
});
