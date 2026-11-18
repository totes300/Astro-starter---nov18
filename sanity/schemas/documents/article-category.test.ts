import "../test-env";
import assert from "node:assert/strict";
import { before, test } from "node:test";
import { evaluate, parse } from "groq-js";
import { DEFAULT_LOCALE, IS_I18N_ENABLED, LOCALE_IDS } from "../../i18n";

let articleCategory: typeof import("./article-category").articleCategory;

before(async () => {
  ({ articleCategory } = await import("./article-category"));
});

// `string`, so the fixtures stay valid when only the default locale is configured.
const secondary: string = LOCALE_IDS.find((locale) => locale !== DEFAULT_LOCALE) ?? DEFAULT_LOCALE;

type Validate = (value: unknown, context: unknown) => Promise<true | string>;

type Field = { name: string; validation?: unknown; fields?: Field[] };

/** Runs the `name` field's own check, with the Studio client answering from `dataset`. */
function nameIssue(value: Record<string, string>, dataset: object[], id = "drafts.category-new"): Promise<true | string> {
  const field = (articleCategory.fields as Field[]).find((entry) => entry.name === "name");
  // With one locale the check runs on the default language's input, against the whole name.
  const input = field?.validation ? undefined : field?.fields?.find((entry) => entry.name === DEFAULT_LOCALE);
  let validate: Validate | undefined;
  const rule = {
    required: () => rule,
    custom: (fn: Validate) => {
      validate = fn;

      return rule;
    },
  };

  const validation = (field?.validation ?? input?.validation) as ((rule: unknown) => unknown) | undefined;

  assert.ok(validation, "the name field has no validation");
  validation(rule);
  assert.ok(validate, "the name field has no custom validation");

  const client = {
    fetch: async (query: string, params: Record<string, unknown>) =>
      (await evaluate(parse(query, { params }), { dataset, params })).get(),
  };
  const context = { document: { _id: id }, getClient: () => client, parent: value };

  return input ? validate(value[DEFAULT_LOCALE], context) : validate(value, context);
}

const design = { _id: "category-design", _type: "articleCategory", name: { [DEFAULT_LOCALE]: "Design" } };
// Stored before the name was translated in place.
const legacy = { _id: "category-legacy", _type: "articleCategory", name: "Publishing" };

test("category: a name another category already has in the default language is refused, whatever its case", async () => {
  assert.match(String(await nameIssue({ [DEFAULT_LOCALE]: "design " }, [design])), /“design” already exists/);
  assert.match(String(await nameIssue({ [DEFAULT_LOCALE]: "publishing" }, [legacy])), /already exists/);
  assert.equal(await nameIssue({ [DEFAULT_LOCALE]: "Engineering" }, [design, legacy]), true);
});

test("category: a category never collides with itself, published, draft or in a release", async () => {
  const versions = [design, { ...design, _id: "drafts.category-design" }, { ...design, _id: "versions.spring.category-design" }];

  for (const id of ["category-design", "drafts.category-design", "versions.spring.category-design"]) {
    assert.equal(await nameIssue({ [DEFAULT_LOCALE]: "Design" }, versions, id), true, id);
  }

  assert.match(String(await nameIssue({ [DEFAULT_LOCALE]: "Design" }, versions)), /already exists/);
});

test("category: names are unique per language, not across languages", { skip: !IS_I18N_ENABLED }, async () => {
  const translated = { ...design, name: { [DEFAULT_LOCALE]: "Design", [secondary]: "Progettazione" } };

  assert.match(
    String(await nameIssue({ [DEFAULT_LOCALE]: "Craft", [secondary]: "progettazione" }, [translated])),
    /already exists/
  );
  assert.equal(await nameIssue({ [DEFAULT_LOCALE]: "Craft", [secondary]: "Design" }, [translated]), true);
  // A plain string is only ever the default language's spelling.
  assert.equal(await nameIssue({ [DEFAULT_LOCALE]: "Craft", [secondary]: "Publishing" }, [legacy]), true);
});
