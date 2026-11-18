import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfiguredLocaleFilter } from "~/features/i18n/fragment";
import {
  AGENT_MARKDOWN_STATE_QUERY,
  GATED_ROUTE_FILTER,
  isAgentMarkdownEligible,
  toAgentMarkdownState,
} from "./markdown-eligibility";

const routes = [
  { uri: "/", excluded: false, gated: false },
  { uri: "/about/", excluded: false, gated: false },
  { uri: "/members", excluded: true, gated: true },
  { uri: "/hidden", excluded: true, gated: true },
  { uri: "/no-markdown", excluded: true, gated: false },
  { uri: "/unknown-flag", excluded: null, gated: null },
  { uri: null, excluded: false, gated: true },
  null,
];

test("only routes the snapshot marks as not excluded are eligible, in any trailing-slash spelling", () => {
  const state = toAgentMarkdownState({ siteLocked: false, routes });

  assert.equal(isAgentMarkdownEligible(state, "/"), true);
  assert.equal(isAgentMarkdownEligible(state, "/about"), true);
  assert.equal(isAgentMarkdownEligible(state, "/about/"), true);
  assert.equal(isAgentMarkdownEligible(state, "/members"), false);
  assert.equal(isAgentMarkdownEligible(state, "/members/"), false);
  assert.equal(isAgentMarkdownEligible(state, "/no-markdown"), false);
});

test("a route missing from the snapshot, or one whose flag did not evaluate, is not eligible", () => {
  const state = toAgentMarkdownState({ siteLocked: false, routes });

  assert.equal(isAgentMarkdownEligible(state, "/just-published-and-protected"), false);
  assert.equal(isAgentMarkdownEligible(state, "/unknown-flag"), false);
  assert.equal(isAgentMarkdownEligible(state, "/%6Dembers"), false);
  assert.equal(isAgentMarkdownEligible(state, "/feed.xml"), false);
});

test("site-wide Basic Auth makes every route ineligible", () => {
  const state = toAgentMarkdownState({ siteLocked: true, routes });

  assert.equal(isAgentMarkdownEligible(state, "/"), false);
  assert.equal(isAgentMarkdownEligible(state, "/about"), false);
});

test("an empty or null payload has nothing eligible", () => {
  assert.equal(isAgentMarkdownEligible(toAgentMarkdownState(null), "/"), false);
  assert.equal(isAgentMarkdownEligible(toAgentMarkdownState({ routes: null }), "/"), false);
});

test("protected and noIndex routes are gated, whatever their Markdown state", () => {
  const state = toAgentMarkdownState({ siteLocked: false, routes });

  assert.deepEqual([...state.gatedPathSet].sort(), ["/hidden", "/members"]);
});

test("the state query reads the settings singleton by id and flags protected and noIndex routes", () => {
  assert.match(AGENT_MARKDOWN_STATE_QUERY, /\*\[_id == "siteSettings"\]\[0\]\.basicAuth\.siteWideEnabled/);
  assert.match(AGENT_MARKDOWN_STATE_QUERY, /"excluded": seoMetadata\.noIndex == true \|\| passwordProtected == true/);
  assert.match(AGENT_MARKDOWN_STATE_QUERY, /"gated": seoMetadata\.noIndex == true \|\| passwordProtected == true/);
});

test("a page in a language the site no longer serves is excluded and gated like a protected one", () => {
  const ghostArm = `|| !(${ConfiguredLocaleFilter})`;

  assert.ok(GATED_ROUTE_FILTER.endsWith(ghostArm));
  assert.ok(AGENT_MARKDOWN_STATE_QUERY.includes(`"excluded": ${GATED_ROUTE_FILTER}`));
  assert.ok(AGENT_MARKDOWN_STATE_QUERY.includes(`"gated": ${GATED_ROUTE_FILTER}`));
});

test("a translated page is eligible only under its own prefixed URI, in any trailing-slash or Unicode spelling", () => {
  const state = toAgentMarkdownState({
    siteLocked: false,
    routes: [
      { uri: "/fr/a-propos", excluded: false, gated: false },
      { uri: "/fr/membres", excluded: true, gated: true },
      { uri: "/it/novit\u00e0", excluded: false, gated: false },
    ],
  });

  assert.equal(isAgentMarkdownEligible(state, "/fr/a-propos"), true);
  assert.equal(isAgentMarkdownEligible(state, "/fr/a-propos/"), true);
  assert.equal(isAgentMarkdownEligible(state, "/a-propos"), false);
  // The accent as a combining mark (NFD), as some clients spell it.
  assert.equal(isAgentMarkdownEligible(state, "/it/novita\u0300"), true);
  assert.equal(isAgentMarkdownEligible(state, "/novita\u0300"), false);
  assert.equal(isAgentMarkdownEligible(state, "/fr/membres"), false);
  assert.deepEqual([...state.gatedPathSet], ["/fr/membres"]);
});
