import "../test-env";
import assert from "node:assert/strict";
import { before, test } from "node:test";
import { evaluate, parse } from "groq-js";
import { LOCALE_IDS } from "../../i18n";

let article: typeof import("./article").article;

before(async () => {
  ({ article } = await import("./article"));
});

type ReferenceFilter = (context: { document: object }) => { filter: string; params: Record<string, unknown> };

// `zz` stands in for a language the site does not serve.
const people = [
  { _id: "before-the-field", _type: "person" },
  ...LOCALE_IDS.map((language) => ({ _id: `person-${language}`, _type: "person", language })),
  { _id: "person-zz", _type: "person", language: "zz" },
];

async function authorsFor(document: object): Promise<string[]> {
  const author = (article.fields as Array<{ name: string; options?: { filter?: unknown } }>).find(
    (field) => field.name === "author"
  );
  const authorFilter = author?.options?.filter as ReferenceFilter | undefined;

  assert.ok(authorFilter, "the author reference has no filter");

  const { filter, params } = authorFilter({ document });
  const result = await evaluate(parse(`*[_type == "person" && ${filter}]._id`, { params }), { dataset: people, params });

  return ((await result.get()) as string[]).sort();
}

test("article: the author picker offers the one shared person in every language, never one the site does not serve", async () => {
  const served = ["before-the-field", ...LOCALE_IDS.map((language) => `person-${language}`)].sort();

  for (const language of LOCALE_IDS) {
    assert.deepEqual(await authorsFor({ _id: "drafts.article", _type: "article", language }), served, language);
  }

  assert.deepEqual(await authorsFor({ _id: "article", _type: "article" }), served);
});
