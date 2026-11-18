// The pair's server re-check against what the plan shows, over an in-memory dataset: no test reaches the network.

import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import type { RequestHandler, SanityClient } from "@sanity/client";
import { fingerprint } from "~/sanity/ai-translation/fingerprint";
import { copyRecord } from "~/sanity/ai-translation/plan";
import { AI_TRANSLATION_RESULT_TYPE, aiTranslationDocumentId } from "~/sanity/constants";
import { DEFAULT_LOCALE, IS_I18N_ENABLED, LOCALE_IDS } from "~/sanity/i18n";
import { agentActionOf } from "~/sanity/test-support/agent-actions";
import { createFakeContentLake, type FakeDocument } from "~/sanity/test-support/fake-content-lake";
import { discardSavedResult, translatePair } from "./pair";
import { readPlan } from "./plan-read";
import type { TranslateDeps } from "./shared";
import { timeoutMarkerId } from "./timeout";

// Typed as a plain string: with one locale, `LOCALE_IDS` narrows to the default's literal.
const SECOND: string = LOCALE_IDS.find((id) => id !== DEFAULT_LOCALE) ?? DEFAULT_LOCALE;
const multi = { skip: !IS_I18N_ENABLED };
const NOW = new Date("2026-10-20T10:00:00.000Z");
const RESULT_ID = aiTranslationDocumentId(AI_TRANSLATION_RESULT_TYPE, "about", SECOND);

type Lake = ReturnType<typeof createFakeContentLake>;

function block(key: string, text: string) {
  return { _key: key, _type: "block", style: "normal", markDefs: [], children: [{ _key: `${key}s`, _type: "span", text }] };
}

function about(): FakeDocument {
  return {
    _id: "about",
    _type: "page",
    language: DEFAULT_LOCALE,
    title: "About us",
    uri: { _type: "slug", current: "/about" },
    body: [block("p1", "We publish content once."), block("p2", "We reuse it everywhere."), block("p3", "We keep it tidy.")],
    contact: { _type: "reference", _ref: "contact" },
  };
}

function row(key: string, language: string, ref: string) {
  return { _key: key, _type: "internationalizedArrayReferenceValue", language, value: { _type: "reference", _ref: ref } };
}

function group(id: string, rows: ReturnType<typeof row>[], createdAt = "2026-01-01T00:00:00Z"): FakeDocument {
  return { _id: id, _type: "translation.metadata", _createdAt: createdAt, schemaTypes: ["page"], translations: rows };
}

/** The copy the Translations menu makes on Sep 10: stamped as made, its link moved to the published variant. */
function stampedCopy(): FakeDocument {
  const copy: FakeDocument = {
    ...about(),
    _id: "about-it",
    language: SECOND,
    uri: { _type: "slug", current: `/${SECOND}/about` },
  };

  copy.contact = { _type: "reference", _ref: "contact-it" };

  return {
    ...copy,
    _createdAt: "2026-09-10T00:00:00Z",
    aiTranslation: copyRecord(copy, { sourceId: "about", sourceLanguage: "en" }),
  };
}

function dataset(extra: FakeDocument[] = []): FakeDocument[] {
  return [
    { _id: "siteSettings", _type: "siteSettings", translations: { defaults: { maxCreditsPerDay: 5 } } },
    about(),
    { _id: "contact", _type: "page", language: DEFAULT_LOCALE, title: "Contact", uri: { current: "/contact" } },
    { _id: "contact-it", _type: "page", language: SECOND, title: "Contatti", uri: { current: `/${SECOND}/contatti` } },
    group("group-contact", [row("c-en", DEFAULT_LOCALE, "contact"), row("c-2", SECOND, "contact-it")]),
    ...extra,
  ];
}

/** Every string translated, the structure sent back as it came; `fail` answers the call with that error, after `onCall`. */
function agent(lake: Lake, fail?: Error, onCall?: () => void) {
  const inner = lake.client.config().requestHandler as RequestHandler;
  const calls: unknown[] = [];
  const translate = (value: unknown, key = ""): unknown => {
    if (typeof value === "string") {
      return key.startsWith("_") ? value : `${value} [${SECOND}]`;
    }

    if (Array.isArray(value)) {
      return value.map((item) => translate(item));
    }

    return value && typeof value === "object"
      ? Object.fromEntries(Object.entries(value).map(([child, entry]) => [child, translate(entry, child)]))
      : value;
  };
  const handler: RequestHandler = async (request, next) => {
    if (agentActionOf(request.url) !== "translate") {
      return inner(request, next);
    }

    calls.push(request.body);
    onCall?.();

    if (fail) {
      throw fail;
    }

    return translate(lake.get(String((request.body as { documentId?: unknown }).documentId)));
  };

  return { client: lake.client.withConfig({ apiVersion: "vX", requestHandler: handler }), calls };
}

