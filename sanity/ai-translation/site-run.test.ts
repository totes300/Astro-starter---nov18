// The whole-site panel's rules over a hand-built plan: no route, no Studio, no network.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AI_TRANSLATION_STYLE_GUIDE_LIMIT } from "../constants";
import { run as runBlock } from "../lib/run";
import type { ApiResult } from "./api";
import {
  type LabelItem,
  type PlanRow,
  type PlanTarget,
  type RunStep,
  TRANSLATION_STATUSES,
  type TranslationStatus,
} from "./plan";
import { type LabelsJob, type PairJob, RUN_STEPS, type RunJob, relinkAll, siteRunJobs, type TranslationRun } from "./run-store";
import {
  aiDraftsCopy,
  allDoneNote,
  cellText,
  confirmCopy,
  countsCopy,
  defaultPlanFilter,
  defaultSiteRunOptions,
  draftsToPublish,
  filterPlanGroups,
  freshestCreditsToday,
  groupCountsCopy,
  isConfirmationTyped,
  type LanguageCounts,
  latestCreditsToday,
  missingLanguageCopy,
  needsTypedConfirmation,
  PLAN_PAGE_SIZE,
  panelBusyCopy,
  plainLabelsCopy,
  planTotals,
  publishButtonText,
  publishConfirmCopy,
  publishCopy,
  publishInBatches,
  rowNeedsTranslation,
  runBlocks,
  runCostCopy,
  runCreditLimit,
  runSpend,
  runSummary,
  SITE_GROUP_TITLES,
  type SiteCell,
  type SiteGroup,
  type SiteRow,
  type SiteRunOptions,
  SWITCHED_OFF_NOTE,
  savedResultItems,
  showMoreCopy,
  showsSwitchedOff,
  sitePlanView,
  siteRunAnnouncement,
  skippedDrafts,
  startBlock,
  stopButtonText,
  styleGuideRoom,
  styleGuideRoomCopy,
  translateButtonText,
} from "./site-run";
import { TEST_LOCALES } from "./test-fixtures";
import type { PairResult, PlanResponse, PublishResult, RelinkResult } from "./wire";

// Built from code points, so this file itself holds no en or em dash.
const DASHES = new RegExp(`[${String.fromCodePoint(0x2013, 0x2014)}]`);

function target(language: string, status: TranslationStatus, extra: Partial<PlanTarget> = {}): PlanTarget {
  return { language, status, hasDraft: false, bulk: false, ...extra };
}

function row(sourceId: string, step: RunStep, targets: PlanTarget[], extra: Partial<PlanRow> = {}): PlanRow {
  return {
    sourceId,
    type: step === "homepage" ? "page" : step,
    title: sourceId,
    step,
    version: "published",
    hasUnpublishedChanges: false,
    targets,
    ...extra,
  };
}

const label = (id: string, missing: string[]): LabelItem => ({ id, type: "articleCategory", field: "name", text: id, missing });

function response(extra: Partial<PlanResponse> = {}): PlanResponse {
  const rows = [
    row("demo-author", "person", [target("it", "notTranslated"), target("de", "upToDate")]),
    row("article-a", "article", [target("it", "englishChanged"), target("de", "editedByHand")]),
    row("about", "page", [target("it", "copyOfEnglish", { targetId: "about-it" }), target("de", "notTranslated")]),
    row("draft-only", "page", [target("it", "notTranslated"), target("de", "notTranslated")], {
      skipped: "notPublished",
      version: undefined,
    }),
    row("home", "homepage", [target("it", "translatedByHand"), target("de", "copyOfEnglish", { targetId: "home-de" })]),
  ];

  return {
    defaultLocale: "en",
    locales: [...TEST_LOCALES],
    settings: {
      defaults: {
        languages: ["de", "fr"],
        policy: "missing",
        slugs: "translate",
        afterTranslate: "draft",
        maxCreditsPerRun: 25,
        maxCreditsPerDay: 100,
      },
      styleGuideLength: 0,
      styleGuideByLanguage: { it: 0, de: 0 },
      protectedPhrases: 0,
      glossaryTerms: 0,
      languageNotes: [],
    },
    plan: {
      rows,
      labels: [label("category-a", ["it", "de"]), label("category-b", ["de"])],
      labelBatches: [],
      missingLanguage: [],
      summary: {},
      estimate: { pairs: 0, labels: 0, labelBatches: 0, credits: 0 },
    },
    creditsToday: { day: "2026-10-20", used: 3, max: 100 },
    schema: { deployedAt: "2026-10-19T21:20:50Z", drift: [], ok: true },
    blocked: null,
    savedResults: [],
    ...extra,
  };
}

function counts(
  byStatus: Partial<Record<TranslationStatus, number>>,
  labels = 0,
  extra: Partial<LanguageCounts> = {}
): LanguageCounts {
  const none = Object.fromEntries(TRANSLATION_STATUSES.map((status) => [status, 0])) as Record<TranslationStatus, number>;

  return {
    toTranslate: 0,
    byStatus: { ...none, ...byStatus },
    unlinked: 0,
    held: 0,
    aiDrafts: 0,
    labels,
    labelsByHand: 0,
    people: 0,
    ...extra,
  };
}

const options = (extra: Partial<SiteRunOptions> = {}): SiteRunOptions => ({
  languages: ["it", "de"],
  policy: "missing",
  slugs: "translate",
  publish: false,
  maxCredits: 25,
  ...extra,
});

function pairJob(sourceId: string, language: string, state: PairJob["state"], result?: Partial<PairResult>): PairJob {
  return {
    id: `${sourceId}.${language}`,
    kind: "pair",
    step: "page",
    key: `source:${sourceId}`,
    title: sourceId,
    state,
    attempts: 1,
    retries: { rateLimited: 0, busy: 0, outOfTime: 0 },
    startedAt: 1_000,
    finishedAt: 2_000,
    creditSpent: result?.creditSpent ?? false,
    creditMayBeSpent: result?.creditSpent ?? false,
    input: { sourceId, language, version: "published", overwrite: false, instructions: "" },
    sourceId,
    language,
    ...(result
      ? {
          result: {
            status: "translated",
            sourceId,
            language,
            creditSpent: false,
            durationMs: 1,
            ...result,
          },
        }
      : {}),
  };
}

