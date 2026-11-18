import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AI_TRANSLATION_DEFAULTS,
  AI_TRANSLATION_LEASE_TYPE,
  AI_TRANSLATION_LEDGER_TYPE,
  AI_TRANSLATION_RESULT_TYPE,
} from "~/sanity/constants";
import { DEFAULT_LOCALE, LOCALE_IDS } from "~/sanity/i18n";
import { createFakeContentLake } from "~/sanity/test-support/fake-content-lake";
import {
  AI_TRANSLATION_LEASE_TTL_MS,
  AI_TRANSLATION_LEDGER_ID,
  acquireLease,
  deleteResult,
  isConflict,
  ledgerDay,
  listSavedResults,
  readCreditsToday,
  readDailyCreditLimit,
  readResult,
  refundCredit,
  releaseLease,
  reserveCredit,
  saveResult,
} from "./ai-ledger";

// A plain string, so the fixtures stay valid with one locale.
const TARGET: string = LOCALE_IDS.find((locale) => locale !== DEFAULT_LOCALE) ?? "xx";
const NOW = new Date("2026-10-20T09:00:00.000Z");
const later = (ms: number) => new Date(NOW.getTime() + ms);

describe("the pair lease", () => {
  it("claims a free pair with a dotted id and type and an expiry, then answers busy until it expires", async () => {
    const lake = createFakeContentLake();
    const first = await acquireLease(lake.client, { sourceId: "page-about", language: TARGET, now: NOW });

    assert.equal(first.acquired, true);
    assert.ok(first.acquired);
    assert.equal(first.lease.id, `${AI_TRANSLATION_LEASE_TYPE}.page-about.${TARGET}`);
    assert.equal(first.lease.expiresAt, later(AI_TRANSLATION_LEASE_TTL_MS).toISOString());

    const stored = lake.get(first.lease.id);

    assert.equal(stored?._type, AI_TRANSLATION_LEASE_TYPE);
    assert.equal(stored?.token, first.lease.token);

    const second = await acquireLease(lake.client, { sourceId: "page-about", language: TARGET, now: later(1000) });

    assert.deepEqual(second, { acquired: false, expiresAt: first.lease.expiresAt });
  });

  it("keeps languages of one source and sources apart", async () => {
    const lake = createFakeContentLake();
    const a = await acquireLease(lake.client, { sourceId: "page-about", language: TARGET, now: NOW });
    const b = await acquireLease(lake.client, { sourceId: "page-about", language: "zz", now: NOW });
    const c = await acquireLease(lake.client, { sourceId: "page-team", language: TARGET, now: NOW });

    assert.deepEqual([a.acquired, b.acquired, c.acquired], [true, true, true]);
  });

  it("takes over an expired lease, so a crashed request never holds a pair for good", async () => {
    const lake = createFakeContentLake();
    const crashed = await acquireLease(lake.client, { sourceId: "page-about", language: TARGET, now: NOW, ttlMs: 1000 });
    const next = await acquireLease(lake.client, { sourceId: "page-about", language: TARGET, now: later(5000) });

    assert.ok(crashed.acquired && next.acquired);
    assert.notEqual(next.lease.token, crashed.lease.token);
    assert.equal(lake.get(next.lease.id)?.token, next.lease.token);

    // The crashed request finishing late must not delete the lease that replaced it.
    assert.equal(await releaseLease(lake.client, crashed.lease), false);
    assert.ok(lake.get(next.lease.id));
  });

  it("lets the owner it was claimed for take a live lease back, and nobody else", async () => {
    const lake = createFakeContentLake();
    const killed = await acquireLease(lake.client, { sourceId: "uri", language: "abc", now: NOW, owner: `page-about.${TARGET}` });
    const other = await acquireLease(lake.client, { sourceId: "uri", language: "abc", now: later(1000), owner: "page-team.xx" });
    const unnamed = await acquireLease(lake.client, { sourceId: "uri", language: "abc", now: later(1000) });
    const retry = await acquireLease(lake.client, {
      sourceId: "uri",
      language: "abc",
      now: later(1000),
      owner: `page-about.${TARGET}`,
    });

    assert.ok(killed.acquired && retry.acquired);
    assert.deepEqual([other.acquired, unnamed.acquired], [false, false]);
    assert.notEqual(retry.lease.token, killed.lease.token);
    assert.equal(lake.get(retry.lease.id)?.owner, `page-about.${TARGET}`);
    assert.equal(await releaseLease(lake.client, killed.lease), false, "the lease taken back is no longer the killed one's");
  });

  it("treats an unreadable expiry as expired", async () => {
    const id = `${AI_TRANSLATION_LEASE_TYPE}.page-about.${TARGET}`;
    const lake = createFakeContentLake({ documents: [{ _id: id, _type: AI_TRANSLATION_LEASE_TYPE, expiresAt: "soon" }] });
    const claim = await acquireLease(lake.client, { sourceId: "page-about", language: TARGET, now: NOW });

    assert.equal(claim.acquired, true);
  });

  it("releases its own lease, success or failure, and frees the pair at once", async () => {
    const lake = createFakeContentLake();
    const claim = await acquireLease(lake.client, { sourceId: "page-about", language: TARGET, now: NOW });

    assert.ok(claim.acquired);
    assert.equal(await releaseLease(lake.client, claim.lease), true);
    assert.equal(lake.get(claim.lease.id), undefined);
    assert.equal(await releaseLease(lake.client, claim.lease), false);

    const again = await acquireLease(lake.client, { sourceId: "page-about", language: TARGET, now: later(1000) });

    assert.equal(again.acquired, true);
  });

  it("refuses a draft or version id before writing anything", async () => {
    const lake = createFakeContentLake();

    for (const sourceId of ["drafts.page-about", "versions.r1.page-about", "", "a b"]) {
      await assert.rejects(acquireLease(lake.client, { sourceId, language: TARGET, now: NOW }), /aiTranslationDocumentId/);
    }

    assert.deepEqual(lake.mutations, []);
  });
});