function deps(lake: Lake, agentClient: SanityClient, extra: Partial<TranslateDeps> = {}): TranslateDeps {
  return { client: lake.client, agentClient, now: () => NOW, siteUrl: "https://site.example", ...extra };
}

const pair = { sourceId: "about", language: SECOND, version: "published" as const, overwrite: false, instructions: "" };

async function targetIn(lake: Lake, documentId = "about") {
  const plan = await readPlan(lake.client, { documentId }, { now: NOW });

  return plan.plan.rows[0]?.targets.find(({ language }) => language === SECOND);
}

describe("translatePair, re-checked against the plan", () => {
  it("never pays for a copy partly translated by hand after the English changed, as the plan shows it", multi, async () => {
    const copy = stampedCopy();

    copy.title = "Chi siamo";
    copy.body = [
      block("p1", "Pubblichiamo i contenuti una volta."),
      block("p2", "We reuse it everywhere."),
      block("p3", "We keep it tidy."),
    ];

    const lake = createFakeContentLake({
      documents: dataset([copy, group("group-about", [row("a-en", DEFAULT_LOCALE, "about"), row("a-2", SECOND, "about-it")])]),
    });

    await lake.client.patch("about").set({ title: "About us, today" }).commit();

    const { client, calls } = agent(lake);
    const target = await targetIn(lake);
    const result = await translatePair(deps(lake, client), pair);

    assert.equal(target?.status, "translatedByHand");
    assert.equal(target?.bulk, false);
    assert.equal(result.status, "skipped", JSON.stringify(result));
    assert.equal(result.previousStatus, "translatedByHand");
    assert.equal(calls.length, 0);
  });

  it(
    "reads an untouched stamped copy as a copy, its link moved to the variant, and a re-pointed link as edited",
    multi,
    async () => {
      const offers = {
        _id: "offerte",
        _type: "page",
        language: SECOND,
        title: "Offerte",
        uri: { current: `/${SECOND}/offerte` },
      };
      const groups = [group("group-about", [row("a-en", DEFAULT_LOCALE, "about"), row("a-2", SECOND, "about-it")])];
      const untouched = createFakeContentLake({ documents: dataset([stampedCopy(), ...groups]) });
      const repointed = createFakeContentLake({
        documents: dataset([{ ...stampedCopy(), contact: { _type: "reference", _ref: "offerte" } }, offers, ...groups]),
      });

      await untouched.client.patch("about").set({ title: "About us, today" }).commit();
      await repointed.client.patch("about").set({ title: "About us, today" }).commit();

      assert.equal((await targetIn(untouched))?.status, "copyOfEnglish");
      assert.equal((await targetIn(repointed))?.status, "editedByHand");

      const kept = await translatePair(deps(repointed, agent(repointed).client), pair);

      assert.equal(kept.status, "skipped", JSON.stringify(kept));
      assert.equal(kept.previousStatus, "editedByHand");
      assert.equal((repointed.get("about-it")?.contact as { _ref?: string } | undefined)?._ref, "offerte");
    }
  );

  it("refuses a pair whose translation exists only inside a release, and never unlinks it", multi, async () => {
    const version = { ...stampedCopy(), _id: "versions.r1.about-it" };
    const lake = createFakeContentLake({
      documents: dataset([version, group("group-about", [row("a-en", DEFAULT_LOCALE, "about"), row("a-2", SECOND, "about-it")])]),
    });
    const { client, calls } = agent(lake);
    const target = await targetIn(lake);
    const site = (await readPlan(lake.client, {}, { now: NOW })).plan.rows.find(({ sourceId }) => sourceId === "about");
    const result = await translatePair(deps(lake, client), { ...pair, overwrite: true });

    assert.equal(target?.hold, "inRelease");
    assert.equal(target?.bulk, false);
    assert.equal(target?.staleRowKey, undefined, "the row is never replaced");
    assert.equal(site?.targets.find(({ language }) => language === SECOND)?.hold, "inRelease");
    assert.equal(result.code, "in_release", JSON.stringify(result));
    assert.equal(result.creditSpent, false);
    assert.equal(calls.length, 0);
    assert.equal((lake.get("group-about")?.translations as unknown[] | undefined)?.length, 2, "still linked");
  });

  it("picks the oldest group as the server does, and holds a source in two groups out of bulk", multi, async () => {
    const lake = createFakeContentLake({
      documents: dataset([
        group("a-newer", [row("n-en", DEFAULT_LOCALE, "about")], "2026-06-01T00:00:00Z"),
        group("z-older", [row("o-en", DEFAULT_LOCALE, "about")], "2026-01-01T00:00:00Z"),
      ]),
    });
    const site = (await readPlan(lake.client, {}, { now: NOW })).plan.rows.find(({ sourceId }) => sourceId === "about");
    const scoped = await readPlan(lake.client, { documentId: "about" }, { now: NOW });

    assert.equal(site?.metadataId, "z-older");
    assert.equal(site?.targets[0]?.hold, "twoGroups");
    assert.equal(site?.targets[0]?.bulk, false);
    assert.equal(scoped.plan.rows[0]?.metadataId, "z-older");
    assert.equal(scoped.plan.rows[0]?.targets[0]?.hold, "twoGroups");
  });

  it("never makes a new translation for a source in two groups, where the other may hold one already", multi, async () => {
    const translationInNewer = createFakeContentLake({
      documents: dataset([
        stampedCopy(),
        group("a-newer", [row("n-en", DEFAULT_LOCALE, "about"), row("n-2", SECOND, "about-it")], "2026-06-01T00:00:00Z"),
        group("z-older", [row("o-en", DEFAULT_LOCALE, "about")], "2026-01-01T00:00:00Z"),
      ]),
    });
    const translationInOlder = createFakeContentLake({
      documents: dataset([
        stampedCopy(),
        group("a-newer", [row("n-en", DEFAULT_LOCALE, "about")], "2026-06-01T00:00:00Z"),
        group("z-older", [row("o-en", DEFAULT_LOCALE, "about"), row("o-2", SECOND, "about-it")], "2026-01-01T00:00:00Z"),
      ]),
    });
    const refusing = agent(translationInNewer);
    const refused = await translatePair(deps(translationInNewer, refusing.client), pair);
    const refreshed = await translatePair(deps(translationInOlder, agent(translationInOlder).client), pair);

    assert.equal(refused.code, "two_groups", JSON.stringify(refused));
    assert.equal(refused.creditSpent, false);
    assert.equal(refusing.calls.length, 0);
    assert.equal(
      translationInNewer.documents().filter(({ language, _type }) => _type === "page" && language === SECOND).length,
      2,
      "no third page"
    );
    assert.equal(refreshed.status, "translated", JSON.stringify(refreshed));
    assert.equal(refreshed.targetId, "about-it");
  });
});

