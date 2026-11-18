import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SANITY_AGENT_SCHEMA_ID } from "~/sanity/constants";
import { createFakeContentLake } from "~/sanity/test-support/fake-content-lake";
import { deployedSchemaCheck, schemaDrift } from "./schema-check";

const local = [{ type: "document", name: "page", attributes: { title: { type: "objectAttribute", value: { type: "string" } } } }];
const loadLocal = async () => JSON.stringify(local);

function deployed(fields: { name: string; type: string }[]) {
  return {
    _id: SANITY_AGENT_SCHEMA_ID,
    _type: "system.schema",
    schema: JSON.stringify([{ name: "page", type: "document", fields }]),
  };
}

describe("deployedSchemaCheck", () => {
  it("reads drift again on the next pair, so a deploy clears it at once, and reuses a pass for a minute", async () => {
    const lake = createFakeContentLake({ documents: [deployed([])] });
    const now = 1_000_000;

    assert.deepEqual((await deployedSchemaCheck(lake.client, loadLocal, { now })).drift, [
      "page.title: missing from the deployed schema",
    ]);

    await lake.client.createOrReplace(deployed([{ name: "title", type: "string" }]));

    assert.deepEqual((await deployedSchemaCheck(lake.client, loadLocal, { now: now + 1_000 })).drift, [], "not the cached drift");

    await lake.client.createOrReplace(deployed([]));

    assert.deepEqual((await deployedSchemaCheck(lake.client, loadLocal, { now: now + 2_000 })).drift, [], "a pass is reused");
    assert.equal((await deployedSchemaCheck(lake.client, loadLocal, { now: now + 2_000, fresh: true })).drift.length, 1);
  });
});

describe("schemaDrift", () => {
  const string = { type: "objectAttribute", value: { type: "string" } };
  const object = (attributes: Record<string, unknown>) => ({ type: "objectAttribute", value: { type: "object", attributes } });
  const array = (...members: unknown[]) => ({
    type: "objectAttribute",
    value: { type: "array", of: { type: "union", of: members } },
  });
  const local = [
    {
      type: "document",
      name: "article",
      attributes: {
        content: array(
          { type: "object", attributes: { figure: object({ caption: string }) } },
          {
            type: "object",
            attributes: {
              children: array({ type: "object", attributes: { media: { value: { type: "inline", name: "media" } } } }),
            },
          }
        ),
      },
    },
    { type: "type", name: "media", value: { type: "object", attributes: { caption: string } } },
  ];
  const deployed = (inlineFields: { name: string; type: string }[]) => [
    {
      name: "article",
      type: "document",
      fields: [
        {
          name: "content",
          type: "array",
          of: [
            {
              name: "figureBlock",
              type: "object",
              fields: [{ name: "figure", type: "object", fields: [{ name: "caption", type: "string" }] }],
            },
            { type: "block", of: [{ name: "inlineMediaField", type: "object", fields: [{ name: "media", type: "media" }] }] },
          ],
        },
      ],
    },
    { name: "media", type: "object", fields: inlineFields },
  ];

  const conditionalPaths = {
    article: [
      ["content", "[]", "figure", "caption"],
      ["content", "[]", "children", "[]", "media", "caption"],
    ],
  };

  it("follows a rule through array members and a block's inline objects, to the field it opens", () => {
    assert.deepEqual(
      schemaDrift({ deployed: deployed([{ name: "caption", type: "string" }]), local, types: ["article"], conditionalPaths }),
      []
    );
    assert.deepEqual(schemaDrift({ deployed: deployed([]), local, types: ["article"], conditionalPaths }), [
      "article.content.[].children.[].media.caption: opened by every request, missing from the deployed schema",
    ]);
  });
});
