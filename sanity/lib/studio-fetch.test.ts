import "../schemas/test-env";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { SanityClient } from "sanity";

const realFetch = globalThis.fetch;
const sent: Headers[] = [];
let studioFetch: typeof import("./studio-fetch").studioFetch;

const client = { config: () => ({ token: "editor-token" }) } as unknown as SanityClient;

before(async () => {
  // No request leaves the process: the headers are what is under test.
  globalThis.fetch = (async (_input: unknown, init: RequestInit = {}) => {
    sent.push(new Headers(init.headers));

    return Response.json({});
  }) as typeof fetch;

  ({ studioFetch } = await import("./studio-fetch"));
});

after(() => {
  globalThis.fetch = realFetch;
});

describe("studioFetch", () => {
  it("sends the editor's token beside the caller's own headers", async () => {
    await studioFetch(client, "/api/agents/image-alt-text", { headers: { "content-type": "application/json" } });

    const [headers] = sent.splice(0);

    assert.equal(headers?.get("authorization"), "Bearer editor-token");
    assert.equal(headers?.get("content-type"), "application/json");
  });
});