function labelsJob(state: LabelsJob["state"], result: Partial<NonNullable<LabelsJob["result"]>>): LabelsJob {
  return {
    id: `labels.${state}`,
    kind: "labels",
    step: "labels",
    key: "labels",
    title: "Category names",
    state,
    attempts: 1,
    retries: { rateLimited: 0, busy: 0, outOfTime: 0 },
    creditSpent: true,
    creditMayBeSpent: true,
    input: { ids: ["category-a"], publish: false },
    result: { status: "translated", creditSpent: true, languages: ["it"], remaining: 0, durationMs: 1, ...result },
  };
}

function siteRun(jobs: RunJob[], extra: Partial<TranslationRun> = {}): TranslationRun {
  return {
    id: "run-1",
    scope: { kind: "site" },
    publish: false,
    maxCredits: 25,
    status: "done",
    startedAt: 0,
    finishedAt: 5_000,
    jobs,
    ...extra,
  };
}

describe("the run's options", () => {
  it("start from the published defaults, keeping only configured languages", () => {
    assert.deepEqual(defaultSiteRunOptions(response()), {
      languages: ["de"],
      policy: "missing",
      slugs: "translate",
      publish: false,
      maxCredits: 25,
    });

    const none = response();

    none.settings.defaults = { ...none.settings.defaults, languages: ["fr"], afterTranslate: "publish" };

    assert.deepEqual(defaultSiteRunOptions(none).languages, ["it", "de"]);
    assert.equal(defaultSiteRunOptions(none).publish, true);
  });

  it("keeps a typed credit limit within Settings' bounds", () => {
    assert.equal(runCreditLimit("40", 25), 40);
    assert.equal(runCreditLimit(12.7, 25), 12);
    assert.equal(runCreditLimit(0, 25), 25);
    assert.equal(runCreditLimit("", 25), 25);
    assert.equal(runCreditLimit("abc", 25), 25);
    assert.equal(runCreditLimit(9000, 25), 500);
  });
});

