import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FUNCTION_CAP_MS } from "~/lib/function-cap";
import { SANITY_AGENT_API_VERSION } from "~/sanity/constants";
import { AgentActionTripwireError } from "~/sanity/test-support/agent-actions";
import { createFakeContentLake } from "~/sanity/test-support/fake-content-lake";
import { AGENT_TIMEOUT_MS, agentCallBudget, createAgentClient } from "./agent-client";

const TRANSLATE = {
  schemaId: "_.schemas.default",
  documentId: "page-about",
  fromLanguage: { id: "en", title: "English" },
  toLanguage: { id: "it", title: "Italiano" },
  noWrite: true,
} as const;

describe("createAgentClient", () => {
  it("times out under the 60 s function cap", () => {
    const client = createAgentClient(createFakeContentLake().client);

    assert.equal(client.config().timeout, AGENT_TIMEOUT_MS);
    assert.ok(AGENT_TIMEOUT_MS < FUNCTION_CAP_MS);
  });

  it("gives a call what its request has left after the reserve, never more than the timeout", () => {
    const now = 1_000_000;

    assert.equal(agentCallBudget(now + 30_000, 10_000, now), 20_000);
    assert.equal(agentCallBudget(now + FUNCTION_CAP_MS, 0, now), AGENT_TIMEOUT_MS);
    assert.ok(agentCallBudget(now + 5_000, 10_000, now) < 0);
  });

  it("calls the Agent Actions API version through the base client's request handler", async () => {
    const lake = createFakeContentLake();
    const client = createAgentClient(lake.client);

    // The fake lake's tripwire: the request was built, and never left the process.
    await assert.rejects(client.agent.action.translate(TRANSLATE), (error: Error) => {
      assert.ok(error instanceof AgentActionTripwireError);
      assert.match(error.message, new RegExp(`/${SANITY_AGENT_API_VERSION}/agent/action/translate/`));

      return true;
    });

    await client.createIfNotExists({ _id: "imageAltText", _type: "imageAltText" });

    assert.equal(lake.get("imageAltText")?._type, "imageAltText");
  });
});
