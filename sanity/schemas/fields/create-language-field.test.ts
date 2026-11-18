import "../test-env";
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { I18N_DOCUMENT_TYPES, LOCALIZED_FIELDS } from "../../constants";
import { DEFAULT_LOCALE, getLocaleTitle, getStudioLocaleTitle, IS_I18N_ENABLED, LOCALE_IDS, LOCALES } from "../../i18n";

let languageField: typeof import("./create-language-field");
let localizedField: typeof import("./create-localized-field");

before(async () => {
  languageField = await import("./create-language-field");
  localizedField = await import("./create-localized-field");
});

// `string`, so the fixtures stay valid when only the default locale is configured.
const secondary: string = LOCALE_IDS.find((locale) => locale !== DEFAULT_LOCALE) ?? DEFAULT_LOCALE;
const multiLocale = { skip: !IS_I18N_ENABLED };

type Validator = (value: unknown, context: unknown) => unknown;
type CapturedRule = { validator?: Validator; level?: string; required?: boolean };

/** A stand-in for Sanity's immutable rule chain: each call returns a new rule recording what was set. */
function rule(state: CapturedRule = {}): Record<string, unknown> & { state: CapturedRule } {
  return {
    state,
    custom: (validator: Validator) => rule({ ...state, validator }),
    warning: () => rule({ ...state, level: "warning" }),
    required: () => rule({ ...state, required: true }),
  };
}

function capturedRules(validation: unknown): CapturedRule[] {
  const result = (validation as (rule: unknown) => unknown)(rule());

  return (Array.isArray(result) ? result : [result]).map((entry) => (entry as { state: CapturedRule }).state);
}

describe("unconfiguredLanguageIssue", () => {
  it("passes every configured locale and a document written before the field existed", () => {
    for (const value of [...LOCALE_IDS, undefined, null]) {
      assert.equal(languageField.unconfiguredLanguageIssue(value), true, String(value));
    }
  });

  it("warns on an empty language, pointing at the backfill", () => {
    const issue = languageField.unconfiguredLanguageIssue("");

    assert.equal(typeof issue, "string");
    assert.match(String(issue), /no language/);
    assert.match(String(issue), /Ask a developer to run npm run sanity:migrate-backfill-language/);
  });

  it("warns on a language the site does not serve, matched exactly", () => {
    for (const value of ["zz", DEFAULT_LOCALE.toUpperCase(), [DEFAULT_LOCALE]]) {
      const issue = languageField.unconfiguredLanguageIssue(value);

      assert.equal(typeof issue, "string", JSON.stringify(value));
      assert.match(String(issue), /is not a language of this site/);
      assert.match(String(issue), /npm run trim/);
    }
  });
});

describe("createLanguageField", () => {
  it("is a hidden, read-only string that starts in the default locale", () => {
    const field = languageField.createLanguageField({ group: "page" });

    assert.equal(field.name, "language");
    assert.equal(field.type, "string");
    assert.equal(field.group, "page");
    assert.equal(field.hidden, true);
    assert.equal(field.readOnly, true);
    assert.equal(field.initialValue, DEFAULT_LOCALE);
  });

  it("always warns on an unconfigured language, and checks references only with a second locale", () => {
    const rules = capturedRules(languageField.createLanguageField().validation);

    assert.deepEqual(
      rules.map(({ validator, level }) => [validator, level]),
      [
        [languageField.unconfiguredLanguageIssue, "warning"],
        ...(IS_I18N_ENABLED ? [[languageField.crossLanguageReferences, "warning"]] : []),
      ]
    );
  });
});

type Fetch = (query: string, params: Record<string, unknown>, options: Record<string, unknown>) => Promise<unknown>;

function validationContext(document: Record<string, unknown>, fetch: Fetch) {
  return { document, getClient: () => ({ fetch }) } as never;
}

describe("crossLanguageReferences", () => {
  const translation = {
    _id: "drafts.translation",
    _type: "page",
    language: secondary,
    author: { _ref: "person", _type: "reference" },
    link: { _ref: "drafts.about", _type: "reference", _weak: true },
  };

  it("reads nothing for a document without references", async () => {
    const fetch: Fetch = async () => assert.fail("no read expected");

    assert.equal(
      await languageField.crossLanguageReferences(undefined, validationContext({ _id: "a", language: secondary }, fetch)),
      true
    );
  });

  it("names each target in another language, read raw with drafts", multiLocale, async () => {
    const reads: Parameters<Fetch>[] = [];
    const fetch: Fetch = async (...args) => {
      reads.push(args);

      return [
        { _id: "person", language: secondary, label: "Jane" },
        { _id: "about", language: DEFAULT_LOCALE, label: "About", uri: "/about" },
        { _id: "drafts.about", language: DEFAULT_LOCALE, label: "About us", uri: "/about" },
      ];
    };

    const issue = await languageField.crossLanguageReferences(undefined, validationContext(translation, fetch));

    assert.deepEqual(reads[0]?.slice(1), [
      { ids: ["person", "drafts.person", "about", "drafts.about"], types: I18N_DOCUMENT_TYPES },
      { perspective: "raw" },
    ]);
    assert.equal(
      issue,
      `This ${getLocaleTitle(secondary)} document points at another language: “About us” (/about, ${getLocaleTitle(DEFAULT_LOCALE)}). Pick the ${getLocaleTitle(secondary)} version, or translate it first. Once that translation is published, Update links in Settings > Translations points this at it.`
    );
  });

  it("passes when every target shares the language", multiLocale, async () => {
    const fetch: Fetch = async () => [{ _id: "person", language: secondary, label: "Jane" }];

    assert.equal(await languageField.crossLanguageReferences(undefined, validationContext(translation, fetch)), true);
  });

  it("never blocks publishing when the read fails", async (t) => {
    const logged = t.mock.method(console, "error", () => {});
    const fetch: Fetch = async () => {
      throw new Error("offline");
    };

    assert.equal(await languageField.crossLanguageReferences(undefined, validationContext(translation, fetch)), true);
    assert.equal(logged.mock.callCount(), 1);
  });
});

