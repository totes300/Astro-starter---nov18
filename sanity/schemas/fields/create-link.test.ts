import "../test-env";
import assert from "node:assert/strict";
import { before, test } from "node:test";
import { evaluate, parse } from "groq-js";
import { DEFAULT_LOCALE, LOCALE_IDS } from "../../i18n";

let internalLinksQuery: string;

before(async () => {
  ({ InternalLinksQuery: internalLinksQuery } = await import("./create-link"));
});

// `zz` stands in for a language the site does not serve.
const dataset = [
  { _id: "before-the-field", _type: "page", uri: { current: "/legacy" } },
  ...LOCALE_IDS.map((language) => ({ _id: `page-${language}`, _type: "page", language, uri: { current: `/${language}-page` } })),
  { _id: "drafts.page-draft", _type: "page", language: DEFAULT_LOCALE, uri: { current: "/draft" } },
  { _id: "versions.spring.page-version", _type: "page", language: DEFAULT_LOCALE, uri: { current: "/version" } },
  { _id: "page-zz", _type: "page", language: "zz", uri: { current: "/zz/page" } },
  { _id: "settings", _type: "siteSettings", language: DEFAULT_LOCALE },
];

async function linkable(language: string): Promise<string[]> {
  const params = { language, locales: LOCALE_IDS };
  const result = await evaluate(parse(internalLinksQuery, { params }), { dataset, params });

  return ((await result.get()) as { value: string }[]).map(({ value }) => value).sort();
}

test("link: the internal link picker offers published pages in the edited document's served language only", async () => {
  for (const language of LOCALE_IDS) {
    const expected = language === DEFAULT_LOCALE ? ["before-the-field", `page-${language}`] : [`page-${language}`];

    assert.deepEqual(await linkable(language), expected.sort(), language);
  }

  assert.deepEqual(await linkable("zz"), [], "a document in a language the site does not serve links nowhere");
});