describe("the site plan seen through the run's options", () => {
  it("recomputes bulk for the policy, skips unpublished sources and counts each language", () => {
    const view = sitePlanView(response(), options());

    assert.deepEqual(
      view.groups.map(({ step, rows }) => [step, rows.length]),
      [
        ["labels", 2],
        ["person", 1],
        ["article", 1],
        ["page", 2],
        ["homepage", 1],
      ]
    );
    assert.equal(view.pairs, 4);
    assert.equal(view.documents, 3);
    assert.equal(view.labels, 2);
    assert.deepEqual(view.estimate, { pairs: 4, labels: 2, labelBatches: 1, credits: 5 });
    assert.equal(view.counts.it?.toTranslate, 2);
    assert.equal(view.counts.it?.byStatus.notTranslated, 1, "the unpublished source counts nowhere");
    assert.equal(view.counts.de?.toTranslate, 2);

    const refresh = sitePlanView(response(), options({ policy: "refresh" }));

    assert.equal(refresh.pairs, 5);
    assert.equal(refresh.counts.it?.toTranslate, 3);
  });

  it("points each row's title at its source, and a category name at its category", () => {
    const view = sitePlanView(response(), options());

    assert.deepEqual(
      view.groups.flatMap(({ rows }) => rows.map(({ documentId, type }) => `${type}:${documentId}`)),
      [
        "articleCategory:category-a",
        "articleCategory:category-b",
        "person:demo-author",
        "article:article-a",
        "page:about",
        "page:draft-only",
        "page:home",
      ]
    );
  });

  it("narrows to the ticked languages, labels and their batches included", () => {
    const view = sitePlanView(response(), options({ languages: ["it"] }));

    assert.deepEqual(
      view.languages.map(({ id }) => id),
      ["it"]
    );
    assert.equal(view.labels, 1);
    assert.deepEqual(view.plan.labels, [label("category-a", ["it"])]);
    assert.deepEqual(
      view.plan.rows.flatMap(({ targets }) => targets.map(({ language }) => language)),
      ["it", "it", "it", "it", "it"]
    );
    assert.deepEqual(view.estimate, { pairs: 2, labels: 1, labelBatches: 1, credits: 3 });

    const jobs = siteRunJobs({ plan: view.plan }, { publish: false, languages: ["it"] });

    assert.deepEqual(
      jobs.map((job) => (job.kind === "pair" ? `${job.input.sourceId}.${job.input.language}` : job.kind)),
      ["labels", "demo-author.it", "about.it"]
    );
  });

  it("leaves out a pair whose paid result is saved, since applying it is free", () => {
    const saved = response({
      savedResults: [{ sourceId: "demo-author", language: "it", savedAt: "2026-10-20T10:00:00Z" }],
    });
    const view = sitePlanView(saved, options());
    const cell = view.groups.find(({ step }) => step === "person")?.rows[0]?.cells.find(({ language }) => language === "it");

    assert.equal(view.pairs, 3);
    assert.equal(view.documents, 2);
    assert.deepEqual(view.estimate, { pairs: 3, labels: 2, labelBatches: 1, credits: 4 });
    assert.equal(view.counts.it?.toTranslate, 1);
    assert.deepEqual(cell, { language: "it", status: "notTranslated", bulk: false, saved: true });
    assert.deepEqual(cellText(cell as never), {
      text: "Not translated yet",
      hint: "A paid result is saved: apply or discard it under Saved results, for free.",
    });
    assert.deepEqual(
      siteRunJobs({ plan: view.plan }, { publish: false }).flatMap((job) =>
        job.kind === "pair" ? [`${job.input.sourceId}.${job.input.language}`] : []
      ),
      ["about.it", "about.de", "home.de"]
    );
  });

  it("is empty when no language is ticked", () => {
    const view = sitePlanView(response(), options({ languages: [] }));

    assert.equal(view.pairs, 0);
    assert.equal(view.labels, 0);
    assert.equal(startBlock({ view, response: response() })?.code, "no_languages");
  });

  it("never runs a language that already has its own document there, and carries it to link instead", () => {
    const linked = response();

    linked.plan.rows = [
      row("home", "homepage", [
        target("it", "notTranslated", { unlinkedId: "home-it", unlinkedTitle: "Casa", bulk: true }),
        target("de", "notTranslated"),
      ]),
    ];

    const view = sitePlanView(linked, options());
    const cells = view.groups.find(({ step }) => step === "homepage")?.rows[0]?.cells ?? [];

    assert.deepEqual(
      cells.map(({ language, bulk, unlinkedId, unlinkedTitle }) => [language, bulk, unlinkedId, unlinkedTitle]),
      [
        ["it", false, "home-it", "Casa"],
        ["de", true, undefined, undefined],
      ]
    );
    assert.equal(view.pairs, 1);
    assert.deepEqual(
      siteRunJobs({ plan: view.plan }, { publish: false }).flatMap((job) =>
        job.kind === "pair" ? [`${job.input.sourceId}.${job.input.language}`] : []
      ),
      ["home.de"]
    );
    assert.deepEqual(cellText(cells[0] as SiteCell), {
      text: "Not linked",
      hint: "This language already has its own version, not linked as its translation. Link it with Translate with AI on the English page instead of translating.",
    });
    assert.equal(view.counts.it?.unlinked, 1);
    assert.equal(view.counts.it?.byStatus.notTranslated, 0);
    assert.equal(countsCopy(view.counts.it as LanguageCounts), "1 not linked, 1 category name not translated yet");
    assert.doesNotMatch(countsCopy(view.counts.it as LanguageCounts), /Translations menu/, "that menu cannot link");
  });

  it("never puts a held target in a run, whatever its status, and says why it is left out", () => {
    const held = response();

    held.plan.rows = [
      row("about", "page", [
        target("it", "notTranslated", { hold: "inRelease" }),
        target("de", "copyOfEnglish", { targetId: "about-de", hold: "twoGroups" }),
      ]),
      row("long", "article", [
        target("it", "notTranslated", { hold: "timedOut" }),
        target("de", "englishChanged", { targetId: "long-de", hold: "timedOut" }),
      ]),
    ];

    const view = sitePlanView(held, options({ policy: "refresh" }));
    const cell = (sourceId: string, language: string) =>
      view.groups
        .flatMap(({ rows }) => rows)
        .find(({ id }) => id === sourceId)
        ?.cells.find((each) => each.language === language) as SiteCell;

    assert.equal(view.pairs, 0, "the plan's own bulk is recomputed here, so the hold must be too");
    assert.deepEqual(
      [cell("about", "it"), cell("about", "de"), cell("long", "it"), cell("long", "de")].map(({ bulk, hold }) => [bulk, hold]),
      [
        [false, "inRelease"],
        [false, "twoGroups"],
        [false, "timedOut"],
        [false, "timedOut"],
      ]
    );
    assert.deepEqual(
      siteRunJobs({ plan: view.plan }, { publish: false }).filter((job) => job.kind === "pair"),
      []
    );
    assert.equal(view.counts.it?.held, 2);
    assert.equal(view.counts.it?.byStatus.notTranslated, 0);
    assert.match(countsCopy(view.counts.it as LanguageCounts), /^2 left out of whole-site runs/);
    assert.equal(cellText(cell("about", "it")).text, "In a release");
    assert.match(cellText(cell("about", "de")).hint ?? "", /two translation groups/);
    assert.match(cellText(cell("long", "de")).hint ?? "", /^English updated since\. .*ran out of time/);
  });

  it("counts an unpublished AI draft apart from what is translated, and says so on its row", () => {
    const drafted = response();

    drafted.plan.rows = [
      row("about", "page", [
        target("it", "upToDate", { targetId: "about-it", hasDraft: true, aiDraft: true }),
        target("de", "upToDate", { targetId: "about-de" }),
      ]),
    ];
    drafted.plan.labels = [];

    const view = sitePlanView(drafted, options());
    const [italian, german] = view.groups[0]?.rows[0]?.cells ?? [];

    assert.equal(view.counts.it?.aiDrafts, 1);
    assert.equal(view.counts.it?.byStatus.upToDate, 0, "the site does not show it yet");
    assert.equal(countsCopy(view.counts.it as LanguageCounts), "1 AI draft not published");
    assert.equal(countsCopy(view.counts.de as LanguageCounts), "1 translated");
    assert.deepEqual(cellText(italian as SiteCell), { text: "Translated by AI", hint: "Draft, not published." });
    assert.deepEqual(cellText(german as SiteCell), { text: "Translated by AI" });
  });

  it("leaves a category name to fill in by hand out of the batches, the estimate and the button", () => {
    const named = response();

    named.plan.labels = [
      label("category-a", ["it", "de"]),
      { ...label("category-long", ["it"]), handFix: "sourceFailsChecks" },
      { ...label("category-rejected", ["it", "de"]), handFix: "rejectedBefore" },
    ];
    named.plan.rows = [];

    const view = sitePlanView(named, options());
    const rows = view.groups.find(({ step }) => step === "labels")?.rows ?? [];

    assert.equal(view.labels, 1);
    assert.deepEqual(view.estimate, { pairs: 0, labels: 1, labelBatches: 1, credits: 1 });
    assert.deepEqual(
      view.plan.labelBatches.map((batch) => batch.map(({ id }) => id)),
      [["category-a"]]
    );
    assert.equal(translateButtonText(view), "Translate 1 category name");
    assert.deepEqual(
      rows.map(({ id, cells }) => [id, cells.map(({ bulk, handFix }) => `${bulk}:${handFix ?? "-"}`)]),
      [
        ["category-a.name", ["true:-", "true:-"]],
        ["category-long.name", ["false:sourceFailsChecks", "false:-"]],
        ["category-rejected.name", ["false:rejectedBefore", "false:rejectedBefore"]],
      ]
    );
    assert.equal(cellText(rows[1]?.cells[0] as SiteCell, { source: "English" }).text, "Fill in by hand");
    assert.match(cellText(rows[2]?.cells[0] as SiteCell).hint ?? "", /not asked again until the English name changes/);
    assert.equal(
      countsCopy(view.counts.it as LanguageCounts),
      "1 category name not translated yet, 2 category names to fill in by hand"
    );

    const handOnly = sitePlanView({ ...named, plan: { ...named.plan, labels: named.plan.labels.slice(1) } }, options());

    assert.equal(startBlock({ view: handOnly, response: named })?.code, "nothing");
    assert.equal(handOnly.labelsByHand, 2);
    assert.equal(
      allDoneNote(handOnly),
      "2 category names are left to fill in by hand. Fill them in, or change the English name and run again.",
      "nothing left to ask is not nothing missing"
    );
    assert.equal(
      allDoneNote(sitePlanView({ ...named, plan: { ...named.plan, labels: [] } }, options())),
      undefined,
      "no hand fix, no note"
    );
    assert.equal(
      sitePlanView({ ...named, plan: { ...named.plan, labels: named.plan.labels.slice(1) } }, options({ languages: ["de"] }))
        .labelsByHand,
      1,
      "only the ticked languages count"
    );
  });

  it("counts each language in a few words, the unpublished source left out", () => {
    const view = sitePlanView(response(), options());

    assert.ok(view.counts.it && view.counts.de);
    assert.equal(
      countsCopy(view.counts.it),
      "1 not translated yet, 1 still in English, 2 translated, 1 category name not translated yet"
    );
    assert.equal(
      countsCopy(view.counts.de, "German"),
      "1 not translated yet, 1 still in German, 2 translated, 2 category names not translated yet"
    );

    const done = sitePlanView(
      response({ plan: { ...response().plan, rows: [row("x", "page", [target("it", "upToDate")])], labels: [] } }),
      options({ languages: ["it"] })
    );
    const empty = sitePlanView(response({ plan: { ...response().plan, rows: [], labels: [] } }), options());

    assert.equal(countsCopy(done.counts.it as LanguageCounts), "1 translated");
    assert.equal(countsCopy(empty.counts.it as LanguageCounts), "nothing to translate");
  });

  it("counts every page with a translation as translated, AI or not, and leaves out what is zero", () => {
    assert.equal(
      countsCopy(counts({ upToDate: 1_200, englishChanged: 1, layoutChanged: 1, editedByHand: 1, translatedByHand: 1 })),
      "1,204 translated"
    );
    assert.equal(countsCopy(counts({ notTranslated: 2 })), "2 not translated yet");
    assert.equal(countsCopy(counts({ copyOfEnglish: 3 })), "3 still in English");
    assert.equal(countsCopy(counts({}, 1)), "1 category name not translated yet");
    assert.equal(countsCopy(counts({}, 2)), "2 category names not translated yet");
    assert.equal(countsCopy(counts({}, 0, { labelsByHand: 1, unlinked: 2 })), "2 not linked, 1 category name to fill in by hand");
    assert.equal(
      countsCopy(counts({ upToDate: 3 }, 0, { aiDrafts: 2, held: 1 })),
      "3 translated, 2 AI drafts not published, 1 left out of whole-site runs"
    );
    assert.equal(countsCopy(counts({})), "nothing to translate");
  });

  it("words each cell as the document dialog does, dated when the record was read", () => {
    const at = "2026-10-20T12:00:00Z";

    assert.deepEqual(cellText({ language: "it", status: "notTranslated", bulk: true }), { text: "Not translated yet" });
    assert.deepEqual(cellText({ language: "it", status: "editedByHand", bulk: false }), {
      text: "Edited since the AI translation",
    });
    assert.deepEqual(cellText({ language: "it", status: "translatedByHand", bulk: false }), { text: "Written by hand" });
    assert.deepEqual(
      cellText({ language: "it", status: "englishChanged", bulk: false }, { source: "German", translatedAt: at }),
      {
        text: "Translated by AI on 20 Oct 2026",
        hint: "German updated since.",
      }
    );
    assert.deepEqual(cellText({ language: "it", status: "upToDate", bulk: false }), { text: "Translated by AI" });
    assert.deepEqual(cellText({ language: "it", status: "notTranslated", bulk: true, isName: true }), {
      text: "Not translated yet",
    });
    assert.deepEqual(cellText({ language: "it", status: "upToDate", bulk: false, isName: true }), { text: "Translated" });
  });

  it("carries each translation's id, so its date can be read", () => {
    const view = sitePlanView(response(), options());
    const about = view.groups.find(({ step }) => step === "page")?.rows.find(({ id }) => id === "about");
    const category = view.groups.find(({ step }) => step === "labels")?.rows[0];

    assert.equal(about?.cells.find(({ language }) => language === "it")?.targetId, "about-it");
    assert.equal(
      category?.cells.every(({ isName }) => isName),
      true
    );
  });

  it("names the button after what runs", () => {
    assert.equal(translateButtonText({ documents: 3, labels: 2 }), "Translate 3 pages");
    assert.equal(translateButtonText({ documents: 1, labels: 0 }), "Translate 1 page");
    assert.equal(translateButtonText({ documents: 0, labels: 2 }), "Translate 2 category names");
    assert.equal(translateButtonText({ documents: 0, labels: 0 }), "Nothing to translate");
  });
});

