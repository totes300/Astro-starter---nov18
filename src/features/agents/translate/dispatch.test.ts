// The POST actions as the route answers them, over an in-memory dataset: the off switch, free failures, linking.

import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import type { RequestHandler, SanityClient } from "@sanity/client";
import type { TranslateAction } from "~/sanity/ai-translation/wire";
import { LOCALIZED_FIELDS } from "~/sanity/constants";
import { DEFAULT_LOCALE, IS_I18N_ENABLED, LOCALE_IDS } from "~/sanity/i18n";
import { agentActionOf } from "~/sanity/test-support/agent-actions";
import { createFakeContentLake, type FakeDocument } from "~/sanity/test-support/fake-content-lake";
import { translationGroupId } from "~/sanity/translation-stub";
import { answerAction, isSwitchedOff } from "./dispatch";
import type { TranslateDeps } from "./shared";

// Typed as a plain string: with one locale, `LOCALE_IDS` narrows to the default's literal.
const SECOND: string = LOCALE_IDS.find((id) => id !== DEFAULT_LOCALE) ?? DEFAULT_LOCALE;
const multi = { skip: !IS_I18N_ENABLED };
const withCategories = { skip: !IS_I18N_ENABLED || !Object.hasOwn(LOCALIZED_FIELDS, "articleCategory") };
const NOW = new Date("2026-10-20T10:00:00.000Z");

type Lake = ReturnType<typeof createFakeContentLake>;

function settings(maxCreditsPerDay?: number): FakeDocument {
  return {
    _id: "siteSettings",
    _type: "siteSettings",
    translations: { defaults: maxCreditsPerDay === undefined ? {} : { maxCreditsPerDay } },
  };
}

const about: FakeDocument = { _id: "about", _type: "page", language: DEFAULT_LOCALE, title: "About", uri: { current: "/about" } };

/** An agent client that answers `translate` with the source as it is, and counts the calls. */
function agent(lake: Lake) {
  const inner = lake.client.config().requestHandler as RequestHandler;
  const calls: unknown[] = [];
  const handler: RequestHandler = async (request, next) => {
    if (agentActionOf(request.url) !== "translate") {
      return inner(request, next);
    }

    calls.push(request.body);

    return lake.get(String((request.body as { documentId?: unknown }).documentId));
  };

  return { client: lake.client.withConfig({ apiVersion: "vX", requestHandler: handler }), calls };
}

function deps(lake: Lake, agentClient: SanityClient = lake.client, client: SanityClient = lake.client): TranslateDeps {
  return { client, agentClient, now: () => NOW, siteUrl: "https://site.example" };
}

/** A client over the lake that fails every write, as Sanity does when it is down. */
function failingWrites(lake: Lake): SanityClient {
  const inner = lake.client.config().requestHandler as RequestHandler;

  return lake.client.withConfig({
    requestHandler: (request, next) =>
      (request.body as { mutations?: unknown } | undefined)?.mutations
        ? Promise.reject(Object.assign(new Error("Service unavailable"), { statusCode: 503 }))
        : inner(request, next),
  });
}

const translate: TranslateAction = {
  action: "translate",
  sourceId: "about",
  language: SECOND,
  version: "published",
  overwrite: false,
  instructions: "",
};

describe("the off switch", () => {
  it("reads 0 credits a day as off, and an unset or positive limit as on", async () => {
    for (const [limit, off] of [
      [0, true],
      [undefined, false],
      [5, false],
    ] as const) {
      const lake = createFakeContentLake({ documents: [settings(limit)] });

      assert.equal(await isSwitchedOff(lake.client), off, String(limit));
    }
  });

  it("answers every action 404 `off` before anything else is read or written", async () => {
    const lake = createFakeContentLake({ documents: [settings(0), about] });
    const { client, calls } = agent(lake);
    const actions: TranslateAction[] = [
      translate,
      { action: "apply", sourceId: "about", language: SECOND },
      { action: "labels" },
      { action: "relink", publish: true },
      { action: "publish", ids: ["about"] },
      { action: "link", sourceId: "about", language: SECOND, targetId: "about-it" },
      { action: "discard", sourceId: "about", language: SECOND },
    ];

    for (const action of actions) {
      const answer = await answerAction(deps(lake, client), action);

      assert.equal(answer.status, 404, action.action);
      assert.equal((answer.body as { code?: string }).code, "off");
    }

    assert.equal(calls.length, 0);
    assert.equal(lake.mutations.length, 0);
  });
});

describe("a Sanity failure", () => {
  it("says nothing was spent when it came before the billed call, so the Studio counts it free", multi, async () => {
    const errors = mock.method(console, "error", () => {});

    try {
      const lake = createFakeContentLake({ documents: [settings(5), about] });
      const { client, calls } = agent(lake);
      const answer = await answerAction(deps(lake, client, failingWrites(lake)), translate);

      assert.equal(answer.status, 503);
      assert.deepEqual(answer.body, {
        error: "Sanity could not be read or written before the AI call, so nothing was spent. Try again in a moment.",
        code: "sanity_unavailable",
        creditSpent: false,
      });
      assert.equal(calls.length, 0);
    } finally {
      errors.mock.restore();
    }
  });

  it("answers a free action that could not write the same way", multi, async () => {
    const errors = mock.method(console, "error", () => {});

    try {
      const saved = {
        _id: `aiTranslation.result.about.${SECOND}`,
        _type: "aiTranslation.result",
        sourceId: "about",
        language: SECOND,
      };
      const lake = createFakeContentLake({ documents: [settings(5), about, saved] });
      const answer = await answerAction(deps(lake, lake.client, failingWrites(lake)), {
        action: "discard",
        sourceId: "about",
        language: SECOND,
      });

      assert.equal(answer.status, 503);
      assert.equal((answer.body as { creditSpent?: boolean }).creditSpent, false);
      assert.ok(lake.get(saved._id), "nothing was deleted");
    } finally {
      errors.mock.restore();
    }
  });
});

