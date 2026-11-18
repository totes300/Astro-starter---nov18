import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluate, parse } from "groq-js";
import { AI_RESULTS_QUERY, type AiResultDocument, aiResultCleanupMutations, planAiResultCleanup } from "./ai-results";

// `zz` is a language nobody configures, so these never depend on LOCALES.
const labels = (pending: Record<string, Record<string, string>>, rejected: Record<string, string> = {}): AiResultDocument => ({
  _id: "aiTranslation.result.labels.all",
  _rev: "labels-rev",
  language: "all",
  result: JSON.stringify({
    pending,
    fields: Object.fromEntries(Object.keys(pending).map((id) => [id, "name"])),
    sources: Object.fromEntries(Object.keys(pending).map((id) => [id, `English ${id}`])),
    rejected,
  }),
});

describe("planAiResultCleanup", () => {
  it("deletes the removed language's saved results and timeout notes, and keeps every other language's", () => {
    const cleanup = planAiResultCleanup(
      [
        { _id: "aiTranslation.result.about.zz", language: "zz" },
        { _id: "aiTranslation.result.about.it", language: "it" },
        { _id: "aiTranslation.result.team.zz.timeout", timedOutLanguage: "zz" },
      ],
      ["zz"]
    );

    assert.deepEqual(cleanup, { deleteIds: ["aiTranslation.result.about.zz", "aiTranslation.result.team.zz.timeout"] });
  });

  it("takes the removed language out of the pending category names, so the next labels request never writes it back", () => {
    const cleanup = planAiResultCleanup([labels({ c1: { zz: "Nome", it: "Nome" }, c2: { zz: "Altro" } })], ["zz"]);
    const result = JSON.parse(String(cleanup.labels?.result));

    assert.equal(cleanup.labels?.names, 2);
    assert.deepEqual(result.pending, { c1: { it: "Nome" } });
    assert.deepEqual(result.fields, { c1: "name" });
    assert.deepEqual(result.sources, { c1: "English c1" });
    assert.deepEqual(aiResultCleanupMutations(cleanup), [
      { patch: { id: "aiTranslation.result.labels.all", ifRevisionID: "labels-rev", set: { result: cleanup.labels?.result } } },
    ]);
  });

  it("deletes the labels result once nothing is left in it, and keeps it while a rejected name still waits", () => {
    const empty = planAiResultCleanup([labels({ c1: { zz: "Nome" } })], ["zz"]);
    const rejected = planAiResultCleanup([labels({ c1: { zz: "Nome" } }, { c2: "Bad" })], ["zz"]);

    assert.deepEqual(aiResultCleanupMutations(empty), [{ delete: { id: "aiTranslation.result.labels.all" } }]);
    assert.deepEqual(JSON.parse(String(rejected.labels?.result)).pending, {});
    assert.deepEqual(planAiResultCleanup([labels({ c1: { it: "Nome" } })], ["zz"]), { deleteIds: [] });
  });

  it("reads every saved result and timeout note, and nothing else", async () => {
    const dataset = [
      { _id: "aiTranslation.result.about.zz", _type: "aiTranslation.result", language: "zz", result: "{}" },
      { _id: "aiTranslation.result.team.zz.timeout", _type: "aiTranslation.result", timedOut: { language: "zz" } },
      { _id: "aiTranslation.lease.about.zz", _type: "aiTranslation.lease", language: "zz" },
    ];
    const read = (await (await evaluate(parse(AI_RESULTS_QUERY), { dataset })).get()) as AiResultDocument[];

    assert.deepEqual(planAiResultCleanup(read, ["zz"]).deleteIds, [
      "aiTranslation.result.about.zz",
      "aiTranslation.result.team.zz.timeout",
    ]);
  });
});
