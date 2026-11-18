import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AgentActionTripwireError, agentActionOf, agentActionTripwire } from "./agent-actions";
import { createFakeContentLake } from "./fake-content-lake";

describe("the Agent Actions tripwire", () => {
  it("names the action a request calls, and nothing for any other request", () => {
    assert.equal(agentActionOf("https://p.api.sanity.io/vX/agent/action/translate/production"), "translate");
    assert.equal(agentActionOf("/vX/agent/action/prompt/test?tag=studio"), "prompt");
    assert.equal(agentActionOf("https://p.api.sanity.io/v2025-02-19/data/query/test?query=*"), null);
    assert.equal(agentActionOf(undefined), null);
  });

  it("throws before an Agent Action is sent, and lets every other request through", async () => {
    let passed = 0;
    const next = async () => {
      passed += 1;

      return {};
    };

    await agentActionTripwire({ url: "https://p.api.sanity.io/v2025-02-19/data/query/test" } as never, next);
    await assert.rejects(
      agentActionTripwire({ url: "https://p.api.sanity.io/vX/agent/action/transform/test" } as never, next),
      AgentActionTripwireError
    );
    assert.equal(passed, 1);
  });

  it("guards the fake Content Lake too, which still answers every write", async () => {
    const lake = createFakeContentLake();
    const agent = lake.client.withConfig({ apiVersion: "vX" });

    await assert.rejects(agent.agent.action.prompt({ instruction: "Hi" }), AgentActionTripwireError);
    await lake.client.create({ _id: "about", _type: "page" });
    assert.equal(lake.get("about")?._type, "page");
  });
});