describe("what blocks a run", () => {
  it("blocks on schema drift, from the plan or the check, and on the daily cap, in that order", () => {
    const all = response({
      blocked: { code: "schema_drift", message: "x" },
      schema: { deployedAt: null, drift: ["page.aiTranslation"], ok: false },
      creditsToday: { day: "d", used: 120, max: 100 },
    });

    assert.deepEqual(
      runBlocks(all).map(({ code }) => code),
      ["schema_drift", "daily_cap"]
    );
    assert.match(
      runBlocks(response({ blocked: { code: "schema_drift", message: "x" } }))[0]?.message ?? "",
      /Ask a developer to run npm run sanity:schema-deploy/
    );
    assert.equal(runBlocks(response({ creditsToday: { day: "d", used: 100, max: 100 } }))[0]?.code, "daily_cap");
    assert.deepEqual(runBlocks(response()), []);
  });

  it("starts a run over this run's limit, which stops at it, and refuses one a block refuses", () => {
    const view = sitePlanView(response(), options());

    assert.equal(startBlock({ view, response: response() }), null, "an estimate of 5 starts under a limit of 4");
    assert.equal(
      startBlock({ view, response: response({ creditsToday: { day: "d", used: 100, max: 100 } }) })?.code,
      "daily_cap"
    );

    const nothing = sitePlanView(response({ plan: { ...response().plan, rows: [], labels: [] } }), options());

    assert.equal(startBlock({ view: nothing, response: response() })?.code, "nothing");
  });

  it("costs what the run may spend: the estimate, or the limit it stops at", () => {
    assert.equal(runSpend({ credits: 620 }, 500), 500);
    assert.equal(runSpend({ credits: 5 }, 25), 5);
    assert.equal(runCostCopy({ credits: 5 }, 25), "5 AI requests");
    assert.equal(runCostCopy({ credits: 620 }, 500), "500 of 620 AI requests this run");
  });

  it("asks for the word typed out only above 50 AI requests the run may make, so a default run asks for a click", () => {
    assert.equal(needsTypedConfirmation(25), false, "Settings' default run limit");
    assert.equal(needsTypedConfirmation(50), false);
    assert.equal(needsTypedConfirmation(51), true);
    assert.equal(needsTypedConfirmation(runSpend({ credits: 620 }, 500)), true, "a run over its limit still asks");
    assert.equal(needsTypedConfirmation(runSpend({ credits: 620 }, 5)), false, "it spends 5 at most");
    assert.equal(isConfirmationTyped(" Translate "), true);
    assert.equal(isConfirmationTyped("translat"), false);
  });
});