describe("a call that timed out", () => {
  it(
    "is noted against the source text, held out of bulk until that text changes, and cleared once translated",
    multi,
    async () => {
      const errors = mock.method(console, "error", () => {});

      try {
        const lake = createFakeContentLake({ documents: dataset() });
        let clock = NOW.getTime();
        // The call runs 40 s on a clock only the test moves, then times out.
        const slow = agent(lake, Object.assign(new Error("timed out"), { name: "TimeoutError" }), () => {
          clock += 40_000;
        });
        const timedOut = await translatePair(deps(lake, slow.client, { now: () => new Date(clock) }), pair);
        const marker = lake.get(timeoutMarkerId(pair));

        assert.equal(timedOut.code, "timeout");
        assert.deepEqual(marker?.timedOut, {
          sourceId: "about",
          language: SECOND,
          sourceTextHash: fingerprint(about()).textHash,
          at: new Date(clock).toISOString(),
        });

        const held = (await readPlan(lake.client, {}, { now: NOW })).plan;
        const target = held.rows.find(({ sourceId }) => sourceId === "about")?.targets[0];

        assert.equal(target?.status, "notTranslated");
        assert.equal(target?.hold, "timedOut");
        assert.equal(target?.bulk, false);
        assert.equal(held.estimate.pairs, held.rows.flatMap(({ targets }) => targets).filter(({ bulk }) => bulk).length);
        assert.deepEqual((await readPlan(lake.client, {}, { now: NOW })).savedResults, [], "never offered as a saved result");

        await lake.client.patch("about").set({ title: "About our team" }).commit();

        assert.equal((await targetIn(lake))?.hold, undefined, "a new text is worth a new try");

        const translated = await translatePair(deps(lake, agent(lake).client), pair);

        assert.equal(translated.status, "translated", JSON.stringify(translated));
        assert.equal(lake.get(timeoutMarkerId(pair)), undefined);
      } finally {
        errors.mock.restore();
      }
    }
  );

  it("is not noted when the request had too little time left for the call to finish anyway", multi, async () => {
    const errors = mock.method(console, "error", () => {});

    try {
      const lake = createFakeContentLake({ documents: dataset() });
      const failing = agent(lake, Object.assign(new Error("timed out"), { name: "TimeoutError" }));

      await translatePair(deps(lake, failing.client, { deadline: Date.now() + 30_000 }), pair);

      assert.equal(failing.calls.length, 1);
      assert.equal(lake.get(timeoutMarkerId(pair)), undefined);
    } finally {
      errors.mock.restore();
    }
  });

  it("is not noted for a gateway timeout that answered at once, so an outage holds no page out of bulk", multi, async () => {
    const errors = mock.method(console, "error", () => {});

    try {
      const lake = createFakeContentLake({ documents: dataset() });
      const gateway = agent(lake, Object.assign(new Error("Gateway Timeout"), { statusCode: 504 }));
      const result = await translatePair(deps(lake, gateway.client), pair);

      assert.equal(result.code, "timeout", JSON.stringify(result));
      assert.equal(lake.get(timeoutMarkerId(pair)), undefined);
      assert.equal((await targetIn(lake))?.hold, undefined);
    } finally {
      errors.mock.restore();
    }
  });
});

