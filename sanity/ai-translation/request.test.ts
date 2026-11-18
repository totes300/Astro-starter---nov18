import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createClient } from "@sanity/client";
import { AI_TRANSLATION_STYLE_GUIDE_LIMIT, SANITY_AGENT_SCHEMA_ID } from "../constants";
import { agentActionTripwire as sharedTripwire } from "../test-support/agent-actions";
import { AI_TRANSLATE_MAX_PATH_DEPTH, buildTranslateRequest, conditionalPaths } from "./request";
import { agentActionTripwire, TEST_LOCALES } from "./test-fixtures";

const [english, italian, german] = TEST_LOCALES as [
  { id: string; title: string },
  { id: string; title: string },
  { id: string; title: string },
];

const SEO = [
  { path: ["seoMetadata", "title"], hidden: false, readOnly: false },
  { path: ["seoMetadata", "description"], hidden: false, readOnly: false },
];

const about = {
  _id: "about",
  _type: "page",
  title: "About",
  seoMetadata: { title: "About us", description: "Who we are." },
  pageBuilder: { sectionsArray: [{ _key: "s1", _type: "textSection", sectionContent: { headline: "Hello" } }] },
};

describe("buildTranslateRequest", () => {
  it("builds the whole noWrite body for a page, opening the title and SEO copy it holds only", () => {
    const request = buildTranslateRequest({
      schemaId: SANITY_AGENT_SCHEMA_ID,
      documentId: "about",
      type: "page",
      document: about,
      from: english,
      to: italian,
      styleGuide: "Friendly.",
      protectedPhrases: ["Sanity"],
    });

    assert.deepEqual(request, {
      schemaId: SANITY_AGENT_SCHEMA_ID,
      documentId: "about",
      forcePublishedWrite: true,
      noWrite: true,
      temperature: 0,
      fromLanguage: { id: "en", title: "English" },
      toLanguage: { id: "it", title: "Italiano" },
      styleGuide: "Friendly.",
      protectedPhrases: ["Sanity"],
      target: { maxPathDepth: AI_TRANSLATE_MAX_PATH_DEPTH, exclude: ["language", "uri", "aiTranslation", "agentMarkdown"] },
      conditionalPaths: { paths: [{ path: ["title"], hidden: false, readOnly: false }, ...SEO] },
    });
    assert.equal(AI_TRANSLATE_MAX_PATH_DEPTH, 12);
  });

  it("reads a draft exactly, leaves a person's name out, and never opens every conditional field", () => {
    const request = buildTranslateRequest({
      schemaId: SANITY_AGENT_SCHEMA_ID,
      documentId: "drafts.ada",
      type: "person",
      document: { _id: "drafts.ada", _type: "person", name: "Ada", seoMetadata: { title: "Ada", description: "Writes." } },
      from: english,
      to: german,
    });

    assert.equal(request.documentId, "drafts.ada");
    assert.equal(request.forcePublishedWrite, true);
    assert.deepEqual(request.toLanguage, { id: "de", title: "Deutsch" });
    assert.ok(!Array.isArray(request.target) && request.target?.exclude?.includes("name"));
    assert.deepEqual(request.conditionalPaths, { paths: SEO });
    assert.equal("styleGuide" in request, false);
    assert.equal("protectedPhrases" in request, false);
    assert.equal("async" in request, false);
    assert.equal("languageFieldPath" in request, false);
    assert.equal(!Array.isArray(request.target) && "types" in (request.target ?? {}), false);
  });

  it("opens no conditional path at all for a document that holds none", () => {
    const request = buildTranslateRequest({
      schemaId: SANITY_AGENT_SCHEMA_ID,
      documentId: "drafts.launch",
      type: "article",
      document: { _id: "drafts.launch", _type: "article", title: "Launch" },
      from: english,
      to: italian,
    });

    assert.equal("conditionalPaths" in request, false);
  });

  it("refuses a release version, the same language twice, and a style guide over the cap", () => {
    const base = {
      schemaId: SANITY_AGENT_SCHEMA_ID,
      documentId: "about",
      type: "page",
      document: about,
      from: english,
      to: italian,
    };

    assert.throws(() => buildTranslateRequest({ ...base, documentId: "versions.r1.about" }));
    assert.throws(() => buildTranslateRequest({ ...base, to: english }));
    assert.throws(() => buildTranslateRequest({ ...base, styleGuide: "x".repeat(AI_TRANSLATION_STYLE_GUIDE_LIMIT + 1) }));
  });

  it("never leaves a test: the tripwire stops a real client before the request is sent", async () => {
    const client = createClient({
      projectId: "test",
      dataset: "test",
      apiVersion: "vX",
      useCdn: false,
      apiHost: "http://127.0.0.1:9",
      requestHandler: agentActionTripwire,
    });
    const request = buildTranslateRequest({
      schemaId: SANITY_AGENT_SCHEMA_ID,
      documentId: "about",
      type: "page",
      document: about,
      from: english,
      to: italian,
    });

    await assert.rejects(client.agent.action.translate(request), /billed Agent Action/);
  });

  it("lets every other request through", async () => {
    let passed = 0;
    const next = async () => {
      passed += 1;

      return {};
    };

    await agentActionTripwire({ url: "https://test.api.sanity.io/v2025-01-01/data/query/test" } as never, next);
    await assert.rejects(agentActionTripwire({ url: "https://test.api.sanity.io/vX/agent/action/prompt/test" } as never, next));
    assert.equal(passed, 1);
  });

  it("is the one tripwire the server's tests carry too, so the Agent Actions path is matched in one place", () => {
    assert.equal(agentActionTripwire, sharedTripwire);
  });
});

