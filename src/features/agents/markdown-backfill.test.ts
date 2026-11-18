import assert from "node:assert/strict";
import { test } from "node:test";
import { SHARED_ROUTED_DOCUMENT_TYPES } from "~/sanity/constants";
import { DEFAULT_LOCALE, IS_I18N_ENABLED, LOCALE_IDS, withLocalePrefix } from "~/sanity/i18n";
import { localizeDocumentPath } from "~/sanity/sections";
import { backlogTasks, missingLanguages, tasksByLocale } from "./markdown-backfill";

// Typed as a plain string: with one locale, `LOCALE_IDS` narrows to the default's literal.
const SECONDARY: string = LOCALE_IDS.find((id) => id !== DEFAULT_LOCALE) ?? DEFAULT_LOCALE;

const ids = (groups: ReturnType<typeof tasksByLocale>) =>
  Object.fromEntries([...groups].map(([language, tasks]) => [language, tasks.map(({ _id }) => _id)]));

test("a backfill chunk is read once per language, each version in the language of its own URI", {
  skip: !IS_I18N_ENABLED,
}, () => {
  const groups = tasksByLocale(
    backlogTasks([
      { _id: "home", uri: "/", missing: true },
      { _id: "translated-home", uri: withLocalePrefix(SECONDARY, "/"), missing: true },
      { _id: "drafts.about", uri: "/about", missing: true },
      { _id: "translated-about", uri: withLocalePrefix(SECONDARY, "/about"), missing: true },
      { _id: "filled", uri: "/filled", missing: false },
    ])
  );

  assert.deepEqual(ids(groups), {
    [DEFAULT_LOCALE]: ["home", "drafts.about"],
    [SECONDARY]: ["translated-home", "translated-about"],
  });
});

test("a prefix the site does not serve, or no URI at all, reads in the default language", () => {
  const groups = tasksByLocale(
    backlogTasks([
      { _id: "unserved", uri: "/zz/ghost", missing: true },
      { _id: "no-uri", uri: null, missing: true },
    ])
  );

  assert.deepEqual(ids(groups), { [DEFAULT_LOCALE]: ["unserved", "no-uri"] });
});

// Read off the registry, so this outlives a trim that removes people.
test("a shared person is one task per language its Markdown lacks, at that language's URL", {
  skip: !SHARED_ROUTED_DOCUMENT_TYPES.includes("person"),
}, () => {
  const uri = "/blog/authors/ada";
  const person = { _id: "person-ada", _type: "person", uri, arms: { [DEFAULT_LOCALE]: "# Ada" } };

  assert.deepEqual(missingLanguages({ ...person, arms: {} }), [...LOCALE_IDS]);
  assert.deepEqual(
    backlogTasks([person]),
    LOCALE_IDS.filter((id) => id !== DEFAULT_LOCALE).map((language) => ({
      _id: "person-ada",
      uri: localizeDocumentPath("person", language, uri),
      language,
      arm: language,
    }))
  );
});
