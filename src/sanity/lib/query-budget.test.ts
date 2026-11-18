// @sanity/client reads with GET below a length of encoded query string and with POST above it. The API CDN caches both,
// but its global edge only caches GET, so a query crossing the line is a decision recorded here, never an accident.

import assert from "node:assert/strict";
import { test } from "node:test";
import { parse } from "groq-js";
import { localeParams } from "~/features/i18n/fragment";
import { inventoryQueries } from "~/features/i18n/query-inventory";
import { DEFAULT_LOCALE, LOCALE_IDS } from "~/sanity/i18n";
import { minifyGroq } from "./fetch";

/** Where `@sanity/client` switches a query from GET to POST (`useGet` in its data request). */
const GET_LIMIT = 11_264;

/** Queries accepted as POST reads: only the one that sends a whole document, on the edit client no CDN serves. */
const POST_QUERIES = new Set<string>(["AiTranslationMarkdownQuery"]);

// Typed as a plain string: with one locale, `LOCALE_IDS` narrows to the default's literal.
const SECONDARY: string = LOCALE_IDS.find((id) => id !== DEFAULT_LOCALE) ?? DEFAULT_LOCALE;

/** A long but realistic value for every param a query can reference, so the measure errs long. */
const SAMPLE_PARAMS: Record<string, unknown> = {
  uri: `/${SECONDARY}/blog/authors/${"a-long-readable-slug-".repeat(3)}`,
  categories: ["design-and-research", "development-practice", "content-strategy"],
  docId: "3f2b9c1e-6a7d-4f0e-9b8c-2d1e0f3a4b5c",
  sectionKey: "a1b2c3d4e5f6",
  ids: Array.from({ length: 10 }, (_, index) => `3f2b9c1e-6a7d-4f0e-9b8c-2d1e0f3a4b${String(index).padStart(2, "0")}`),
  contentVersion: "2026-10-19T16:00:00.000Z:3f2b9c1e",
  // A whole translated page, which a long one fills past the line on its own.
  document: { _id: "drafts.3f2b9c1e-6a7d-4f0e-9b8c-2d1e0f3a4b5c", _type: "page", title: "x".repeat(GET_LIMIT) },
};

/** The query string `@sanity/client` measures: the query, then every param as `$name=<json>`. */
function encodedLength(query: string, params: Record<string, unknown>): number {
  const search = new URLSearchParams();

  search.append("query", query);

  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined) {
      search.append(`$${name}`, JSON.stringify(value));
    }
  }

  return `?${search}`.length;
}

function referencedParams(query: string): string[] {
  const names = new Set<string>();

  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") {
      return;
    }

    const { type, name } = node as { type?: unknown; name?: unknown };

    if (type === "Parameter" && typeof name === "string") {
      names.add(name);
    }

    for (const child of Object.values(node)) {
      walk(child);
    }
  };

  walk(parse(query));

  return [...names];
}

/** As `fetchSanity` sends it: minified, the locale params bound, and the content version every published page read adds. */
function measure(query: string): number {
  const params = Object.fromEntries(referencedParams(query).map((name) => [name, SAMPLE_PARAMS[name] ?? "x".repeat(40)]));

  return encodedLength(minifyGroq(query), {
    ...localeParams({ ...params, language: SECONDARY }),
    contentVersion: SAMPLE_PARAMS.contentVersion,
  });
}

test("every query reads with GET unless it is recorded as a POST read", async () => {
  const { queries, errors } = await inventoryQueries();

  assert.deepEqual(errors, [], "typegen drops a query it cannot read, so this measure would too");
  assert.ok(queries.some(({ name }) => name === "PageQ") && queries.some(({ name }) => name === "SitemapQ"), "finds the routes");

  const over = queries.flatMap(({ name, query }) => {
    const length = measure(query);

    return length >= GET_LIMIT && !POST_QUERIES.has(name) ? [`${name}: ${length} (${length - GET_LIMIT + 1} over)`] : [];
  });

  assert.deepEqual(over, [], "shrink these or record them in POST_QUERIES and docs/features/internationalization.md");
});