describe("link", () => {
  const italian: FakeDocument = {
    _id: "chi-siamo",
    _type: "page",
    language: SECOND,
    title: "Chi siamo",
    uri: { current: `/${SECOND}/chi-siamo` },
  };
  const link = (targetId: string, preview = false): TranslateAction => ({
    action: "link",
    sourceId: "about",
    language: SECOND,
    targetId,
    ...(preview ? { preview } : {}),
  });

  it("names the document first, then links it in a new group, for free", multi, async () => {
    const lake = createFakeContentLake({ documents: [settings(5), about, italian] });
    const preview = await answerAction(deps(lake), link("chi-siamo", true));

    assert.equal(preview.status, 200);
    assert.deepEqual(preview.body, {
      sourceId: "about",
      language: SECOND,
      targetId: "chi-siamo",
      status: "preview",
      title: "Chi siamo",
      creditSpent: false,
    });
    assert.equal(
      lake.mutations.filter((batch) =>
        batch.some((mutation) => "create" in mutation && JSON.stringify(mutation).includes("translation.metadata"))
      ).length,
      0
    );

    const linked = await answerAction(deps(lake), link("chi-siamo"));
    const groupId = await translationGroupId("about");
    const rows = (lake.get(groupId)?.translations ?? []) as { language: string; value: { _ref: string } }[];

    assert.equal(linked.status, 200, JSON.stringify(linked.body));
    assert.equal((linked.body as { status: string }).status, "linked");
    assert.deepEqual(
      rows.map(({ language, value }) => `${language}:${value._ref}`),
      [`${DEFAULT_LOCALE}:about`, `${SECOND}:chi-siamo`]
    );
  });

  it("replaces a row whose document is gone instead of adding a second one for the language", multi, async () => {
    const group = {
      _id: "g-about",
      _type: "translation.metadata",
      translations: [
        { _key: "en", language: DEFAULT_LOCALE, value: { _type: "reference", _ref: "about" } },
        { _key: "gone", language: SECOND, value: { _type: "reference", _ref: "deleted" } },
      ],
    };
    const lake = createFakeContentLake({ documents: [settings(5), about, italian, group] });
    const linked = await answerAction(deps(lake), link("chi-siamo"));
    const rows = (lake.get("g-about")?.translations ?? []) as { language: string; value: { _ref: string } }[];

    assert.equal((linked.body as { metadataId?: string }).metadataId, "g-about");
    assert.deepEqual(
      rows.map(({ language, value }) => `${language}:${value._ref}`),
      [`${DEFAULT_LOCALE}:about`, `${SECOND}:chi-siamo`]
    );
  });

  it("refuses another type, another language, a missing document, and one already in a group", multi, async () => {
    const person = { _id: "ada-it", _type: "person", language: SECOND, name: "Ada" };
    const english = { _id: "other", _type: "page", language: DEFAULT_LOCALE, title: "Other" };
    const grouped = {
      _id: "g-other",
      _type: "translation.metadata",
      translations: [{ _key: "x", language: SECOND, value: { _type: "reference", _ref: "chi-siamo" } }],
    };
    const lake = createFakeContentLake({ documents: [settings(5), about, italian, person, english] });
    const taken = createFakeContentLake({ documents: [settings(5), about, italian, grouped] });

    for (const [targetId, code, status] of [
      ["ada-it", "link_mismatch", 409],
      ["other", "link_mismatch", 409],
      ["nowhere", "link_not_found", 404],
    ] as const) {
      const answer = await answerAction(deps(lake), link(targetId));

      assert.equal(answer.status, status, targetId);
      assert.equal((answer.body as { code?: string }).code, code, targetId);
    }

    const answer = await answerAction(deps(taken), link("chi-siamo"));

    assert.equal((answer.body as { code?: string }).code, "link_taken");
    assert.equal(answer.status, 409);
  });
});

describe("publish", () => {
  it(
    "publishes a category draft that only fills names without a revision from the Studio, never one that renamed",
    withCategories,
    async () => {
      const category = (id: string, name: Record<string, string>): FakeDocument => ({ _id: id, _type: "articleCategory", name });
      const lake = createFakeContentLake({
        documents: [
          settings(5),
          category("c-filled", { [DEFAULT_LOCALE]: "Design" }),
          category("drafts.c-filled", { [DEFAULT_LOCALE]: "Design", [SECOND]: "Progettazione" }),
          category("c-renamed", { [DEFAULT_LOCALE]: "Code" }),
          category("drafts.c-renamed", { [DEFAULT_LOCALE]: "Coding", [SECOND]: "Codice" }),
        ],
      });
      const answer = await answerAction(deps(lake), { action: "publish", ids: ["c-filled", "c-renamed"] });

      assert.deepEqual((answer.body as { published: string[] }).published, ["c-filled"]);
      assert.equal(lake.get("drafts.c-filled"), undefined);
      assert.ok(lake.get("drafts.c-renamed"), "an editor's rename stays a draft");
    }
  );
});