describe("the confirm copy", () => {
  it("lists what runs, the cost and what is left alone", () => {
    const view = sitePlanView(response(), options());
    const copy = confirmCopy({ view, run: options(), response: response() });

    assert.equal(copy.summary, "3 pages and 2 category names into Italian and German.", "prose names languages in English");
    assert.deepEqual(copy.lines.slice(0, 3), [
      "Italiano: 2 pages",
      "Deutsch: 2 pages",
      "Makes 5 AI requests. Uses your Sanity organization's AI credits. Check usage in your organization settings.",
    ]);
    assert.ok(copy.lines.includes("Everything is saved as drafts to review."));
    assert.ok(
      copy.lines.includes(
        "Only pages not translated yet are translated; AI translations whose English was updated stay as they are."
      )
    );
    assert.ok(copy.lines.includes("Pages edited since the AI translation or written by hand are left as they are."));
    assert.ok(
      confirmCopy({ view, run: options({ policy: "refresh" }), response: response() }).lines.includes(
        "AI translations whose English was updated are translated again."
      )
    );
    assert.ok(copy.lines.includes("AI requests today: 3 of 100."));
    assert.deepEqual(copy.cautions, []);

    assert.ok(
      confirmCopy({ view, run: options({ publish: true }), response: response() }).lines.includes(
        "Each translation is published as soon as it is done, then the links on other pages are updated to point at it."
      )
    );

    const tight = confirmCopy({
      view,
      run: options(),
      response: response({ creditsToday: { day: "d", used: 98, max: 100 } }),
    });

    assert.deepEqual(tight.cautions, ["Only 2 AI requests left today: the run stops at today's limit."]);
  });

  it("says a run over its limit stops there, how much it does now, and that the next run continues", () => {
    const view = sitePlanView(response(), options());
    const copy = confirmCopy({ view, run: options({ maxCredits: 4 }), response: response() });

    assert.ok(
      copy.lines.includes(
        "Makes up to 4 AI requests, this run's limit. Uses your Sanity organization's AI credits. Check usage in your organization settings."
      )
    );
    assert.deepEqual(copy.cautions, [
      "This run needs 5 AI requests, over its limit of 4: it stops there, with about 4 of the 5 translations done. Publish its drafts, then translate the site again to continue: the next run picks up the rest.",
    ]);
    assert.ok(
      confirmCopy({ view, run: options({ maxCredits: 4, publish: true }), response: response() }).cautions[0]?.endsWith(
        "done. Translate the site again to continue: the next run picks up the rest."
      ),
      "a run that publishes leaves no drafts to publish first"
    );

    const tight = confirmCopy({
      view,
      run: options({ maxCredits: 4 }),
      response: response({ creditsToday: { day: "d", used: 97, max: 100 } }),
    });

    assert.equal(tight.cautions.length, 2, "3 left today is under the 4 this run may spend");
    assert.equal(
      confirmCopy({
        view,
        run: options({ maxCredits: 4 }),
        response: response({ creditsToday: { day: "d", used: 96, max: 100 } }),
      }).cautions.length,
      1,
      "4 left today covers what the run may spend"
    );
  });
});

describe("a run in progress", () => {
  it("words Stop after what is in flight", () => {
    assert.equal(stopButtonText({ status: "running" }, { running: 2 }), "Stop after the 2 running");
    assert.equal(stopButtonText({ status: "running" }, { running: 0 }), "Stop");
    assert.equal(stopButtonText({ status: "stopping" }, { running: 1 }), "Stopping...");
  });

  it("keeps the live line free of the ticking timer", () => {
    const run = siteRun([pairJob("a", "it", "done", { creditSpent: true }), pairJob("b", "it", "running")], {
      status: "running",
      finishedAt: undefined,
    });
    const early = siteRunAnnouncement({ ...run, startedAt: 9_000 });
    const later = siteRunAnnouncement({ ...run, startedAt: 0 });

    assert.equal(early, "1 of 2 done, 1 AI request made");
    assert.equal(later, early);
  });

  it("announces progress while it runs and the outcome once it ends, never the timer", () => {
    const running = siteRun([pairJob("a", "it", "done", { creditSpent: true }), pairJob("b", "it", "running")], {
      status: "running",
      finishedAt: undefined,
    });
    const finished = siteRun([pairJob("a", "it", "done", { creditSpent: true }), pairJob("b", "it", "failed")]);
    const lost = siteRun(
      [pairJob("a", "it", "done", { creditSpent: true }), { ...pairJob("b", "it", "running"), creditMayBeSpent: true }],
      { status: "running", finishedAt: undefined }
    );

    assert.equal(siteRunAnnouncement(running), "1 of 2 done, 1 AI request made");
    assert.equal(
      siteRunAnnouncement(lost),
      "1 of 2 done, 1 AI request made, 1 more may still count",
      "the words the document dialog uses for the same run"
    );
    assert.equal(siteRunAnnouncement(finished), "Translation finished. 1 translated, 1 failed.");
    assert.match(siteRunAnnouncement({ ...finished, status: "stopped" }), /^Translation stopped\./);
    assert.equal(siteRunAnnouncement(null), "");
  });

  it("reads the freshest daily count from the results", () => {
    const older = pairJob("a", "it", "done", { credits: { day: "d", used: 4, max: 100 } });
    const newer = { ...pairJob("b", "it", "done", { credits: { day: "d", used: 5, max: 100 } }), finishedAt: 3_000 };

    assert.deepEqual(latestCreditsToday(siteRun([newer, older])), { day: "d", used: 5, max: 100 });
    assert.equal(latestCreditsToday(siteRun([pairJob("c", "it", "failed")])), undefined);

    const plan = { day: "d", used: 7, max: 100 };

    assert.equal(freshestCreditsToday(siteRun([newer]), plan), plan);
    assert.deepEqual(freshestCreditsToday(siteRun([newer]), { ...plan, used: 2 }), newer.result?.credits);
    assert.deepEqual(freshestCreditsToday(siteRun([newer]), { day: "c", used: 9, max: 100 }), newer.result?.credits);
    assert.equal(freshestCreditsToday(null, plan), plan);
  });
});