describe("the paid result", () => {
  it("is saved again after one transient failure, so a failed write still leaves it to apply for free", multi, async () => {
    const errors = mock.method(console, "error", () => {});

    try {
      const lake = createFakeContentLake({ documents: dataset() });
      const inner = lake.client.config().requestHandler as RequestHandler;
      let saveFailures = 1;
      const flaky = lake.client.withConfig({
        requestHandler: (request, next) => {
          const mutations = (request.body as { mutations?: Record<string, { _id?: string }>[] } | undefined)?.mutations ?? [];

          if (mutations.some(({ createOrReplace }) => createOrReplace?._id === RESULT_ID) && saveFailures-- > 0) {
            return Promise.reject(Object.assign(new Error("Service unavailable"), { statusCode: 503 }));
          }

          if (mutations.some(({ create }) => create?._id?.startsWith("drafts.") === true)) {
            return Promise.reject(Object.assign(new Error("Server error"), { statusCode: 500 }));
          }

          return inner(request, next);
        },
      });
      const result = await translatePair({ ...deps(lake, agent(lake).client), client: flaky }, pair);

      assert.equal(result.status, "saved_result", JSON.stringify(result));
      assert.equal(result.code, "write_failed");
      assert.ok(lake.get(RESULT_ID), "kept to apply for free");
    } finally {
      errors.mock.restore();
    }
  });
});

describe("discardSavedResult", () => {
  it("deletes the pair's saved result for free, under its lease, and says when there is none", multi, async () => {
    const saved = { _id: RESULT_ID, _type: AI_TRANSLATION_RESULT_TYPE, sourceId: "about", language: SECOND, result: "{}" };
    const lake = createFakeContentLake({ documents: dataset([saved]) });
    const lease = aiTranslationDocumentId("aiTranslation.lease", "about", SECOND);
    const busy = createFakeContentLake({
      documents: dataset([saved, { _id: lease, _type: "aiTranslation.lease", expiresAt: "2999-01-01T00:00:00Z" }]),
    });

    const discarded = await discardSavedResult(deps(lake, lake.client), { sourceId: "about", language: SECOND });
    const again = await discardSavedResult(deps(lake, lake.client), { sourceId: "about", language: SECOND });
    const waiting = await discardSavedResult(deps(busy, busy.client), { sourceId: "about", language: SECOND });

    assert.deepEqual(discarded, { sourceId: "about", language: SECOND, status: "discarded", creditSpent: false });
    assert.equal(lake.get(RESULT_ID), undefined);
    assert.equal(again.code, "no_saved_result");
    assert.equal(waiting.status, "busy");
    assert.ok(busy.get(RESULT_ID), "kept while another request holds the pair");
  });
});
