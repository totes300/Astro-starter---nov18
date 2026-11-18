import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluate, parse } from "groq-js";
import { I18N_DOCUMENT_TYPES, SANITY_SINGLETON_SITE_SETTINGS_ID } from "./constants";
import { LOCALE_IDS } from "./i18n";
import {
  CONFIGURED_LANGUAGE_FILTER,
  grouped,
  isDivider,
  translationIdsByLanguage,
  UNSERVED_LANGUAGE_FILTER,
  unservedLanguageList,
  unservedLanguages,
} from "./structure-groups";

const divider = { type: "divider" } as const;
const item = (title: string) => ({ title });

test("isDivider tells the one plain object apart from the builders around it", () => {
  assert.ok(isDivider(divider));
  assert.ok(!isDivider(item("Pages")));
  assert.ok(!isDivider(undefined));
  assert.ok(!isDivider(null));
});

test("a group removed from the middle takes its leftover divider with it", () => {
  // What `npm run trim` leaves behind: the items went, the rules that framed them did not.
  const before = [item("Pages"), divider, divider, item("Site")];

  assert.deepEqual(grouped(before), [item("Pages"), divider, item("Site")]);
});

test("a divider at either end is dropped, since it frames nothing", () => {
  assert.deepEqual(grouped([divider, item("Pages")]), [item("Pages")]);
  assert.deepEqual(grouped([item("Pages"), divider]), [item("Pages")]);
  assert.deepEqual(grouped([divider, item("Pages"), divider]), [item("Pages")]);
});

test("a run of dividers collapses to one, however long", () => {
  assert.deepEqual(grouped([item("A"), divider, divider, divider, item("B")]), [item("A"), divider, item("B")]);
});

test("a list of nothing but dividers comes back empty", () => {
  assert.deepEqual(grouped([divider, divider]), []);
});

test("a list that needs no tidying is returned unchanged", () => {
  const list = [item("Pages"), divider, item("Site")];

  assert.deepEqual(grouped(list), list);
});

// `zz` stands in for a language the site does not serve; the rest derive from `sanity/i18n.ts`.
const types = [...I18N_DOCUMENT_TYPES];
const [translatedType = "page"] = types;

async function ids(filter: string, dataset: Record<string, unknown>[], params: Record<string, unknown> = {}) {
  const result = (await (await evaluate(parse(`*[${filter}]._id`, { params }), { dataset, params })).get()) as string[];

  return [...result].sort();
}

const served = [
  { _id: "before-the-field", _type: translatedType },
  ...LOCALE_IDS.map((language) => ({ _id: `in-${language}`, _type: translatedType, language })),
];

const unserved = [
  { _id: "in-zz", _type: translatedType, language: "zz" },
  { _id: "drafts.in-zz", _type: translatedType, language: "zz" },
  { _id: "versions.spring.in-zz", _type: translatedType, language: "zz" },
  { _id: "in-zz-too", _type: translatedType, language: "zz" },
  { _id: "uppercase", _type: translatedType, language: LOCALE_IDS[0]?.toUpperCase() },
  { _id: "drafts.empty", _type: translatedType, language: "" },
  { _id: "array", _type: translatedType, language: [LOCALE_IDS[0]] },
];

const untranslated = [{ _id: "settings-in-zz", _type: SANITY_SINGLETON_SITE_SETTINGS_ID, language: "zz" }];

test("the configured filter keeps every served language and a document from before the field, nothing else", async () => {
  const dataset = [...served, ...unserved];

  assert.deepEqual(await ids(CONFIGURED_LANGUAGE_FILTER, dataset), served.map(({ _id }) => _id).sort());
});

test("the unserved filter is exactly the rest of the translated types, an empty language included", async () => {
  const dataset = [...served, ...unserved, ...untranslated];

  assert.deepEqual(await ids(UNSERVED_LANGUAGE_FILTER, dataset, { types }), unserved.map(({ _id }) => _id).sort());
});

test("unserved documents group by their exact language, each counted once across drafts and versions", () => {
  const groups = unservedLanguages(unserved);

  assert.deepEqual(
    groups.map(({ language, count }) => [language, count]),
    [
      [LOCALE_IDS[0]?.toUpperCase(), 1],
      ["zz", 2],
      ["", 1],
      [null, 1],
    ]
  );
});

test("an empty language is labelled as missing, not as a language", () => {
  const [missing] = unservedLanguages([{ _id: "empty", language: "" }]);

  assert.equal(missing?.label, "Missing language, run the backfill (1)");
});

test("each group's list shows exactly the documents the group counted", async () => {
  const dataset = [...served, ...unserved, ...untranslated];

  for (const group of unservedLanguages(unserved)) {
    const { filter, params } = unservedLanguageList(group, types);

    assert.deepEqual(await ids(filter, dataset, params), [...group.ids].sort(), group.label);
  }
});

test("a language's document is the metadata's own, else the one found at its URI, opened by its published id", () => {
  const ids = translationIdsByLanguage(
    [
      { id: "home-xx", language: "xx" },
      { id: null, language: "yy" },
    ],
    [
      { id: "drafts.orphan-xx", language: "xx" },
      { id: "versions.spring.orphan-yy", language: "yy" },
      { id: "drafts.orphan-zz", language: "zz" },
      { id: "orphan-zz-later", language: "zz" },
    ]
  );

  assert.deepEqual(Object.fromEntries(ids), { xx: "home-xx", yy: "orphan-yy", zz: "orphan-zz" });
});

test("without a URI lookup, only the metadata's entries count", () => {
  assert.deepEqual(Object.fromEntries(translationIdsByLanguage([{ id: "home-xx", language: "xx" }, { language: "yy" }])), {
    xx: "home-xx",
  });
});