describe("the summary", () => {
  it("counts the outcome, lists failures with their reason and what to apply later", () => {
    const failed: PairJob = { ...pairJob("b", "it", "failed"), message: "Sanity AI could not translate this document." };
    const run = siteRun(
      [
        pairJob("a", "it", "done", { creditSpent: true, targetId: "a-it" }),
        pairJob("p", "it", "done", { creditSpent: true, targetId: "p-it", published: true }),
        failed,
        pairJob("c", "it", "saved_result", { status: "saved_result", creditSpent: true }),
        pairJob("d", "it", "stopped"),
      ],
      { status: "stopped", stopReason: { code: "credit_cap", message: "Stopped at this run's limit." } }
    );
    const summary = runSummary(run);

    assert.equal(summary.tone, "caution");
    assert.equal(summary.headline, "2 translated, 1 failed, 1 saved, not applied, 1 not started.");
    assert.equal(summary.credits, "3 AI requests made.");
    assert.equal(summary.stopped, "Stopped at this run's limit.");
    assert.deepEqual(summary.failures, [
      { id: "b.it", title: "b", language: "it", message: "Sanity AI could not translate this document." },
    ]);
    assert.deepEqual(summary.savedResults, [{ sourceId: "c", language: "it", title: "c" }]);
    assert.equal(summary.published, 1);
  });

  it("is positive when everything went through, and counts credits as the document dialog does", () => {
    const run = siteRun([
      pairJob("a", "it", "done", { creditSpent: true, targetId: "a-it" }),
      pairJob("b", "it", "done", { creditSpent: true, targetId: "b-it", published: true }),
    ]);
    const summary = runSummary(run);

    assert.equal(summary.tone, "positive");
    assert.equal(summary.credits, "2 AI requests made.");
    assert.equal(
      runSummary(siteRun([{ ...pairJob("a", "it", "failed"), creditMayBeSpent: true }])).credits,
      "0 AI requests made, 1 more may still count."
    );
    assert.equal(runSummary(siteRun([pairJob("a", "it", "skipped")])).credits, "No AI requests made.");
  });

  it("counts the category names a refused batch still wrote", () => {
    const run = siteRun([
      labelsJob("done", { written: ["category-a"], labels: { "category-a": { it: "Contenuti" } } }),
      labelsJob("failed", { status: "refused", written: ["category-b"] }),
    ]);

    assert.equal(runSummary(run).categoryNames, 2);
  });
});

describe("the AI drafts to publish", () => {
  const drafted = (aiDrafts: string[] | undefined) =>
    response({
      plan: {
        ...response().plan,
        rows: [row("about", "page", [target("it", "upToDate", { targetId: "about-it", hasDraft: true, aiDraft: true })])],
        labels: [label("category-c", ["de"])],
        ...(aiDrafts ? { aiDrafts } : {}),
      },
    });

  it("come from the plan, whatever run left them, so Dismiss, a reload or the next run never loses them", () => {
    const drafts = draftsToPublish(drafted(["about-it", "category-c", "category-d"]));

    assert.deepEqual(drafts, { ids: ["about-it", "category-c", "category-d"], translations: 1, categoryNames: 2 });
    assert.equal(publishButtonText(drafts), "Publish 3 AI drafts");
    assert.equal(publishButtonText({ ids: ["a"] }), "Publish 1 AI draft");
    assert.equal(aiDraftsCopy(drafts), "1 translation and 2 category names the AI wrote are saved as drafts, not published yet.");
    assert.equal(
      aiDraftsCopy({ ids: ["a"], translations: 1, categoryNames: 0 }),
      "1 translation the AI wrote is saved as a draft, not published yet."
    );
  });

  it("offer nothing when the plan lists none, or there is no plan", () => {
    const none = { ids: [], translations: 0, categoryNames: 0 };

    assert.deepEqual(draftsToPublish(drafted(undefined)), none);
    assert.deepEqual(draftsToPublish(drafted([])), none);
    assert.deepEqual(draftsToPublish(null), none);
  });

  it("confirm what Publish does: edited drafts stay drafts, then Update links", () => {
    const copy = publishConfirmCopy({ ids: ["a", "b", "c"], translations: 2, categoryNames: 1 });

    assert.equal(
      copy,
      "Publishes the 2 translation drafts and 1 category name draft the AI wrote, then runs Update links (free), so the published translations link to each other's pages. A draft edited since the AI wrote it stays a draft, and is listed after."
    );
  });

  it("name each draft Publish left alone from the plan and the run, with the route's reason", () => {
    const run = siteRun([labelsJob("done", { labels: { "category-a": { it: "Contenuti" } } })]);
    const plan = drafted(["about-it", "category-a", "category-c"]);
    plan.plan.rows[0] = { ...(plan.plan.rows[0] as PlanRow), title: "About" };

    const skipped = skippedDrafts(
      {
        published: [],
        skipped: [
          {
            id: "about-it",
            reason: "Edited since the AI wrote it, so it was left as a draft to review.",
            code: "edited_by_hand",
          },
          {
            id: "category-a",
            reason: "Changed since the AI run wrote it, so it was left as a draft to review.",
            code: "changed_since",
          },
          { id: "category-c", reason: "Sanity refused to publish it; open it in the Studio.", code: "publish_failed" },
          { id: "gone", reason: "No draft to publish.", code: "no_draft" },
        ],
      },
      { response: plan, run }
    );

    assert.deepEqual(
      skipped.map(({ title }) => title),
      ["About (Italian)", "Category name: Contenuti", "Category: category-c", "gone"]
    );
    assert.match(skipped[0]?.reason ?? "", /^Edited since the AI wrote it/);
    assert.deepEqual(
      skippedDrafts({ published: [], skipped: [{ id: "about-it", reason: "x" }] }, { response: plan }).map(({ title }) => title),
      ["About (Italian)"],
      "the plan alone names it, with no run in this tab"
    );
  });
});

