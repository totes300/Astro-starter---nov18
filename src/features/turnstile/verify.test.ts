import assert from "node:assert/strict";
import { test } from "node:test";
import { TURNSTILE_TEST_SECRET_KEY } from "./constants";
import { isTurnstileTestSecret, verifyTurnstile } from "./verify";

const LIVE_SECRET = "0x4AAAAAAAexampleexampleexampleexample";

function siteverify(answer: unknown, calls: FormData[] = []) {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push(init?.body as FormData);

    return Response.json(answer);
  }) as typeof fetch;
}

const check = { secret: LIVE_SECRET, action: "contact-form", hostname: "prod.example.com" };

test("a token Cloudflare confirms for this action and host passes, and the token, secret and IP are what is sent", async () => {
  const calls: FormData[] = [];
  const passed = await verifyTurnstile({
    ...check,
    token: "token",
    ip: "203.0.113.7",
    fetch: siteverify({ success: true, action: "contact-form", hostname: "prod.example.com" }, calls),
  });

  assert.equal(passed, true);
  assert.equal(calls[0]?.get("response"), "token");
  assert.equal(calls[0]?.get("secret"), LIVE_SECRET);
  assert.equal(calls[0]?.get("remoteip"), "203.0.113.7");
});

test("a token minted for another action or host is refused, even when Cloudflare calls it a success", async () => {
  assert.equal(
    await verifyTurnstile({
      ...check,
      token: "t",
      fetch: siteverify({ success: true, action: "other", hostname: "prod.example.com" }),
    }),
    false
  );
  assert.equal(
    await verifyTurnstile({
      ...check,
      token: "t",
      fetch: siteverify({ success: true, action: "contact-form", hostname: "evil.example" }),
    }),
    false
  );
});

test("a token Cloudflare refuses, an answer that never comes, and a missing or oversized token are all refusals", async () => {
  const quiet = console.warn;
  const loud = console.error;
  console.warn = () => {};
  console.error = () => {};

  try {
    const never = (async () => {
      throw new Error("timeout");
    }) as typeof fetch;

    assert.equal(await verifyTurnstile({ ...check, token: "t", fetch: siteverify({ success: false }) }), false);
    assert.equal(await verifyTurnstile({ ...check, token: "t", fetch: never }), false);

    for (const token of [null, "", "x".repeat(2049), new File(["t"], "t")]) {
      assert.equal(await verifyTurnstile({ ...check, token, fetch: siteverify({ success: true }) }), false, String(token));
    }
  } finally {
    console.warn = quiet;
    console.error = loud;
  }
});

test("the test secret passes on success alone, since Cloudflare's test answers carry no action or real host", async () => {
  assert.equal(isTurnstileTestSecret(TURNSTILE_TEST_SECRET_KEY), true);
  assert.equal(isTurnstileTestSecret(LIVE_SECRET), false);
  assert.equal(
    await verifyTurnstile({
      ...check,
      secret: TURNSTILE_TEST_SECRET_KEY,
      token: "XXXX.DUMMY.TOKEN.XXXX",
      fetch: siteverify({ success: true }),
    }),
    true
  );
});