describe("the daily AI request ledger", () => {
  it("counts each reservation on the one ledger and refuses at the cap without writing", async () => {
    const lake = createFakeContentLake();
    const day = ledgerDay(NOW);
    const id = AI_TRANSLATION_LEDGER_ID;

    assert.equal(day, "2026-10-20");
    assert.deepEqual(await reserveCredit(lake.client, { maxCreditsPerDay: 2, now: NOW }), {
      reserved: true,
      day,
      used: 1,
      max: 2,
    });
    assert.deepEqual(await reserveCredit(lake.client, { maxCreditsPerDay: 2, now: NOW }), {
      reserved: true,
      day,
      used: 2,
      max: 2,
    });

    const writes = lake.mutations.length;
    const refused = await reserveCredit(lake.client, { maxCreditsPerDay: 2, now: NOW });

    assert.deepEqual(refused, { reserved: false, reason: "daily_cap", day, used: 2, max: 2 });
    assert.equal(lake.mutations.length, writes);
    assert.equal(lake.get(id)?._type, AI_TRANSLATION_LEDGER_TYPE);
    assert.equal(lake.get(id)?.count, 2);
  });

  it("resets the same ledger on the next UTC day instead of starting another document", async () => {
    const lake = createFakeContentLake();

    await reserveCredit(lake.client, { maxCreditsPerDay: 1, now: NOW });

    const tomorrow = await reserveCredit(lake.client, { maxCreditsPerDay: 1, now: later(24 * 60 * 60 * 1000) });

    assert.deepEqual(tomorrow, { reserved: true, day: "2026-10-21", used: 1, max: 1 });
    assert.equal(lake.get(AI_TRANSLATION_LEDGER_ID)?.day, "2026-10-21");
    assert.equal(lake.get(AI_TRANSLATION_LEDGER_ID)?.count, 1);
    assert.equal(lake.get(`${AI_TRANSLATION_LEDGER_TYPE}.2026-10-20`), undefined);
    assert.equal(lake.get(`${AI_TRANSLATION_LEDGER_TYPE}.2026-10-21`), undefined);
  });

  it("reads a ledger left from an earlier day as zero, and a refund from that day leaves today alone", async () => {
    const lake = createFakeContentLake();
    const yesterday = await reserveCredit(lake.client, { maxCreditsPerDay: 5, now: NOW });
    const nextDay = later(24 * 60 * 60 * 1000);

    assert.equal((await readCreditsToday(lake.client, { maxCreditsPerDay: 5, now: nextDay })).used, 0);

    await reserveCredit(lake.client, { maxCreditsPerDay: 5, now: nextDay });
    await reserveCredit(lake.client, { maxCreditsPerDay: 5, now: nextDay });

    assert.equal(await refundCredit(lake.client, { day: yesterday.day }), 0);
    assert.equal((await readCreditsToday(lake.client, { maxCreditsPerDay: 5, now: nextDay })).used, 2);
  });

  it("never loses a count when reservations race: each one lands on a fresh revision", async () => {
    const lake = createFakeContentLake();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => reserveCredit(lake.client, { maxCreditsPerDay: 100, now: NOW }))
    );

    assert.ok(results.every((result) => result.reserved));
    assert.deepEqual(results.map((result) => result.used).sort(), [1, 2, 3, 4, 5]);
    assert.equal(lake.get(AI_TRANSLATION_LEDGER_ID)?.count, 5);
  });

  it("reserves with ifRevisionID on an existing ledger", async () => {
    const lake = createFakeContentLake();

    await reserveCredit(lake.client, { maxCreditsPerDay: 5, now: NOW });
    await reserveCredit(lake.client, { maxCreditsPerDay: 5, now: NOW });

    const [, second = []] = lake.mutations;
    const patch = (second[0] as { patch?: { ifRevisionID?: unknown } } | undefined)?.patch;

    assert.equal(typeof patch?.ifRevisionID, "string");
  });

  it("refuses everything with a cap of zero, and reads today's count for the plan", async () => {
    const lake = createFakeContentLake();

    assert.equal((await reserveCredit(lake.client, { maxCreditsPerDay: 0, now: NOW })).reserved, false);
    assert.deepEqual(await readCreditsToday(lake.client, { maxCreditsPerDay: 100, now: NOW }), {
      day: "2026-10-20",
      used: 0,
      max: 100,
    });

    await reserveCredit(lake.client, { maxCreditsPerDay: 100, now: NOW });

    assert.equal((await readCreditsToday(lake.client, { maxCreditsPerDay: 100, now: NOW })).used, 1);
  });

  it("reads Settings' daily limit as published, and its default when unset or not a whole number", async () => {
    const settings = (maxCreditsPerDay?: unknown) =>
      createFakeContentLake({
        documents: [{ _id: "siteSettings", _type: "siteSettings", translations: { defaults: { maxCreditsPerDay } } }],
      }).client;

    assert.equal(await readDailyCreditLimit(settings(7)), 7);

    for (const unset of [undefined, 0, 2.5, "7"]) {
      assert.equal(await readDailyCreditLimit(settings(unset)), AI_TRANSLATION_DEFAULTS.maxCreditsPerDay, String(unset));
    }

    assert.equal(await readDailyCreditLimit(createFakeContentLake().client), AI_TRANSLATION_DEFAULTS.maxCreditsPerDay);
  });

  it("refunds a request for a call refused before any work, never below zero", async () => {
    const lake = createFakeContentLake();
    const reservation = await reserveCredit(lake.client, { maxCreditsPerDay: 1, now: NOW });

    assert.equal(await refundCredit(lake.client, { day: reservation.day }), 0);
    assert.equal(await refundCredit(lake.client, { day: reservation.day }), 0);
    assert.equal((await reserveCredit(lake.client, { maxCreditsPerDay: 1, now: NOW })).reserved, true);
  });
});