function relinkAnswer(relinked: string[], remaining: number, extra: Partial<RelinkResult> = {}): ApiResult<RelinkResult> {
  return { ok: true, data: { relinked, published: [], conflicts: [], remaining, ...extra } };
}

describe("the free passes", () => {
  it("relinks until nothing is left, or a round relinks nothing", async () => {
    const answers = [relinkAnswer(["a"], 2), relinkAnswer(["b", "c"], 0)];
    const sent: unknown[] = [];
    const result = await relinkAll(async (input) => {
      sent.push(input);

      return answers.shift() ?? relinkAnswer([], 0);
    }, true);

    assert.deepEqual(sent, [{ publish: true }, { publish: true }]);
    assert.ok(result.ok);
    assert.deepEqual(result.data.relinked, ["a", "b", "c"]);

    let calls = 0;
    const stuck = await relinkAll(async () => {
      calls += 1;

      return relinkAnswer([], 5);
    }, false);

    assert.equal(calls, 1);
    assert.ok(stuck.ok);
    assert.equal(stuck.data.remaining, 5);
  });

  it("keeps going while a pass publishes drafts an earlier relink left, and says what it could not save", async () => {
    const answers = [relinkAnswer([], 1, { published: ["x"], failed: ["y"] }), relinkAnswer([], 0, { published: ["z"] })];
    const result = await relinkAll(async () => answers.shift() ?? relinkAnswer([], 0), true);

    assert.ok(result.ok);
    assert.deepEqual(result.data, { relinked: [], published: ["x", "z"], conflicts: [], failed: ["y"], remaining: 0 });
  });

  it("stops relinking at the first failure", async () => {
    const failure: ApiResult<RelinkResult> = {
      ok: false,
      error: { code: "network", message: "x", status: 0, creditSpent: false, creditMayBeSpent: false },
    };
    const result = await relinkAll(async () => failure, false);

    assert.equal(result.ok, false);
  });

  it("publishes 50 at a time", async () => {
    const ids = Array.from({ length: 120 }, (_, index) => `t-${index}`);
    const batches: number[] = [];
    const result = await publishInBatches(async (batch): Promise<ApiResult<PublishResult>> => {
      batches.push(batch.length);

      return { ok: true, data: { published: batch.slice(1), skipped: [{ id: batch[0] as string, reason: "No draft." }] } };
    }, ids);

    assert.deepEqual(batches, [50, 50, 20]);
    assert.ok(result.ok);
    assert.equal(result.data.published.length, 117);
  });

  it("sends each batch the revisions of its own ids, and once more what the route had no time for", async () => {
    const sent: [string[], Record<string, string>][] = [];
    const result = await publishInBatches(
      async (batch, revs): Promise<ApiResult<PublishResult>> => {
        sent.push([batch, revs]);

        const late = runBlock(() => {
          if (sent.length === 1) {
            return ["b", "c"];
          }
          if (sent.length === 2) {
            return ["c"];
          }
          return [];
        });

        return {
          ok: true,
          data: {
            published: batch.filter((id) => !late.includes(id)),
            skipped: late.map((id) => ({
              id,
              reason: "Not reached in this request; publish again.",
              code: "out_of_time" as const,
            })),
          },
        };
      },
      ["a", "b", "c"],
      { c: "r3", elsewhere: "r9" }
    );

    assert.deepEqual(sent, [
      [["a", "b", "c"], { c: "r3" }],
      [["b", "c"], { c: "r3" }],
    ]);
    assert.ok(result.ok);
    assert.deepEqual(result.data.published, ["a", "b"]);
    assert.deepEqual(
      result.data.skipped.map(({ id, code }) => `${id}:${code}`),
      ["c:out_of_time"],
      "each id goes again once"
    );
  });

  it("words the publish, then Update links after it, in the words the dialog uses", () => {
    const published: PublishResult = {
      published: ["a", "b"],
      skipped: [
        { id: "c", reason: "Edited since the AI wrote it, so it was left as a draft to review.", code: "edited_by_hand" },
      ],
    };

    assert.equal(publishCopy(published), "2 drafts published, 1 left as a draft.");
    assert.equal(
      publishCopy(published, relinkAnswer(["a"], 0, { published: ["a"] })),
      "2 drafts published, 1 left as a draft. 1 translation now links to pages in its own language, 1 page published."
    );
    assert.equal(
      publishCopy(published, {
        ok: false,
        error: { code: "network", message: "x", status: 0, creditSpent: false, creditMayBeSpent: false },
      }),
      "2 drafts published, 1 left as a draft. Links were not updated: use Update links in the menu above."
    );
  });

  it("calls the free relink Update links wherever a run shows it", () => {
    assert.equal(SITE_GROUP_TITLES.relink, "Update links");
    assert.equal(Object.hasOwn(SITE_GROUP_TITLES, "publish"), false, "the queue has no publish step");
  });

  it("titles every step once, so no type's group reads as another's", () => {
    const titles = RUN_STEPS.map((step) => SITE_GROUP_TITLES[step]);

    assert.equal(new Set(titles).size, titles.length);
  });
});

describe("the panel when Translate with AI is off", () => {
  const active = siteRun([pairJob("a", "it", "running")], { status: "running", finishedAt: undefined });

  it("shows only how to switch it on, unless this tab's run is still going", () => {
    assert.equal(showsSwitchedOff(true, null), true);
    assert.equal(showsSwitchedOff(true, siteRun([pairJob("a", "it", "done")])), true, "a finished run keeps nothing on");
    assert.equal(showsSwitchedOff(true, active), false, "its progress and Stop stay on screen");
    assert.equal(showsSwitchedOff(true, { ...active, status: "stopping" }), false);
    assert.equal(showsSwitchedOff(false, null), false);
  });

  it("says what switches it off and how to switch it on", () => {
    assert.match(SWITCHED_OFF_NOTE, /AI request limit per day under Defaults is 0/);
    assert.match(SWITCHED_OFF_NOTE, /Set it above 0 and publish/);
  });
});