describe("conditionalPaths", () => {
  const page = {
    _id: "pricing",
    _type: "page",
    title: "Pricing",
    banner: { promo: { eyebrow: "Plans" } },
    pageBuilder: {
      sectionsArray: [
        {
          _key: "table",
          _type: "comparisonTableSection",
          sectionContent: {
            rows: [
              { _key: "r1", status: "Supported", cells: [{ _key: "c1", text: "Yes" }, { _key: "c2" }] },
              { _key: "r2", cells: [{ _key: "c3", text: "No" }] },
            ],
          },
        },
        { _key: "faq", _type: "faqSection", sectionContent: { quote: null } },
        { _type: "textSection", sectionContent: { quote: "A section with no key cannot be addressed." } },
      ],
    },
  };

  it("names every array item by its key, through nested arrays, in document order", () => {
    const rows = ["pageBuilder", "sectionsArray", "[]", "sectionContent", "rows", "[]"];

    assert.deepEqual(conditionalPaths(page, [[...rows, "cells", "[]", "text"]]), [
      [
        "pageBuilder",
        "sectionsArray",
        { _key: "table" },
        "sectionContent",
        "rows",
        { _key: "r1" },
        "cells",
        { _key: "c1" },
        "text",
      ],
      [
        "pageBuilder",
        "sectionsArray",
        { _key: "table" },
        "sectionContent",
        "rows",
        { _key: "r2" },
        "cells",
        { _key: "c3" },
        "text",
      ],
    ]);
    assert.deepEqual(conditionalPaths(page, [[...rows, "status"]]), [
      ["pageBuilder", "sectionsArray", { _key: "table" }, "sectionContent", "rows", { _key: "r1" }, "status"],
    ]);
  });

  it("opens nothing the document lacks: a missing or null value, an item without a key, an array that is not one", () => {
    assert.deepEqual(
      conditionalPaths(page, [
        ["seoMetadata", "title"],
        ["pageBuilder", "sectionsArray", "[]", "sectionContent", "quote"],
        ["title", "[]"],
        ["banner", "notice"],
      ]),
      []
    );
    assert.deepEqual(conditionalPaths(page, [["title"], ["banner", "promo"], ["banner", "promo", "eyebrow"]]), [
      ["title"],
      ["banner", "promo"],
      ["banner", "promo", "eyebrow"],
    ]);
  });

  it("names a path once, however many rules reach it", () => {
    assert.deepEqual(conditionalPaths(page, [["title"], ["title"]]), [["title"]]);
  });

  it("stops at Translate's path depth, where the agent could not reach the copy anyway", () => {
    let nested: Record<string, unknown> = { text: "Deep" };
    const rule: string[] = ["text"];

    for (let depth = 0; depth < AI_TRANSLATE_MAX_PATH_DEPTH; depth += 1) {
      nested = { items: [{ _key: `k${depth}`, ...nested }] };
      rule.unshift("items", "[]");
    }

    const document = { _id: "deep", _type: "page", ...nested };

    assert.equal(rule.length, AI_TRANSLATE_MAX_PATH_DEPTH * 2 + 1);
    assert.deepEqual(conditionalPaths(document, [rule]), []);
    assert.equal(conditionalPaths(document, [rule.slice(0, AI_TRANSLATE_MAX_PATH_DEPTH)]).length, 1);
    assert.deepEqual(conditionalPaths(document, [rule.slice(0, AI_TRANSLATE_MAX_PATH_DEPTH + 1)]), []);
  });
});