describe("the saved result", () => {
  const source = {
    _id: "page-about",
    _type: "page",
    title: "⟦it⟧ About",
    author: { _type: "reference", _ref: "person-demo-author" },
  };

  it("keeps the paid result as JSON text, so its references stay inert, and reads it back", async () => {
    const lake = createFakeContentLake();
    const id = await saveResult(lake.client, {
      sourceId: "page-about",
      language: TARGET,
      result: source,
      meta: { version: "published", sourceRev: "r1" },
      now: NOW,
    });

    assert.equal(id, `${AI_TRANSLATION_RESULT_TYPE}.page-about.${TARGET}`);

    const stored = lake.get(id);

    assert.equal(stored?._type, AI_TRANSLATION_RESULT_TYPE);
    assert.equal(typeof stored?.result, "string");
    assert.doesNotMatch(JSON.stringify(stored?.meta), /_ref/);

    const read = await readResult<typeof source>(lake.client, { sourceId: "page-about", language: TARGET });

    assert.deepEqual(read, {
      id,
      sourceId: "page-about",
      language: TARGET,
      savedAt: NOW.toISOString(),
      meta: { version: "published", sourceRev: "r1" },
      result: source,
    });
  });

  it("replaces an older result for the same pair, lists what is saved, and deletes it once applied", async () => {
    const lake = createFakeContentLake();

    await saveResult(lake.client, { sourceId: "page-about", language: TARGET, result: { title: "old" }, now: NOW });
    await saveResult(lake.client, { sourceId: "page-about", language: TARGET, result: { title: "new" }, now: later(1) });
    await saveResult(lake.client, { sourceId: "page-team", language: TARGET, result: { title: "team" }, now: NOW });

    const read = await readResult<{ title: string }>(lake.client, { sourceId: "page-about", language: TARGET });

    assert.equal(read?.result.title, "new");
    assert.deepEqual(
      (await listSavedResults(lake.client)).map(({ sourceId, language }) => [sourceId, language]),
      [
        ["page-about", TARGET],
        ["page-team", TARGET],
      ]
    );

    await deleteResult(lake.client, { sourceId: "page-about", language: TARGET });

    assert.equal(await readResult(lake.client, { sourceId: "page-about", language: TARGET }), null);
    assert.equal((await listSavedResults(lake.client)).length, 1);
  });

  it("reads nothing for a pair with no result, or one whose text is not JSON", async () => {
    const id = `${AI_TRANSLATION_RESULT_TYPE}.page-about.${TARGET}`;
    const lake = createFakeContentLake({ documents: [{ _id: id, _type: AI_TRANSLATION_RESULT_TYPE, result: "{not json" }] });

    assert.equal(await readResult(lake.client, { sourceId: "page-team", language: TARGET }), null);
    assert.equal(await readResult(lake.client, { sourceId: "page-about", language: TARGET }), null);
  });
});

describe("isConflict", () => {
  it("matches only a 409", () => {
    assert.equal(isConflict({ statusCode: 409 }), true);
    assert.equal(isConflict({ statusCode: 404 }), false);
    assert.equal(isConflict(new Error("x")), false);
    assert.equal(isConflict(null), false);
  });
});