describe("what a screen reader hears while a free pass runs", () => {
  it("says what the spinner is doing, and nothing once it is done", () => {
    assert.equal(panelBusyCopy({ isUpdatingLinks: true }), "Updating links.");
    assert.equal(panelBusyCopy({ isPublishing: true, isUpdatingLinks: true }), "Publishing the AI drafts.");
    assert.equal(panelBusyCopy({}), "");
  });
});

describe("the panel's notes and saved results", () => {
  it("points documents without a language at the backfill, which a developer runs", () => {
    assert.equal(
      missingLanguageCopy(1),
      "1 document has no language yet and is left out. Ask a developer to run npm run sanity:migrate-backfill-language."
    );
    assert.match(missingLanguageCopy(3), /^3 documents have no language yet and are left out\./);
  });

  it("points category names still in plain text at the migration, which a developer runs", () => {
    assert.equal(
      plainLabelsCopy(1),
      "1 category name is still plain text, not one per language, and left out. Ask a developer to run npm run sanity:migrate-localize-fields."
    );
    assert.match(plainLabelsCopy(2), /^2 category names are still plain text/);
  });

  it("titles each saved result from the plan", () => {
    const items = savedResultItems(
      response({ savedResults: [{ sourceId: "about", language: "it", savedAt: "2026-10-20T01:00:00Z" }] })
    );

    assert.deepEqual(items, [
      { sourceId: "about", language: "it", savedAt: "2026-10-20T01:00:00Z", title: "about", languageTitle: "Italiano" },
    ]);
  });
});

describe("the style guide counter", () => {
  it("counts each language's compiled guide against Sanity's cap", () => {
    const languages = TEST_LOCALES.filter(({ id }) => id !== "en");
    const value = { styleGuide: "x".repeat(400), languageNotes: { it: "Use tu." }, glossary: [] };
    const [italian, german] = styleGuideRoom(value, languages);

    assert.ok(italian && german);
    assert.equal(italian.length, 400 + 2 + "Use tu.".length);
    assert.equal(german.length, 400);
    assert.equal(styleGuideRoomCopy(german, true), "400 / 2,000, 1,600 characters left");
    assert.equal(styleGuideRoomCopy(italian, false), "Italiano: 409 / 2,000, 1,591 characters left");

    const [over] = styleGuideRoom({ styleGuide: "x".repeat(AI_TRANSLATION_STYLE_GUIDE_LIMIT + 1) }, languages);

    assert.ok(over && !over.ok);
    assert.equal(styleGuideRoomCopy(over, true), "2,001 / 2,000, 1 character over, shorten it");
  });
});

describe("the panel's words", () => {
  it("hold no en or em dash", () => {
    const view = sitePlanView(response(), options());
    const words = [
      ...Object.values(view.counts).map((count) => countsCopy(count)),
      ...Object.values(confirmCopy({ view, run: options(), response: response() })).flat(),
      ...Object.values(confirmCopy({ view, run: options({ maxCredits: 1 }), response: response() })).flat(),
      publishConfirmCopy({ ids: ["a"], translations: 1, categoryNames: 1 }),
      aiDraftsCopy({ ids: ["a", "b"], translations: 1, categoryNames: 1 }),
      SWITCHED_OFF_NOTE,
      plainLabelsCopy(2),
      runCostCopy({ credits: 9 }, 2),
      ...runBlocks(
        response({ creditsToday: { day: "d", used: 1, max: 1 }, blocked: { code: "schema_drift", message: "x" } })
      ).map(({ message }) => message),
    ];

    for (const word of words) {
      assert.doesNotMatch(word, DASHES, word);
    }
  });
});

describe("the page list at scale", () => {
  const cell = (bulk: boolean): SiteCell => ({ language: "it", status: bulk ? "notTranslated" : "upToDate", bulk });
  const row = (index: number, bulk: boolean, skipped = false): SiteRow => ({
    id: `row-${index}`,
    documentId: `doc-${index}`,
    title: `Page ${index}`,
    type: "page",
    skipped,
    hasUnpublishedChanges: false,
    cells: [cell(bulk)],
  });
  // 500 pages, every tenth one still to translate, plus one never published.
  const pages: SiteGroup = {
    step: "page",
    title: "Pages",
    rows: [...Array.from({ length: 500 }, (_, index) => row(index, index % 10 === 0)), row(500, true, true)],
  };
  const people: SiteGroup = { step: "person", title: "People", rows: [row(1000, false)] };

  it("counts every row, and only what a run would translate as left", () => {
    assert.deepEqual(planTotals([pages, people]), { rows: 502, toTranslate: 50 });
  });

  it("opens on what is left to translate, and on everything when nothing is", () => {
    assert.equal(defaultPlanFilter([pages, people]), "toTranslate");
    assert.equal(defaultPlanFilter([people]), "all");
  });

  it("keeps only rows left to translate, and drops a group with none", () => {
    const groups = filterPlanGroups([pages, people], { filter: "toTranslate", query: "" });

    assert.deepEqual(
      groups.map(({ step, rows, total, toTranslate }) => ({ step, rows: rows.length, total, toTranslate })),
      [{ step: "page", rows: 50, total: 501, toTranslate: 50 }]
    );
  });

  it("searches titles in any case, across the whole list", () => {
    const groups = filterPlanGroups([pages, people], { filter: "all", query: "  PAGE 10 " });

    assert.deepEqual(
      groups.flatMap(({ rows }) => rows.map(({ title }) => title)),
      [
        "Page 10",
        "Page 100",
        "Page 101",
        "Page 102",
        "Page 103",
        "Page 104",
        "Page 105",
        "Page 106",
        "Page 107",
        "Page 108",
        "Page 109",
        "Page 1000",
      ]
    );
  });

  it("never counts a page that was never published as left to translate", () => {
    assert.equal(rowNeedsTranslation(row(1, true, true)), false);
    assert.equal(rowNeedsTranslation(row(1, true)), true);
  });

  it("sums up a group, and pages a long one", () => {
    assert.equal(groupCountsCopy({ total: 1204, toTranslate: 30 }), "1,204 pages · 30 to translate");
    assert.equal(groupCountsCopy({ total: 1, toTranslate: 0 }), "1 page");
    assert.equal(showMoreCopy(480), `Show ${PLAN_PAGE_SIZE} more (480 left)`);
    assert.equal(showMoreCopy(7), "Show 7 more (7 left)");
  });
});