// A registered pair, read off the registry so the test outlives a trim that removes the type.
const [localizedPair] = Object.entries<readonly string[]>(LOCALIZED_FIELDS).flatMap(([type, names]) =>
  names.map((name) => ({ type, name }))
);
const hasLocalizedField = { skip: !localizedPair };

/** `never`: with every pair trimmed the registry is empty, and a literal pair would stop compiling. */
function localizedOptions() {
  return { documentType: localizedPair?.type as never, name: localizedPair?.name as never, title: "Name" };
}

type LocalizedShape = {
  type: string;
  title: string;
  description?: string;
  options?: unknown;
  validation?: unknown;
  components?: { field?: unknown };
  fields: { name: string; title: string; description?: string; type: string; validation: unknown }[];
};

const ONE_LOCALE = [{ id: DEFAULT_LOCALE }];
// `zz`: a language nobody configures, so the two-locale shape is tested whichever mode runs.
const TWO_LOCALES = [{ id: DEFAULT_LOCALE }, { id: "zz" }];

describe("createLocalizedField", () => {
  it("has one input per locale, required in the default locale only", hasLocalizedField, () => {
    const field = localizedField.createLocalizedField({ ...localizedOptions(), required: true });

    assert.equal(field.type, "object");
    assert.deepEqual(field.options, { collapsible: false, columns: IS_I18N_ENABLED ? 2 : 1 });

    const arms = field.fields as { name: string; title: string; type: string; validation: unknown }[];

    assert.deepEqual(
      arms.map(({ name, title, type }) => [name, title, type]),
      LOCALES.map(({ id }) => [id, IS_I18N_ENABLED ? getStudioLocaleTitle(id) : "Name", "string"])
    );

    for (const arm of arms) {
      assert.equal(capturedRules(arm.validation)[0]?.required === true, arm.name === DEFAULT_LOCALE, arm.name);
    }
  });

  it("passes the whole object to `validate`", hasLocalizedField, async () => {
    const seen: unknown[] = [];
    const field = localizedField.localizedFieldFor(
      {
        ...localizedOptions(),
        type: "text",
        validate: (value) => {
          seen.push(value);

          return true;
        },
      },
      TWO_LOCALES
    ) as unknown as LocalizedShape;

    const [validation] = capturedRules(field.validation);

    assert.equal(await validation?.validator?.({ [DEFAULT_LOCALE]: "News" }, {}), true);
    assert.deepEqual(seen, [{ [DEFAULT_LOCALE]: "News" }]);
    assert.ok(field.fields.every(({ type }) => type === "text"));
  });

  it("frames each language under its flag from a second locale", hasLocalizedField, () => {
    const field = localizedField.localizedFieldFor(
      { ...localizedOptions(), validate: () => true },
      TWO_LOCALES
    ) as unknown as LocalizedShape;

    assert.equal(field.components, undefined);
    assert.deepEqual(
      field.fields.map(({ title }) => title),
      TWO_LOCALES.map(({ id }) => getStudioLocaleTitle(id))
    );
    assert.equal(capturedRules(field.fields[0]?.validation)[0]?.validator, undefined, "the check stays on the object");
  });

  it("reads as a plain field with one locale, its check shown on that input", hasLocalizedField, async () => {
    const seen: unknown[] = [];
    const field = localizedField.localizedFieldFor(
      {
        ...localizedOptions(),
        description: "What readers see.",
        required: true,
        validate: (value) => {
          seen.push(value);

          return "Taken";
        },
      },
      ONE_LOCALE
    ) as unknown as LocalizedShape;
    const [input] = field.fields;

    assert.equal(typeof field.components?.field, "function", "the object's own header is not rendered");
    assert.equal(field.validation, undefined, "a check on the object would have no marker to show");
    assert.deepEqual([input?.name, input?.title, input?.description], [DEFAULT_LOCALE, "Name", "What readers see."]);

    const [rule] = capturedRules(input?.validation);
    const name = { [DEFAULT_LOCALE]: "News" };

    assert.equal(rule?.required, true);
    assert.equal(await rule?.validator?.("News", { parent: name }), "Taken");
    assert.deepEqual(seen, [name], "the whole stored object, so the check reads every language as before");
  });
});
