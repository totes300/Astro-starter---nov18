// What the free plan offers beyond statuses: AI drafts left unpublished, unlinked documents by name, saved results.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { translationRecord } from "~/sanity/ai-translation/plan";
import { AI_TRANSLATION_RESULT_TYPE, aiTranslationDocumentId, LOCALIZED_FIELDS } from "~/sanity/constants";
import { DEFAULT_LOCALE, IS_I18N_ENABLED, LOCALE_IDS } from "~/sanity/i18n";
import { createFakeContentLake, type FakeDocument } from "~/sanity/test-support/fake-content-lake";
import { readPlan } from "./plan-read";

// Typed as a plain string: with one locale, `LOCALE_IDS` narrows to the default's literal.
const SECOND: string = LOCALE_IDS.find((id) => id !== DEFAULT_LOCALE) ?? DEFAULT_LOCALE;
const multi = { skip: !IS_I18N_ENABLED };
const withCategories = { skip: !IS_I18N_ENABLED || !Object.hasOwn(LOCALIZED_FIELDS, "articleCategory") };
const NOW = new Date("2026-10-20T10:00:00.000Z");

const about: FakeDocument = { _id: "about", _type: "page", language: DEFAULT_LOCALE, title: "About", uri: { current: "/about" } };

function aiWritten(id: string): FakeDocument {
  const written: FakeDocument = {
    ...about,
    _id: id,
    language: SECOND,
    title: "Chi siamo",
    uri: { current: `/${SECOND}/chi-siamo` },
  };

  return {
    ...written,
    aiTranslation: translationRecord({ source: about, written, sourceLanguage: DEFAULT_LOCALE, translatedAt: NOW.toISOString() }),
  };
}

function group(id: string, refs: Record<string, string>): FakeDocument {
  return {
    _id: id,
    _type: "translation.metadata",
    translations: Object.entries(refs).map(([language, ref]) => ({
      _key: `${id}-${language}`,
      language,
      value: { _type: "reference", _ref: ref },
    })),
  };
}

function saved(sourceId: string, language: string): FakeDocument {
  return {
    _id: aiTranslationDocumentId(AI_TRANSLATION_RESULT_TYPE, sourceId, language),
    _type: AI_TRANSLATION_RESULT_TYPE,
    sourceId,
    language,
    savedAt: NOW.toISOString(),
    meta: {},
    result: "{}",
  };
}

describe("readPlan", () => {
  it("lists every unpublished AI draft whatever run left it, never a draft someone edited", multi, async () => {
    const edited = { ...aiWritten("drafts.team-it"), title: "Il team, a mano" };
    const lake = createFakeContentLake({
      documents: [
        about,
        aiWritten("drafts.about-it"),
        { ...about, _id: "team", title: "Team", uri: { current: "/team" } },
        edited,
        group("g-about", { [DEFAULT_LOCALE]: "about", [SECOND]: "about-it" }),
        group("g-team", { [DEFAULT_LOCALE]: "team", [SECOND]: "team-it" }),
      ],
    });
    const plan = (await readPlan(lake.client, {}, { now: NOW })).plan;
    const cell = (sourceId: string) => plan.rows.find((row) => row.sourceId === sourceId)?.targets[0];

    assert.deepEqual(plan.aiDrafts, ["about-it"]);
    assert.equal(cell("about")?.aiDraft, true);
    assert.equal(cell("about")?.hasDraft, true);
    assert.equal(cell("team")?.aiDraft, undefined);
  });

  it(
    "lists a category draft that only fills empty names, verified here, never one that changed anything else",
    withCategories,
    async () => {
      const category = (id: string, name: Record<string, string>, extra: Record<string, unknown> = {}): FakeDocument => ({
        _id: id,
        _type: "articleCategory",
        name: { _type: "localizedString", ...name },
        ...extra,
      });
      const lake = createFakeContentLake({
        documents: [
          category("c-filled", { [DEFAULT_LOCALE]: "Design" }),
          category("drafts.c-filled", { [DEFAULT_LOCALE]: "Design", [SECOND]: "Progettazione" }),
          category("c-renamed", { [DEFAULT_LOCALE]: "Code" }),
          category("drafts.c-renamed", { [DEFAULT_LOCALE]: "Coding", [SECOND]: "Codice" }),
          category("c-slug", { [DEFAULT_LOCALE]: "Data" }, { slug: "data" }),
          category("drafts.c-slug", { [DEFAULT_LOCALE]: "Data", [SECOND]: "Dati" }, { slug: "dati" }),
        ],
      });
      const plan = (await readPlan(lake.client, {}, { now: NOW })).plan;

      assert.deepEqual(plan.aiDrafts, ["c-filled"]);
    }
  );

  it(
    "names the unlinked document a new translation would duplicate, so an editor can confirm before linking",
    multi,
    async () => {
      const homepage = { _id: "homepage", _type: "page", language: DEFAULT_LOCALE, title: "Home", uri: { current: "/" } };
      const italianHome = {
        _id: "home-it",
        _type: "page",
        language: SECOND,
        title: "La nostra casa",
        uri: { current: `/${SECOND}` },
      };
      const lake = createFakeContentLake({ documents: [homepage, italianHome] });
      const scoped = await readPlan(lake.client, { documentId: "homepage" }, { now: NOW });
      const site = await readPlan(lake.client, {}, { now: NOW });

      for (const plan of [scoped, site]) {
        const target = plan.plan.rows.find(({ sourceId }) => sourceId === "homepage")?.targets[0];

        assert.equal(target?.unlinkedId, "home-it");
        assert.equal(target?.unlinkedTitle, "La nostra casa");
      }
    }
  );

  it("offers no saved result for a language no longer served or a source since deleted", multi, async () => {
    const lake = createFakeContentLake({
      documents: [about, saved("about", SECOND), saved("about", "zz"), saved("deleted-page", SECOND)],
    });
    const site = await readPlan(lake.client, {}, { now: NOW });
    const scoped = await readPlan(lake.client, { documentId: "about" }, { now: NOW });

    for (const plan of [site, scoped]) {
      assert.deepEqual(
        plan.savedResults.map(({ sourceId, language }) => `${sourceId}:${language}`),
        [`about:${SECOND}`]
      );
    }
  });
});
